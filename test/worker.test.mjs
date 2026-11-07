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
    if (nativeReady) {
      assert.equal(home.ok, true)
      assert.equal(home.result.sections.length, 1)
      assert.equal(home.result.sections[0].stations[0].id, 'radio:42')
      assert.equal(home.result.sections[0].playlists, undefined)
      assert.equal(home.result.sections[0].morePage, 'listening-modes')
    } else {
      assert.equal(home.ok, false)
      assert.equal(home.error, 'setup')
    }
    const library = await request('playlists')
    assert.equal(library.ok, true)
    assert.deepEqual(library.result.slice(0, -1).map(p => p.id), ['123', '124', '125', '126', '127', '128', '129'])
    assert.equal(library.result.length, 8)
    assert.equal(library.result[0].trackCount, 1)
    assert.equal(library.result[2].trackCount, 1)
    assert.equal(library.result.at(-2).trackCount, undefined)
    assert.equal(library.result.at(-2).id, '129')
    assert.equal(library.result.at(-1).id, 'qishui:history')
    assert.match(library.result.at(-1).imageUrl, /^file:/)
    for (const id of ['empty-omitted', 'empty-null', 'empty-string-zero', 'empty-defaults']) {
      const empty = await request('playlist', { id })
      assert.equal(empty.ok, true)
      assert.equal(empty.result.id, id)
      assert.equal(empty.result.name, 'Empty fixture')
      assert.equal(empty.result.description, 'Empty description')
      assert.equal(empty.result.imageUrl, 'https://example.invalid/empty.jpg')
      assert.deepEqual(empty.result.tracks, [])
    }
    const recovered = await request('playlist', { id: '124' })
    assert.equal(recovered.ok, true)
    assert.equal(recovered.result.name, 'Fixture Playlist 1')
    assert.deepEqual(recovered.result.tracks, [])
    assert.equal((await request('playlist', { id: '125' })).result.tracks[0].id, '7123456789012345678')
    if (nativeReady) {
      const history = await request('playlist', { id: 'qishui:history' })
      assert.equal(history.ok, true)
      assert.deepEqual(history.result.tracks.map(t => t.id), ['7123456789012345678', '2'])
    }
    assert.equal((await request('unsupported')).error, 'unsupported')
    const playlist = await request('playlist', { id: '123' })
    assert.equal(playlist.result.tracks[0].duration, 180000)
    const search = await request('search', { query: '音乐' })
    assert.equal(search.result.tracks[0].id, '7123456789012345678')
    assert.equal((await request('lyrics', { id: '7123456789012345678' })).result.lrc, '[00:01.00]歌词')
    child.stdin.write(JSON.stringify({ op: 'account', session }) + '\n')
    const account = JSON.parse((await lines.next()).value)
    assert.equal(account.ok, true)
    assert.equal(account.account.name, 'SVIP · Fixture account')
  } finally {
    child.stdin.end()
    assert.equal(await exit, 0)
    clearTimeout(timer)
  }
})

// The packaged worker must sign mode discovery and scene-specific continuations using the actual SDK.
test('packaged worker signs listening modes and recommendation continuations', { skip: !nativeReady }, async () => {
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./fixtures/music-service.mjs', import.meta.url)), fileURLToPath(new URL('../helper/worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } })
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const exit = new Promise(resolve => child.once('exit', code => resolve(code)))
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
  const request = async (method, params = {}) => {
    child.stdin.write(JSON.stringify({ op: 'music', session, method, params }) + '\n')
    return JSON.parse((await lines.next()).value)
  }
  try {
    const modes = await request('modes')
    assert.equal(modes.ok, true)
    assert.equal(modes.result[2].id, 'scene:0')
    const landing = await request('modePage', { page: 'listening-modes' })
    assert.equal(landing.ok, true)
    assert.deepEqual(landing.result.sections[0].stations.map(mode => mode.id), modes.result.slice(0, 8).map(mode => mode.id))
    assert.equal(landing.result.sections[0].stations.length, 8)
    assert.equal(landing.result.sections[0].morePage, 'scene-modes')
    assert.equal(landing.result.sections[1].stations[0].id, 'radio:42')
    assert.equal(landing.more, true)
    const next = await request('discover', { state: landing.discovery })
    assert.equal(next.ok, true)
    assert.equal(next.result.sections[0].stations[0].id, 'radio:43')
    assert.equal(next.more, false)
    const allModes = await request('modePage', { page: 'scene-modes' })
    assert.equal(allModes.ok, true)
    assert.deepEqual(allModes.result.sections[0].stations.map(mode => mode.id), modes.result.map(mode => mode.id))
    assert.equal(allModes.result.sections[0].stations[2].id, 'scene:0')
    const radio = await request('radio', { id: 'radio:42', cursor: 'opaque-radio' })
    assert.equal(radio.ok, true)
    assert.equal(radio.result[0].id, '7123456789012345678')
    assert.equal(radio.more, false)
    const batch = await request('feed', { id: modes.result[2].id, count: 2, firstDeviceRequest: true, firstUseTime: 1700000000, played: [{ id: '2', duration: 180999 }] })
    assert.equal(batch.ok, true)
    assert.equal(batch.result[0].id, '7123456789012345678')
    assert.equal(batch.result[0].duration, 180000)
    assert.equal((await request('feed', { id: 'scene:-1' })).error, 'response')
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
