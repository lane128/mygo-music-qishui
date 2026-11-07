import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sandbox, session, profile, qrReply, confirmedReply, profileReply, json, until } from './fixtures/plugin-sandbox.mjs'
import { catalogService, paths, track, resource, playlist, search, feed, modes, discovery, assertSigner, stale } from './fixtures/catalog-service.mjs'
import { grant } from './fixtures/grant.mjs'

// These APIs map remote JSON in the standalone sandbox without a process capability.
test('loads playlists, regular playlist tracks, search cursors and public lyrics without spawn', async () => {
  const service = catalogService({
    playlists: [{ playlists: [{ id: '123', title: 'Fixture Playlist', count_tracks: 1 }] }],
    playlist: [playlist('123', [track('7123456789012345678')])],
    search: [search([track('1')], 'opaque', true), search([track('2')])],
    lyrics: [{ seo_track: { track: track('123') }, lyric: { content: '[1000,2000]<0,1000,0>歌词' } }],
  })
  const s = await sandbox([], session, { allowSpawn: false, request: service.request })
  const lists = await s.api.playlists()
  assert.equal(lists[0].id, '123')
  assert.ok(lists.some(list => list.id === 'qishui:history'))
  assert.equal((await s.api.playlist({ id: '123' })).tracks[0].id, '7123456789012345678')
  assert.equal((await s.api.search({ query: '音乐' })).tracks[0].id, '1')
  assert.equal((await s.api.search({ query: '音乐', offset: 1 })).tracks[0].id, '2')
  assert.equal(service.for('search')[1].parsed.searchParams.get('cursor'), 'opaque')
  assert.equal(service.for('search')[0].parsed.searchParams.get('device_platform'), 'android')
  assert.equal((await s.api.lyrics({ id: '123' })).lrc, '[00:01.00]歌词')
  await assert.rejects(s.api.search({ query: '音乐', kind: 'albums' }), error => error.code === 'unsupported')
  assert.equal(service.for('search').length, 2)
  assert.equal(s.spawned(), 0)
  await s.api.signOut()
})

test('loads music after login without settings and keeps stream URLs alive until sign-out', async () => {
  const service = catalogService({ discover: [discovery(['123'], { type: 'playlist' })] })
  const audio = { url: 'http://127.0.0.1:12345/private', type: 'flac', quality: 'high' }
  const s = await sandbox([[{ ok: true, result: audio }]], session, { sign: true, request: service.request })
  assert.equal((await s.api.home()).sections[0].playlists[0].id, '123')
  assertSigner(s.calls[0], 'discover', session)
  assert.equal(s.closed(), 1)
  assert.equal((await s.api.stream({ id: '123', quality: 'high' })).url, audio.url)
  assert.equal(s.calls[1].method, 'sign')
  assert.equal(new URL(s.calls[1].params.url).pathname, '/luna/pc/track_v2')
  assert.equal(s.calls[2].method, 'stream')
  assert.equal(s.calls[2].session.deviceID, session.deviceID)
  assert.equal(s.calls[2].session.cookies, undefined)
  assert.equal(s.calls[2].params.grant.track.id, '123')
  assert.equal(s.closed(), 1)
  await s.api.signOut()
  assert.equal(s.closed(), 2)
  await assert.rejects(s.api.home(), error => error.code === 'signIn')
})

// Playback authorization stays in MyGO; native audio receives only this grant and anonymous client metadata.
test('fetches the signed playback grant in the sandbox before passing it to native audio', async () => {
  const id = '7123456789012345678'
  let authorized
  const audio = { ok: true, result: { url: 'http://127.0.0.1:12345/fixture', type: 'mp3', quality: 'high' } }
  const s = await sandbox([[audio]], { ...session, account: { id: 'fixture-account' } }, { request: async (url, options) => {
    authorized = { url, options }
    assert.equal(new URL(url).pathname, '/luna/pc/track_v2')
    assert.equal(JSON.parse(options.body).track_id, id)
    assert.equal(options.headers['x-helios'], 'fixture-helios')
    assert.ok(options.headers.Cookie)
    assert.equal(options.redirect, 'error')
    return json(grant(id))
  } })
  try {
    assert.equal((await s.api.stream({ id })).type, 'mp3')
    const [signing, playing] = s.calls
    assert.equal(signing.method, 'sign')
    assert.equal(signing.params.url, authorized.url)
    assert.equal(signing.params.headerLines, Object.entries(signing.params.headers).flat().join('\r\n'))
    assert.equal(signing.params.headers['x-ss-stub'], authorized.options.headers['X-SS-STUB'])
    assert.equal(playing.method, 'stream')
    assert.equal(playing.params.grant.track.id, id)
    for (const call of s.calls) assert.deepEqual(Object.keys(call.session).sort(), ['deviceID', 'installID', 'version'])
    assert.equal(s.spawned(), 1)
  } finally { await s.api.signOut() }
})

// A refused API grant cannot be turned into a native download request.
test('does not start audio processing when the sandbox playback grant is rejected', async () => {
  const s = await sandbox([], session, { request: async () => json({}, [], 403) })
  try {
    await assert.rejects(s.api.stream({ id: '123' }), /拒绝/)
    assert.deepEqual(s.calls.map(call => call.method), ['sign'])
    assert.equal(s.closed(), 1)
  } finally { await s.api.signOut() }
})

// Sign-out must cancel the new sandbox playback HTTP request, not only the native child.
test('sign-out aborts an in-flight playback grant and never passes it to native audio', async () => {
  let signal
  const s = await sandbox([], session, { request: (url, options) => {
    signal = options.signal
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('fixture canceled')), { once: true }))
  } })
  const playing = s.api.stream({ id: '123' }), rejected = assert.rejects(playing, stale)
  await until(() => signal)
  await s.api.signOut()
  await rejected
  assert.equal(signal.aborted, true)
  assert.deepEqual(s.calls.map(call => call.method), ['sign'])
  assert.equal(s.closed(), 1)
})

test('rejects a successful audio response delivered after the helper deadline', async () => {
  let deadline, finish
  const pending = new Promise(resolve => { finish = resolve })
  const s = await sandbox([[() => pending]], session, { timer: (callback, ms) => {
    if (ms === 24000) deadline = callback
    return 0
  } })
  const playing = s.api.stream({ id: '123' })
  const rejected = assert.rejects(playing, /取消/)
  await until(() => s.calls.some(call => call.method === 'stream'))
  assert.equal(typeof deadline, 'function')
  deadline()
  finish(JSON.stringify({ ok: true, result: { url: 'http://127.0.0.1:12345/expired', type: 'mp3' } }))
  await rejected
  assert.equal(s.closed(), 1)
  await s.api.signOut()
  assert.equal(s.closed(), 1, 'expired helper must not be retained')
})

test('loads exploration home and rejects stale account replies', async () => {
  let finish
  const waiting = new Promise(resolve => { finish = resolve })
  const frame = discovery(['42'])
  const service = catalogService({ discover: [frame, () => waiting] })
  const s = await sandbox([], session, { sign: true, request: service.request })
  const result = await s.api.home()
  assert.equal(result.sections[0].stations[0].id, 'radio:42')
  assert.equal(result.sections[0].morePage, 'listening-modes')
  assertSigner(s.calls[0], 'discover', session)
  const pending = s.api.home(), rejected = assert.rejects(pending, stale)
  await until(() => service.calls.length === 2)
  await s.api.signOut()
  finish(frame) // Ignore abort at the fake network boundary to exercise the generation guard too.
  await rejected
  await assert.rejects(s.api.home(), error => error.code === 'signIn')
  assert.equal(s.spawned(), 2)
})

test('routes history lists and invalidates pending results on sign-out', async () => {
  let finish
  const waiting = new Promise(resolve => { finish = resolve })
  const frame = { media: [resource(track('123'))], has_more: false }
  const service = catalogService({ history: [frame, () => waiting, { media: 'malformed', has_more: false }] })
  const s = await sandbox([], session, { sign: true, request: service.request })
  assert.equal((await s.api.playlist({ id: 'qishui:history' })).tracks[0].id, '123')
  assertSigner(s.calls[0], 'history', session)
  const request = service.calls[0]
  assert.equal(request.parsed.searchParams.get('count'), '1000')
  assert.equal(request.parsed.searchParams.get('cursor'), '')
  assert.equal(request.options.headers['X-Luna-Is-Local-User'], '1')
  assert.equal(request.options.body, undefined)
  const pending = s.api.playlist({ id: 'qishui:history' }), rejected = assert.rejects(pending, stale)
  await until(() => service.calls.length === 2)
  await s.api.signOut()
  finish(frame)
  await rejected
  s.state.set('session', session)
  await assert.rejects(s.api.playlist({ id: 'qishui:history' }), error => /播放历史/.test(error.message))
  await s.api.signOut()
})

// Background prefetch must not make a new stream wait behind another song's budget.
test('resolves concurrent streams independently and bounds retained audio helpers', async () => {
  let first, second
  const waitingFirst = new Promise(resolve => { first = resolve })
  const waitingSecond = new Promise(resolve => { second = resolve })
  const frame = { ok: true, result: { url: 'http://127.0.0.1:12345/fixture', type: 'mp3', quality: 'high' } }
  const s = await sandbox([[() => waitingFirst], [() => waitingSecond], [frame], [frame], [frame]], session)
  const a = s.api.stream({ id: '1' }), b = s.api.stream({ id: '2' })
  await until(() => s.calls.filter(call => call.method === 'stream').length === 2)
  assert.deepEqual(s.calls.filter(call => call.method === 'stream').map(call => call.params.grant.track.id), ['1', '2'])
  second(JSON.stringify(frame))
  assert.equal((await b).type, 'mp3')
  first(JSON.stringify(frame))
  await a
  for (const id of ['3', '4', '5']) await s.api.stream({ id })
  assert.equal(s.closed(), 1, 'only the oldest completed helper is evicted')
  await s.api.signOut()
  assert.equal(s.closed(), 5)
})

test('maps stream entitlement failures to unavailable', async () => {
  const s = await sandbox([[{ ok: false, error: 'preview' }]], session)
  await assert.rejects(s.api.stream({ id: '3' }), error => error.code === 'unavailable')
  await s.api.signOut()
})

test('replacement login invalidates music started during QR confirmation', async () => {
  let confirm, finishAudio
  const confirmation = new Promise(resolve => { confirm = resolve })
  const audio = new Promise(resolve => { finishAudio = resolve })
  const s = await sandbox([[() => audio]], { ...session, account: { id: '1', name: 'Account A' } }, { replies: [qrReply(), () => confirmation, profileReply()] })
  const signing = s.api.signIn()
  await until(() => s.authCalls.length === 2)
  const playing = s.api.stream({ id: '123' }), rejected = assert.rejects(playing, stale)
  await until(() => s.calls.some(call => call.method === 'stream'))
  assert.equal(s.calls[0].session.account, undefined)
  assert.equal(s.calls[0].session.cookies, undefined)
  confirm(confirmedReply())
  await signing
  assert.equal(s.state.get('session').account.id, profile.id)
  finishAudio(JSON.stringify({ ok: true, result: { url: 'http://127.0.0.1/old-account', type: 'mp3' } }))
  await rejected
  assert.equal(s.closed(), 1)
})

test('discards in-flight catalog results after sign-out', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const service = catalogService({ playlist: [() => pending] })
  const s = await sandbox([], session, { allowSpawn: false, request: service.request })
  const loading = s.api.playlist({ id: '123' }), rejected = assert.rejects(loading, stale)
  await until(() => service.calls.length === 1)
  await s.api.signOut()
  finish(playlist('123', [track('old-account')]))
  await rejected
  assert.equal(s.spawned(), 0)
})

test('a stale account check cannot discard newly signed-in credentials', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const s = await sandbox([], session, { replies: [() => pending, qrReply(), confirmedReply(), profileReply()] })
  const checking = s.api.account()
  await s.api.signIn()
  finish(json({}, [], 401))
  assert.equal(await checking, null)
  assert.equal(s.state.get('session').account.id, profile.id)
})

// Failed attempts consume counters. Offered tracks remain pending feedback, bounded to the latest 30.
test('continues recommendation and mode batches with independent lifecycle and bounded pending tracks', async () => {
  const tracks = Array.from({ length: 35 }, (_, i) => track(i, 181234))
  const service = catalogService({ feed: [
    feed([...tracks, tracks[34]]), () => { throw Error('synthetic network failure') }, feed([track('35', 200000)]),
    feed([track('mode')]), feed(),
  ] })
  const s = await sandbox([], session, { sign: true, request: service.request })
  assert.equal((await s.api.stationNext({ id: 'recommendations' })).length, 35, 'duplicate remote tracks are mapped once')
  await assert.rejects(s.api.stationNext({ id: 'recommendations' }))
  await s.api.stationNext({ id: 'recommendations' })
  await s.api.stationNext({ id: 'scene:0' })
  await s.api.stationNext({ id: 'preference:fresh' })
  const bodies = service.calls.map(call => call.body)
  assert.equal(bodies[0].feed_counts.mix_session_count, 1)
  assert.equal(bodies[0].is_first_request, true)
  assert.equal(bodies[0].is_did_first_request, true)
  assert.ok(bodies[0].did_first_use_time > 0)
  assert.equal(bodies[1].feed_counts.mix_session_count, 2)
  assert.equal(bodies[1].is_first_request, false)
  assert.equal(bodies[1].played_media.length, 30)
  assert.deepEqual(bodies[1].played_media[0], { type: 'track', media_id: '5', duration: 181, played_mills: -1 })
  assert.ok(bodies[1].played_media.every(media => media.played_mills === -1))
  assert.equal(bodies[1].is_did_first_request, false)
  assert.equal(bodies[2].feed_counts.mix_session_count, 3)
  assert.deepEqual(bodies[2].played_media, bodies[1].played_media)
  assert.equal(bodies[2].did_first_use_time, bodies[0].did_first_use_time)
  for (const body of bodies.slice(3)) {
    assert.equal(body.feed_counts.mix_session_count, 1)
    assert.deepEqual(body.played_media, [])
    assert.equal(body.did_first_use_time, undefined)
    assert.equal(body.is_did_first_request, false)
  }
  assert.deepEqual(bodies[3].feed_preference, { scene_mode_id: 0 })
  assert.deepEqual(bodies[4].feed_preference, { preference_mode: 'fresh' })
  for (const call of s.calls) assertSigner(call, 'feed', session)
  await s.api.signOut()
  assert.equal(s.closed(), 5)
})

test('coalesces only concurrent requests for the same station', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const frame = feed([track('1')])
  const service = catalogService({ feed: [() => pending, frame, frame] })
  const s = await sandbox([], session, { sign: true, request: service.request })
  const first = s.api.stationNext({ id: 'recommendations' }), same = s.api.stationNext({ id: 'recommendations' })
  assert.equal((await s.api.stationNext({ id: 'preference:fresh' }))[0].id, '1')
  assert.equal(service.calls.length, 2)
  finish(frame)
  assert.equal((await first)[0].id, '1')
  assert.equal((await same)[0].id, '1')
  await s.api.stationNext({ id: 'recommendations' })
  assert.equal(service.calls[2].body.feed_counts.mix_session_count, 2)
  await s.api.signOut()
})

test('recommendation previews and all-mode navigation remain reachable without action or category cards', async () => {
  const service = catalogService({ feed: [feed([track('1')]), feed([track('2')])], modes: [modes(9), modes(9), modes(9)], discover: [discovery(['42'], { more: false })] })
  const s = await sandbox([], session, { sign: true, request: service.request })
  const first = await s.api.browse({ page: 'recommendations' })
  const next = await s.api.browse({ page: first.sections[0].morePage })
  assert.equal(first.sections[0].tracks[0].id, '1')
  assert.equal(next.sections[0].tracks[0].id, '2')
  assert.notEqual(first.sections[0].morePage, next.sections[0].morePage)
  assert.ok(first.sections.every(section => !section.links && !section.stations))
  const page = await s.api.browse({ page: 'listening-modes' })
  assert.equal(page.sections[0].morePage, 'scene-modes')
  assert.equal(page.sections[1].stations[0].id, 'radio:42')
  const all = await s.api.browse({ page: page.sections[0].morePage })
  assert.equal(all.sections.flatMap(section => section.stations || []).find(mode => mode.id === 'scene:0').name, 'Fixture Mode 0')
  assert.equal(service.for('modes').length, 2)
  assert.equal(service.for('discover').length, 1)
  const stations = await s.api.stations()
  assert.deepEqual(Array.from(stations, mode => mode.id), ['recommendations', 'preference:familiar', 'preference:fresh'])
  await assert.rejects(s.api.browse({ page: 'unsupported' }), error => error.code === 'unsupported')
  await s.api.signOut()
})

// A bottom link owns its exposure/cursor snapshot through concurrent clicks, caching, and retries.
test('coalesces exploration continuation and retries without skipping an exposure state', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const service = catalogService({
    modes: [modes()], discover: [discovery(['42'], { cursor: 'root-cursor', sessionID: 'synthetic-discovery' })],
    mix: [() => pending, () => { throw Error('fixture network') }, discovery(['44'], { initial: false, more: false })],
  })
  const s = await sandbox([], session, { sign: true, request: service.request })
  const landing = await s.api.browse({ page: 'listening-modes' })
  const route = landing.sections.at(-1).links[0].page
  assert.match(route, /^listening-modes:more:\d+$/)
  assert.equal(landing.sections[1].stations[0].id, 'radio:42')
  assert.equal(landing.sections[1].morePage, undefined)
  assert.equal(landing.sections.length, 3)
  const a = s.api.browse({ page: route }), b = s.api.browse({ page: route })
  await until(() => service.for('mix').length === 1)
  assert.deepEqual(service.for('mix')[0].body, { block_type: 'discover_playlist_mix', sub_channel_id: -2, exposure_radio_list: ['42'], cursor: 'root-cursor', session_id: 'synthetic-discovery' })
  finish(discovery(['43'], { initial: false, cursor: 'next-cursor' }))
  const [first, same] = await Promise.all([a, b])
  assert.equal(first, same)
  assert.equal(await s.api.browse({ page: route }), first)
  assert.equal(service.for('mix').length, 1)
  assert.equal(first.sections[0].stations[0].id, 'radio:43')
  assert.equal(first.sections[0].morePage, undefined)
  assert.equal(first.sections.length, 2)
  const more = first.sections.at(-1).links[0].page
  assert.notEqual(more, route)
  await assert.rejects(s.api.browse({ page: more }))
  const final = await s.api.browse({ page: more })
  assert.equal(final.sections[0].stations[0].id, 'radio:44')
  assert.equal(final.sections[0].morePage, undefined)
  assert.equal(final.sections.length, 1)
  assert.ok(final.sections.every(section => !section.links))
  assert.deepEqual(service.for('mix')[1].body, service.for('mix')[2].body)
  assert.deepEqual(service.for('mix')[2].body.exposure_radio_list, ['42', '43'])
  assert.equal(service.for('mix')[2].body.cursor, 'next-cursor')
  for (const call of s.calls.filter(call => new URL(call.params.url).pathname === paths.mix)) assertSigner(call, 'mix', session)
  await s.api.signOut()
  await assert.rejects(s.api.browse({ page: route }), error => error.code === 'unsupported')
})

test('sign-out discards pending exploration pages and continuation tokens', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const service = catalogService({ modes: [modes()], discover: [discovery(['42'])], mix: [() => pending] })
  const s = await sandbox([], session, { sign: true, request: service.request })
  const first = await s.api.browse({ page: 'listening-modes' })
  const route = first.sections.at(-1).links[0].page
  const loading = s.api.browse({ page: route }), rejected = assert.rejects(loading, stale)
  await until(() => service.for('mix').length === 1)
  await s.api.signOut()
  finish(discovery(['43'], { initial: false }))
  await rejected
  await assert.rejects(s.api.browse({ page: route }), error => error.code === 'unsupported')
})

test('continues discovery radios independently from ordinary scene feeds', async () => {
  const service = catalogService({ radio: [feed([track('1')], { next_cursor: 'opaque-radio', has_more: true }), feed([track('2')], { has_more: false })], feed: [feed([track('3')])] })
  const s = await sandbox([], session, { sign: true, request: service.request })
  await s.api.stationNext({ id: 'radio:42' })
  await s.api.stationNext({ id: 'radio:42' })
  assert.deepEqual(Array.from(await s.api.stationNext({ id: 'radio:42' })), [])
  assert.equal(service.calls.length, 2)
  assert.deepEqual(service.for('radio')[0].body, { radio_id: '42', count: 6, cursor: '' })
  assert.equal(service.for('radio')[1].body.cursor, 'opaque-radio')
  assertSigner(s.calls[0], 'radio', session)
  await s.api.stationNext({ id: 'scene:0' })
  assertSigner(s.calls[2], 'feed', session)
  assert.equal(service.for('feed')[0].body.cursor, undefined)
  assert.deepEqual(service.for('feed')[0].body.feed_preference, { scene_mode_id: 0 })
  await s.api.signOut()
})

test('keeps radio continuation alive after an empty filtered batch', async () => {
  const service = catalogService({ radio: [
    { items: [{ type: 'video', entity: { video: { id: 'video' } } }], next_cursor: 'after-video', has_more: true },
    feed([track('song')], { has_more: false }),
  ] })
  const s = await sandbox([], session, { sign: true, request: service.request })
  assert.equal((await s.api.stationNext({ id: 'radio:42' })).length, 0)
  assert.equal((await s.api.stationNext({ id: 'radio:42' }))[0].id, 'song')
  assert.equal(service.calls[1].body.cursor, 'after-video')
  assert.equal(service.calls[1].body.count, 6)
  assert.equal((await s.api.stationNext({ id: 'radio:42' })).length, 0)
  assert.equal(service.calls.length, 2)
  await s.api.signOut()
})

test('replacement login invalidates pending feeds and resets continuation for the new device', async () => {
  let finish, confirm
  const pending = new Promise(resolve => { finish = resolve })
  const confirmation = new Promise(resolve => { confirm = resolve })
  const service = catalogService({ feed: [() => pending, feed()] })
  const s = await sandbox([], session, { sign: true, request: service.request, replies: [qrReply(), () => confirmation, profileReply()] })
  const signing = s.api.signIn()
  await until(() => s.authCalls.length === 2)
  const old = s.api.stationNext({ id: 'recommendations' }), rejected = assert.rejects(old, stale)
  await until(() => service.calls.length === 1)
  confirm(confirmedReply())
  await signing
  finish(feed([track('old')]))
  await rejected
  await s.api.stationNext({ id: 'recommendations' })
  const saved = s.state.get('session'), latest = service.calls.at(-1)
  assertSigner(s.calls.at(-1), 'feed', saved)
  assert.equal(latest.parsed.searchParams.get('device_id'), saved.deviceID)
  assert.notEqual(saved.deviceID, session.deviceID)
  assert.equal(latest.body.feed_counts.mix_session_count, 1)
  assert.equal(latest.body.is_did_first_request, true)
  assert.deepEqual(latest.body.played_media, [])
  await s.api.signOut()
})

test('invalid account restoration invalidates pending station results', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const service = catalogService({ feed: [() => pending] })
  const s = await sandbox([], session, { sign: true, request: service.request, replies: [json({}, [], 401)] })
  const next = s.api.stationNext({ id: 'scene:0' }), rejected = assert.rejects(next, stale)
  await until(() => service.calls.length === 1)
  assert.equal(await s.api.account(), null)
  finish(feed([track('old')]))
  await rejected
  await assert.rejects(s.api.stationNext({ id: 'scene:0' }), error => error.code === 'signIn')
})
