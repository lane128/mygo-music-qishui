import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Catalog, requestJSON, normalizeLyrics } from '../helper/catalog.mjs'

const session = { version: 1, deviceID: '1234567890123456', installID: '123456789012345', cookies: [{ name: 'sessionid', value: 'fixture-session' }] }
const track = id => ({ id, name: '歌曲', duration: 180000, artists: [{ id: 'artist:opaque', name: '歌手' }], album: { id: 'album:opaque', name: '专辑', url_cover: { uri: 'cover', template_prefix: 'tpl' } } })
const resource = id => ({ type: 'track', entity: { track_wrapper: { track: track(id) } } })
const playlist = { id: '123', public_title: '我的歌单', resource_cnt: { track_cnt: 3 } }
const wire = value => new Response(JSON.stringify(value))

// Personal playlists and their tracks must survive opaque cursors and an omitted terminal list.
test('loads complete playlists, deduplicates boundary tracks, preserves IDs and milliseconds', async () => {
  const calls = []
  const pages = [
    { playlist, media_resources: [resource('7123456789012345678'), resource('2')], next_cursor: 'opaque:first', has_more: true },
    { playlist, media_resources: [resource('2'), resource('3')], next_cursor: 'opaque:end' },
    { playlist },
  ]
  const catalog = new Catalog(session, { request: async (_, path, { query }) => {
    calls.push(query.get('cursor'))
    assert.equal(path, '/luna/pc/playlist/detail')
    return pages.shift()
  } })
  const result = await catalog.playlist('123')
  assert.equal(result.name, '我的歌单')
  assert.deepEqual(result.tracks.map(t => t.id), ['7123456789012345678', '2', '3'])
  assert.equal(result.tracks[0].duration, 180000)
  assert.equal(result.tracks[0].artists[0].id, 'artist:opaque')
  assert.equal(result.tracks[0].album.id, 'album:opaque')
  assert.match(result.tracks[0].album.imageUrl, /cover~tpl-resize/)
  assert.deepEqual(calls, ['', 'opaque:first', 'opaque:end'])
})

// An incomplete or looping playlist must fail instead of silently dropping later songs.
test('rejects identity mismatches, missing first-page resources, and nonadvancing playlist cursors', async () => {
  for (const response of [
    { playlist: { ...playlist, id: '456' }, media_resources: [] },
    { playlist },
    { playlist, media_resources: [resource('1')] },
    { playlist, media_resources: [], has_more: true, next_cursor: '' },
  ]) {
    const catalog = new Catalog(session, { request: async () => response })
    await assert.rejects(catalog.playlist('123'), e => e.kind === 'response')
  }
})

// MyGO gives item offsets while Qishui uses opaque search cursors.
test('maps MyGO search offsets through real server cursors without guessing them', async () => {
  const cursors = []
  const catalog = new Catalog(session, { request: async (_, path, { query }) => {
    assert.equal(path, '/luna/search/track')
    const cursor = query.get('cursor')
    cursors.push(cursor)
    return { result_groups: [{ data: (cursor === '0' ? ['1', '2'] : ['3']).map(id => ({ entity: { track: track(id) } })), next_cursor: cursor === '0' ? 'opaque-next' : '', has_more: cursor === '0' }] }
  } })
  const result = await catalog.search({ query: '音乐', offset: 2 })
  assert.deepEqual(cursors, ['0', 'opaque-next'])
  assert.deepEqual(result.result.tracks.map(t => t.id), ['3'])
  assert.equal(result.result.more, false)
  cursors.length = 0
  await catalog.search({ query: '音乐', offset: 2, cursor: 'opaque-next' })
  assert.deepEqual(cursors, ['opaque-next'])
  await assert.rejects(catalog.search({ query: '音乐', kind: 'albums' }), e => e.kind === 'unsupported')
})

// Signatures must bind the final URL, exact body bytes and one cookie header, with redirects disabled.
test('signs the final PC request and never exposes credentials to alternate hosts', async () => {
  let signed
  const result = await requestJSON(session, '/luna/pc/track_v2', { query: { aid: '386088' }, body: { track_id: '123' }, signed: true }, {
    sign: async spec => { signed = spec; return { 'X-Helios': 'fixture-helios', 'X-Medusa': 'fixture-medusa' } },
    fetch: async (url, options) => {
      assert.equal(url, signed.url)
      assert.equal(new URL(url).hostname, 'api.qishui.com')
      assert.equal(new URL(url).searchParams.get('device_platform'), 'mac')
      assert.equal(options.body, '{"track_id":"123"}')
      assert.equal(options.headers.Cookie, ['sessionid', session.cookies[0].value].join('='))
      assert.equal(options.headers['X-SS-STUB'], '3EB6F837CE8FDAF2B242A107D85CB626')
      assert.equal(options.redirect, 'error')
      return wire({ ok: true })
    },
  })
  assert.equal(result.ok, true)
  await assert.rejects(requestJSON(session, 'https://evil.invalid/steal'), e => e.kind === 'response')
  await assert.rejects(requestJSON(session, '/luna/pc/feed/mode', { body: {}, signed: true }, { sign: async () => ({ Cookie: 'bad' }) }), e => e.kind === 'signature')
})

// Public lyrics use no account headers, preserve ordinary LRC, and normalize the PC word timing.
test('fetches public lyrics without account credentials and strips per-word timing', async () => {
  const catalog = new Catalog(session, { publicFetch: async (url, opts) => {
    assert.equal(new URL(url).hostname, 'beta-luna.douyin.com')
    assert.equal(Object.keys(opts.headers).some(k => /cookie|helios|medusa/i.test(k)), false)
    assert.equal(opts.redirect, 'error')
    return wire({ seo_track: { track: { id: '123' } }, lyric: { content: '[61234,900]<0,10,0>你<10,30,0>好\n[01:04.20]世界' } })
  } })
  assert.deepEqual(await catalog.lyrics('123'), { lrc: '[01:01.23]你好\n[01:04.20]世界' })
  assert.equal(normalizeLyrics('unrecognized'), '')
})

// Real top-level lyrics must survive SEO metadata, while legacy nested lyrics and instrumentals remain supported.
test('reads top-level lyrics beside SEO metadata and retains legitimate no-lyric tracks', async () => {
  for (const [response, expected] of [
    [{ seo_track: { track: { id: '123' } }, lyric: { content: '[1000,100]正文' } }, '[00:01.00]正文'],
    [{ seo_track: { track: { id: '123' }, lyric: { content: '[2000,100]旧版' } } }, '[00:02.00]旧版'],
    [{ seo_track: { track: { id: '123' }, lyric: { content: '[2000,100]旧版' } }, lyric: { content: '' } }, ''],
    [{ seo_track: { track: { id: '123' } } }, ''],
    [{ track_info: { id: '123' }, lyric: null }, ''],
  ]) {
    const catalog = new Catalog(session, { publicFetch: async () => wire(response) })
    assert.equal((await catalog.lyrics('123')).lrc, expected)
  }
})

// Wrong-song metadata and malformed lyric payloads must fail rather than showing another song or silently hiding an error.
test('rejects mismatched lyric identity and malformed public lyric responses', async () => {
  for (const response of [
    { seo_track: { track: { id: '456' } }, lyric: { content: '[1000,100]错误歌曲' } },
    { seo_track: { track: { id: '123' } }, lyric: { content: 42 } },
    { seo_track: { track: { id: '123' } }, lyric: 'wrong-type' },
    { seo_track: { track: { id: '123' } }, lyric: [] },
    {},
  ]) {
    const catalog = new Catalog(session, { publicFetch: async () => wire(response) })
    await assert.rejects(catalog.lyrics('123'), { kind: 'response' })
  }
})

// The home must expose real account playlists even when recommendation signing is unavailable.
test('home lists real playlists without requesting playback or recommendation grants', async () => {
  const catalog = new Catalog(session, { request: async (_, path) => {
    assert.equal(path, '/luna/pc/me/playlist')
    return { playlists: [playlist] }
  } })
  const home = await catalog.home()
  assert.equal(home.sections[0].playlists[0].id, '123')
  assert.equal(home.sections[1].links[0].page, 'recommendations')
})

// Response limits and error envelopes must be enforced before content reaches MyGO.
test('bounds catalog responses and classifies server rejection without raw payloads', async () => {
  await assert.rejects(requestJSON(session, '/luna/pc/me/playlist', {}, { fetch: async () => new Response('x'.repeat(1048577)) }), e => e.kind === 'response')
  await assert.rejects(requestJSON(session, '/luna/pc/me/playlist', {}, { fetch: async () => wire({ error_code: 7, message: 'private upstream text' }) }), e => e.kind === 'rateLimit' && !e.message.includes('private'))
})
