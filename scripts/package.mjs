// Build a platform-specific, self-contained test ZIP. Build-time SDK paths
// never become user settings or appear in the resulting runtime configuration.
import { chmod, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const assets = process.env.QISHUI_SECURITY_DIR
if (!assets || !path.isAbsolute(assets)) throw new Error('Build requires QISHUI_SECURITY_DIR with the verified login SDK files.')
const securityFiles = {
  'bdms.js': 'dd918a8d2028d68b47407e205eae01d9d674daa51013bc6c5efc0573e4b0a8e0',
  'sdk-glue.js': '42f03c3d8f25c3b4f8c499b456999377b1a9d7c5238a0a95d252d6a64ae91b13',
}
for (const [name, expected] of Object.entries(securityFiles)) {
  const digest = createHash('sha256').update(await readFile(path.join(assets, name))).digest('hex')
  if (digest !== expected) throw new Error(`Unexpected build SDK checksum: ${name}`)
}
const nodeLicense = path.resolve(path.dirname(process.execPath), process.platform === 'win32' ? 'LICENSE' : '../LICENSE')
await readFile(nodeLicense) // Refuse a runtime distribution without its license.
const playwright = path.dirname(require.resolve('playwright-core/package.json'))
const manifest = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'))
const platform = process.platform === 'win32' ? 'windows' : process.platform
// MyGO reports Go architecture names, which differ from Node on x86 systems.
const arch = { x64: 'amd64', ia32: '386' }[process.arch] || process.arch
const executable = `node-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`
await mkdir(path.join(root, 'dist'), { recursive: true })
const stage = await mkdtemp(path.join(root, 'dist', '.package-'))
const archive = path.join(root, 'dist', `plugin-${platform}-${arch}-${manifest.version}-${Date.now()}.zip`)
try {
  for (const name of ['plugin.json', 'index.js', 'package.json', 'package-lock.json', 'README.md', 'NOTICE.md', 'VALIDATION.md', 'LICENSE', 'helper', 'scripts', 'test']) {
    await cp(path.join(root, name), path.join(stage, name), { recursive: true })
  }
  await mkdir(path.join(stage, 'bin'), { recursive: true })
  await cp(process.execPath, path.join(stage, 'bin', executable))
  await chmod(path.join(stage, 'bin', executable), 0o755)
  await cp(nodeLicense, path.join(stage, 'bin', 'NODE-LICENSE'))
  await cp(playwright, path.join(stage, 'node_modules', 'playwright-core'), { recursive: true })
  await mkdir(path.join(stage, 'runtime', 'security'), { recursive: true })
  for (const name of Object.keys(securityFiles)) await cp(path.join(assets, name), path.join(stage, 'runtime', 'security', name))
  const result = spawnSync('zip', ['-q', '-r', archive, '.'], { cwd: stage, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error('ZIP packaging failed; install the zip command.')
  console.log(archive)
} finally {
  await rm(stage, { recursive: true, force: true })
}
