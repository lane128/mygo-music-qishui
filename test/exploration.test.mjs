import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoveryOf, discoveryBody, discoveryState } from '../helper/exploration.mjs'
import { Catalog, requestJSON } from '../helper/catalog.mjs'

const session = { version: 1, deviceID: '1234567890123456', installID: '123456789012345', cookies: [{ name: 'sessionid', value: 'fixture-session' }] }
const card = (id, type = 'radio', blockID = id) => ({ type: type === 'radio' ? 'discover_radio' : 'discover_playlist', inner_block_id: blockID, resources: [{ resource_id: id, type, style: { title: `音乐 ${id}`, desc: '发现音乐', cover_url_list: ['https://example.invalid/cover.jpg'] } }] })
const options = { cover: raw => raw }
const track = id => ({ type: 'track', entity: { track_wrapper: { track: { id, duration: 180000, name: '歌曲' } } } })

// A real view envelope contains mixed resource types; IDs and provider photos must survive without category fabrication.
test('maps separate discovery view and mix envelopes while retaining resource identities and pictures', () => {
  const first = discoveryOf({ blocks: [{ type: 'discover_playlist_mix', inner_block: [card('9223372036854775807'), card('73', 'playlist')] }] }, { ...options, initial: true })
  assert.equal(first.items[0].item.id, 'radio:9223372036854775807')
  assert.equal(first.items[1].type, 'playlist')
  assert.equal(first.items[1].item.id, '73')
  assert.equal(first.items[0].item.imageUrl, 'https://example.invalid/cover.jpg')
  assert.equal(first.more, true)
  const second = discoveryOf({ inner_block: [card('9223372036854775807'), card('74'), card('74')], has_more: true, next_cursor: 'opaque:next', session_id: 'public-discovery-session' }, { ...options, state: first.state })
  assert.deepEqual(second.items.map(entry => entry.item.id), ['radio:74'])
  assert.deepEqual(discoveryBody(second.state), { block_type: 'discover_playlist_mix', sub_channel_id: -2, exposure_radio_list: ['9223372036854775807', '73', '74'], cursor: 'opaque:next', session_id: 'public-discovery-session' })
})

// Repeats, final pages and unknown future resource kinds must not produce endless empty continuation links.
test('stops repeated or terminal feeds and bounds exposure history without dropping continuation context', () => {
  const state = { exposure: ['1'], cursor: 'opaque', sessionID: 'context' }
  const repeated = discoveryOf({ inner_block: [card('1')], has_more: true }, { ...options, state })
  assert.equal(repeated.more, false)
  assert.deepEqual(repeated.items, [])
  assert.equal(repeated.state.cursor, 'opaque')
  assert.equal(repeated.state.sessionID, 'context')
  const last = discoveryOf({ inner_block: [card('2')], has_more: false }, { ...options, state })
  assert.equal(last.items.length, 1)
  assert.equal(last.more, false)
  const bounded = discoveryOf({ inner_block: [card('new')], has_more: true }, { ...options, state: { exposure: Array.from({ length: 256 }, (_, i) => String(i)) } })
  assert.equal(bounded.state.exposure.length, 256)
  assert.equal(bounded.state.exposure.at(-1), 'new')
  assert.equal(discoveryOf({ inner_block: [{ type: 'future_kind' }], has_more: true }, options).more, false)
})

// Invalid response identities or shapes fail before the host displays a wrong card or dispatches an invalid next request.
test('rejects malformed discovery responses and oversized continuation state', () => {
  for (const value of [null, {}, { inner_block: [], has_more: 'yes' }, { inner_block: [null], has_more: true }, { inner_block: [card(Number.MAX_SAFE_INTEGER + 1)], has_more: true }, { inner_block: [{ ...card('1'), resources: [] }], has_more: true }, { inner_block: [{ ...card('1'), resources: [{ type: 'radio', resource_id: '1', style: { title: null } }] }], has_more: true }]) assert.throws(() => discoveryOf(value, options), { kind: 'response' })
  for (const state of [{ exposure: Array(257).fill('1') }, { exposure: 'wrong' }, { cursor: 123 }, { cursor: 'x'.repeat(8193) }, { sessionID: {} }, { exposure: ['bad\nvalue'] }]) assert.throws(() => discoveryState(state), { kind: 'response' })
})

test('restores legacy radio resource IDs verbatim instead of URL-decoding saved queues', async () => {
  const ids = ['mix/42', 'mix 42', 'mix%42', 'mix%2F42', 'mix%XX', 'mix?42', 'mix??42', '42?flow_type=3&trigger_info=artist-a', 'mix?flow_type=oops', 'mix?%XX', '?' + 'x'.repeat(511), 'x'.repeat(512)]
  const bodies = []
  const catalog = new Catalog(session, { request: async (_, path, options) => {
    bodies.push(options.body)
    return { items: [track('1')], has_more: false }
  } })
  for (const id of ids) await catalog.radioBatch({ id: 'radio:' + id })
  assert.deepEqual(bodies.map(body => body.radio_id), ids)
  assert.ok(bodies.every(body => body.flow_type === 2 && body.trigger_info === ''))
  for (const id of ['', ' ', 'bad\nvalue', 'x'.repeat(513)]) await assert.rejects(catalog.radioBatch({ id: 'radio:' + id }), { kind: 'response' })
  assert.equal(bodies.length, ids.length)
})

test('newly discovered default radios keep raw percent and slash IDs compatible with saved legacy queues', async () => {
  for (const id of ['mix/42', 'mix 42', 'mix%42', 'mix%2F42', 'mix?42', '42?flow_type=3&trigger_info=artist-a']) {
    const page = discoveryOf({ inner_block: [card(id)], has_more: false }, options)
    assert.equal(page.items[0].item.id, 'radio:' + id)
    let requested
    const catalog = new Catalog(session, { request: async (_, path, options) => {
      requested = options.body.radio_id
      return { items: [], has_more: false }
    } })
    await catalog.radioBatch({ id: page.items[0].item.id })
    assert.equal(requested, id)
  }
})

for (const type of ['playlist', 'radio']) test(`ignores incomplete duplicate ${type} display metadata after a valid resource`, () => {
  for (const style of [undefined, null, { title: null }, { title: 'duplicate', cover_url_list: 'wrong' }]) {
    const first = card('42', type, 'first'), duplicate = card('42', type, 'duplicate')
    duplicate.resources[0].style = style
    const result = discoveryOf({ inner_block: [first, duplicate], has_more: false }, options)
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].item.name, '音乐 42')
    assert.deepEqual(result.state.exposure, ['first', 'duplicate'])
    assert.throws(() => discoveryOf({ inner_block: [duplicate], has_more: false }, options), { kind: 'response' })
  }
})

test('duplicate themed radios need only their selection fields before display validation', () => {
  const first = card('42', 'radio', 'first')
  first.resources[0].style.link = 'luna://radio?flow_type=1&trigger_info=artist-a'
  const duplicate = card('42', 'radio', 'duplicate')
  duplicate.resources[0].style = { link: 'luna://radio?flow_type=1&trigger_info=artist-a' }
  assert.equal(discoveryOf({ inner_block: [first, duplicate], has_more: false }, options).items.length, 1)
  duplicate.resources[0].style.link = 'luna://radio?flow_type=1&trigger_info=artist-b'
  assert.throws(() => discoveryOf({ inner_block: [first, duplicate], has_more: false }, options), { kind: 'response' })
})

test('keeps a literal legacy query ID distinct from a themed station', async () => {
  const legacyID = '42?flow_type=3&trigger_info=artist-a'
  const themed = card('42')
  themed.resources[0].style.link = 'luna://radio?flow_type=3&trigger_info=artist-a'
  const page = discoveryOf({ inner_block: [themed, card(legacyID, 'radio', 'legacy')], has_more: false }, options)
  assert.deepEqual(page.items.map(entry => entry.item.id), ['radio-theme:v1:42?flow_type=3&trigger_info=artist-a', 'radio:' + legacyID])
  const bodies = []
  const catalog = new Catalog(session, { request: async (_, path, options) => {
    bodies.push(options.body)
    return { items: [], has_more: false }
  } })
  for (const entry of page.items) await catalog.radioBatch({ id: entry.item.id })
  assert.deepEqual(bodies, [
    { radio_id: '42', flow_type: 3, trigger_info: 'artist-a', cursor: '' },
    { radio_id: legacyID, flow_type: 2, trigger_info: '', cursor: '' },
  ])
})

test('round-trips encoded radio identities with explicit theme selectors', async () => {
  for (const id of ['mix/42', 'mix 42', 'mix%42', 'mix%2F42', 'mix?42']) {
    const item = card(id)
    item.resources[0].style.link = 'luna://radio?flow_type=1&trigger_info=artist%2Fa'
    const page = discoveryOf({ inner_block: [item], has_more: false }, options)
    let requested
    const catalog = new Catalog(session, { request: async (_, path, options) => {
      requested = options.body
      return { items: [], has_more: false }
    } })
    await catalog.radioBatch({ id: page.items[0].item.id })
    assert.deepEqual(requested, { radio_id: id, flow_type: 1, trigger_info: 'artist/a', cursor: '' })
    delete item.resources[0].style.link
    const defaultPage = discoveryOf({ inner_block: [item], has_more: false }, options)
    await catalog.radioBatch({ id: defaultPage.items[0].item.id })
    assert.deepEqual(requested, { radio_id: id, flow_type: 2, trigger_info: '', cursor: '' })
  }
})

test('rejects malformed radio navigation selectors before requesting a default mix', async () => {
  for (const link of ['not a URL', 'luna://radio?flow_type=oops', 'luna://radio?flow_type=-1', 'luna://radio?flow_type=1.5', 'luna://radio?flow_type=2147483648', 'luna://radio?trigger_info=' + 'x'.repeat(8193)]) {
    const item = card('42')
    item.resources[0].style.link = link
    assert.throws(() => discoveryOf({ inner_block: [item], has_more: false }, options), { kind: 'response' })
  }
  let calls = 0
  const catalog = new Catalog(session, { request: async () => { calls++; throw Error('unexpected network') } })
  for (const id of ['radio-theme:v1:42?flow_type=oops', 'radio-theme:v1:42?flow_type=3&trigger_info=a&trigger_info=b', 'radio-theme:v1:42?flow_type=3&trigger_info=a&unknown=b', 'radio-theme:v1:%XX?flow_type=3&trigger_info=a', 'radio-theme:v1:42?flow_type=3&trigger_info=a?ignored', 'radio-theme:v1:42?flow_type=3&trigger_info=' + 'x'.repeat(8193), 'radio-theme:v1:42', 'radio-theme:v1:42?flow_type=2&trigger_info=', 'radio-theme:v1:%34%32?flow_type=3&trigger_info=a']) {
    await assert.rejects(catalog.radioBatch({ id }), { kind: 'response' })
  }
  assert.equal(calls, 0)
})

// Production transport binds the final discover URL and exact exposure payload to the existing native signer.
test('signs native discovery requests and reuses exact server exposures and cursors', async () => {
  const calls = []
  const catalog = new Catalog(session, { request: (session, path, options) => requestJSON(session, path, options, {
    sign: async spec => { calls.push({ path, spec }); return { 'X-Helios': 'fixture-helios', 'X-Medusa': 'fixture-medusa' } },
    fetch: async (url, spec) => {
      assert.equal(url, calls.at(-1).spec.url)
      assert.equal(spec.redirect, 'error')
      assert.equal(spec.headers.Cookie, ['sessionid', session.cookies[0].value].join('='))
      const initial = path === '/luna/pc/discover'
      assert.deepEqual(JSON.parse(spec.body), initial ? { first_request: true, pc_new_discover_request: true } : { block_type: 'discover_playlist_mix', sub_channel_id: -2, exposure_radio_list: ['1'], cursor: 'server-cursor' })
      return new Response(JSON.stringify(initial ? { blocks: [{ type: 'discover_playlist_mix', inner_block: [card('1')] }], next_cursor: 'server-cursor' } : { inner_block: [card('2')], has_more: false }))
    },
  }) })
  const first = await catalog.discoveryPage()
  const next = await catalog.discoveryPage(first.state)
  assert.equal(next.items[0].item.id, 'radio:2')
  assert.equal(next.more, false)
  assert.deepEqual(calls.map(call => call.path), ['/luna/pc/discover', '/luna/pc/discover/mix'])
})

// A discovery radio is not a scene_mode_id; its feed must use radio_id and actual opaque cursors only.
test('loads radio-specific songs and keeps video filtering and track identity checks', async () => {
  const catalog = new Catalog(session, { request: async (_, path, options) => {
    assert.equal(path, '/luna/pc/feed/radio/tracks')
    assert.equal(options.signed, true)
    assert.deepEqual(options.body, { radio_id: '9223372036854775807', flow_type: 2, trigger_info: '', cursor: 'opaque-next' })
    return { items: [track('1'), { type: 'video' }, track('1'), track('2')], has_more: true, next_cursor: 'opaque-end' }
  } })
  const page = await catalog.radioBatch({ id: 'radio:9223372036854775807', cursor: 'opaque-next' })
  assert.deepEqual(page.result.map(t => t.id), ['1', '2'])
  assert.equal(page.result[0].duration, 180000)
  assert.equal(page.cursor, 'opaque-end')
  assert.equal(page.more, true)
  await assert.rejects(catalog.radioBatch({ id: 'scene:42' }), { kind: 'unsupported' })
})
