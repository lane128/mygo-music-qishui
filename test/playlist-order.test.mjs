import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Catalog } from '../helper/catalog.mjs'
import { session, profile, until } from './fixtures/plugin-sandbox.mjs'

function fixture({ type = 2, owner = profile.id, video = false, write } = {}) {
  let ids = ['1', '2', '3']
  const writes = []
  const catalog = new Catalog({ ...session, account: profile }, { request: async (_, path, options) => {
    if (path === '/luna/pc/me/playlist') return { playlists: [{ id: '10', title: 'Mine', type, owner: { id: owner } }], has_more: false }
    if (path === '/luna/pc/playlist/detail') return {
      playlist: { id: '10', title: 'Mine', count_tracks: ids.length }, has_more: false,
      media_resources: [...ids.map(id => ({ type: 'track', entity: { track: { id, name: id } } })), ...(video ? [{ type: 'video', entity: { video: {} } }] : [])],
    }
    assert.equal(path, '/luna/me/playlist/media/sort')
    assert.equal(options.signed, true)
    writes.push(options.body)
    if (write) return write()
    ids = options.body.media.map(item => item.id)
    return { status_code: 0 }
  } })
  return { catalog, writes, change: order => { ids = order } }
}

// Moving is a full-order write, after checking owner and re-reading the exact order shown in MyGO.
test('reorders the complete playlist and supports the next move without dropping tracks', async () => {
  const f = fixture()
  await f.catalog.playlist('10')
  await f.catalog.movePlaylistTrack('10', 0, 2)
  assert.deepEqual(f.writes[0], { playlist_id: '10', media: ['2', '3', '1'].map(id => ({ id, type: 'track' })) })
  await f.catalog.movePlaylistTrack('10', 2, 1)
  assert.deepEqual(f.writes[1].media.map(item => item.id), ['2', '1', '3'])
})

// A changed server list, protected list, unsupported media or unknown snapshot must never be overwritten.
test('refuses unsafe, stale, fixed and foreign playlist reordering before writing', async () => {
  for (const options of [{ type: 1 }, { type: 4 }, { type: 999 }, { owner: '999' }, { video: true }]) {
    const f = fixture(options)
    await f.catalog.playlist('10')
    await assert.rejects(f.catalog.movePlaylistTrack('10', 0, 1))
    assert.equal(f.writes.length, 0)
  }
  const f = fixture()
  await assert.rejects(f.catalog.movePlaylistTrack('10', 0, 1), { kind: 'unsupported' })
  await f.catalog.playlist('10')
  f.change(['3', '2', '1'])
  await assert.rejects(f.catalog.movePlaylistTrack('10', 0, 1), { kind: 'response' })
  assert.equal(f.writes.length, 0)
  for (const index of [-1, 0.5, NaN, '0', 99]) await assert.rejects(f.catalog.movePlaylistTrack('10', index, 1))
  assert.equal(f.writes.length, 0)
})

// An uncertain sort result cannot be retried with a guessed snapshot, and overlapping local writes are rejected.
test('does not retry an ambiguous write or accept overlapping moves', async () => {
  let release
  const f = fixture({ write: () => new Promise((_, reject) => { release = () => reject(Object.assign(new Error('private transport'), { kind: 'network' })) }) })
  await f.catalog.playlist('10')
  const first = f.catalog.movePlaylistTrack('10', 0, 1)
  await assert.rejects(f.catalog.movePlaylistTrack('10', 1, 2), { kind: 'unsupported' })
  await until(() => release)
  release()
  await assert.rejects(first, { kind: 'network' })
  await assert.rejects(f.catalog.movePlaylistTrack('10', 0, 1), { kind: 'unsupported' })
  assert.equal(f.writes.length, 1)
})
