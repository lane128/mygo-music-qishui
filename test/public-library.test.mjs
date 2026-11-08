import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Catalog, requestJSON } from '../helper/catalog.mjs'
import { sandbox, session } from './fixtures/plugin-sandbox.mjs'
import { catalogService, track } from './fixtures/catalog-service.mjs'

// A list newly exposed by sidebar pagination may omit its detail metadata; recovery must search later library pages too.
test('recovers empty playlist metadata beyond the first library page', async () => {
  const cursors = []
  const catalog = new Catalog({ ...session, account: { id: '7' } }, { request: async (_, path, { query }) => {
    if (path === '/luna/pc/playlist/detail') return { playlist: {}, next_cursor: '0' }
    assert.equal(path, '/luna/pc/me/playlist')
    cursors.push(query.cursor)
    return query.cursor === ''
      ? { playlists: [{ id: '93', title: 'Other' }], has_more: true, next_cursor: 'tail' }
      : { playlists: [{ id: '94', title: 'Empty own playlist', count_tracks: 0, owner: { id: '7' }, type: 2 }], has_more: false }
  } })
  const result = await catalog.playlist('94')
  assert.equal(result.name, 'Empty own playlist')
  assert.equal(result.mine, true)
  assert.deepEqual(result.tracks, [])
  assert.deepEqual(cursors, ['', 'tail'])
})

const album = id => ({ id, name: 'Fixture Album', artists: [{ id: '92', name: 'Fixture Artist' }], release_date: 1759276800 })
const group = (kind, entries, more = false, cursor) => ({ result_groups: [{ id: kind + 's', data: entries.map(raw => ({ entity: { [kind]: raw } })), has_more: more, next_cursor: cursor }] })

// Opening an album preserves source song order and metadata through the actual standalone bundle.
test('album maps release date and songs without helper or credentials', async () => {
  const service = catalogService({ '/luna/pc/albums/93': [call => {
    assert.equal(call.parsed.searchParams.get('ignore_tracks'), 'false')
    return { album_info: album('93'), tracks: [track('91'), { ...track('91'), name: 'Duplicate' }, track('94')] }
  }] })
  const s = await sandbox([], session, { allowSpawn: false, request: service.request })
  try {
    const page = await s.api.album({ id: '93' })
    assert.equal(page.album.released, '2025-10-01')
    assert.equal(page.album.artists[0].id, '92')
    assert.deepEqual(Array.from(page.tracks, t => t.id), ['91', '94'])
    assert.equal(page.tracks[0].name, 'Fixture Song')
    assert.equal(s.spawned(), 0)
  } finally { await s.api.signOut() }
  for (const result of [{ album_info: album('94') }, { album_info: { id: '93', name: '' } }, { album_info: album('93'), tracks: {} }]) {
    await assert.rejects(new Catalog(session, { request: async () => result }).album('93'), { kind: 'response' })
  }
})

// PC search_id must stay constant through filtered/duplicate pages, and offset counts visible unique results.
test('PC entity search skips empty pages and keeps search identity and cursor', async () => {
  let searchID
  const replies = [group('album', [album('93')], true, 'cursor-a'), group('album', [], true, 'cursor-b'), group('album', [album('93'), album('94')], false)]
  const service = catalogService({ '/luna/pc/search/album': replies.map((reply, i) => call => {
    const q = call.parsed.searchParams
    searchID ??= q.get('search_id')
    assert.equal(q.get('search_id'), searchID)
    assert.equal(q.get('cursor'), ['0', 'cursor-a', 'cursor-b'][i])
    assert.equal(q.has('count'), false)
    return reply
  }) })
  const s = await sandbox([], session, { allowSpawn: false, request: service.request })
  try {
    const first = await s.api.search({ query: 'Fixture', kind: 'albums' })
    assert.equal(first.albums[0].id, '93')
    assert.equal(first.more, true)
    const next = await s.api.search({ query: 'Fixture', kind: 'albums', offset: 1 })
    assert.deepEqual(Array.from(next.albums, a => a.id), ['94'])
    assert.equal(next.more, false)
    assert.equal(service.calls.length, 3)
    assert.equal(s.spawned(), 0)
  } finally { await s.api.signOut() }
})

// All native entity search tabs have matching remote mappers; suggestions use official strings only.
test('artist and playlist searches and suggestions expose native shapes', async () => {
  const service = catalogService({
    '/luna/pc/search/artist': [group('artist', [{ id: '92', name: 'Fixture Artist' }])],
    '/luna/pc/search/playlist': [group('playlist', [{ id: '94', title: 'Fixture Playlist' }])],
    '/luna/pc/sug': [{ sugs: [{ suggestion: 'Fixture' }, { suggestion: 'Fixture' }, { suggestion: 'Other' }] }],
  })
  const s = await sandbox([], session, { allowSpawn: false, request: service.request })
  try {
    assert.equal((await s.api.search({ query: 'Fixture', kind: 'artists' })).artists[0].name, 'Fixture Artist')
    assert.equal((await s.api.search({ query: 'Fixture', kind: 'playlists' })).playlists[0].name, 'Fixture Playlist')
    assert.deepEqual(Array.from(await s.api.suggest({ query: 'Fix' })), ['Fixture', 'Other'])
    assert.deepEqual(Array.from(await s.api.suggest({ query: '  ' })), [])
    assert.equal(service.calls.length, 3)
  } finally { await s.api.signOut() }
})

// Cursor cycles and malformed group responses must fail rather than hang or return a truncated result.
test('PC search rejects repeated cursors and preserves strict public GET boundaries', async () => {
  const catalog = new Catalog(session, { request: async () => group('album', [], true, 'loop') })
  await assert.rejects(catalog.search({ query: 'Fixture', kind: 'albums' }), { kind: 'response' })
  for (const path of ['/luna/pc/albums/93', '/luna/pc/search/artist', '/luna/pc/search/album', '/luna/pc/search/playlist', '/luna/pc/sug']) {
    for (const options of [{ signed: true }, { body: {} }]) await assert.rejects(requestJSON(session, path, options), { kind: 'response' })
  }
  for (const path of ['/luna/pc/comments/create', '/luna/pc/comments/action', '/luna/pc/me/playlist/delete']) {
    await assert.rejects(requestJSON(session, path, { body: {} }), { kind: 'response' })
  }
})
