// Build native runtime programs; Node is development tooling only.
import { spawnSync } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSigner } from '../native/signer/build.mjs'
import { checkWindowsPE, packageTarget, sha256 } from './runtime-assets.mjs'
const project = fileURLToPath(new URL('..', import.meta.url))
export function goCommand(module, target, args) {
  const result = spawnSync('go', ['-C', module, ...args], {
    env: { ...process.env, GOOS: target.platform, GOARCH: target.arch, CGO_ENABLED: '0' },
    encoding: 'utf8', timeout: 180000, maxBuffer: 1048576,
  })
  if (result.error || result.status !== 0) throw new Error('Native Go build failed.\n' + (result.stderr || 'Go toolchain unavailable'))
  return result.stdout.trim()
}
export async function buildNative(destination, { target: name, zig = process.env.QISHUI_ZIG } = {}) {
  const target = packageTarget(name)
  if (!path.isAbsolute(destination)) throw new Error('Native output must be an absolute directory')
  const bin = path.join(destination, 'bin'), native = path.join(destination, 'runtime/native')
  await mkdir(bin, { recursive: true }); await mkdir(native, { recursive: true })
  const extension = target.windows ? '.exe' : ''
  const workerName = `qishui-helper-${target.platform}-${target.arch}${extension}`
  const worker = path.join(bin, workerName), signer = path.join(native, 'qishui-sign' + extension)
  // The QR verification window runs on WebKit and WebView2, not Linux.
  const loginName = `qishui-helper-login-${target.platform}-${target.arch}${extension}`
  const login = ['darwin', 'windows'].includes(target.platform) ? path.join(bin, loginName) : null
  for (const output of [worker, signer, ...(login ? [login] : [])]) {
    try { await access(output) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw new Error('Refusing to replace an existing native executable')
  }
  const workerModule = path.join(project, 'native/worker')
  goCommand(workerModule, target, ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', worker, '.'])
  if (login) {
    goCommand(path.join(project, 'native/login'), target, ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', login, '.']);
  }
  const signerArch = target.windows ? 'amd64' : target.arch
  await buildSigner({ platform: target.platform, arch: signerArch, output: signer, ...(zig ? { zig } : {}) })
  // Go's Intel Mach-O linker does not supply the arm64 linker's ad hoc signature.
  if (target.platform === 'darwin' && target.arch === 'amd64') {
    for (const output of [worker, login]) {
      const result = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--identifier', 'qishui.helper', output], { encoding: 'utf8' })
      if (result.error || result.status !== 0) throw new Error('Intel native helper signing failed')
    }
  }
  if (!target.windows) for (const output of [worker, signer, ...(login ? [login] : [])]) {
    const result = spawnSync('/usr/bin/codesign', ['--verify', '--strict', output], { encoding: 'utf8' })
    if (result.error || result.status !== 0) throw new Error('Native executable signature verification failed')
  }
  const images = { [workerName]: await readFile(worker), ['qishui-sign' + extension]: await readFile(signer) }
  if (login) images[path.basename(login)] = await readFile(login)
  if (target.windows) for (const [name, bytes] of Object.entries(images)) checkWindowsPE(bytes, name, name === workerName || name === loginName ? target.arch : signerArch)
  const metadata = Object.fromEntries(Object.entries(images).map(([name, bytes]) => [name, sha256(bytes)]))
  await writeFile(path.join(native, 'NATIVE-BUILD.json'), JSON.stringify({ platform: target.platform, arch: target.arch, signerArch, runtime: 'native; no Node executable', ...(target.windows && target.arch === 'arm64' ? { minimumWindows: '11', emulation: 'x64 signing subprocess' } : {}), images: metadata }, null, 2) + '\n', { flag: 'wx' })
  return { target, worker, signer, images: metadata }
}
const entry = process.argv[1] && path.resolve(process.argv[1])
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const [destination, target] = process.argv.slice(2)
  if (!destination) throw new Error('Provide a new absolute native output directory')
  console.log(JSON.stringify(await buildNative(destination, { target }), null, 2))
}
