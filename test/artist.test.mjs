import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Catalog, requestJSON } from '../helper/catalog.mjs'
import { sandbox, session, json, until } from './fixtures/plugin-sandbox.mjs'
import { catalogService, track, stale } from './fixtures/catalog-service.mjs'

const profile = (id = '92', extra = {}) => ({ artist_info: { id, name: 'Fixture Artist', url_avatar: { urls: ['https://p3-luna.douyinpic.com/img/artist.jpg'] } }, hot_tracks: [track('91')], ...extra })

// Host navigation passes an artist ID, never a name or a user ID. Preserve
// large IDs through the real bundle, public HTTP parsing and native page shape.
test('artist capability fetches a public detail GET without process permission and maps hot songs', async () => {
  const id = '9223372036854775807', path = `/luna/pc/artists/${id}`
  const service = catalogService({ [path]: [call => {
    assert.equal(call.options.method, 'GET')
    assert.equal(call.parsed.searchParams.get('locate_item_id'), '')
    assert.equal(call.parsed.searchParams.has('user_id'), false)
    assert.equal(call.options.body, undefined)
    assert.equal(call.options.headers['X-SS-STUB'], undefined)
    assert.equal(call.options.headers['X-Luna-Is-Local-User'], '0')
    return new Response('{"artist_info":{"id":9223372036854775807,"name":"Fixture Artist","url_avatar":{"urls":["https://p3-luna.douyinpic.com/img/artist.jpg"]}},"hot_tracks":[{"id":7123456789012345678,"name":"Hot Song","duration":180000,"artists":[{"id":9223372036854775807,"name":"Fixture Artist"}],"album":{}}],"hot_mvs":[{"video_id":"ignored-video"}]}')
  }] })
  const s = await sandbox([], session, { allowSpawn: false, request: service.request })
  try {
    const page = await s.api.artist({ id })
    assert.equal(page.artist.id, id)
    assert.equal(page.artist.name, 'Fixture Artist')
    assert.equal(page.artist.imageUrl, 'https://p3-luna.douyinpic.com/img/artist.jpg~c5_375x375.jpg')
    assert.equal(page.tracks[0].id, '7123456789012345678')
    assert.equal(page.tracks[0].artists[0].id, id)
    assert.equal(page.tracks[0].duration, 180000)
    assert.equal(page.tracks.length, 1)
    assert.equal(page.albums, undefined)
    assert.deepEqual(s.calls, [])
    assert.equal(s.spawned(), 0)
    assert.equal(s.closed(), 0)
  } finally { await s.api.signOut() }
})

// Missing optional hot-song arrays are an honest empty artist page, as in
// the official client, while wrong identities or malformed songs stay errors.
test('artist pages handle empty hot songs and missing images without hiding malformed responses', async () => {
  for (const hot_tracks of [undefined, null, []]) {
    const value = profile('92', { hot_tracks })
    delete value.artist_info.url_avatar
    const page = await new Catalog(session, { request: async () => value }).artist('92')
    assert.deepEqual(page.tracks, [])
    assert.equal(page.artist.imageUrl, undefined)
  }
  for (const value of [
    {}, { artist_info: null }, { artist_info: { id: '93', name: 'Wrong Artist' } },
    { artist_info: { id: '92', name: '' } }, { artist_info: { id: '92', name: 1 } },
    profile('92', { hot_tracks: {} }), profile('92', { hot_tracks: [null] }),
    profile('92', { hot_tracks: [{ id: '91', duration: -1 }] }),
  ]) await assert.rejects(new Catalog(session, { request: async () => value }).artist('92'), { kind: 'response' })
  const unsafe = profile()
  unsafe.artist_info.url_avatar = 'http://example.invalid/avatar'
  assert.equal((await new Catalog(session, { request: async () => unsafe }).artist('92')).artist.imageUrl, undefined)
})

// Same-named singers and featured credits must remain distinct, and duplicate
// hot-song rows must not reorder the artist's songs or replace their first data.
test('artist pages keep duet IDs and official hot-song order', async () => {
  const one = { ...track('2'), artists: [{ id: '92', name: 'Same Name' }, { id: '93', name: 'Same Name' }] }
  const value = profile('93', { hot_tracks: [one, track('1'), { ...one, name: 'Duplicate' }] })
  const page = await new Catalog(session, { request: async (_, path) => { assert.equal(path, '/luna/pc/artists/93'); return value } }).artist('93')
  assert.equal(page.artist.id, '93')
  assert.deepEqual(page.tracks.map(t => t.id), ['2', '1'])
  assert.deepEqual(page.tracks[0].artists.map(a => a.id), ['92', '93'])
  assert.equal(page.tracks[0].name, one.name)
})

// The new detail route must not become an arbitrary signed account API path.
test('artist navigation rejects unsupported IDs and path injection before signing or HTTP', async () => {
  const s = await sandbox([], session, { request: () => { throw Error('unexpected HTTP') } })
  try {
    for (const id of [undefined, null, 92, '', 'name', '../me', '92/tracks', '92?user_id=1', '1'.repeat(33)]) await assert.rejects(s.api.artist({ id }), /歌手主页/)
    assert.equal(s.spawned(), 0)
    for (const path of ['/luna/pc/artists/', '/luna/pc/artists/92/tracks', '/luna/pc/artists/%39%32', '/luna/pc/artists/../me']) {
      await assert.rejects(requestJSON(session, path, { signed: true }, { sign: () => { throw Error('unexpected sign') } }), { kind: 'response' })
    }
    for (const options of [{ signed: true }, { body: { unexpected: true } }]) {
      await assert.rejects(requestJSON(session, '/luna/pc/artists/92', options), { kind: 'response' })
    }
    await s.api.signOut()
    await assert.rejects(s.api.artist({ id: '92' }), e => e.code === 'signIn')
  } finally { await s.api.signOut() }
})

// Artist failures are shown with fixed plugin text, never remote diagnostics.
test('artist HTTP and response errors remain sanitized and do not produce placeholder profiles', async () => {
  for (const value of [json({ error_code: 7, message: 'private response' }), json({ error_code: 2046, message: 'private response' }), json({}, [], 401), json({}, [], 503), json(profile('93')), new Response('private malformed response')]) {
    const service = catalogService({ artist: [value] })
    const s = await sandbox([], session, { allowSpawn: false, request: service.request })
    try {
      await assert.rejects(s.api.artist({ id: '92' }), e => !e.message.includes('private'))
      assert.equal(service.for('artist').length, 1)
      assert.equal(s.closed(), 0)
      assert.equal(s.timers.size, 0)
    } finally { await s.api.signOut() }
  }
})

// A late HTTP reply must not populate the new account's artist page.
test('artist navigation aborts HTTP and rejects old-account replies after account replacement', async () => {
  let finish, signal
  const pending = new Promise(resolve => { finish = resolve })
  const service = catalogService({ artist: [call => { signal = call.options.signal; return pending }, profile()] })
  const s = await sandbox([], session, { allowSpawn: false, request: service.request })
  const loading = s.api.artist({ id: '92' }), rejected = assert.rejects(loading, stale)
  await until(() => signal)
  await s.api.signOut()
  s.state.set('session', { ...session, cookies: [{ name: 'sessionid', value: 'replacement-fixture' }] })
  finish(profile())
  await rejected
  assert.equal(signal.aborted, true)
  assert.equal((await s.api.artist({ id: '92' })).artist.id, '92')
  assert.ok(service.for('artist').every(c => c.options.headers.Cookie === undefined))
  assert.equal(s.spawned(), 0)
  await s.api.signOut()
})
