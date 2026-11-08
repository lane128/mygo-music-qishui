import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Catalog, trackOf, requestJSON } from '../helper/catalog.mjs'
import { artistFollowing, followArtist, collectionList } from '../helper/collections.mjs'
import { sandbox, session, profile, until } from './fixtures/plugin-sandbox.mjs'
import { catalogService, track, search } from './fixtures/catalog-service.mjs'

const saved = { ...session, account: profile }
const bound = { id: '92', name: 'Bound artist', user_artist_type: 2, user: { id: '192' } }

// User-backed artists must follow the bound user, while the host keeps the catalog artist ID.
test('selects the official user-follow path and reads actual signed user state', async () => {
  let following = false
  const writes = []
  const catalog = new Catalog(saved, { request: async (_, path, options) => {
    if (path === '/luna/pc/artists/92') return { artist_info: bound }
    if (path === '/luna/users/192') {
      assert.equal(options.signed, true)
      assert.deepEqual(options.query, { user_id: '192', sec_uid: '' })
      return { user: { id: '192' }, my_user_state: { follow_status: following ? 6 : 3 } }
    }
    assert.equal(path, following ? '/luna/pc/me/unfollow' : '/luna/pc/me/follow')
    assert.equal(options.signed, true)
    assert.deepEqual(options.body, { user_id: '192' })
    writes.push(path)
    following = !following
    return { user_id: 192, follow_status: following ? 7 : 0 }
  } })
  assert.equal(await artistFollowing(catalog, bound), false)
  await followArtist(catalog, '92', true)
  assert.equal(await artistFollowing(catalog, bound), true)
  await followArtist(catalog, '92', false)
  assert.equal(await artistFollowing(catalog, { ...bound, user: { id: 192 } }), false)
  assert.equal(writes.length, 2)
})

// An unverified binding or malformed receipt must never silently switch ID namespaces.
test('rejects unknown artist types, missing bindings, mismatched identities and refused results', async () => {
  for (const raw of [{ ...bound, user: null }, { ...bound, id: '93' }, { ...bound, user_artist_type: 3 }, { ...bound, user: { id: Number.MAX_SAFE_INTEGER + 1 } }]) {
    let writes = 0
    const catalog = new Catalog(saved, { request: async (_, path, options) => {
      if (options?.body) writes++
      return { artist_info: raw }
    } })
    await assert.rejects(followArtist(catalog, '92', true))
    assert.equal(writes, 0)
  }
  for (const reply of [{ user_id: '193', follow_status: 1 }, { user_id: ['192'], follow_status: 1 }, { follow_status: 0 }, { follow_status: 8 }, {}]) {
    let writes = 0
    const catalog = new Catalog(saved, { request: async (_, path) => {
      if (path === '/luna/pc/artists/92') return { artist_info: bound }
      writes++
      return reply
    } })
    await assert.rejects(followArtist(catalog, '92', true))
    assert.equal(writes, 1)
  }
  for (const reply of [{ user: { id: '193' }, my_user_state: { follow_status: 1 } }, { user: { id: '192' } }]) {
    const catalog = new Catalog(saved, { request: async () => reply })
    await assert.rejects(artistFollowing(catalog, bound), { kind: 'response' })
  }
})

// Resolving a public identity can overlap cancellation; no later account write may start.
test('account change during identity lookup blocks the write and concurrent follows are rejected', async () => {
  let release, writes = 0
  const ownSession = { ...saved }
  const catalog = new Catalog(ownSession, { request: async (_, path) => {
    if (path === '/luna/pc/artists/92') return new Promise(resolve => { release = () => resolve({ artist_info: bound }) })
    writes++
    throw Object.assign(new Error('private transport'), { kind: 'network' })
  } })
  const pending = followArtist(catalog, '92', true)
  await until(() => release)
  await assert.rejects(followArtist(catalog, '92', false), { kind: 'unsupported' })
  ownSession.account = { ...profile, id: '999' }
  release()
  await assert.rejects(pending, { kind: 'session' })
  assert.equal(writes, 0)
})

// A user follow used to invalidate a different collection and reject a simultaneous artist page read.
test('user follows leave pending catalog-artist collections intact', async () => {
  let release, reads = 0
  const catalog = new Catalog(saved, { request: async (_, path) => {
    if (path === '/luna/me/collection/artist') {
      reads++
      return new Promise(resolve => { release = () => resolve({ artists: [{ id: '93', name: 'Catalog artist' }], has_more: false }) })
    }
    if (path === '/luna/pc/artists/92') return { artist_info: bound }
    assert.equal(path, '/luna/pc/me/follow')
    return { follow_status: 1 }
  } })
  const pending = collectionList(catalog, 'artist')
  await until(() => release)
  await followArtist(catalog, '92', true)
  release()
  assert.deepEqual((await pending).map(a => a.id), ['93'])
  assert.deepEqual((await collectionList(catalog, 'artist')).map(a => a.id), ['93'])
  assert.equal(reads, 1)
})

// Old user-state results must not survive an account change, and canceling is not an authentication failure.
test('guards delayed user reads and writes and preserves cancellation classification', async () => {
  for (const phase of ['lookup', 'state', 'write']) for (const cancel of [false, true]) {
    let release, writes = 0
    const controller = new AbortController(), ownSession = { ...saved }
    const catalog = new Catalog(ownSession, { signal: controller.signal, request: async (_, path, options) => {
      if (path === '/luna/pc/artists/92' && phase !== 'lookup') return { artist_info: bound }
      if (options.body) writes++
      const reply = phase === 'lookup' ? { artist_info: bound } : phase === 'state' ? { user: { id: '192' }, my_user_state: { follow_status: 1 } } : { follow_status: 1 }
      return new Promise(resolve => { release = () => resolve(reply) })
    } })
    const pending = phase === 'state' ? artistFollowing(catalog, bound) : followArtist(catalog, '92', true)
    await until(() => release)
    if (cancel) controller.abort()
    else ownSession.account = { ...profile, id: '999' }
    release()
    await assert.rejects(pending, { kind: cancel ? 'canceled' : 'session' })
    assert.equal(writes, phase === 'write' ? 1 : 0)
  }
})

// Both identity reads and exact signed user operations must traverse the real standalone bundle.
test('standalone artist page and follow use the bound user without credentialing public metadata', async () => {
  const detail = () => ({ artist_info: bound })
  const service = catalogService({
    artist: [detail, detail, detail],
    '/luna/pc/artists/92/tracks': [{ tracks: [], has_more: false }],
    '/luna/pc/artists/92/albums': [{ albums: [], has_more: false }],
    '/luna/users/192': [{ user: { id: '192' }, my_user_state: { follow_status: 1 } }],
    '/luna/pc/me/unfollow': [{ user_id: '192', follow_status: 0 }],
    '/luna/pc/me/follow': [{ user_id: '192', follow_status: 4 }],
  })
  const s = await sandbox([], saved, { sign: true, request: service.request })
  const page = await s.api.artist({ id: '92' })
  assert.equal(page.artist.id, '92')
  assert.equal(page.artist.following, true)
  await s.api.followArtist({ id: '92', on: false })
  await s.api.followArtist({ id: '92', on: true })
  assert.equal(s.spawned(), 3)
  assert.deepEqual(service.calls.filter(c => c.body).map(c => c.body), [{ user_id: '192' }, { user_id: '192' }])
})

// The legacy alias returned HTTP 200 with an empty body and hid otherwise valid artist pages.
test('preferred user route loads the artist and real state despite an empty legacy alias', async () => {
  const service = catalogService({
    artist: [{ artist_info: bound }],
    '/luna/pc/artists/92/tracks': [{ tracks: [track('91')], has_more: false }],
    '/luna/pc/artists/92/albums': [{ albums: [], has_more: false }],
    '/luna/user/info': [new Response('', { headers: { 'content-type': 'application/json' } })],
    '/luna/users/192': [call => {
      assert.equal(call.parsed.searchParams.get('user_id'), '192')
      assert.equal(call.parsed.searchParams.get('sec_uid'), '')
      return { user: { id: '192' }, my_user_state: { follow_status: 0 } }
    }],
  })
  const s = await sandbox([], saved, { sign: true, request: service.request })
  const page = await s.api.artist({ id: '92' })
  assert.equal(page.artist.following, false)
  assert.equal(page.tracks[0].id, '91')
  assert.equal(service.calls.filter(call => call.parsed.pathname === '/luna/user/info').length, 0)
})

// Expanding the signed route must not admit arbitrary user paths or unsigned/account-writing requests.
test('user-info route is decimal-only, bounded and requires a signed GET', async () => {
  for (const path of ['/luna/users/', '/luna/users/x', '/luna/users/-1', '/luna/users/1/', '/luna/users/1/follows', '/luna/users/%31', '/luna/users/' + '1'.repeat(33)]) {
    await assert.rejects(requestJSON(saved, path, { signed: true }), { kind: 'response' })
  }
  for (const id of ['1', '1'.repeat(32)]) {
    await assert.rejects(requestJSON(saved, '/luna/users/' + id), { kind: 'response' })
    await assert.rejects(requestJSON(saved, '/luna/users/' + id, { signed: true, body: {} }), { kind: 'response' })
    const service = catalogService({ ['/luna/users/' + id]: [{ user: { id }, my_user_state: { follow_status: 1 } }] })
    const reply = await requestJSON(saved, '/luna/users/' + id, { signed: true, query: { user_id: id, sec_uid: '' } }, {
      platform: 'darwin', fetch: service.request, sign: async () => ({ 'x-helios': 'fixture-helios', 'x-medusa': 'fixture-medusa' }),
    })
    assert.equal(reply.user.id, id)
  }
})

// Public share pages belong to the song, never to an upstream media URL or a sharer's account.
test('maps verified song share URLs without extra requests or unsafe opaque IDs', async () => {
  for (const id of ['91', '7123456789012345678']) {
    const mapped = trackOf({ ...track(id), url: 'https://media.example.invalid/private?token=fixture' })
    assert.equal(mapped.url, `https://music.douyin.com/qishui/share/track?track_id=${id}`)
  }
  for (const id of ['opaque:91', '91&token=fixture', '1'.repeat(33)]) assert.equal(trackOf(track(id)).url, undefined)
  const service = catalogService({ search: [search([track('91'), track('92')], '', false)] })
  const s = await sandbox([], saved, { allowSpawn: false, request: service.request })
  const page = await s.api.search({ query: 'Fixture', kind: 'tracks', offset: 0 })
  assert.equal(page.tracks[0].url, 'https://music.douyin.com/qishui/share/track?track_id=91')
  assert.equal(page.tracks[1].url, 'https://music.douyin.com/qishui/share/track?track_id=92')
  assert.equal(service.calls.length, 1)
  assert.equal(s.spawned(), 0)
})
