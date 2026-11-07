import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Catalog, requestJSON } from '../helper/catalog.mjs'
import { HISTORY_ID, HISTORY_PATH, historyPlaylist } from '../helper/history.mjs'

const session = { version: 1, deviceID: '1234567890123456', installID: '123456789012345', cookies: [{ name: 'sessionid', value: 'fixture-session' }] }
const track = id => ({ id, name: 'Fixture song', duration: 180000, artists: [], album: {} })
const resource = id => ({ entity: { track: track(id) } })

// The only local system list must follow every real playlist without issuing a history request during sidebar loading.
test('appends a read-only history entry after all personal playlists with a bundled cover', async () => {
  const calls = []
  const catalog = new Catalog(session, { request: async (_, path) => { calls.push(path); return { playlists: [{ id: '123', title: 'Library' }] } } })
  const playlists = await catalog.playlists()
  assert.deepEqual(playlists.map(p => p.id), ['123', HISTORY_ID])
  assert.deepEqual(calls, ['/luna/pc/me/playlist'])
  assert.equal(playlists.at(-1).mine, undefined)
  await access(new URL(playlists.at(-1).imageUrl))
  const cover = await readFile(new URL(playlists.at(-1).imageUrl))
  assert.equal(cover.subarray(1, 4).toString(), 'PNG')
  assert.equal(cover.readUInt32BE(16), 320)
  assert.equal(cover.readUInt32BE(20), 320)
})

// The history route must use the official GET endpoint and preserve newest-first order while filtering videos and deduplicating overlaps.
test('loads history through the local playlist ID using direct and wrapped song entities', async () => {
  const calls = []
  const catalog = new Catalog(session, { request: async (_, path, options) => {
    calls.push(options.query.cursor)
    assert.equal(path, HISTORY_PATH)
    assert.equal(options.signed, true)
    assert.equal(options.body, undefined)
    assert.equal(options.query.media_type, '')
    assert.equal(options.query.scene, '')
    if (!options.query.cursor) {
      assert.equal(options.query.count, '1000')
      return { media: [resource('7123456789012345678'), { type: 'track', entity: { track_wrapper: { track: track('2') } } }, { entity: { video: { video_id: 'video' } } }], has_more: true, next_cursor: 'opaque+/next' }
    }
    assert.equal(options.query.count, '997')
    return { media: [resource('2'), resource('3')], has_more: false }
  } })
  const result = await catalog.playlist(HISTORY_ID)
  assert.equal(result.id, HISTORY_ID)
  assert.equal(result.trackCount, 3)
  assert.deepEqual(result.tracks.map(t => t.id), ['7123456789012345678', '2', '3'])
  assert.equal(result.tracks[0].duration, 180000)
  assert.deepEqual(calls, ['', 'opaque+/next'])
})

// Failed history reads must stay errors; successful zero-value envelopes can legitimately omit the repeated media field.
test('handles honest empty history and rejects invalid resources or looping pagination', async () => {
  for (const response of [{ media: [] }, { status_info: { code: 0 } }, { media: null, has_more: false }]) {
    const catalog = new Catalog(session, { request: async () => response })
    assert.deepEqual((await catalog.playlist(HISTORY_ID)).tracks, [])
  }
  for (const response of [{}, { media: {} }, { media: [{ type: 'track', entity: {} }] }, { media: [{ entity: { track: null } }] }, { media: [{ entity: { track_wrapper: null } }] }, { media: [], has_more: true }, { media: Array.from({ length: 1001 }, () => resource('1')) }]) {
    const catalog = new Catalog(session, { request: async () => response })
    await assert.rejects(catalog.playlist(HISTORY_ID), { kind: 'response' })
  }
  const repeating = new Catalog(session, { request: async () => ({ media: [], has_more: true, next_cursor: 'loop' }) })
  await assert.rejects(repeating.playlist(HISTORY_ID), { kind: 'response' })
  const failed = new Catalog(session, { request: async () => { throw Object.assign(new Error('fixture'), { kind: 'network' }) } })
  await assert.rejects(failed.playlist(HISTORY_ID), { kind: 'network' })
})

// A signed GET binds the complete URL and cookies without adding a body digest for an absent body.
test('signs history GET without a fabricated request body or POST digest', async () => {
  let signed
  await requestJSON(session, HISTORY_PATH, { signed: true, query: { cursor: '', count: '1000', media_type: '', scene: '' } }, {
    sign: async spec => { signed = spec; return { 'X-Helios': 'fixture', 'X-Medusa': 'fixture' } },
    fetch: async (url, options) => {
      assert.equal(url, signed.url)
      assert.equal(new URL(url).pathname, HISTORY_PATH)
      assert.equal(new URL(url).searchParams.get('count'), '1000')
      assert.equal(new URL(url).searchParams.get('device_platform'), 'mac')
      assert.equal(options.method, 'GET')
      assert.equal(options.body, undefined)
      assert.equal(options.headers['X-SS-STUB'], undefined)
      assert.equal(signed.headers.Cookie, ['sessionid', 'fixture-session'].join('='))
      assert.equal(signed.headers['X-Luna-Is-Local-User'], '1')
      return new Response('{"media":[]}')
    },
  })
})

// History's official 1000-item response needs a larger bounded envelope, without lifting limits for other catalog operations.
test('bounds history envelopes separately from ordinary catalog responses', async () => {
  const sign = async () => ({ 'X-Helios': 'fixture', 'X-Medusa': 'fixture' })
  const medium = JSON.stringify({ media: [], padding: 'x'.repeat(1048576) })
  assert.deepEqual((await requestJSON(session, HISTORY_PATH, { signed: true }, { sign, fetch: async () => new Response(medium) })).media, [])
  await assert.rejects(requestJSON(session, HISTORY_PATH, { signed: true }, { sign, fetch: async () => new Response('x'.repeat(8 * 1048576 + 1)) }), { kind: 'response' })
  await assert.rejects(requestJSON(session, '/luna/pc/me/playlist', {}, { fetch: async () => new Response(medium) }), { kind: 'response' })
  assert.match(historyPlaylist().description, /1000/)
})
