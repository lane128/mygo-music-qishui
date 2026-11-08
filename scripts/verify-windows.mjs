// Development CLI; installed Windows verification uses standalone Go test EXEs.
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WINDOWS_FILES, checkDigest, checkWindowsPE, inspectWindowsAudio, sha256 } from './runtime-assets.mjs'
import { checkPackageLayout } from './package-layout.mjs'

export async function checkWindowsPackage(root) {
  const native = path.join(root, 'runtime/native'), hashes = {}, files = []
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name + '/')
      else files.push(name)
    }
  }
  for (const [name, expected] of Object.entries(WINDOWS_FILES)) {
    const bytes = await readFile(path.join(native, name))
    checkDigest(bytes, expected, name)
    if (/\.(?:exe|dll|node)$/.test(name)) checkWindowsPE(bytes, name)
    hashes[name] = expected
  }
  const build = JSON.parse(await readFile(path.join(native, 'BUILD.json'), 'utf8'))
  const nativeBuild = JSON.parse(await readFile(path.join(native, 'NATIVE-BUILD.json'), 'utf8'))
  if (nativeBuild.platform !== 'windows' || !['amd64', 'arm64'].includes(nativeBuild.arch)) throw new Error('Incorrect native build platform')
  const arch = nativeBuild.arch, workerName = `qishui-helper-windows-${arch}.exe`
  if (arch === 'arm64' && nativeBuild.signerArch !== 'amd64') throw new Error('Windows ARM64 requires an x64 signer subprocess')
  const packageKind = Object.hasOwn(build, 'native-worker.test.exe') ? 'validation' : 'runtime'
  const images = [['windows-runner.exe', path.join(native, 'windows-runner.exe')], ['qishui-sign.exe', path.join(native, 'qishui-sign.exe')], [workerName, path.join(root, 'bin', workerName)]]
  if (packageKind === 'validation') images.push(['windows-runner.test.exe', path.join(root, 'test/windows-runner.test.exe')], ['native-worker.test.exe', path.join(root, 'test/native-worker.test.exe')])
  for (const [name, file] of images) {
    const bytes = await readFile(file)
    checkWindowsPE(bytes, name, name === 'qishui-sign.exe' ? 'amd64' : arch)
    if (!/^[a-f0-9]{64}$/.test(build[name] || '')) throw new Error('Missing native build digest')
    checkDigest(bytes, build[name], name)
    hashes[name] = sha256(bytes)
  }
  for (const name of ['qishui-sign.exe', workerName]) if (nativeBuild.images?.[name] !== build[name]) throw new Error('Native build digest disagreement')
  for (const name of ['GO-LICENSE', 'X-SYS-LICENSE']) if ((await readFile(path.join(native, name))).length < 100) throw new Error('Missing native dependency license')
  const licenses = path.join(root, 'native/signer/licenses')
  const licenseSources = JSON.parse(await readFile(path.join(licenses, 'provenance.json'), 'utf8'))
  for (const name of ['LIBCXX-LICENSE', 'LIBCXXABI-LICENSE', 'LIBUNWIND-LICENSE']) checkDigest(await readFile(path.join(licenses, name)), licenseSources[name]?.sha256, name)
  const manifest = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'))
  if (manifest.id !== 'qishui-app-login' || manifest.permissions?.process?.join(',') !== 'bin/qishui-helper-*') throw new Error('Incorrect native plugin manifest')
  await walk(root)
  checkPackageLayout(files, { validation: packageKind === 'validation' })
  const audioPE = inspectWindowsAudio(await readFile(path.join(native, 'ffmpeg.exe')))
  return { platform: 'windows', arch, signerArch: 'amd64', ...(arch === 'arm64' ? { minimumWindows: '11', emulation: 'x64 signing and audio subprocesses' } : {}), runtime: 'native', nodeExecutableIncluded: false, packageKind, hashes, audioPE }
}
async function main() {
  const args = process.argv.slice(2)
  const root = args[0] === '--check' ? path.resolve(args[1] || '.') : fileURLToPath(new URL('..', import.meta.url))
  if (args[0] !== '--check' && (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch))) throw new Error('Runtime verification requires Windows x64 or ARM64. Use --check <extracted-package> for static inspection.')
  const inspected = await checkWindowsPackage(root)
  if (args[0] === '--check') { console.log(JSON.stringify({ ...inspected, staticOnly: true }, null, 2)); return }
  if (inspected.packageKind !== 'validation') throw new Error('Runtime verification requires the separate -validation.zip package with its native tests and fixtures.')
  if ((process.arch === 'x64' ? 'amd64' : process.arch) !== inspected.arch) throw new Error('Use Node matching the package architecture, or run scripts/verify-windows.cmd without Node.')
  const started = new Date().toISOString(), results = []
  const env = { ...process.env, QISHUI_NATIVE_ROOT: root, QISHUI_TEST_WINDOWS: '1', QISHUI_WINDOWS_RUNNER: path.join(root, 'runtime/native/windows-runner.exe') }
  for (const [name, executable] of [['isolated-runner', 'windows-runner.test.exe'], ['native-playback', 'native-worker.test.exe']]) {
    const result = spawnSync(path.join(root, 'test', executable), ['-test.v', '-test.timeout=180s'], { cwd: root, env, stdio: 'inherit', windowsHide: true, shell: false, timeout: 200000 })
    results.push({ name, exitCode: result.status, failedToStart: Boolean(result.error) })
  }
  const report = { started, finished: new Date().toISOString(), ...inspected, staticOnly: false, results,
    passed: results.every(result => result.exitCode === 0 && !result.failedToStart), liveAccountVerified: false, audioDeviceVerified: false }
  const output = path.join(root, `validation-windows-${Date.now()}.json`)
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log('Windows verification report: ' + output)
  if (!report.passed) process.exitCode = 1
}
const entry = process.argv[1] && await realpath(process.argv[1]).catch(() => null)
if (entry && import.meta.url === pathToFileURL(entry).href) await main()
