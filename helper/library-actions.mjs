import { error } from './protocol.mjs'

const OWN_PATH = '/luna/pc/me/playlist'
const COLLECTION = '/luna/pc/me/collection'
const PAGE_SIZE = 50
const MAX_PAGES = 500
const MAX_ITEMS = 25000
const MAX_IDS = 1000
const ordinaryTypes = new Set([2, 3, 11])
const knownTypes = new Set([1, 2, 3, 4, 11])
const validID = value => typeof value === 'string' && /^\d{1,32}$/.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function idOf(id) {
  if (!validID(id)) throw error('response')
  return id
}

function idsOf(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IDS) throw error('response')
  // Copy before any await; one invalid entry must prevent the entire write.
  return Array.from(new Set(Array.from(ids, idOf)))
}

function booleanOf(on) {
  if (typeof on !== 'boolean') throw error('response')
  return on
}

function nameOf(name) {
  if (typeof name !== 'string') throw error('response')
  name = name.trim()
  // The official input uses native maxlength=30 and a UTF-16 .length counter.
  if (!name || name.length > 30 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name)) throw error('response')
  return name
}

function accountOf(catalog) {
  const id = catalog.session?.account?.id
  if (!validID(id)) throw error('session')
  return id
}

// Renderer usePlaylistStatus compares my_info.id with playlist.owner.id.
// Sidebar treats types 2/3/11 as owned lists; 1/4 are favorites/Douyin.
// Unknown types do not acquire editing capabilities from ownership alone.
export function playlistFlags(raw, accountId) {
  if (!object(raw) || !validID(raw.id) || !validID(accountId) || !validID(raw.owner?.id)) return {}
  if (raw.owner.id === accountId) {
    if (!knownTypes.has(raw.type)) return {}
    return { mine: true, ...(ordinaryTypes.has(raw.type) ? {} : { fixed: true }) }
  }
  return raw.state?.is_collected === true ? { saved: true } : {}
}

// Return raw metadata so the caller can retain its normal count/image mapping.
// This endpoint is authenticated; detail/search results cannot substitute for it.
export async function ownPlaylists(catalog) {
  const accountId = accountOf(catalog)
  const entries = new Map()
  const cursors = new Set([''])
  let cursor = '', total = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await catalog.request(OWN_PATH, { query: { cursor, count: String(PAGE_SIZE) }, signed: true })
    if (!object(result) || !Array.isArray(result.playlists) ||
        (result.has_more !== undefined && typeof result.has_more !== 'boolean')) throw error('response')
    total += result.playlists.length
    if (total > MAX_ITEMS) throw error('response')
    for (const raw of result.playlists) {
      if (!object(raw) || !validID(raw.id)) throw error('response')
      const old = entries.get(raw.id)
      if (old && (old.type !== raw.type || old.owner?.id !== raw.owner?.id)) throw error('response')
      entries.set(raw.id, raw)
    }
    // Missing has_more is terminal, regardless of a leftover next_cursor.
    if (result.has_more !== true) {
      if (accountOf(catalog) !== accountId) throw error('session')
      return [...entries.values()]
    }
    const next = typeof result.next_cursor === 'number' && Number.isSafeInteger(result.next_cursor)
      ? String(result.next_cursor) : result.next_cursor
    if (typeof next !== 'string' || !next || next === '0' || next.length > 8192 ||
        /[\x00-\x1f\x7f]/.test(next) || cursors.has(next)) throw error('response')
    cursor = next
    cursors.add(cursor)
  }
  throw error('response')
}

async function editablePlaylist(catalog, id, allowLiked = false) {
  const raw = (await ownPlaylists(catalog)).find(raw => raw.id === id)
  if (!raw || raw.owner?.id !== accountOf(catalog) ||
      !(ordinaryTypes.has(raw.type) || (allowLiked && raw.type === 1))) throw error('unsupported')
  return raw
}

async function playlistMutation(catalog, id, operation) {
  const locks = (catalog.state ??= {}).playlistLocks ??= new Set()
  if (locks.has(id)) throw error('unsupported')
  locks.add(id)
  try { return await operation() } finally { locks.delete(id) }
}

async function write(catalog, path, body) {
  // A mutation is issued exactly once, including on ambiguous transport errors.
  await catalog.request(path, { body, signed: true })
}

const mediaOf = ids => ids.map(id => ({ id, type: 'track' }))

async function collectMedia(catalog, ids, on) {
  const media = mediaOf(ids)
  await write(catalog, `${COLLECTION}/media${on ? '' : '/delete'}`, on ? { scene: '', media } : { media })
}

export async function like(catalog, id, on) {
  idOf(id)
  booleanOf(on)
  await collectMedia(catalog, [id], on)
}

export async function savePlaylist(catalog, id, on) {
  idOf(id)
  booleanOf(on)
  await write(catalog, `${COLLECTION}/playlist${on ? '' : '/delete'}`, { playlist_ids: [id] })
}

export async function createPlaylist(catalog, name) {
  name = nameOf(name)
  const result = await catalog.request(OWN_PATH, { body: { name, is_private: false, media: [] }, signed: true })
  return idOf(result?.playlist?.id)
}

export async function renamePlaylist(catalog, id, name) {
  idOf(id)
  name = nameOf(name)
  await playlistMutation(catalog, id, async () => {
    await editablePlaylist(catalog, id)
    await write(catalog, `${OWN_PATH}/update`, { playlist_id: id, name })
  })
}

export async function deletePlaylist(catalog, id) {
  idOf(id)
  await playlistMutation(catalog, id, async () => {
    await editablePlaylist(catalog, id)
    await write(catalog, `${OWN_PATH}/delete`, { playlist_ids: [id] })
    catalog.state.playlistOrder?.delete(id)
  })
}

async function changePlaylist(catalog, id, trackIds, on) {
  idOf(id)
  const ids = idsOf(trackIds)
  await playlistMutation(catalog, id, async () => {
    const raw = await editablePlaylist(catalog, id, true)
    // Even an ambiguous write may have changed the server list. Require a reload before reordering.
    catalog.state.playlistOrder?.delete(id)
    if (raw.type === 1) return collectMedia(catalog, ids, on)
    await write(catalog, `${OWN_PATH}/media/${on ? 'append' : 'delete'}`, { playlist_id: id, media: mediaOf(ids) })
  })
}

export async function addToPlaylist(catalog, id, trackIds) {
  await changePlaylist(catalog, id, trackIds, true)
}

export async function removeFromPlaylist(catalog, id, trackIds) {
  await changePlaylist(catalog, id, trackIds, false)
}

// The official SortPlaylistMedia contract uses /luna/me (no /pc alias) and the full desired order.
export async function movePlaylistTrack(catalog, id, from, to) {
  idOf(id)
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < 0) throw error('response')
  await playlistMutation(catalog, id, async () => {
    const snapshots = catalog.state.playlistOrder
    const before = snapshots?.get(id)
    if (!before?.sortSafe || !Array.isArray(before.ids) || from >= before.ids.length || to >= before.ids.length) throw error('unsupported')
    await editablePlaylist(catalog, id)
    // Indices are meaningful only while the server still matches the list shown in MyGO.
    await catalog.playlist(id)
    const fresh = snapshots.get(id)
    if (!fresh?.sortSafe || !Array.isArray(fresh.ids) || fresh.ids.length !== before.ids.length || fresh.ids.some((value, i) => value !== before.ids[i])) throw error('response')
    if (from === to) return
    const order = [...before.ids]
    order.splice(to, 0, ...order.splice(from, 1))
    snapshots.delete(id)
    await write(catalog, '/luna/me/playlist/media/sort', { playlist_id: id, media: mediaOf(order) })
    snapshots.set(id, { sortSafe: true, ids: order })
  })
}

async function likedTracks(catalog) {
  const lists = (await ownPlaylists(catalog)).filter(raw => raw.type === 1 && raw.owner?.id === accountOf(catalog))
  if (lists.length !== 1) throw error('response')
  // Catalog.playlist resolves every page and checks completeness. Never cache
  // a partial set, or infer false from one page or a title matching "Liked".
  const playlist = await catalog.playlist(lists[0].id)
  if (playlist?.id !== lists[0].id || !Array.isArray(playlist.tracks) || playlist.tracks.length > MAX_ITEMS) throw error('response')
  const tracks = new Map()
  for (const track of playlist.tracks) {
    if (!object(track) || !validID(track.id)) throw error('response')
    tracks.set(track.id, track)
  }
  return [...tracks.values()]
}

export async function liked(catalog, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_ITEMS) throw error('response')
  const tracks = await likedTracks(catalog)
  return { tracks: tracks.slice(offset, offset + PAGE_SIZE), more: offset + PAGE_SIZE < tracks.length }
}

export async function isLiked(catalog, ids) {
  ids = idsOf(ids)
  const likedIDs = new Set((await likedTracks(catalog)).map(track => track.id))
  return Object.fromEntries(ids.map(id => [id, likedIDs.has(id)]))
}
