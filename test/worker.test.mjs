import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { requestJSON } from '../helper/catalog.mjs'

const session = { version: 1, deviceID: '1234567890123456', installID: '123456789012345' }
const windows = process.platform === 'win32'
const platform = windows ? 'windows' : process.platform
const name = `qishui-helper-${platform}-${process.arch === 'x64' ? 'amd64' : process.arch}${windows ? '.exe' : ''}`
const packaged = process.env.QISHUI_NATIVE_ROOT
let executable
if (packaged) {
  assert.ok(path.isAbsolute(packaged), 'QISHUI_NATIVE_ROOT must be absolute')
  executable = path.join(packaged, 'bin', name)
  await access(executable)
} else {
  const output = await mkdtemp(path.join(tmpdir(), 'qishui-worker-ipc-'))
  after(() => rm(output, { recursive: true, force: true }))
  executable = path.join(output, name)
  const built = spawnSync('go', ['-C', fileURLToPath(new URL('../native/worker', import.meta.url)), 'build', '-trimpath', '-buildvcs=false', '-o', executable, '.'], {
    env: { ...process.env, CGO_ENABLED: '0' }, encoding: 'utf8', timeout: 180000,
  })
  assert.equal(built.status, 0, built.stderr || 'Native IPC tests require Go')
}
function worker() {
  const env = windows ? { PATH: '', SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : { PATH: '/usr/bin:/bin', HOME: process.env.HOME }
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], env })
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const exit = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject) })
  let stderrBytes = 0
  child.stderr.on('data', chunk => { stderrBytes += chunk.length })
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
  return {
    async raw(value) { child.stdin.write(value + '\n'); const next = await lines.next(); assert.equal(next.done, false); return JSON.parse(next.value) },
    async request(spec) { return this.raw(JSON.stringify(spec)) },
    async close() {
      child.stdin.end()
      try { assert.deepEqual(await exit, { code: 0, signal: null }); assert.equal(stderrBytes, 0, 'Worker must not log private input or SDK diagnostics') }
      finally { clearTimeout(timer) }
    },
  }
}
const spec = (method, params = {}) => ({ op: 'music', session, method, params })

// Execute the actual native protocol even when no proprietary SDK is available.
test('native worker rejects removed authentication and catalog operations', async () => {
  const w = worker()
  try {
    for (const op of ['start', 'check', 'account']) assert.deepEqual(await w.request({ op, session }), { ok: false, error: 'response' })
    for (const method of ['home', 'playlists', 'playlist', 'search', 'modes', 'modePage', 'discover', 'radio', 'feed', 'lyrics']) {
      assert.deepEqual(await w.request(spec(method)), { ok: false, error: 'unsupported' })
    }
  } finally { await w.close() }
})

test('native signing bridge rejects invalid origins, devices and headers without losing its protocol', async () => {
  const w = worker()
  const base = { url: 'https://api.qishui.com/luna/pc/feed/mode?device_id=' + session.deviceID, did: session.deviceID, headers: { Accept: 'application/json' } }
  try {
    for (const changes of [
      { url: 'https://evil.invalid/luna/pc/feed/mode' },
      { url: 'https://api.qishui.com/not-supported?device_id=' + session.deviceID },
      { url: 'https://user@api.qishui.com/luna/pc/feed/mode?device_id=' + session.deviceID },
      { url: 'https://api.qishui.com:8443/luna/pc/feed/mode?device_id=' + session.deviceID },
      { url: base.url + '#fragment' }, { did: '1111111111111111' },
      { headers: { Accept: 'application/json\r\nInjected: bad' } },
      { headers: { 'bad header': 'value' } },
      { headers: { Accept: 'application/json' }, headerLines: 'accept\r\ndifferent-value' },
    ]) assert.deepEqual(await w.request(spec('sign', { ...base, ...changes })), { ok: false, error: 'response' })
    assert.deepEqual(await w.request(spec('unsupported')), { ok: false, error: 'unsupported' })
  } finally { await w.close() }
})

test('native worker recovers after oversized and duplicate-key input and refuses missing grants', async () => {
  const w = worker()
  try {
    assert.deepEqual(await w.raw('x'.repeat(131073)), { ok: false, error: 'response' })
    assert.deepEqual(await w.raw('{"op":"music","op":"start"}'), { ok: false, error: 'response' })
    assert.deepEqual(await w.request(spec('stream', { id: '123', quality: 'high' })), { ok: false, error: 'unavailable' })
    assert.deepEqual(await w.request(spec('unsupported')), { ok: false, error: 'unsupported' })
  } finally { await w.close() }
})

// QISHUI_NATIVE_ROOT selects an extracted complete package. PATH contains no Node.
test('packaged native worker returns only actual SDK signatures and exits on EOF', { skip: !packaged }, async () => {
  const w = worker()
  try {
    for (const [endpoint, body] of [
      ['/luna/pc/feed/mode', {}],
      ['/luna/pc/me/recently-played-media', { media: [{ type: 'track', id: '91' }] }],
    ]) {
      let signing
      await requestJSON({ ...session, cookies: [{ name: 'sessionid', value: 'fixture-session' }] }, endpoint, { signed: true, body }, {
        sign: async value => { signing = value; return { 'x-helios': 'fixture-helios', 'x-medusa': 'fixture-medusa' } },
        fetch: async () => new Response('{}'),
      })
      const headers = Object.fromEntries(Object.entries(signing.headers).map(([key, value]) => [key.toLowerCase(), value]))
      const frame = await w.request(spec('sign', { ...signing, headers, headerLines: Object.entries(headers).flat().join('\r\n') }))
      assert.equal(frame.ok, true, `Packaged isolated SDK call failed for ${endpoint}: ${frame.error || 'no diagnostic'}`)
      assert.deepEqual(Object.keys(frame.result).sort(), ['x-helios', 'x-medusa'])
      assert.ok(Object.values(frame.result).every(value => typeof value === 'string' && value.length > 0))
    }
  } finally { await w.close() }
})
