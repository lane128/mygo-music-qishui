import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const session = { version: 1, deviceID: '1234567890123456', installID: '123456789012345', cookies: [{ name: 'sessionid', value: 'fixture-session' }] }
const nativeReady = process.platform === 'darwin' && await access(new URL('../runtime/native/bdms.node', import.meta.url)).then(() => true, () => false)

// Execute the real worker, replacing only remote network responses through a Node preload.
test('actual worker serves catalog results and remains usable after an unsupported operation', async () => {
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./fixtures/music-service.mjs', import.meta.url)), fileURLToPath(new URL('../helper/worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } })
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const exit = new Promise(resolve => child.once('exit', code => resolve(code)))
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
  const request = async (method, params = {}) => {
    child.stdin.write(JSON.stringify({ op: 'music', session, method, params }) + '\n')
    const { value, done } = await lines.next()
    assert.equal(done, false)
    return JSON.parse(value)
  }
  try {
    const home = await request('home')
    assert.equal(home.ok, true)
    assert.equal(home.result.sections[0].playlists[0].id, '123')
    assert.equal((await request('unsupported')).error, 'unsupported')
    const playlist = await request('playlist', { id: '123' })
    assert.equal(playlist.result.tracks[0].duration, 180000)
    const search = await request('search', { query: '音乐' })
    assert.equal(search.result.tracks[0].id, '7123456789012345678')
    assert.equal((await request('lyrics', { id: '7123456789012345678' })).result.lrc, '[00:01.00]歌词')
  } finally {
    child.stdin.end()
    assert.equal(await exit, 0)
    clearTimeout(timer)
  }
})

// The complete ZIP signs a fixture grant with its real native SDK and serves only authorized bytes.
test('packaged worker signs and bridges granted audio until stdin closes', { skip: !nativeReady }, async () => {
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./fixtures/music-service.mjs', import.meta.url)), fileURLToPath(new URL('../helper/worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } })
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const exit = new Promise(resolve => child.once('exit', code => resolve(code)))
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
  let url
  try {
    child.stdin.write(JSON.stringify({ op: 'music', method: 'stream', params: { id: '7123456789012345678', quality: 'high' }, session }) + '\n')
    const frame = JSON.parse((await lines.next()).value)
    assert.equal(frame.ok, true, 'packaged native signing or audio bridge failed')
    assert.equal(frame.result.type, 'mp3')
    assert.equal(frame.result.quality, 'high')
    assert.equal(frame.result.data, undefined)
    url = frame.result.url
    assert.equal(new URL(url).hostname, '127.0.0.1')
    const response = await fetch(url, { headers: { Range: 'bytes=0-3' } })
    assert.equal(response.status, 206)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0xff, 0xfb, 0x90, 0x64]))
  } finally {
    child.stdin.end()
    assert.equal(await exit, 0)
    clearTimeout(timer)
  }
  if (url) await assert.rejects(fetch(url))
})
