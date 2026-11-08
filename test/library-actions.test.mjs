import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as library from '../helper/library-actions.mjs'

const mine = (id = '10', type = 2, extra = {}) => ({ id, type, title: 'Fixture', owner: { id: '7' }, ...extra })
function fixture(playlists = [mine()], deps = {}) {
  const calls = []
  const catalog = {
    session: { account: { id: '7' } },
    request: async (path, opts) => {
      calls.push({ path, ...opts })
      if (opts.body !== undefined) return deps.write ? deps.write(path, opts) : {}
      return deps.read ? deps.read(path, opts) : { playlists, has_more: false }
    },
    playlist: deps.playlist ?? (async id => ({ id, tracks: [{ id: '1' }, { id: '2' }] })),
  }
  return { catalog, calls, writes: () => calls.filter(call => call.body !== undefined) }
}

test('maps only confirmed owner, collection and fixed type evidence', () => {
  for (const type of [2, 3, 11]) assert.deepEqual(library.playlistFlags(mine('10', type), '7'), { mine: true })
  for (const type of [1, 4]) assert.deepEqual(library.playlistFlags(mine('10', type), '7'), { mine: true, fixed: true })
  assert.deepEqual(library.playlistFlags(mine('10', 2, { state: { is_collected: true } }), '8'), { saved: true })
  for (const raw of [undefined, {}, { id: '10', type: 2 }, mine('10', 999), mine('10', '2'), mine('qishui:history'), mine('10', 2, { owner: { id: 7 } })]) {
    assert.deepEqual(library.playlistFlags(raw, '7'), {})
  }
  for (const state of [{}, { is_collected: false }, { is_collected: 1 }, { is_collected: 'true' }]) {
    assert.deepEqual(library.playlistFlags(mine('10', 2, { state }), '8'), {})
  }
  assert.deepEqual(library.playlistFlags(mine(), undefined), {})
})

test('issues exact signed collection mutations and returns void', async () => {
  const f = fixture()
  assert.equal(await library.like(f.catalog, '12345678901234567890', true), undefined)
  await library.like(f.catalog, '2', false)
  await library.savePlaylist(f.catalog, '3', true)
  await library.savePlaylist(f.catalog, '3', false)
  assert.deepEqual(f.calls, [
    { path: '/luna/pc/me/collection/media', signed: true, body: { scene: '', media: [{ id: '12345678901234567890', type: 'track' }] } },
    { path: '/luna/pc/me/collection/media/delete', signed: true, body: { media: [{ id: '2', type: 'track' }] } },
    { path: '/luna/pc/me/collection/playlist', signed: true, body: { playlist_ids: ['3'] } },
    { path: '/luna/pc/me/collection/playlist/delete', signed: true, body: { playlist_ids: ['3'] } },
  ])
})

test('rejects unsafe IDs and coercible booleans before any request', async () => {
  const f = fixture()
  const invalid = ['synthetic', 'qishui:history', '', '1'.repeat(33), ' 1', '1 ', '-1', '1.2', '1e2', '1\n', 1, 1n, null, {}, undefined]
  for (const id of invalid) {
    for (const action of ['like', 'savePlaylist']) await assert.rejects(library[action](f.catalog, id, true), { kind: 'response' })
    await assert.rejects(library.renamePlaylist(f.catalog, id, 'Name'), { kind: 'response' })
    await assert.rejects(library.deletePlaylist(f.catalog, id), { kind: 'response' })
    await assert.rejects(library.addToPlaylist(f.catalog, id, ['1']), { kind: 'response' })
    await assert.rejects(library.removeFromPlaylist(f.catalog, id, ['1']), { kind: 'response' })
  }
  for (const on of [0, 1, 'true', 'false', null, undefined, {}]) {
    for (const action of ['like', 'savePlaylist']) await assert.rejects(library[action](f.catalog, '1', on), { kind: 'response' })
  }
  assert.deepEqual(f.calls, [])
})

test('validates entire nonempty bounded ID arrays before any reads or writes', async () => {
  const f = fixture()
  for (const ids of [[], ['1', 'qishui:history'], ['1', 2], ['1', 'synthetic'], Array(1001).fill('1'), new Array(2), {}, undefined]) {
    for (const action of ['addToPlaylist', 'removeFromPlaylist']) await assert.rejects(library[action](f.catalog, '10', ids), { kind: 'response' })
    await assert.rejects(library.isLiked(f.catalog, ids), { kind: 'response' })
  }
  assert.deepEqual(f.calls, [])
})

test('creates using trimmed names, official UTF-16 length limit and exact body', async () => {
  const f = fixture([], { write: async () => ({ playlist: { id: '12345678901234567890' } }) })
  assert.equal(await library.createPlaylist(f.catalog, '  我的 🎵 歌单  '), '12345678901234567890')
  assert.deepEqual(f.writes()[0], { path: '/luna/pc/me/playlist', signed: true, body: { name: '我的 🎵 歌单', is_private: false, media: [] } })
  await library.createPlaylist(f.catalog, '🎵'.repeat(15))
  for (const name of ['', ' \t ', 'a'.repeat(31), '🎵'.repeat(16), 'a\nb', 'a\0b', 'a‮b', '\ud800', 1, null]) {
    const before = f.calls.length
    await assert.rejects(library.createPlaylist(f.catalog, name), { kind: 'response' })
    await assert.rejects(library.renamePlaylist(f.catalog, '10', name), { kind: 'response' })
    assert.equal(f.calls.length, before)
  }
  for (const response of [{}, { playlist: { id: 12 } }, { playlist: { id: 'qishui:history' } }]) {
    const bad = fixture([], { write: async () => response })
    await assert.rejects(library.createPlaylist(bad.catalog, 'Name'), { kind: 'response' })
    assert.equal(bad.calls.length, 1)
  }
})

test('reads all authenticated pages, deduplicates boundaries and defaults omitted has_more to false', async () => {
  const f = fixture([], { read: async (_, { query }) => query.cursor === ''
    ? { playlists: [mine('1')], has_more: true, next_cursor: 'opaque' }
    : { playlists: [mine('1'), mine('2')], next_cursor: 'leftover' } })
  assert.deepEqual((await library.ownPlaylists(f.catalog)).map(raw => raw.id), ['1', '2'])
  assert.deepEqual(f.calls.map(call => [call.query, call.signed]), [[{ cursor: '', count: '50' }, true], [{ cursor: 'opaque', count: '50' }, true]])
})

test('authorizes ordinary own edits only after full pagination and uses exact mutation bodies', async () => {
  for (const type of [2, 3, 11]) {
    const f = fixture([], { read: async (_, { query }) => query.cursor === ''
      ? { playlists: [mine('10', type)], has_more: true, next_cursor: 'next' }
      : { playlists: [], has_more: false } })
    assert.equal(await library.renamePlaylist(f.catalog, '10', ' New '), undefined)
    assert.equal(f.calls.length, 3)
    await library.deletePlaylist(f.catalog, '10')
    await library.addToPlaylist(f.catalog, '10', ['1', '2', '1'])
    await library.removeFromPlaylist(f.catalog, '10', ['1'])
    assert.deepEqual(f.writes(), [
      { path: '/luna/pc/me/playlist/update', body: { playlist_id: '10', name: 'New' }, signed: true },
      { path: '/luna/pc/me/playlist/delete', body: { playlist_ids: ['10'] }, signed: true },
      { path: '/luna/pc/me/playlist/media/append', body: { playlist_id: '10', media: [{ id: '1', type: 'track' }, { id: '2', type: 'track' }] }, signed: true },
      { path: '/luna/pc/me/playlist/media/delete', body: { playlist_id: '10', media: [{ id: '1', type: 'track' }] }, signed: true },
    ])
  }
})

test('rejects absent, other-owner, ownerless, unknown and Douyin lists without writes', async () => {
  for (const playlists of [[], [mine('99')], [mine('10', 2, { owner: { id: '8' } })], [mine('10', 2, { owner: undefined })], [mine('10', 999)], [mine('10', '2')], [mine('10', 4)]]) {
    const f = fixture(playlists)
    await assert.rejects(library.renamePlaylist(f.catalog, '10', 'Name'), { kind: 'unsupported' })
    await assert.rejects(library.deletePlaylist(f.catalog, '10'), { kind: 'unsupported' })
    await assert.rejects(library.addToPlaylist(f.catalog, '10', ['1']), { kind: 'unsupported' })
    await assert.rejects(library.removeFromPlaylist(f.catalog, '10', ['1']), { kind: 'unsupported' })
    assert.deepEqual(f.writes(), [])
  }
})

test('routes true owned type1 track edits through collection and blocks rename/delete', async () => {
  const f = fixture([mine('10', 1, { title: 'Arbitrary title' })])
  await library.addToPlaylist(f.catalog, '10', ['1', '2'])
  await library.removeFromPlaylist(f.catalog, '10', ['1'])
  await assert.rejects(library.renamePlaylist(f.catalog, '10', 'Name'), { kind: 'unsupported' })
  await assert.rejects(library.deletePlaylist(f.catalog, '10'), { kind: 'unsupported' })
  assert.deepEqual(f.writes(), [
    { path: '/luna/pc/me/collection/media', body: { scene: '', media: [{ id: '1', type: 'track' }, { id: '2', type: 'track' }] }, signed: true },
    { path: '/luna/pc/me/collection/media/delete', body: { media: [{ id: '1', type: 'track' }] }, signed: true },
  ])
})

test('rejects malformed and cycling pages even when an editable target already appeared', async () => {
  for (const response of [null, {}, { playlists: {} }, { playlists: [null] }, { playlists: [mine('qishui:history')] },
    { playlists: [], has_more: 'true' }, { playlists: [], has_more: null },
    ...['', '0', undefined, {}, 'x\n', 'a'.repeat(8193)].map(next_cursor => ({ playlists: [mine()], has_more: true, next_cursor }))]) {
    const f = fixture([], { read: async () => response })
    await assert.rejects(library.deletePlaylist(f.catalog, '10'), { kind: 'response' })
    assert.deepEqual(f.writes(), [])
  }
  for (const continuation of [
    { playlists: [mine()], has_more: true, next_cursor: 'loop' },
    { playlists: [mine('10', 4)], has_more: false },
    { playlists: [mine('10', 2, { owner: { id: '8' } })], has_more: false },
  ]) {
    const f = fixture([], { read: async (_, { query }) => query.cursor === ''
      ? { playlists: [mine()], has_more: true, next_cursor: 'loop' } : continuation })
    await assert.rejects(library.deletePlaylist(f.catalog, '10'), { kind: 'response' })
    assert.deepEqual(f.writes(), [])
  }
})

test('bounds full-library memory and request count', async () => {
  const pages = fixture([], { read: async (_, { query }) => ({ playlists: [], has_more: true, next_cursor: String(Number(query.cursor || 0) + 1) }) })
  await assert.rejects(library.ownPlaylists(pages.catalog), { kind: 'response' })
  assert.equal(pages.calls.length, 500)
  const size = fixture([], { read: async () => ({ playlists: Array(25001).fill(mine()) }) })
  await assert.rejects(library.ownPlaylists(size.catalog), { kind: 'response' })
  assert.equal(size.calls.length, 1)
})

test('requires a decimal current-account ID and rejects account changes during authorization', async () => {
  for (const id of [undefined, 'qishui:history', 7]) {
    const f = fixture()
    f.catalog.session.account.id = id
    await assert.rejects(library.deletePlaylist(f.catalog, '10'), { kind: 'session' })
    assert.deepEqual(f.calls, [])
  }
  const f = fixture([], { read: async () => {
    f.catalog.session.account.id = '8'
    return { playlists: [mine()] }
  } })
  await assert.rejects(library.deletePlaylist(f.catalog, '10'), { kind: 'session' })
  assert.deepEqual(f.writes(), [])
})

test('liked pages and membership resolve the fully loaded type1 identity, never a name', async () => {
  const tracks = Array.from({ length: 55 }, (_, i) => ({ id: String(i + 1) }))
  const resolved = []
  const f = fixture([mine('90', 2, { title: 'Liked' }), mine('91', 4), mine('92', 1, { title: 'Anything' })], {
    playlist: async id => { resolved.push(id); return { id, tracks } },
  })
  assert.deepEqual(await library.liked(f.catalog, 50), { tracks: tracks.slice(50), more: false })
  assert.deepEqual(await library.liked(f.catalog), { tracks: tracks.slice(0, 50), more: true })
  assert.deepEqual(await library.isLiked(f.catalog, ['1', '55', '56']), { 1: true, 55: true, 56: false })
  assert.deepEqual(resolved, ['92', '92', '92'])
  for (const offset of [-1, 0.5, '0', 25001, NaN]) await assert.rejects(library.liked(f.catalog, offset), { kind: 'response' })
})

test('membership never turns absent IDs false after incomplete or failed loading and never caches partial state', async () => {
  let complete = false
  const f = fixture([mine('10', 1)], { playlist: async id => {
    if (!complete) throw Object.assign(new Error('response'), { kind: 'response' })
    return { id, tracks: [{ id: '9' }] }
  } })
  await assert.rejects(library.isLiked(f.catalog, ['9']), { kind: 'response' })
  complete = true
  assert.deepEqual(await library.isLiked(f.catalog, ['9', '8']), { 9: true, 8: false })
  for (const playlists of [[], [mine('10', 2, { title: 'Liked' })], [mine('10', 1, { owner: { id: '8' } })], [mine('10', 1), mine('11', 1)]]) {
    await assert.rejects(library.isLiked(fixture(playlists).catalog, ['9']), { kind: 'response' })
  }
  for (const result of [{ id: '99', tracks: [] }, { id: '10' }, { id: '10', tracks: [{ id: 'qishui:history' }] }, { id: '10', tracks: Array(25001).fill({ id: '1' }) }]) {
    await assert.rejects(library.isLiked(fixture([mine('10', 1)], { playlist: async () => result }).catalog, ['9']), { kind: 'response' })
  }
})

test('copies validated track IDs before authorization awaits', async () => {
  const ids = ['1']
  const f = fixture([], { read: async () => { ids[0] = 'qishui:history'; return { playlists: [mine()] } } })
  await library.addToPlaylist(f.catalog, '10', ids)
  assert.deepEqual(f.writes()[0].body.media, [{ id: '1', type: 'track' }])
})

test('never retries any failed write', async () => {
  const failure = Object.assign(new Error('network'), { kind: 'network' })
  for (const perform of [
    c => library.like(c, '1', true), c => library.like(c, '1', false),
    c => library.savePlaylist(c, '1', true), c => library.savePlaylist(c, '1', false),
    c => library.createPlaylist(c, 'Name'), c => library.renamePlaylist(c, '10', 'Name'),
    c => library.deletePlaylist(c, '10'), c => library.addToPlaylist(c, '10', ['1']), c => library.removeFromPlaylist(c, '10', ['1']),
    c => library.addToPlaylist(c, '20', ['1']), c => library.removeFromPlaylist(c, '20', ['1']),
  ]) {
    const f = fixture([mine(), mine('20', 1)], { write: async () => { throw failure } })
    await assert.rejects(perform(f.catalog), failure)
    assert.equal(f.writes().length, 1)
  }
})
