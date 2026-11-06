import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Catalog, requestJSON } from '../helper/catalog.mjs'
import { feedBody, feedPreference, modesOf } from '../helper/discovery.mjs'

const session = { version: 1, deviceID: '1234567890123456', installID: '123456789012345', cookies: [{ name: 'sessionid', value: 'fixture-session' }] }
const scene = (value, text = '放松') => ({ type: 'scene_mode', text, url_info: { urls: ['https://p3-luna.douyinpic.com/img/'], uri: 'scene-cover' }, entity: { feed_scene_mode: value } })
const track = id => ({ type: 'track', entity: { track_wrapper: { track: { id, name: '推荐歌曲', duration: 181234 } } } })

// Grouped listening modes retain explicit scene zero and deduplicate official preference entries.
test('loads signed grouped modes without conflating scene zero and absent IDs', async () => {
  const catalog = new Catalog(session, { request: async (_, path, options) => {
    assert.equal(path, '/luna/pc/feed/mode')
    assert.equal(options.signed, true)
    assert.deepEqual(options.body, {})
    return { feed_mode_block: [
      { title: '心情', feed_mode: [scene({ scene_mode_id: 0, sub_queue_type: 'relax' }), scene({ sub_queue_type: 'fresh' }), { type: 'advertisement' }] },
      { title: '场景', feed_mode: [scene({ scene_mode_id: 0 }), scene({ scene_mode_id: '42' }), scene({ sub_queue_type: 'custom:focus' })] },
    ] }
  } })
  const modes = await catalog.listeningModes()
  assert.deepEqual(modes.map(mode => mode.id), ['preference:familiar', 'preference:fresh', 'scene:0', 'scene:42', 'preference:custom%3Afocus'])
  assert.equal(modes.find(mode => mode.id === 'scene:0').group, '心情')
  assert.match(modes[2].imageUrl, /^https:\/\/p3-luna\.douyinpic\.com\/img\/scene-cover/)
  assert.deepEqual(feedPreference(modes[4].id), { preference_mode: 'custom:focus' })
})

// A malformed mode response must not silently become a fabricated familiar/fresh-only catalog.
test('rejects missing mode groups and invalid scene identities', () => {
  for (const value of [null, {}, { feed_mode_block: null }, { feed_mode_block: [{}] }, { feed_mode_block: [{ title: '组', feed_mode: [scene({})] }] }, { feed_mode_block: [{ title: '组', feed_mode: [scene({ scene_mode_id: -1 })] }] }, { feed_mode_block: [{ title: '组', feed_mode: [scene({ scene_mode_id: Number.MAX_SAFE_INTEGER + 1 })] }] }]) {
    assert.throws(() => modesOf(value, () => undefined), { kind: 'response' })
  }
  for (const id of ['scene:-1', 'scene:00', 'scene:1.5', 'scene:9223372036854775808', 'preference:', 'preference:%', 'preference:%66resh']) assert.throws(() => feedPreference(id), { kind: 'response' })
  assert.throws(() => feedPreference('unknown'), { kind: 'unsupported' })
  assert.equal(modesOf({ feed_mode_block: [] }, () => undefined).length, 2)
})

// Familiar/fresh preferences and numbered scenes use distinct official fields and never leak device-first-use data.
test('builds feed lifecycle and pending-media feedback with correct units', () => {
  const input = { count: 3, firstDeviceRequest: true, firstUseTime: 1700000000, played: [{ id: '92233720368547758080001', duration: 181234 }] }
  const ordinary = feedBody(input)
  assert.equal(ordinary.is_first_request, false)
  assert.equal(ordinary.is_did_first_request, true)
  assert.equal(ordinary.did_first_use_time, input.firstUseTime)
  assert.equal(ordinary.feed_counts.mix_session_count, 3)
  assert.deepEqual(ordinary.played_media, [{ type: 'track', media_id: '92233720368547758080001', duration: 181, played_mills: -1 }])
  assert.equal(ordinary.feed_preference, undefined)
  for (const [id, preference] of [['preference:familiar', { preference_mode: 'familiar' }], ['preference:fresh', { preference_mode: 'fresh' }], ['scene:0', { scene_mode_id: 0 }], ['scene:42', { scene_mode_id: 42 }]]) {
    const body = feedBody({ ...input, id, count: 1 })
    assert.deepEqual(body.feed_preference, preference)
    assert.equal(body.is_first_request, true)
    assert.equal(body.is_did_first_request, false)
    assert.equal(body.did_first_use_time, undefined)
  }
})

// Invalid counters and media feedback must fail before signing or contacting the API.
test('bounds recommendation request metadata before dispatch', () => {
  for (const input of [{ count: 0 }, { count: 1.5 }, { firstDeviceRequest: 1 }, { firstUseTime: -1 }, { played: Array(31).fill({ id: '1', duration: 1000 }) }, { played: [{ id: '', duration: 1000 }] }, { played: [{ id: '1', duration: -1 }] }]) assert.throws(() => feedBody(input), { kind: 'response' })
})

// The actual signed transport must bind exact feed body bytes, including an int64 scene ID without rounding.
test('signs precise recommendation bodies and preserves large scene and track IDs', async () => {
  let signed
  const catalog = new Catalog(session, { request: (session, path, options) => requestJSON(session, path, options, {
    sign: async spec => { signed = spec; return { 'x-helios': 'fixture-helios', 'x-medusa': 'fixture-medusa' } },
    fetch: async (url, options) => {
      assert.equal(new URL(url).pathname, '/luna/pc/feed/song-tab')
      assert.equal(url, signed.url)
      assert.equal(new URL(url).searchParams.get('device_platform'), 'mac')
      assert.equal(options.method, 'POST')
      assert.equal(options.redirect, 'error')
      assert.match(options.body, /"scene_mode_id":9223372036854775807/)
      assert.equal(options.headers.Cookie, ['sessionid', 'fixture-session'].join('='))
      assert.equal(options.headers['x-helios'], 'fixture-helios')
      return new Response('{"items":[{"type":"video"}, {"type":"track","entity":{"track_wrapper":{"track":{"id":92233720368547758080001,"duration":181234}}}}, {"type":"track","entity":{"track_wrapper":{"track":{"id":"92233720368547758080001","duration":181234}}}}]}')
    },
  }) })
  const tracks = await catalog.recommendationBatch({ id: 'scene:9223372036854775807' })
  assert.deepEqual(tracks.map(track => track.id), ['92233720368547758080001'])
  assert.equal(tracks[0].duration, 181234)
})

// Missing or malformed recommendation tracks must fail while legitimate empty batches remain empty.
test('rejects malformed feed envelopes and deduplicates real track wrappers', async () => {
  for (const response of [{}, { items: null }, { items: 'bad' }, { items: [null] }, { items: [{ type: 'track', entity: {} }] }]) {
    const catalog = new Catalog(session, { request: async () => response })
    await assert.rejects(catalog.recommendationBatch(), { kind: 'response' })
  }
  const catalog = new Catalog(session, { request: async () => ({ items: [track('1'), track('1'), { type: 'video' }, track('2')] }) })
  assert.deepEqual((await catalog.recommendationBatch()).map(track => track.id), ['1', '2'])
  const empty = new Catalog(session, { request: async () => ({ items: [] }) })
  assert.deepEqual(await empty.recommendationBatch(), [])
})
