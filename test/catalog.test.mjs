import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Catalog, requestJSON, normalizeLyrics } from '../helper/catalog.mjs'

const session = { version: 1, deviceID: '1234567890123456', installID: '123456789012345', cookies: [{ name: 'sessionid', value: 'fixture-session' }] }
const track = id => ({ id, name: '歌曲', duration: 180000, artists: [{ id: 'artist:opaque', name: '歌手' }], album: { id: 'album:opaque', name: '专辑', url_cover: { uri: 'cover', template_prefix: 'tpl' } } })
const resource = id => ({ type: 'track', entity: { track_wrapper: { track: track(id) } } })
const playlist = { id: '123', public_title: '我的歌单', resource_cnt: { track_cnt: 3 } }
const wire = value => new Response(JSON.stringify(value))

// Count validation once rejected the entire sidebar when one entry had legacy zero or inconsistent count metadata.
test('keeps every sidebar playlist and history when optional counts vary or are malformed', async () => {
  const cases = [
    [{ count_tracks: 0, resource_cnt: { track_cnt: 3 } }, 3],
    [{ count_tracks: 3, resource_cnt: { track_cnt: 0 } }, 3],
    [{ count_tracks: '0', resource_cnt: { track_cnt: '3' } }, 3],
    [{ count_tracks: 2, resource_cnt: { track_cnt: 3 } }, 2],
    [{ count_tracks: 'not-a-count' }, undefined],
    [{ count_tracks: -1 }, undefined],
    [{}, undefined],
  ]
  const raw = cases.map(([counts], i) => ({ id: String(100 + i), title: `Playlist ${i}`, ...counts }))
  const catalog = new Catalog(session, { request: async () => ({ playlists: raw }) })
  const lists = await catalog.playlists()
  assert.deepEqual(lists.map(p => p.id), [...raw.map(p => p.id), 'qishui:history'])
  for (const [i, [, count]] of cases.entries()) assert.equal(lists[i].trackCount, count)
  assert.deepEqual(lists.slice(0, -1).map(p => p.name), raw.map(p => p.title))
})

// A default zero is not an assertion that the alternate positive count is corrupt or that the playlist is empty.
test('opens zero-default count variants without weakening content completeness checks', async () => {
  for (const counts of [{ count_tracks: 0, resource_cnt: { track_cnt: 3 } }, { count_tracks: 3, resource_cnt: { track_cnt: 0 } }]) {
    const raw = { id: '123', title: 'Library', ...counts }
    const catalog = new Catalog(session, { request: async () => ({ playlist: raw, media_resources: ['1', '2', '3'].map(resource) }) })
    const result = await catalog.playlist('123')
    assert.equal(result.trackCount, 3)
    assert.equal(result.tracks.length, 3)
    for (const body of [{ playlist: raw }, { playlist: raw, media_resources: [resource('1')] }]) {
      await assert.rejects(new Catalog(session, { request: async () => body }).playlist('123'), { kind: 'response' })
    }
  }
  await assert.rejects(new Catalog(session, { request: async () => ({ playlist: { id: '123', title: 'Library', count_tracks: 'bad' }, media_resources: [], has_more: false }) }).playlist('123'), { kind: 'response' })
})

// A real liked playlist returned valid songs and advancing cursors, but two positive counts differed and rejected every page.
test('loads liked playlist pages with different positive metadata counts using legacy count precedence', async () => {
  for (const counts of [
    { count_tracks: 3, resource_cnt: { track_cnt: 5 } },
    { count_tracks: 5, resource_cnt: { track_cnt: 3 } },
    { count_tracks: '3', resource_cnt: { track_cnt: '5' } },
  ]) {
    const raw = { id: '123', title: 'Liked fixture', ...counts }
    const cursors = []
    const catalog = new Catalog(session, { request: async (_, path, { query }) => {
      assert.equal(path, '/luna/pc/playlist/detail')
      const cursor = query.get('cursor')
      cursors.push(cursor)
      return cursor === ''
        ? { playlist: raw, media_resources: [resource('1'), resource('2')], has_more: true, next_cursor: 'opaque-liked' }
        : { playlist: raw, media_resources: [resource('2'), resource('3')], has_more: false }
    } })
    const result = await catalog.playlist('123')
    assert.deepEqual(result.tracks.map(t => t.id), ['1', '2', '3'])
    assert.deepEqual(cursors, ['', 'opaque-liked'])
    assert.equal(result.trackCount, Number(counts.count_tracks))
    const missing = new Catalog(session, { request: async () => ({ playlist: raw, has_more: false }) })
    await assert.rejects(missing.playlist('123'), { kind: 'response' })
    const incomplete = new Catalog(session, { request: async () => ({ playlist: raw, media_resources: [resource('1')] }) })
    await assert.rejects(incomplete.playlist('123'), { kind: 'response' })
  }
})

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

// Empty first pages previously failed when the service omitted media_resources or encoded it as null.
test('loads confirmed empty playlists with absent, null or empty resources and retains metadata', async () => {
  for (const count of [{ count_tracks: 0 }, { resource_cnt: { track_cnt: 0 } }, { count_tracks: 0, resource_cnt: { track_cnt: 0 } }]) {
    for (const resources of [{}, { media_resources: null }, { media_resources: [] }]) {
      const raw = { id: '123', title: 'Empty fixture', cover_url: 'https://example.invalid/empty.jpg', desc: 'Fixture description', ...count }
      const catalog = new Catalog(session, { request: async () => ({ playlist: raw, ...resources }) })
      const result = await catalog.playlist('123')
      assert.equal(result.id, raw.id)
      assert.equal(result.name, raw.title)
      assert.equal(result.imageUrl, raw.cover_url)
      assert.equal(result.description, raw.desc)
      assert.equal(result.trackCount, 0)
      assert.deepEqual(result.tracks, [])
    }
  }
})

// Compatibility with empty fields must not hide unknown counts, partial data, invalid types or pagination evidence.
test('rejects missing resources unless the first page is explicitly empty and terminal', async () => {
  for (const resources of [{}, { media_resources: null }]) {
    for (const extra of [
      { playlist: { id: '123', title: 'Unknown count' } },
      { playlist },
      { playlist: { id: '123', title: 'Invalid count', count_tracks: 'not-a-count' } },
      { playlist: { id: '123', title: 'Conflicting counts', count_tracks: 0, resource_cnt: { track_cnt: 3 } } },
      { has_more: true, next_cursor: 'next' },
      { next_cursor: 'next' },
      { next_cursor: 1 },
      { has_more: 'false' },
      { playlist: { id: '456', title: 'Wrong identity', count_tracks: 0 } },
    ]) {
      const catalog = new Catalog(session, { request: async () => ({ playlist: { id: '123', title: 'Empty', count_tracks: 0 }, ...resources, ...extra }) })
      await assert.rejects(catalog.playlist('123'), { kind: 'response' })
    }
  }
  for (const media_resources of [{}, '', false, 0]) {
    const catalog = new Catalog(session, { request: async () => ({ playlist: { id: '123', title: 'Empty', count_tracks: 0 }, media_resources }) })
    await assert.rejects(catalog.playlist('123'), { kind: 'response' })
  }
})

// The actual empty Douyin response omitted counts, resources and has_more but retained its identity and terminal zero cursor.
test('accepts identified zero-cursor empty system lists without treating unknown details as empty', async () => {
  for (const next_cursor of ['0', 0]) {
    for (const resources of [{}, { media_resources: null }]) {
      const raw = { id: '123', title: 'Empty system fixture', desc: 'Metadata retained', cover_url: 'https://example.invalid/empty.jpg' }
      const catalog = new Catalog(session, { request: async () => ({ playlist: raw, next_cursor, ...resources }) })
      const result = await catalog.playlist('123')
      assert.equal(result.id, raw.id)
      assert.equal(result.name, raw.title)
      assert.equal(result.imageUrl, raw.cover_url)
      assert.equal(result.description, raw.desc)
      assert.deepEqual(result.tracks, [])
    }
  }
  for (const response of [
    { playlist: { id: '123', title: 'Unknown' } },
    { playlist: { id: '123', title: 'Unknown' }, next_cursor: '' },
    { playlist: { id: '456', title: 'Other' }, next_cursor: '0' },
    { playlist: { id: '123', title: 'Nonempty', count_tracks: 2 }, next_cursor: '0' },
    { playlist: { id: '123', title: 'Advancing' }, next_cursor: 'next' },
    { playlist: { id: '123', title: 'More' }, next_cursor: '0', has_more: true },
  ]) {
    await assert.rejects(new Catalog(session, { request: async () => response }).playlist('123'), { kind: 'response' })
  }
})

// Null terminal continuations must keep the songs already loaded, just like omitted terminal lists.
test('keeps accumulated tracks on a null terminal continuation and rejects a missing advancing page', async () => {
  for (const ending of [{ has_more: false }, { next_cursor: 'opaque:end' }, {}]) {
    const pages = [{ playlist, media_resources: [resource('1')], next_cursor: 'opaque:end', has_more: true }, { playlist, media_resources: null, ...ending }]
    const catalog = new Catalog(session, { request: async () => pages.shift() })
    assert.deepEqual((await catalog.playlist('123')).tracks.map(t => t.id), ['1'])
  }
  for (const extra of [{ has_more: true }, { next_cursor: 'advanced' }]) {
    const catalog = new Catalog(session, { request: async () => ({ playlist, media_resources: null, ...extra }) })
    await assert.rejects(catalog.playlistPage('123', 'opaque:end'), { kind: 'response' })
  }
})

// The PC API can encode zero counts/cursors as numbers or strings and omit the count on an explicitly terminal empty list.
test('normalizes zero values and accepts explicitly terminal empty responses without a count', async () => {
  for (const count of [{ count_tracks: '0' }, { resource_cnt: { track_cnt: '0' } }, {}]) {
    for (const next_cursor of [0, '0', '', undefined]) {
      const catalog = new Catalog(session, { request: async () => ({ playlist: { id: '123', title: 'Empty', ...count }, media_resources: null, has_more: false, next_cursor }) })
      assert.deepEqual((await catalog.playlist('123')).tracks, [])
    }
  }
  const catalog = new Catalog(session, { request: async () => ({ playlist, has_more: false }) })
  await assert.rejects(catalog.playlist('123'), { kind: 'response' })
})

// Empty detail responses can omit playlist metadata; use only this account's matching library entry, as the official navigation fallback does.
test('recovers missing detail metadata from the matching library while rejecting mismatched identities', async () => {
  for (const detail of [
    { has_more: false },
    { playlist: { id: '123' }, media_resources: null, has_more: false },
    { playlist: { id: '123' }, media_resources: [{ entity: { track: track('8') } }], has_more: false },
  ]) {
    const calls = []
    const catalog = new Catalog(session, { request: async (_, path) => {
      calls.push(path)
      return path.endsWith('/detail') ? detail : { playlists: [{ id: '123', title: 'Library metadata', count_tracks: 0, cover_url: 'https://example.invalid/cover.jpg', desc: 'Original description' }] }
    } })
    const result = await catalog.playlist('123')
    assert.equal(result.name, 'Library metadata')
    assert.equal(result.imageUrl, 'https://example.invalid/cover.jpg')
    assert.equal(result.description, 'Original description')
    assert.equal(result.tracks.length, detail.media_resources?.length || 0)
    assert.deepEqual(calls, ['/luna/pc/playlist/detail', '/luna/pc/me/playlist'])
  }
  for (const detail of [{}, { playlist: { id: '456' }, has_more: false }]) {
    const catalog = new Catalog(session, { request: async (_, path) => path.endsWith('/detail') ? detail : { playlists: [{ id: '123', title: 'Known', count_tracks: 0 }] } })
    await assert.rejects(catalog.playlist('123'), { kind: 'response' })
  }
  const missing = new Catalog(session, { request: async (_, path) => path.endsWith('/detail') ? { has_more: false } : { playlists: [{ id: '456', title: 'Another list', count_tracks: 0 }] } })
  await assert.rejects(missing.playlist('123'), { kind: 'response' })
})

// Official media resources can carry a direct track, a wrapped track, or a video; missing type must not drop a valid song.
test('loads both official track entity variants without fabricating songs from videos', async () => {
  const catalog = new Catalog(session, { request: async () => ({ playlist, has_more: false, media_resources: [resource('1'), { entity: { track: track('2') } }, { type: 'track', entity: { track: track('3') } }, { type: 'video', entity: { video: { id: '4' } } }] }) })
  assert.deepEqual((await catalog.playlist('123')).tracks.map(t => t.id), ['1', '2', '3'])
})

// A present but malformed direct entity used to be silently skipped and could turn a broken playlist into an empty success.
test('rejects malformed direct and wrapped songs while preserving unsupported resource filtering', async () => {
  for (const entity of [{ track: null }, { track: {} }, { track_wrapper: null }, { track_wrapper: {} }]) {
    const catalog = new Catalog(session, { request: async () => ({ playlist, has_more: false, media_resources: [{ entity }] }) })
    await assert.rejects(catalog.playlist('123'), { kind: 'response' })
  }
  const unknown = new Catalog(session, { request: async () => ({ playlist, has_more: false, media_resources: [{ entity: { future_resource: {} } }] }) })
  assert.deepEqual((await unknown.playlist('123')).tracks, [])
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
  await assert.rejects(catalog.search({ query: '音乐', kind: 'shows' }), e => e.kind === 'unsupported')
})

// Signatures must bind the final URL, exact body bytes and one cookie header, with redirects disabled.
test('signs the final PC request and never exposes credentials to alternate hosts', async () => {
  let signed
  const result = await requestJSON(session, '/luna/pc/track_v2', { query: { aid: '386088' }, body: { track_id: '123' }, signed: true }, {
    sign: async spec => { signed = spec; return { 'X-Helios': 'fixture-helios', 'X-Medusa': 'fixture-medusa' } },
    fetch: async (url, options) => {
      assert.equal(url, signed.url)
      assert.equal(new URL(url).hostname, 'api.qishui.com')
      assert.equal(new URL(url).searchParams.get('device_platform'), process.platform === 'win32' ? 'windows' : 'mac')
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
test('fetches public lyrics without account credentials and preserves per-word timing', async () => {
  const catalog = new Catalog(session, { publicFetch: async (url, opts) => {
    assert.equal(new URL(url).hostname, 'beta-luna.douyin.com')
    assert.equal(Object.keys(opts.headers).some(k => /cookie|helios|medusa/i.test(k)), false)
    assert.equal(opts.redirect, 'error')
    return wire({ seo_track: { track: { id: '123' } }, lyric: { content: '[61234,900]<0,10,0>你<10,30,0>好\n[01:04.20]世界' } })
  } })
  assert.deepEqual(await catalog.lyrics('123'), { lrc: '[01:01.23]你好\n[01:04.20]世界', lines: [
    { start: 61234, end: 62134, text: '你好', words: [{ start: 61234, end: 61244, text: '你' }, { start: 61244, end: 61274, text: '好' }] },
    { start: 64200, text: '世界' },
  ] })
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

// Discovery failures must reach the host's error handling rather than masquerading as an empty successful page.
test('home propagates discovery failures without requesting personal playlists or playback', async () => {
  for (const kind of ['setup', 'signature', 'network', 'response', 'session']) {
    const calls = []
    const catalog = new Catalog(session, { request: async (_, path) => {
      calls.push(path)
      throw Object.assign(new Error('fixture'), { kind })
    } })
    await assert.rejects(catalog.home(), { kind })
    assert.deepEqual(calls, ['/luna/pc/discover'])
  }
})

// Sign-out and worker deadlines must still cancel the discovery-only Home operation.
test('home preserves caller cancellation', async () => {
  const parent = new AbortController()
  const catalog = new Catalog(session, { signal: parent.signal, request: async (_, path, { signal }) => {
    assert.equal(path, '/luna/pc/discover')
    signal.throwIfAborted()
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  const pending = catalog.home()
  parent.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

// Response limits and error envelopes must be enforced before content reaches MyGO.
test('bounds catalog responses and classifies server rejection without raw payloads', async () => {
  await assert.rejects(requestJSON(session, '/luna/pc/me/playlist', {}, { fetch: async () => new Response('x'.repeat(1048577)) }), e => e.kind === 'response')
  await assert.rejects(requestJSON(session, '/luna/pc/me/playlist', {}, { fetch: async () => wire({ error_code: 7, message: 'private upstream text' }) }), e => e.kind === 'rateLimit' && !e.message.includes('private'))
})
