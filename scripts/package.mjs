// Complete native platform packages; no runtime downloads or user-installed dependencies.
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import path from 'node:path'
import { DARWIN_FILES, WINDOWS_FILES, WINDOWS_FFMPEG_FILES, WINDOWS_SOURCES, checkDigest, checkWindowsPE, inspectWindowsAudio, packageTarget, sha256 } from './runtime-assets.mjs'
import { checkPackageLayout, copyPackageSource } from './package-layout.mjs'
import { buildNative, goCommand } from './build-native.mjs'

await import('./build.mjs')
const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--target')) throw new Error('Usage: npm run package -- [--target windows-amd64]')
const target = packageTarget(args[1])
if (!target.windows && (process.platform !== 'darwin' || process.arch !== 'arm64')) throw new Error('The macOS native package must be built on macOS arm64')
const inputs = target.windows ? process.env.QISHUI_WINDOWS_ASSETS : process.env.QISHUI_NATIVE_DIR
if (!inputs || !path.isAbsolute(inputs)) throw new Error(target.windows ? 'Build requires QISHUI_WINDOWS_ASSETS; prepare verified native/audio assets first.' : 'Build requires QISHUI_NATIVE_DIR with the verified official 3.7.0 native pair.')
const expected = target.windows ? WINDOWS_FILES : DARWIN_FILES
for (const [name, hash] of Object.entries(expected)) {
  const bytes = await readFile(path.join(inputs, name))
  checkDigest(bytes, hash, name)
  if (target.windows && /\.(?:exe|dll|node)$/.test(name)) checkWindowsPE(bytes, name)
  if (target.windows && name === 'ffmpeg.exe') inspectWindowsAudio(bytes)
}
const manifest = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'))
await mkdir(path.join(root, 'dist'), { recursive: true })
const stage = await mkdtemp(path.join(root, 'dist', '.package-'))
const basename = `plugin-${target.platform}-${target.arch}-${manifest.version}-${Date.now()}`
const runnerModule = path.join(root, 'native/windows-runner'), workerModule = path.join(root, 'native/worker')
try {
  await copyPackageSource(root, stage)
  const generated = await buildNative(stage, { target: `${target.platform}-${target.arch}` })
  const native = path.join(stage, 'runtime/native')
  const goRoot = goCommand(workerModule, target, ['env', 'GOROOT'])
  let goLicense
  for (const candidate of [path.join(goRoot, 'LICENSE'), path.join(goRoot, '../LICENSE')]) {
    try { goLicense = await readFile(candidate); break } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!goLicense) throw new Error('Go distribution license is required')
  await writeFile(path.join(native, 'GO-LICENSE'), goLicense)
  if (target.windows) {
    for (const name of ['bdms.node', 'metasecml.dll', ...Object.keys(WINDOWS_FFMPEG_FILES)]) await cp(path.join(inputs, name), path.join(native, name))
    await writeFile(path.join(native, 'SOURCES.json'), JSON.stringify(WINDOWS_SOURCES, null, 2) + '\n')
    const runner = path.join(native, 'windows-runner.exe')
    goCommand(runnerModule, target, ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', runner, '.'])
    const bytes = await readFile(runner)
    checkWindowsPE(bytes, 'windows-runner.exe')
    await writeFile(path.join(native, 'BUILD.json'), JSON.stringify({ ...generated.images, 'windows-runner.exe': sha256(bytes) }, null, 2) + '\n')
    await cp(path.join(goCommand(runnerModule, target, ['list', '-m', '-f', '{{.Dir}}', 'golang.org/x/sys']), 'LICENSE'), path.join(native, 'X-SYS-LICENSE'))
  } else {
    for (const name of Object.keys(DARWIN_FILES)) await cp(path.join(inputs, name), path.join(native, name))
    const converter = path.join(native, 'audio-convert')
    const build = spawnSync('/usr/bin/clang', ['-O2', '-framework', 'AudioToolbox', '-framework', 'CoreFoundation', path.join(root, 'helper/audio-convert.c'), '-o', converter], { stdio: 'inherit', timeout: 60000 })
    if (build.error || build.status !== 0) throw new Error('Audio converter build failed; install Xcode Command Line Tools')
    await chmod(converter, 0o755)
  }
  async function archive(suffix) {
    const entries = Object.create(null)
    async function collect(directory, prefix = '') {
      for (const name of await readdir(directory)) {
        const absolute = path.join(directory, name), relative = prefix + name, info = await lstat(absolute)
        if (info.isSymbolicLink()) throw new Error('Package cannot contain links')
        if (info.isDirectory()) await collect(absolute, relative + '/')
        else if (info.isFile()) entries[relative] = [await readFile(absolute), { os: 3, attrs: ((info.mode & 0o777 | 0o100000) << 16) >>> 0 }]
        else throw new Error('Package cannot contain special files')
      }
    }
    await collect(stage)
    checkPackageLayout(Object.keys(entries), { validation: suffix === '-validation' })
    const destination = path.join(root, 'dist', basename + suffix + '.zip')
    await writeFile(destination, zipSync(entries, { level: 6 }), { flag: 'wx' })
    console.log(destination)
  }
  await archive('')
  await copyPackageSource(root, stage, { validation: true })
  const workerTests = path.join(stage, 'test/native-worker.test' + (target.windows ? '.exe' : ''))
  goCommand(workerModule, target, ['test', '-c', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', workerTests, '.'])
  if (target.windows) {
    const runnerTests = path.join(stage, 'test/windows-runner.test.exe')
    goCommand(runnerModule, target, ['test', '-c', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', runnerTests, './tests'])
    const buildFile = path.join(native, 'BUILD.json'), build = JSON.parse(await readFile(buildFile, 'utf8'))
    for (const [name, output] of [['windows-runner.test.exe', runnerTests], ['native-worker.test.exe', workerTests]]) {
      const bytes = await readFile(output)
      checkWindowsPE(bytes, name); build[name] = sha256(bytes)
    }
    await writeFile(buildFile, JSON.stringify(build, null, 2) + '\n')
  }
  await archive('-validation')
} finally {
  await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
}
