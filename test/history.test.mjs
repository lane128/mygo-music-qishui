import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Catalog, requestJSON } from '../helper/catalog.mjs'
import { HISTORY_ID, HISTORY_PATH, historyPlaylist } from '../helper/history.mjs'

const session = { version: 1, deviceID: '1234567890123456', installID: '123456789012345', cookies: [{ name: 'sessionid', value: 'fixture-session' }] }
const track = id => ({ id, name: 'Fixture song', duration: 180000, artists: [], album: {} })
const resource = id => ({ entity: { track: track(id) } })

// Sidebar loading keeps the default history entry and never requests its contents.
test('keeps the sidebar history cover unchanged without requesting history', async () => {
  const calls = []
  const catalog = new Catalog(session, { request: async (_, path) => {
    calls.push(path)
    assert.notEqual(path, HISTORY_PATH)
    return { playlists: [{ id: '123', title: 'Library' }] }
  } })
  const playlists = await catalog.playlists()
  assert.deepEqual(playlists.map(p => p.id), ['123', HISTORY_ID])
  assert.deepEqual(calls, ['/luna/pc/me/playlist'])
  assert.equal(playlists.at(-1).mine, undefined)
  assert.equal(playlists.at(-1).imageUrl, undefined)
})

test('only the history detail page uses the newest song cover and loads the complete list', async () => {
  const first = { ...track('1'), album: { cover_url: 'https://p3-luna.douyinpic.com/img/first.jpg' } }
  const second = { ...track('2'), album: { cover_url: 'https://p3-luna.douyinpic.com/img/second.jpg' } }
  let historyRequests = 0
  const catalog = new Catalog(session, { request: async (_, path, options) => {
    if (path !== HISTORY_PATH) return { playlists: [{ id: '123', title: 'Library' }] }
    historyRequests++
    assert.equal(options.signed, true)
    assert.equal(options.query.count, '1000')
    return {
      media: [
        { entity: { track_wrapper: { track: first } } },
        { entity: { track: second } },
      ],
      has_more: false,
    }
  } })
  const sidebar = (await catalog.playlists()).at(-1)
  assert.equal(sidebar.imageUrl, undefined)
  assert.equal(sidebar.trackCount, undefined)
  assert.equal(sidebar.tracks, undefined)
  assert.equal(historyRequests, 0)
  const page = await catalog.playlist(HISTORY_ID)
  assert.equal(page.imageUrl, first.album.cover_url)
  assert.equal(page.trackCount, 2)
  assert.deepEqual(page.tracks.map(t => t.id), ['1', '2'])
  assert.equal(historyRequests, 1)
  assert.equal((await catalog.playlists()).at(-1).imageUrl, undefined)
  assert.equal(historyRequests, 1, 'sidebar refresh must not fetch history after opening its detail')
})

test('empty history and a newest song without a safe cover retain the host fallback', async () => {
  for (const first of [undefined, track('1'), { ...track('1'), album: { cover_url: 'http://example.invalid/unsafe.jpg' } }]) {
    const catalog = new Catalog(session, { request: async (_, path, options) => path === HISTORY_PATH
      ? { media: first ? [{ entity: { track: first } }] : [], has_more: false }
      : { playlists: [] } })
    assert.equal((await catalog.playlists())[0].imageUrl, undefined)
    assert.equal((await catalog.playlist(HISTORY_ID)).imageUrl, undefined)
  }
})

test('history detail filters a leading video and never substitutes an older song cover', async () => {
  const first = track('1')
  const older = { ...track('2'), album: { cover_url: 'https://p3-luna.douyinpic.com/img/older.jpg' } }
  const catalog = new Catalog(session, { request: async () => ({ media: [
    { type: 'video', entity: { video: { video_id: 'fixture-video' } } },
    { entity: { track: first } }, { entity: { track: older } },
  ], has_more: false }) })
  const page = await catalog.playlist(HISTORY_ID)
  assert.deepEqual(page.tracks.map(t => t.id), ['1', '2'])
  assert.equal(page.imageUrl, undefined)
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
      assert.equal(new URL(url).searchParams.get('device_platform'), process.platform === 'win32' ? 'windows' : 'mac')
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
