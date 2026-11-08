// Optional real Windows execution uses the native integration test binary.
// No account, network service or installed Node/FFmpeg is required by the helper.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
const enabled = process.platform === 'win32' && process.env.QISHUI_TEST_WINDOWS === '1'
test('Windows AppContainer decrypts and serves verified M4A without a converter', { skip: !enabled }, () => {
  const root = process.env.QISHUI_NATIVE_ROOT
  assert.ok(root && path.isAbsolute(root), 'set QISHUI_NATIVE_ROOT to an extracted validation package')
  const result = spawnSync(path.join(root, 'test/native-worker.test.exe'), ['-test.run', '^TestNativeM4APassthrough$', '-test.v'], { cwd: root, env: { ...process.env, QISHUI_NATIVE_ROOT: root }, windowsHide: true, shell: false, timeout: 60000, encoding: 'utf8' })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout)
  assert.doesNotMatch(result.stdout, /SKIP/)
})
