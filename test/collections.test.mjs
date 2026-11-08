import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Catalog, requestJSON } from '../helper/catalog.mjs'
import { collectionList, followArtist, saveAlbum } from '../helper/collections.mjs'
import { sandbox, session, profile, until } from './fixtures/plugin-sandbox.mjs'
import { catalogService } from './fixtures/catalog-service.mjs'

const saved = { ...session, account: profile }
const album = id => ({ id, name: 'Album ' + id })
const artist = id => ({ id, name: 'Artist ' + id })

// Collection pages must be complete before an absent item can be considered not saved.
test('reads every collection cursor, deduplicates and filters mixed item kinds', async () => {
  const queries = []
  const catalog = new Catalog(saved, { request: async (_, path, options) => {
    assert.equal(path, '/luna/pc/me/collection/mixed')
    assert.equal(options.signed, true)
    queries.push(options.query)
    return options.query.get('cursor') === ''
      ? { mixed_collections: [{ item_type: 'album', album: album('1') }, { item_type: 'playlist', playlist: { id: '9' } }], has_more: true, next_cursor: 'next' }
      : { mixed_collections: [{ item_type: 'album', album: album('1') }, { item_type: 'album', album: album('2') }], has_more: false }
  } })
  const page = await catalog.savedAlbums(0)
  assert.deepEqual(page.albums.map(a => [a.id, a.saved]), [['1', true], ['2', true]])
  assert.equal(page.more, false)
  assert.deepEqual(queries[0].getAll('item_types'), ['album', 'playlist'])
  assert.deepEqual(await catalog.savedAlbums(50), { albums: [], more: false })
  assert.equal(queries.length, 2)
})

// Live empty mixed collections omit the list and pagination, keeping only status_info.
test('status-only empty collections load the saved list and unsaved album detail', async () => {
  for (const empty of [{ status_info: {} }, { status_info: {}, has_more: false }, { status_info: {}, mixed_collections: null }]) {
    const service = catalogService({
      '/luna/pc/me/collection/mixed': [empty],
      '/luna/pc/albums/93': [{ album_info: album('93'), tracks: [{ id: '91', name: 'Song', duration: 1000 }] }],
    })
    const s = await sandbox([], saved, { sign: true, request: service.request })
    const page = await s.api.savedAlbums()
    assert.equal(page.albums.length, 0)
    assert.equal(page.more, false)
    const detail = await s.api.album({ id: '93' })
    assert.equal(detail.album.id, '93')
    assert.equal(detail.album.saved, false)
    assert.deepEqual(Array.from(detail.tracks, track => track.id), ['91'])
    assert.equal(service.calls.filter(call => call.parsed.pathname === '/luna/pc/me/collection/mixed').length, 1)
  }
})

test('a status-only terminal collection page retains albums from earlier pages', async () => {
  let reads = 0
  const catalog = new Catalog(saved, { request: async () => ++reads === 1
    ? { mixed_collections: [{ item_type: 'album', album: album('93') }], has_more: true, next_cursor: 'last' }
    : { status_info: {} } })
  const page = await catalog.savedAlbums()
  assert.deepEqual(page.albums.map(item => [item.id, item.saved]), [['93', true]])
  assert.equal(page.more, false)
  assert.equal(reads, 2)
})

// A successful empty read must not hide missing pages, malformed metadata or transport/API failures.
test('empty collection compatibility still rejects malformed and incomplete responses', async () => {
  for (const reply of [{}, { status_info: null }, { status_info: [] }, { status_info: 'ok' }, { status_info: {}, has_more: true, next_cursor: 'next' }, { status_info: {}, has_more: 'false' }, { status_info: {}, total_num: 1 }, { status_info: {}, mixed_collections: {} }]) {
    const catalog = new Catalog(saved, { request: async () => reply })
    await assert.rejects(catalog.savedAlbums(), { kind: 'response' })
    assert.equal(catalog.state.collections.has('album'), false)
  }
})

test('collection API failures propagate and can recover on a later read', async () => {
  for (const [reply, kind] of [
    [{ status_info: { code: 2 } }, 'expired'],
    [{ status_info: { code: 2046 } }, 'verify'],
    [{ status_code: 7, status_info: {} }, 'rateLimit'],
    [{ error_code: 123, status_info: {} }, 'rejected'],
    [new Response('{}', { status: 500 }), 'network'],
  ]) {
    const service = catalogService({ '/luna/pc/me/collection/mixed': [reply, { status_info: {} }] })
    const catalog = new Catalog(saved, { request: (session, path, options) => requestJSON(session, path, options, {
      fetch: service.request, platform: 'darwin', sign: async () => ({ 'x-helios': 'fixture-helios', 'x-medusa': 'fixture-medusa' }),
    }) })
    await assert.rejects(catalog.savedAlbums(), { kind })
    assert.equal(catalog.state.collections.has('album'), false)
    assert.deepEqual(await catalog.savedAlbums(), { albums: [], more: false })
    assert.equal(service.calls.length, 2)
  }
})

// Follow/save writes use exact ID arrays once, and invalidate even on ambiguous timeouts.
test('mutations invalidate state, honor returned status, and never retry', async () => {
  let on = true, reads = 0, writes = 0
  const catalog = new Catalog(saved, { request: async (_, path, options) => {
    if (path === '/luna/pc/artists/92') return { artist_info: artist('92') }
    if (options.body) {
      writes++
      assert.equal(options.signed, true)
      assert.deepEqual(options.body, { artist_ids: ['92'] })
      on = !path.endsWith('/delete')
      return { [on ? 'collect_artist_status' : 'deleted_artist_status']: { '92': on ? 1 : 0 } }
    }
    reads++
    return { artists: on ? [artist('92')] : [], has_more: false }
  } })
  assert.equal((await collectionList(catalog, 'artist')).length, 1)
  await followArtist(catalog, '92', false)
  assert.equal((await collectionList(catalog, 'artist')).length, 0)
  await followArtist(catalog, '92', true)
  assert.equal((await collectionList(catalog, 'artist')).length, 1)
  assert.equal(reads, 3)
  assert.equal(writes, 2)
  catalog.request = async () => { writes++; throw Object.assign(new Error('private'), { kind: 'network' }) }
  await assert.rejects(saveAlbum(catalog, '93', true), { kind: 'network' })
  assert.equal(writes, 3)
  assert.equal(catalog.state.collections.has('album'), false)
})

// Invalid or incomplete responses must not turn unknown account state into false.
test('refuses invalid input, malformed collections, repeated cursors and refused follow state', async () => {
  const catalog = new Catalog(saved, { request: async () => { throw Error('unexpected request') } })
  for (const id of ['', 'x', 1, '../me', '1'.repeat(33)]) {
    await assert.rejects(followArtist(catalog, id, true), { kind: 'response' })
    await assert.rejects(saveAlbum(catalog, id, true), { kind: 'response' })
  }
  await assert.rejects(saveAlbum(catalog, '93', 'true'), { kind: 'response' })
  for (const reply of [{}, { artists: {} }, { artists: [{ id: 12 }] }, { artists: [], has_more: true, next_cursor: 'again' }]) {
    const bad = new Catalog(saved, { request: async () => reply })
    await assert.rejects(collectionList(bad, 'artist'), { kind: 'response' })
  }
  const refused = new Catalog(saved, { request: async (_, path) => path === '/luna/pc/artists/92' ? { artist_info: artist('92') } : { collect_artist_status: { '92': 0 } } })
  await assert.rejects(followArtist(refused, '92', true), { kind: 'rejected' })
})

// Official private-account follow request states 6/7 and omitted entries used to report successful writes as failures.
test('accepts every official follow status and omitted per-artist receipts', async () => {
  for (const on of [true, false]) {
    for (const status of [0, 1, 2, 3, 4, 5, 6, 7, undefined, null, 8, '1']) {
      let writes = 0
      const catalog = new Catalog(saved, { request: async (_, path) => {
        if (path === '/luna/pc/artists/92') return { artist_info: artist('92') }
        writes++
        return { [on ? 'collect_artist_status' : 'deleted_artist_status']: { '92': status } }
      } })
      const pending = followArtist(catalog, '92', on)
      if (status == null || (Number.isInteger(status) && status <= 7 && (![0, 3].includes(status) === on))) await pending
      else await assert.rejects(pending, { kind: status === 8 || status === '1' ? 'response' : 'rejected' })
      assert.equal(writes, 1)
      assert.equal(catalog.state.collections.has('artist'), false)
    }
  }
})

// Repeated item_types must survive URL signing; one comma-joined value changes the official request.
test('bundle signs collection reads and mutations and preserves repeated query parameters', async () => {
  const service = catalogService({
    '/luna/pc/me/collection/mixed': [call => {
      assert.deepEqual(call.parsed.searchParams.getAll('item_types'), ['album', 'playlist'])
      return { mixed_collections: [{ item_type: 'album', album: album('93') }], has_more: false }
    }],
    '/luna/pc/artists/92': [{ artist_info: artist('92') }],
    '/luna/pc/me/collection/artist': [{ artist_ids: ['92'] }],
    '/luna/pc/me/collection/album/delete': [{ deleted_albums: ['93'] }],
  })
  const s = await sandbox([], saved, { sign: true, request: service.request })
  const page = await s.api.savedAlbums()
  assert.equal(page.albums[0].id, '93')
  await s.api.followArtist({ id: '92', on: true })
  await s.api.saveAlbum({ id: '93', on: false })
  assert.equal(s.spawned(), 3)
  await s.api.signOut()
  await assert.rejects(s.api.savedAlbums(), err => err.code === 'signIn')
  for (const path of ['/luna/me/collection/artist', '/luna/pc/me/collection/mixed']) {
    await assert.rejects(requestJSON(saved, path), { kind: 'response' })
    await assert.rejects(requestJSON(saved, path, { signed: true, body: {} }), { kind: 'response' })
  }
})

// An old account's pending collection list must never become a new account's library.
test('sign-out discards a late saved-album response', async () => {
  let release, started = false
  const service = catalogService({ '/luna/pc/me/collection/mixed': [() => {
    started = true
    return new Promise(resolve => { release = () => resolve({ mixed_collections: [{ item_type: 'album', album: album('93') }], has_more: false }) })
  }] })
  const s = await sandbox([], saved, { sign: true, request: service.request })
  const pending = s.api.savedAlbums(), rejected = assert.rejects(pending, err => err.code === 'signIn')
  await until(() => started)
  await s.api.signOut()
  release()
  await rejected
})
