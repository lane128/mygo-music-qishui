// Official PC 3.7.0 CollectArtists / CollectAlbum and mixed-collection contracts.
// Public artist/album metadata remains credential-free; account state comes from signed collections.
import { error } from './protocol.mjs'

const validID = id => typeof id === 'string' && /^\d{1,32}$/.test(id)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const routes = {
  artist: { path: '/luna/me/collection/artist', field: 'artists' },
  album: { path: '/luna/pc/me/collection/mixed', field: 'mixed_collections' },
}
function accountOf(catalog) {
  const id = catalog.session?.account?.id
  if (!validID(id)) throw error('session')
  return id
}
function cacheOf(catalog) { return catalog.state.collections ??= new Map() }

export async function collectionList(catalog, kind) {
  const route = routes[kind]
  if (!route) throw error('response')
  const account = accountOf(catalog), cache = cacheOf(catalog)
  const existing = cache.get(kind)
  if (existing && existing.account === account && (existing.pending || Date.now() - existing.loadedAt < 30000)) return existing.pending || existing.rows
  const entry = { account }
  cache.set(kind, entry)
  entry.pending = (async () => {
    const rows = new Map(), cursors = new Set([''])
    let cursor = '', total = 0
    for (let page = 0; page < 500; page++) {
      const query = new URLSearchParams({ cursor, count: '50' })
      if (kind === 'album') { query.append('item_types', 'album'); query.append('item_types', 'playlist') }
      const result = await catalog.request(route.path, { query, signed: true })
      if (!object(result) || (result.has_more != null && typeof result.has_more !== 'boolean')) throw error('response')
      let items = result[route.field]
      // Empty PC mixed collections can omit both the list and pagination fields.
      // requestJSON has already rejected explicit upstream error codes.
      const emptyMixed = kind === 'album' && object(result.status_info) && result.total_num == null
      if (items == null && result.has_more !== true && (result.total_num === 0 || result.status_code === 0 || result.status_info?.code === 0 || emptyMixed)) items = []
      if (!Array.isArray(items) || (total += items.length) > 25000) throw error('response')
      for (const item of items) {
        if (!object(item)) throw error('response')
        if (kind === 'album' && item.item_type !== 'album') continue
        const row = kind === 'album' ? item.album : item
        if (!object(row) || !validID(row.id)) throw error('response')
        rows.set(row.id, row)
      }
      if (accountOf(catalog) !== account) throw error('session')
      if (cache.get(kind) !== entry) throw error('response')
      if (result.has_more !== true) {
        entry.rows = [...rows.values()]
        entry.loadedAt = Date.now()
        return entry.rows
      }
      const next = result.next_cursor
      if (typeof next !== 'string' || !next || next.length > 8192 || /[\x00-\x1f\x7f]/.test(next) || cursors.has(next)) throw error('response')
      cursor = next
      cursors.add(cursor)
    }
    throw error('response')
  })()
  try { return await entry.pending }
  catch (failure) { if (cache.get(kind) === entry) cache.delete(kind); throw failure }
  finally { entry.pending = null }
}

// Artist detail uses `user` (track briefs use `user_info`). Type 2 follows the
// bound user; type 1 and legacy details without a type collect the catalog artist.
function userID(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (!validID(id)) throw error('response')
  return id
}
function artistTarget(raw, id = raw?.id) {
  if (!object(raw) || !validID(id) || raw.id !== id) throw error('response')
  if (raw.user_artist_type === 2) {
    return { kind: 'user', id: userID(raw.user?.id) }
  }
  if (raw.user_artist_type != null && raw.user_artist_type !== 1) throw error('unsupported')
  return { kind: 'artist', id }
}
function followed(status) {
  if (!Number.isInteger(status) || status < 0 || status > 7) throw error('response')
  return ![0, 3].includes(status)
}
function checkAccount(catalog, account) {
  if (accountOf(catalog) !== account) throw error('session')
  if (catalog.signal?.aborted) throw error('canceled')
}
export async function artistFollowing(catalog, raw) {
  const account = accountOf(catalog)
  const target = artistTarget(raw)
  if (target.kind === 'artist') return (await collectionList(catalog, 'artist')).some(row => row.id === target.id)
  // Use the official client's preferred route; the fixed legacy alias can return an empty body.
  const result = await catalog.request(`/luna/users/${target.id}`, { signed: true, query: { user_id: target.id, sec_uid: '' } })
  checkAccount(catalog, account)
  if (!object(result) || userID(result.user?.id) !== target.id) throw error('response')
  return followed(result.my_user_state?.follow_status)
}

async function collect(catalog, kind, id, on) {
  if (!validID(id) || typeof on !== 'boolean') throw error('response')
  const account = accountOf(catalog)
  const locks = catalog.state.collectionLocks ??= new Set()
  const key = kind + ':' + id
  if (locks.has(key)) throw error('unsupported')
  locks.add(key)
  const cache = cacheOf(catalog)
  let invalidated = false
  try {
    let target
    if (kind === 'artist') {
      const detail = await catalog.request(`/luna/pc/artists/${id}`, { query: { locate_item_id: '' } })
      target = artistTarget(detail?.artist_info, id)
    }
    checkAccount(catalog, account)
    const user = target?.kind === 'user'
    // A user follow does not mutate the catalog-artist collection. Invalidate
    // only its own collection, so an unrelated paged artist read can finish.
    if (!user) { cache.delete(kind); invalidated = true }
    const result = await catalog.request(user ? `/luna/pc/me/${on ? 'follow' : 'unfollow'}` : `/luna/pc/me/collection/${kind}${on ? '' : '/delete'}`, {
      signed: true, body: user ? { user_id: target.id } : { [kind === 'artist' ? 'artist_ids' : 'album_ids']: [id] },
    })
    checkAccount(catalog, account)
    if (!object(result)) throw error('response')
    if (user) {
      if (result.user_id != null && userID(result.user_id) !== target.id) throw error('response')
      if (followed(result.follow_status) !== on) throw error('rejected')
      return
    }
    if (kind === 'artist') {
      const statuses = on ? result.collect_artist_status : result.deleted_artist_status
      if (statuses != null) {
        if (!object(statuses)) throw error('response')
        const status = statuses[id]
        if (status != null) {
          if (followed(status) !== on) throw error('rejected')
        }
      }
    }
    const ids = kind === 'artist' ? (on ? result.artist_ids : result.deleted_artists) : (on ? result.collected_albums : result.deleted_albums)
    if (ids != null && (!Array.isArray(ids) || !ids.includes(id))) throw error('response')
  } finally {
    // An ambiguous timeout must not retain a guessed before/after state. Never retry a write.
    if (invalidated) cache.delete(kind)
    locks.delete(key)
  }
}
export function followArtist(catalog, id, on) { return collect(catalog, 'artist', id, on) }
export function saveAlbum(catalog, id, on) { return collect(catalog, 'album', id, on) }
