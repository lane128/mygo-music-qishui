import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Catalog, requestJSON, artistOf } from '../helper/catalog.mjs'
import { sandbox, session, json, until } from './fixtures/plugin-sandbox.mjs'
import { catalogService, track, stale } from './fixtures/catalog-service.mjs'

const profile = (id = '92') => ({ artist_info: { id, name: 'Fixture Artist', url_avatar: { urls: ['https://p3-luna.douyinpic.com/img/artist.jpg'] } }, hot_tracks: [track('99')] })
const artistRoutes = (id = '92') => ({
  [`/luna/pc/artists/${id}`]: [profile(id)],
  [`/luna/pc/artists/${id}/tracks`]: [{ tracks: [track('91')], has_more: false }],
  [`/luna/pc/artists/${id}/albums`]: [{ albums: [], has_more: false }],
})

// The full singles list starts at its own first cursor; hot songs cannot stand in for a complete catalogue.
test('artist capability maps complete paged singles and albums without cookies or helper', async () => {
  const id = '9223372036854775807', base = `/luna/pc/artists/${id}`
  const routes = artistRoutes(id)
  routes[base + '/tracks'] = [call => {
    assert.equal(call.parsed.searchParams.get('cursor'), '')
    return { tracks: [{ ...track('7123456789012345678'), artists: [{ id, name: 'Fixture Artist' }] }, track('2')], has_more: true, next_cursor: '50' }
  }, call => {
    assert.equal(call.parsed.searchParams.get('cursor'), '50')
    return { tracks: [{ ...track('2'), name: 'Duplicate' }, track('3')], has_more: false }
  }]
  routes[base + '/albums'] = [{ albums: [{ id: '93', name: 'Fixture Album', release_date: 1759276800 }], next_cursor: '146' }]
  const service = catalogService(routes)
  const s = await sandbox([], session, { allowSpawn: false, request: service.request })
  try {
    const page = await s.api.artist({ id })
    assert.equal(page.artist.id, id)
    assert.equal(page.artist.imageUrl, 'https://p3-luna.douyinpic.com/img/artist.jpg')
    assert.deepEqual(Array.from(page.tracks, t => t.id), ['7123456789012345678', '2', '3'])
    assert.equal(page.tracks[0].artists[0].id, id)
    assert.equal(page.tracks[1].name, 'Fixture Song')
    assert.equal(page.albums[0].released, '2025-10-01')
    assert.equal(s.spawned(), 0)
    assert.ok(service.calls.every(c => c.options.headers.Cookie === undefined))
  } finally { await s.api.signOut() }
})

// Artist photos use the avatar contract, not a cover suffix or a hardcoded CDN.
test('artist photos preserve complete URLs and construct official square templates on the returned CDN', () => {
  const complete = 'https://photos.example.test/artist/portrait-key.jpg?from=fixture&size=600%2f600+square&size=original'
  for (const url_avatar of [complete, { urls: [complete] },
    { uri: 'portrait-key', urls: [complete], template_prefix: 'tplv-avatar' },
    { uri: 'opaque-other-id', urls: [complete], template_prefix: 'tplv-avatar', need_complete_url: true },
  ]) assert.equal(artistOf({ id: '92', name: 'Artist', url_avatar }).imageUrl, complete)
  const url_avatar = { uri: 'portrait-key', template_prefix: 'tplv-avatar', urls: ['http://unsafe.example.test/img/', 'https://preferred.example.test/img/'] }
  assert.equal(artistOf({ id: '92', name: 'Artist', url_avatar }).imageUrl,
    'https://preferred.example.test/img/portrait-key~tplv-avatar-crop-center:%7Bsize%7D:%7Bsize%7D.jpg')
  for (const url_avatar of [undefined, { urls: ['javascript:fixture'] }, { uri: 'portrait-key', template_prefix: 'tplv-avatar' }]) {
    assert.equal(artistOf({ id: '92', name: 'Artist', url_avatar }).imageUrl, undefined)
  }
})

// Search cards and artist pages share the avatar mapper even though their response shapes differ.
test('artist search keeps complete photos and uses the supplied template CDN through the bundle', async () => {
  const complete = 'https://photos.example.test/artist/portrait-key.jpg?from=fixture&size=600%2f600+square'
  const service = catalogService({ '/luna/pc/search/artist': [{ result_groups: [{ id: 'artists', data: [
    { entity: { artist: { id: '92', name: 'First', url_avatar: { urls: [complete], uri: 'portrait-key', need_complete_url: true } } } },
    { entity: { artist: { id: '93', name: 'Second', url_avatar: { urls: ['https://preferred.example.test/img/'], uri: 'portrait-key', template_prefix: 'tplv-avatar' } } } },
  ], has_more: false }] }] })
  const s = await sandbox([], session, { allowSpawn: false, request: service.request })
  try {
    const page = await s.api.search({ query: 'Fixture', kind: 'artists', offset: 0 })
    assert.equal(page.artists[0].imageUrl, complete)
    assert.equal(page.artists[1].imageUrl, 'https://preferred.example.test/img/portrait-key~tplv-avatar-crop-center:%7Bsize%7D:%7Bsize%7D.jpg')
    assert.equal(s.spawned(), 0)
  } finally { await s.api.signOut() }
})

// Missing protobuf arrays are empty only with an identified successful terminal response.
test('artist lists accept terminal omitted arrays and reject malformed or looping responses', async () => {
  const empty = await new Catalog(session, { request: async (_, path) => path.endsWith('/92') ? profile() : { status_info: { code: 0 } } }).artist('92')
  assert.deepEqual(empty.tracks, [])
  assert.deepEqual(empty.albums, [])
  for (const value of [
    {}, { tracks: {} }, { tracks: [null] }, { tracks: [{ id: '91', duration: -1 }] },
    { tracks: [], has_more: true, next_cursor: '' },
    { tracks: [], has_more: true, next_cursor: 'loop' },
  ]) {
    const catalog = new Catalog(session, { request: async (_, path) => path.endsWith('/92') ? profile() : path.endsWith('/albums') ? { albums: [] } : value })
    await assert.rejects(catalog.artist('92'), { kind: 'response' })
  }
  for (const artist_info of [null, { id: '93', name: 'Wrong Artist' }, { id: '92', name: '' }, { id: '92', name: 1 }]) {
    await assert.rejects(new Catalog(session, { request: async () => ({ artist_info }) }).artist('92'), { kind: 'response' })
  }
})

// Same-named duet credits retain their distinct directory IDs and the official singles order.
test('artist singles preserve duet IDs and first data across duplicate rows', async () => {
  const one = { ...track('2'), artists: [{ id: '92', name: 'Same Name' }, { id: '93', name: 'Same Name' }] }
  const catalog = new Catalog(session, { request: async (_, path) => path.endsWith('/93') ? profile('93') : path.endsWith('/albums') ? { albums: [] } : { tracks: [one, track('1'), { ...one, name: 'Duplicate' }] } })
  const page = await catalog.artist('93')
  assert.deepEqual(page.tracks.map(t => t.id), ['2', '1'])
  assert.deepEqual(page.tracks[0].artists.map(a => a.id), ['92', '93'])
  assert.equal(page.tracks[0].name, one.name)
})

// Dynamic public paths remain GET-only numeric entity paths, never arbitrary signed account routes.
test('artist navigation rejects invalid IDs and public path signing before HTTP', async () => {
  const s = await sandbox([], session, { request: () => { throw Error('unexpected HTTP') } })
  try {
    for (const id of [undefined, null, 92, '', 'name', '../me', '92/tracks', '92?user_id=1', '1'.repeat(33)]) await assert.rejects(s.api.artist({ id }), /歌手主页/)
    assert.equal(s.spawned(), 0)
    for (const path of ['/luna/pc/artists/', '/luna/pc/artists/92/tracks/extra', '/luna/pc/artists/%39%32', '/luna/pc/artists/../me']) {
      await assert.rejects(requestJSON(session, path), { kind: 'response' })
    }
    for (const path of ['/luna/pc/artists/92', '/luna/pc/artists/92/tracks', '/luna/pc/artists/92/albums']) {
      for (const options of [{ signed: true }, { body: {} }]) await assert.rejects(requestJSON(session, path, options), { kind: 'response' })
    }
    await s.api.signOut()
    await assert.rejects(s.api.artist({ id: '92' }), e => e.code === 'signIn')
  } finally { await s.api.signOut() }
})

// Artist failures expose only fixed plugin messages and never partially populated profiles.
test('artist HTTP and response errors remain sanitized', async () => {
  for (const value of [json({ error_code: 7, message: 'private response' }), json({ error_code: 2046, message: 'private response' }), json({}, [], 401), json({}, [], 503), json(profile('93')), new Response('private malformed response')]) {
    const service = catalogService({ artist: [value] })
    const s = await sandbox([], session, { allowSpawn: false, request: service.request })
    try {
      await assert.rejects(s.api.artist({ id: '92' }), e => !e.message.includes('private'))
      assert.equal(service.for('artist').length, 1)
      assert.equal(s.timers.size, 0)
    } finally { await s.api.signOut() }
  }
})

// A reply from the old account cannot fill any of the new account's artist lists.
test('artist navigation aborts and rejects late account replies', async () => {
  let finish, signal
  const pending = new Promise(resolve => { finish = resolve })
  const routes = artistRoutes()
  routes['/luna/pc/artists/92'] = [call => { signal = call.options.signal; return pending }, profile()]
  const service = catalogService(routes)
  const s = await sandbox([], session, { allowSpawn: false, request: service.request })
  const loading = s.api.artist({ id: '92' }), rejected = assert.rejects(loading, stale)
  await until(() => signal)
  await s.api.signOut()
  s.state.set('session', { ...session, cookies: [{ name: 'sessionid', value: 'replacement-fixture' }] })
  finish(profile())
  await rejected
  assert.equal(signal.aborted, true)
  assert.equal((await s.api.artist({ id: '92' })).artist.id, '92')
  assert.equal(s.spawned(), 0)
  await s.api.signOut()
})
