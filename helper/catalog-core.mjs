// Ported from mygo-cloudmusic/internal/qishui/{catalog,client,feed,pc}.go.
import { API, cookieHeader, decodeResponse, error } from './protocol.mjs'
import { feedBody, modesOf } from './discovery.mjs'
import { stringifyBody } from './json-body.mjs'
import { signedClient } from './client-profile.mjs'
import { discoveryBody, discoveryOf } from './exploration.mjs'
import { homePage } from './home-page.mjs'
import { HISTORY_ID, HISTORY_PATH, HISTORY_LIMIT, historyPlaylist } from './history.mjs'
import * as Library from './library-actions.mjs'
import { readComments, likeComment, postComment } from './comments.mjs'
import { avatarURL } from './avatar.mjs'
import { lyricsOf } from './lyrics.mjs'
import * as Collections from './collections.mjs'
export { normalizeLyrics } from './lyrics.mjs'

const PAGE_SIZE = 20
const idOf = value => {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) throw error('response')
  const id = String(value)
  if (!id.trim() || id.length > 512 || /[\x00-\x1f\x7f]/.test(id)) throw error('response')
  return id
}
export function validateSession(session) {
  if (session?.version !== 1 || !/^\d{16}$/.test(session.deviceID) || !/^\d{15}$/.test(session.installID)) throw error('session')
  const storedCookies = session.cookies
  return cookieHeader(storedCookies)
}
export function pcCatalogParams(session) {
  return new URLSearchParams({
    aid: '386088', app_name: 'luna_pc', region: 'cn', geo_region: 'cn', os_region: 'cn', sim_region: '',
    device_id: session.deviceID, cdid: '', iid: session.installID, version_name: '3.3.0', version_code: '30030000',
    channel: 'official', build_mode: 'master', network_carrier: '', ac: 'wifi', tz_name: 'Asia/Shanghai', resolution: '',
    device_platform: 'windows', device_type: 'Windows', os_version: 'Windows 11', fp: session.deviceID,
  })
}
export const isPublicCatalogPath = path => typeof path === 'string' && (
  /^\/luna\/pc\/artists\/\d{1,32}(?:\/(?:tracks|albums))?$/.test(path) ||
  /^\/luna\/pc\/albums\/\d{1,32}$/.test(path) ||
  /^\/luna\/pc\/(?:search\/(?:artist|album|playlist)|sug)$/.test(path)
)
export const libraryWritePaths = [
  '/luna/pc/comments/action', '/luna/pc/comments/create',
  '/luna/pc/me/collection/media', '/luna/pc/me/collection/media/delete',
  '/luna/pc/me/collection/playlist', '/luna/pc/me/collection/playlist/delete',
  '/luna/pc/me/playlist/update', '/luna/pc/me/playlist/delete',
  '/luna/pc/me/playlist/media/append', '/luna/pc/me/playlist/media/delete',
  '/luna/pc/me/collection/artist', '/luna/pc/me/collection/artist/delete',
  '/luna/pc/me/collection/album', '/luna/pc/me/collection/album/delete',
  '/luna/me/playlist/media/sort',
  '/luna/pc/me/follow', '/luna/pc/me/unfollow',
]
export const collectionReadPaths = ['/luna/me/collection/artist', '/luna/pc/me/collection/mixed', '/luna/user/info']
const paths = new Set([HISTORY_PATH, '/luna/pc/me/playlist', '/luna/pc/playlist/detail', '/luna/search/track', '/luna/pc/track_v2', '/luna/pc/feed/mode', '/luna/pc/feed/song-tab', '/luna/pc/discover', '/luna/pc/discover/mix', '/luna/pc/feed/radio/tracks', '/luna/pc/comments', ...collectionReadPaths, ...libraryWritePaths])
export async function requestJSON(session, path, { query = {}, body, signed = false, signal } = {}, deps = {}) {
  const artist = isPublicCatalogPath(path)
  const userInfo = /^\/luna\/users\/\d{1,32}$/.test(path)
  if (!paths.has(path) && !artist && !userInfo) throw error('response')
  // Verified public metadata routes never receive account credentials.
  if (artist && (body !== undefined || signed)) throw error('response')
  if (libraryWritePaths.includes(path) && (body === undefined || !signed)) throw error('response')
  if ((collectionReadPaths.includes(path) || userInfo) && (body !== undefined || !signed)) throw error('response')
  if (path === '/luna/pc/me/playlist' && body !== undefined && !signed) throw error('response')
  if (path === '/luna/pc/comments' && (body !== undefined || !signed)) throw error('response')
  const cookies = validateSession(session)
  const params = signed || artist ? pcCatalogParams(session) : new URLSearchParams()
  const supplied = new URLSearchParams(query)
  for (const name of new Set(supplied.keys())) params.delete(name)
  for (const [name, value] of supplied) params.append(name, value)
  const headers = { 'User-Agent': 'LunaPC/3.0.0(290101097)', Accept: 'application/json', ...(artist ? {} : { Cookie: cookies }) }
  let data
  if (body !== undefined) {
    data = stringifyBody(body)
    headers['Content-Type'] = 'application/json; charset=utf-8'
  }
  if (path === '/luna/search/track') {
    headers['User-Agent'] = 'com.luna.music/100198030 (Linux; U; Android 15; zh_CN; ABR-AL80; Build/V417IR;tt-ok/3.12.13.19)'
    headers['Content-Type'] = 'application/json; charset=UTF-8'
  }
  if (signed || artist) {
    params.set('version_name', '3.7.0')
    params.set('version_code', '30070000')
    for (const [key, value] of Object.entries(signedClient(deps.platform))) params.set(key, value)
    Object.assign(headers, {
      'User-Agent': 'LunaPC/3.7.0(452316191)', 'Accept-Encoding': 'identity',
      'X-Luna-Background-Type': 'foreground', 'X-Luna-Is-Background-Req': '0', 'X-Luna-Is-Local-User': path === HISTORY_PATH ? '1' : '0',
      ...(data === undefined ? {} : { 'X-SS-STUB': deps.md5(data).toUpperCase() }),
    })
  }
  params.sort()
  const url = API + path + '?' + params
  if (signed) {
    const sign = deps.sign
    if (typeof sign !== 'function') throw error('signature')
    const result = await sign({ url, headers, did: session.deviceID, signal })
    const names = Object.keys(result || {})
    if (names.length !== 2 || names.some(name => !/^x-(helios|medusa)$/i.test(name)) ||
        !names.some(name => /^x-helios$/i.test(name)) || !names.some(name => /^x-medusa$/i.test(name)) ||
        Object.values(result).some(value => typeof value !== 'string' || !value || /[\r\n\0]/.test(value))) throw error('signature')
    Object.assign(headers, result)
  }
  return fetchJSON(url, { headers, body: data, method: data === undefined ? 'GET' : 'POST', signal }, deps.fetch, path === HISTORY_PATH ? 8 * 1048576 : 1048576)
}

async function fetchJSON(url, options, request = fetch, limit = 1048576) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const parent = options.signal
  if (parent?.aborted) throw error('canceled')
  parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 20000)
  let reader
  try {
    const response = await request(url, { ...options, redirect: 'error', signal: controller.signal })
    if (controller.signal.aborted) throw error('network')
    reader = response.body.getReader()
    let body = '', bytes = 0
    const decoder = new TextDecoder()
    for (;;) {
      const part = await reader.read()
      if (controller.signal.aborted) throw error('network')
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > limit) throw error('response')
      body += decoder.decode(part.value, { stream: true })
    }
    body += decoder.decode()
    return decodeResponse({ status: response.status, body }, limit)
  } catch (err) {
    if (reader) { try { await reader.cancel() } catch { /* Discard transport details. */ } }
    throw err.kind ? err : error('network')
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
    reader?.releaseLock?.()
  }
}

export function image(raw, suffix = '~c5_{size}x{size}.jpg') {
  if (typeof raw === 'string') {
    try { return new URL(raw).protocol === 'https:' ? raw : undefined } catch { return undefined }
  }
  if (raw?.uri && raw.template_prefix) return `https://p3-luna.douyinpic.com/img/${raw.uri}~${raw.template_prefix}-resize:%7Bsize%7D:%7Bsize%7D.png`
  for (const entry of raw?.urls || []) {
    try {
      const url = new URL(entry)
      if (url.protocol !== 'https:') continue
      if (raw.uri && !url.pathname.includes(raw.uri)) url.pathname = url.pathname.replace(/\/$/, '') + '/' + raw.uri.replace(/^\//, '')
      if (!url.pathname.includes('~')) url.pathname += suffix
      return url.href
    } catch { /* Try the next cover. */ }
  }
}
export function trackOf(raw) {
  if (!raw || (raw.name != null && typeof raw.name !== 'string') || !Number.isFinite(raw.duration ?? 0) || (raw.duration ?? 0) < 0) throw error('response')
  const id = idOf(raw.id)
  return {
    id, name: raw.name || '', duration: raw.duration ?? 0,
    // Verified official public song page; no per-track request or account/share token.
    ...(/^\d{1,32}$/.test(id) ? { url: `https://music.douyin.com/qishui/share/track?track_id=${id}` } : {}),
    artists: (raw.artists || []).map(a => ({ id: a.id == null || a.id === '' ? '' : idOf(a.id), name: a.name || '' })),
    album: { id: raw.album?.id == null ? '' : idOf(raw.album.id), name: raw.album?.name || '', imageUrl: image(raw.album?.cover_url || raw.album?.url_cover) },
  }
}
function playlistCount(raw, strict = true) {
  const counts = [raw.count_tracks, raw.resource_cnt?.track_cnt].filter(value => value != null).map(value => {
    if (typeof value === 'string' && /^\d{1,16}$/.test(value)) value = Number(value)
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  })
  // These are independent metadata fields, not consistency checks. The PC
  // client uses count_tracks; the reference client falls back to resource_cnt
  // only for zero/missing legacy counts. Real liked playlists can have two
  // different positive counts while returning valid, explicitly paged songs.
  if (counts.includes(undefined)) {
    if (strict) throw error('response')
    return undefined
  }
  return counts.find(value => value > 0) ?? counts[0]
}

function paginationOf(result, cursor) {
  const raw = result.next_cursor
  const next = raw == null ? '' : typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : raw
  if (typeof next !== 'string' || next.length > 8192 || /[\x00-\x1f\x7f]/.test(next) || (result.has_more != null && typeof result.has_more !== 'boolean')) throw error('response')
  const more = result.has_more ?? !!(next && next !== '0' && next !== cursor)
  if (more && (!next || next === cursor)) throw error('response')
  return { cursor: next, more }
}

// A playlist's owner is shown by the name the account profile has.
function playlistOwner(raw) {
  const owner = raw?.owner
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return undefined
  const name = [owner.nickname, owner.public_name].find(value => typeof value === 'string' && value.trim())
  if (!name) return undefined
  const trimmed = name.trim()
  return trimmed.length <= 512 && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : undefined
}

export function playlistOf(raw, accountId) {
  if (!raw || typeof (raw.title || raw.public_title) !== 'string') throw error('response')
  // Sidebar counts are optional metadata: a bad count must not hide every
  // valid playlist. Content loading still validates counts in playlistPage.
  const count = playlistCount(raw, false)
  const owner = playlistOwner(raw)
  return {
    id: idOf(raw.id), name: raw.title || raw.public_title,
    ...(count == null ? {} : { trackCount: count }),
    imageUrl: image(raw.cover_url || raw.url_cover), description: raw.desc || '',
    ...(owner ? { owner } : {}),
    ...Library.playlistFlags(raw, accountId),
  }
}

// The PC client supports both direct track entities and wrapped track entities.
function tracksOf(resources) {
  const tracks = []
  for (const item of resources) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw error('response')
    const raw = item.entity?.track ?? item.entity?.track_wrapper?.track
    if (item.type === 'video' || item.entity?.video) continue
    if (raw != null) tracks.push(trackOf(raw))
    else if (item.type === 'track' || (item.entity && (Object.hasOwn(item.entity, 'track') || Object.hasOwn(item.entity, 'track_wrapper')))) throw error('response')
  }
  return tracks
}

const catalogID = value => {
  if (typeof value !== 'string' || !/^\d{1,32}$/.test(value)) throw error('response')
  return value
}
export function artistOf(raw) {
  if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) throw error('response')
  return { id: catalogID(idOf(raw.id)), name: raw.name, imageUrl: avatarURL(raw.url_avatar) }
}
export function albumOf(raw) {
  if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) throw error('response')
  const album = { id: catalogID(idOf(raw.id)), name: raw.name, imageUrl: image(raw.url_cover), artists: (raw.artists ?? []).map(artistOf) }
  if (raw.release_date != null) {
    const seconds = Number(raw.release_date)
    if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 253402300799) throw error('response')
    if (seconds) album.released = new Date(seconds * 1000).toISOString().slice(0, 10)
  }
  return album
}
// New PC lists explicitly opt into another page. A terminal nonzero cursor is
// common for artist albums; the older playlist fallback does not apply here.
function pcPage(result, cursor, cursorField = 'next_cursor') {
  if (!result || typeof result !== 'object' || Array.isArray(result) || (result.has_more != null && typeof result.has_more !== 'boolean')) throw error('response')
  const raw = result[cursorField]
  const next = raw == null ? '' : typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : raw
  if (typeof next !== 'string' || next.length > 8192 || /[\x00-\x1f\x7f]/.test(next)) throw error('response')
  const more = result.has_more === true
  if (more && (!next || next === cursor)) throw error('response')
  return { cursor: next, more }
}

export class Catalog {
  constructor(session, { request = requestJSON, signal, publicFetch, uuid, state = {} } = {}) {
    validateSession(session)
    this.session = session
    this.request = (path, opts) => request(session, path, { ...opts, signal })
    this.signal = signal
    this.publicFetch = publicFetch
    this.uuid = uuid
    this.state = state
    this.state.search ??= new Map()
    this.state.comments ??= new Map()
    this.state.commentLocks ??= new Map()
  }
  async libraryPlaylists() {
    const entries = new Map(), cursors = new Set([''])
    let cursor = ''
    for (let count = 0; count < 500; count++) {
      const result = await this.request('/luna/pc/me/playlist', { query: { aid: '386088', version_code: '30020100', cursor, count: '50' } })
      if (!Array.isArray(result.playlists)) throw error('response')
      for (const raw of result.playlists) {
        const id = idOf(raw?.id)
        if (!entries.has(id)) entries.set(id, raw)
      }
      if (entries.size > 25000) throw error('response')
      const next = pcPage(result, cursor)
      if (!next.more) return [...entries.values()]
      if (cursors.has(next.cursor)) throw error('response')
      cursor = next.cursor
      cursors.add(cursor)
    }
    throw error('response')
  }
  async playlists() {
    return [...(await this.libraryPlaylists()).map(raw => playlistOf(raw, this.session.account?.id)), historyPlaylist()]
  }
  async profile() {
    const account = this.session.account
    if (!account?.id || typeof account.name !== 'string') throw error('session')
    const playlists = (await this.libraryPlaylists()).map(raw => playlistOf(raw, account.id))
    const mine = playlists.filter(list => list.mine)
    const saved = playlists.filter(list => list.saved)
    const other = playlists.filter(list => !list.mine && !list.saved)
    return {
      title: account.name,
      ...(account.imageUrl ? { imageUrl: account.imageUrl } : {}),
      sections: [
        { title: '我的歌单', playlists: mine, empty: '还没有自己的歌单' },
        { title: '收藏的歌单', playlists: saved, empty: '还没有收藏歌单' },
        ...(other.length ? [{ title: '其他歌单', playlists: other }] : []),
      ],
    }
  }
  like(id, on) { return Library.like(this, id, on) }
  liked(offset) { return Library.liked(this, offset) }
  isLiked(ids) { return ids?.length === 0 ? {} : Library.isLiked(this, ids) }
  savePlaylist(id, on) { return Library.savePlaylist(this, id, on) }
  followArtist(id, on) { return Collections.followArtist(this, id, on) }
  saveAlbum(id, on) { return Collections.saveAlbum(this, id, on) }
  async savedAlbums(offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 25000) throw error('response')
    const rows = await Collections.collectionList(this, 'album')
    return { albums: rows.slice(offset, offset + 50).map(raw => ({ ...albumOf(raw), saved: true })), more: offset + 50 < rows.length }
  }
  async createPlaylist(name) { const id = await Library.createPlaylist(this, name); return { id, name: name.trim(), mine: true } }
  renamePlaylist(id, name) { return Library.renamePlaylist(this, id, name) }
  deletePlaylist(id) { return Library.deletePlaylist(this, id) }
  addToPlaylist(id, trackIds) { return Library.addToPlaylist(this, id, trackIds) }
  removeFromPlaylist(id, trackIds) { return Library.removeFromPlaylist(this, id, trackIds) }
  movePlaylistTrack(id, from, to) { return Library.movePlaylistTrack(this, id, from, to) }
  recent() { return this.history().then(page => page.tracks) }
  async commentOperation(trackId, operation) {
    catalogID(trackId)
    const locks = this.state.commentLocks
    if (!locks.has(trackId) && locks.size >= 16) throw error('rateLimit')
    const prior = locks.get(trackId) ?? Promise.resolve()
    const pending = prior.catch(() => {}).then(() => {
      if (this.signal?.aborted) throw error('canceled')
      return operation()
    })
    locks.set(trackId, pending)
    try { return await pending } finally { if (locks.get(trackId) === pending) locks.delete(trackId) }
  }
  comments(params) {
    return this.commentOperation(params.trackId, () => readComments(this.request, { ...params, state: this.state.comments }))
  }
  likeComment(params) {
    return this.commentOperation(params.trackId, async () => {
      await likeComment(this.request, params)
      const cached = this.state.comments.get(params.trackId)?.comments.find(comment => comment.id === params.commentId)
      if (cached) {
        if (cached.liked !== params.on && cached.likes != null) cached.likes = Math.max(0, cached.likes + (params.on ? 1 : -1))
        cached.liked = params.on
      }
    })
  }
  postComment(params) {
    return this.commentOperation(params.trackId, async () => {
      const comment = await postComment(this.request, { ...params, account: this.session.account })
      const cached = this.state.comments.get(params.trackId)
      if (cached && !cached.ids.has(comment.id)) {
        cached.comments.unshift(comment)
        cached.ids.add(comment.id)
        cached.total++
      }
      return comment
    })
  }
  async playlistPage(id, cursor = '') {
    idOf(id)
    const query = pcCatalogParams(this.session)
    query.set('playlist_id', id)
    query.set('cursor', cursor)
    query.set('count', '100')
    const result = await this.request('/luna/pc/playlist/detail', { query })
    if (!result || typeof result !== 'object' || Array.isArray(result) || !['playlist', 'media_resources', 'has_more', 'status_info'].some(key => key in result)) throw error('response')
    const page = paginationOf(result, cursor)
    let raw = result.playlist
    if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) throw error('response')
    if (raw?.id != null && idOf(raw.id) !== id) throw error('response')
    // The official client falls back to navigation metadata for empty details.
    // Resolve that metadata from this account's library, never from a title or
    // a guessed system-list ID. A mismatched returned identity is never repaired.
    if (raw?.id == null || typeof (raw.title || raw.public_title) !== 'string') {
      const library = await this.libraryPlaylists()
      const known = library.find(item => item?.id != null && idOf(item.id) === id)
      if (!known) throw error('response')
      const detailCounts = raw && (raw.count_tracks != null || raw.resource_cnt?.track_cnt != null)
        ? { count_tracks: raw.count_tracks, resource_cnt: raw.resource_cnt } : {}
      raw = { ...known, ...raw, ...detailCounts, id, title: raw?.title || raw?.public_title || known.title || known.public_title }
    }
    const playlist = playlistOf(raw, this.session.account?.id)
    const count = playlistCount(raw)
    if (!Array.isArray(result.media_resources)) {
      const terminal = !page.more && (!page.cursor || page.cursor === '0' || page.cursor === cursor || result.has_more === false)
      // The real empty Douyin system list omits zero-valued counts, repeated
      // resources and has_more, but returns its identity and terminal cursor 0.
      const identifiedZeroCursor = !cursor && result.playlist?.id != null && (result.next_cursor === 0 || result.next_cursor === '0')
      const confirmedEmpty = count === 0 || (count == null && (result.has_more === false || identifiedZeroCursor))
      if (result.media_resources == null && terminal && (cursor || confirmedEmpty)) {
        return { playlist, tracks: [], ...page }
      }
      throw error('response')
    }
    const tracks = tracksOf(result.media_resources)
    if (result.has_more == null && !page.more && !cursor && (count > tracks.length || (tracks.length && count == null))) throw error('response')
    return { playlist, tracks, ...page, sortSafe: tracks.length === result.media_resources.length }
  }
  async playlist(id) {
    if (id === HISTORY_ID) return this.history()
    const tracks = new Map()
    const cursors = new Set([''])
    const snapshots = this.state.playlistOrder ??= new Map()
    const snapshot = { sortSafe: true, ids: null }
    if (!snapshots.has(id)) while (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value)
    snapshots.set(id, snapshot)
    let cursor = ''
    for (let count = 0; count < 500; count++) {
      const page = await this.playlistPage(id, cursor)
      snapshot.sortSafe &&= page.sortSafe === true
      for (const track of page.tracks) {
        if (tracks.has(track.id)) snapshot.sortSafe = false
        tracks.set(track.id, track)
      }
      if (!page.more) {
        snapshot.ids = [...tracks.keys()]
        return { ...page.playlist, tracks: [...tracks.values()] }
      }
      if (cursors.has(page.cursor)) throw error('response')
      cursor = page.cursor
      cursors.add(cursor)
    }
    throw error('response')
  }
  async artistList(id, kind) {
    const entries = new Map(), cursors = new Set([''])
    let cursor = ''
    for (let page = 0; page < 200; page++) {
      if (this.signal?.aborted) throw error('canceled')
      const result = await this.request(`/luna/pc/artists/${id}/${kind}`, { query: { cursor, count: '50', ...(kind === 'tracks' ? { sort_type: '0' } : {}) } })
      const next = pcPage(result, cursor)
      if (result[kind] == null && (next.more || !result.status_info || typeof result.status_info !== 'object' || Array.isArray(result.status_info))) throw error('response')
      const rows = result[kind] ?? []
      if (!Array.isArray(rows) || rows.length > 1000) throw error('response')
      for (const raw of rows) {
        const entry = kind === 'tracks' ? trackOf(raw) : albumOf(raw)
        if (!entries.has(entry.id)) entries.set(entry.id, entry)
      }
      if (entries.size > 10000) throw error('response')
      if (!next.more) return [...entries.values()]
      if (cursors.has(next.cursor)) throw error('response')
      cursor = next.cursor
      cursors.add(cursor)
    }
    throw error('response')
  }
  async artist(id) {
    catalogID(id)
    const result = await this.request(`/luna/pc/artists/${id}`, { query: { locate_item_id: '' } })
    const artist = artistOf(result.artist_info)
    if (artist.id !== id) throw error('response')
    const [tracks, albums] = await Promise.all([this.artistList(id, 'tracks'), this.artistList(id, 'albums')])
    if (this.session.account) artist.following = await Collections.artistFollowing(this, result.artist_info)
    return { artist, tracks, albums }
  }
  async album(id) {
    catalogID(id)
    const result = await this.request(`/luna/pc/albums/${id}`, { query: { ignore_tracks: 'false' } })
    const album = albumOf(result.album_info)
    if (album.id !== id || (result.tracks != null && !Array.isArray(result.tracks))) throw error('response')
    const tracks = new Map()
    for (const raw of result.tracks ?? []) {
      const track = trackOf(raw)
      if (!tracks.has(track.id)) tracks.set(track.id, track)
    }
    if (this.session.account) album.saved = (await Collections.collectionList(this, 'album')).some(row => row.id === id)
    return { album, tracks: [...tracks.values()] }
  }
  async suggest(query) {
    if (typeof query !== 'string' || query.length > 512) throw error('response')
    if (!query.trim()) return []
    const result = await this.request('/luna/pc/sug', { query: { q: query, sug_scene: 'main', sug_search_id: this.uuid() } })
    if (result.sugs != null && !Array.isArray(result.sugs)) throw error('response')
    const suggestions = new Set()
    for (const item of result.sugs ?? []) {
      if (typeof item?.suggestion !== 'string') throw error('response')
      if (item.suggestion.trim()) suggestions.add(item.suggestion)
      if (suggestions.size === 20) break
    }
    return [...suggestions]
  }
  async entitySearch({ query, kind, offset }) {
    const types = { artists: ['artist', artistOf], albums: ['album', albumOf], playlists: ['playlist', playlistOf] }
    if (!Object.hasOwn(types, kind)) throw error('unsupported')
    const [type, map] = types[kind]
    const key = JSON.stringify([query, kind])
    let state = this.state.search.get(key)
    if (!state || offset === 0) {
      state = { id: this.uuid(), cursor: '0', cursors: new Set(['0']), items: [], ids: new Set(), more: true, pages: 0, pending: null }
      while (this.state.search.size >= 16) this.state.search.delete(this.state.search.keys().next().value)
      this.state.search.set(key, state)
    }
    while (state.items.length <= offset && state.more) {
      if (this.signal?.aborted) throw error('canceled')
      if (!state.pending) state.pending = (async () => {
        if (++state.pages > 500) throw error('response')
        const result = await this.request(`/luna/pc/search/${type}`, { query: {
          q: query, cursor: state.cursor, search_id: state.id, search_method: 'input', debug_params: '', from_search_id: '', search_scene: '',
        } })
        if (!Array.isArray(result.result_groups)) throw error('response')
        const groups = result.result_groups.filter(group => group?.id === kind)
        if (groups.length > 1) throw error('response')
        const group = groups[0]
        if (!group) {
          if (result.result_groups.length) throw error('response')
          state.more = false
          return
        }
        const next = pcPage(group, state.cursor)
        if (group.data != null && !Array.isArray(group.data)) throw error('response')
        const additions = []
        for (const item of group.data ?? []) {
          const raw = item?.entity?.[type]
          if (raw == null) continue
          const entry = map(raw)
          if (!state.ids.has(entry.id)) { state.ids.add(entry.id); additions.push(entry) }
        }
        if (state.ids.size > 10000 || (next.more && state.cursors.has(next.cursor))) throw error('response')
        state.items.push(...additions)
        state.more = next.more
        state.cursor = next.cursor
        state.cursors.add(next.cursor)
      })().finally(() => { state.pending = null })
      try { await state.pending } catch (failure) { if (this.state.search.get(key) === state) this.state.search.delete(key); throw failure }
    }
    const entries = state.items.slice(offset, offset + PAGE_SIZE)
    return { result: { [kind]: entries, more: offset + entries.length < state.items.length || state.more } }
  }
  async played(id) {
    if (typeof id !== 'string' || !/^\d{1,32}$/.test(id)) throw error('response')
    // Official AppendRecentlyPlayedMedia records a start, without inventing
    // listened time, feed feedback or collection/queue attribution.
    await this.request(HISTORY_PATH, { signed: true, body: { media: [{ type: 'track', id }] } })
  }
  async history() {
    const tracks = new Map()
    const cursors = new Set([''])
    let cursor = '', mediaCount = 0
    for (let pageCount = 0; pageCount < 50; pageCount++) {
      const result = await this.request(HISTORY_PATH, {
        signed: true,
        query: { cursor, count: String(HISTORY_LIMIT - mediaCount), media_type: '', scene: '' },
      })
      const page = paginationOf(result, cursor)
      const empty = result.media == null && !page.more && (result.has_more === false || (result.status_info && typeof result.status_info === 'object' && !Array.isArray(result.status_info)))
      const media = empty ? [] : result.media
      if (!Array.isArray(media) || media.length > HISTORY_LIMIT - mediaCount) throw error('response')
      for (const track of tracksOf(media)) if (!tracks.has(track.id)) tracks.set(track.id, track)
      mediaCount += media.length
      if (!page.more || mediaCount >= HISTORY_LIMIT) {
        const ordered = [...tracks.values()]
        return { ...historyPlaylist(ordered[0]), trackCount: tracks.size, tracks: ordered }
      }
      if (cursors.has(page.cursor)) throw error('response')
      cursor = page.cursor
      cursors.add(cursor)
    }
    throw error('response')
  }
  async searchPage(query, cursor = '0') {
    const params = androidSearchParams(this.session, this.uuid())
    params.set('q', query)
    params.set('cursor', cursor)
    params.set('count', String(PAGE_SIZE))
    const result = await this.request('/luna/search/track', { query: params })
    if (!Array.isArray(result.result_groups)) throw error('response')
    const tracks = new Map()
    let next, more, rawCount = 0
    for (const group of result.result_groups) {
      if (!Array.isArray(group.data)) throw error('response')
      for (const item of group.data) {
        if (!item.entity) throw error('response')
        if (!item.entity.track) continue
        const track = trackOf(item.entity.track)
        rawCount++
        tracks.set(track.id, track)
      }
      if (group.next_cursor != null) {
        if (next != null && next !== String(group.next_cursor)) throw error('response')
        next = String(group.next_cursor)
      }
      if (group.has_more != null) {
        if (typeof group.has_more !== 'boolean' || (more != null && more !== group.has_more)) throw error('response')
        more = group.has_more
      }
    }
    more ??= !!next || rawCount >= PAGE_SIZE
    if (more && next == null) {
      if (!/^\d+$/.test(cursor) || !rawCount || !Number.isSafeInteger(Number(cursor) + Math.max(PAGE_SIZE, rawCount))) throw error('response')
      next = String(Number(cursor) + Math.max(PAGE_SIZE, rawCount))
    }
    if (more && (!next || next === cursor)) throw error('response')
    return { tracks: [...tracks.values()], more, cursor: next }
  }
  async search({ query, kind = 'tracks', offset = 0, cursor }) {
    if (typeof query !== 'string' || !query.trim() || query.length > 512 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw error('response')
    if (kind !== 'tracks') return this.entitySearch({ query, kind, offset })
    if (cursor != null && (typeof cursor !== 'string' || cursor.length > 8192)) throw error('response')
    let skipped = 0
    let current = cursor ?? '0'
    const seen = new Set([current])
    for (let count = 0; count < 500; count++) {
      const page = await this.searchPage(query, current)
      if (cursor != null || skipped === offset) return { result: { tracks: page.tracks, more: page.more }, cursor: page.cursor, nextOffset: offset + page.tracks.length }
      if (skipped + page.tracks.length > offset) {
        return { result: { tracks: page.tracks.slice(offset - skipped), more: page.more }, cursor: page.cursor, nextOffset: skipped + page.tracks.length }
      }
      skipped += page.tracks.length
      if (!page.more) return { result: { tracks: [], more: false } }
      if (seen.has(page.cursor)) throw error('response')
      current = page.cursor
      seen.add(current)
    }
    throw error('response')
  }
  async home() {
    const discovery = await this.discoveryPage()
    return homePage(discovery.items)
  }
  async listeningModes() {
    const result = await this.request('/luna/pc/feed/mode', { signed: true, body: {} })
    return modesOf(result, raw => image(raw))
  }
  async discoveryPage(state) {
    const initial = state == null
    const result = await this.request(initial ? '/luna/pc/discover' : '/luna/pc/discover/mix', {
      signed: true,
      body: initial ? { first_request: true, pc_new_discover_request: true } : discoveryBody(state),
    })
    return discoveryOf(result, { initial, state, cover: raw => image(raw) })
  }
  async recommendationBatch(params = {}) {
    const result = await this.request('/luna/pc/feed/song-tab', { signed: true, body: feedBody(params) })
    return feedTracks(result)
  }
  async radioBatch({ id, cursor = '' } = {}) {
    if (typeof id !== 'string' || !id.startsWith('radio:')) throw error('unsupported')
    const radioID = idOf(id.slice(6))
    if (typeof cursor !== 'string' || cursor.length > 8192) throw error('response')
    const result = await this.request('/luna/pc/feed/radio/tracks', { signed: true, body: { radio_id: radioID, count: 6, cursor } })
    if (result.has_more != null && typeof result.has_more !== 'boolean') throw error('response')
    if (result.next_cursor != null && (typeof result.next_cursor !== 'string' || result.next_cursor.length > 8192)) throw error('response')
    return { result: feedTracks(result), ...(result.next_cursor == null ? {} : { cursor: result.next_cursor }), more: result.has_more ?? result.items.length > 0 }
  }
  async lyrics(id) {
    idOf(id)
    // The public SEO endpoint is metadata-only and never receives account credentials.
    const query = new URLSearchParams({ track_id: id, device_platform: 'web' })
    const result = await fetchJSON('https://beta-luna.douyin.com/luna/h5/seo_track?' + query, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36' }, signal: this.signal,
    }, this.publicFetch)
    // The live SEO response puts lyric beside seo_track, not inside it.
    // Retain the legacy nested form without letting metadata hide the lyric.
    const track = result.seo_track?.track || result.track || result.track_info
    if (track?.id != null && idOf(track.id) !== id) throw error('response')
    const lyric = result.lyric ?? result.seo_track?.lyric
    if (lyric != null) {
      if (typeof lyric !== 'object' || Array.isArray(lyric) || (lyric.content != null && typeof lyric.content !== 'string')) throw error('response')
      if (typeof lyric.content === 'string') return lyricsOf(lyric.content, lyric.translations?.cn)
    }
    if (!track?.id) throw error('response')
    return { lrc: '' }
  }
}
function feedTracks(result) {
  if (!Array.isArray(result?.items)) throw error('response')
  const tracks = new Map()
  for (const item of result.items) {
    if (!item || typeof item !== 'object') throw error('response')
    if (item.type !== 'track') continue
    const track = trackOf(item.entity?.track_wrapper?.track)
    tracks.set(track.id, track)
  }
  return [...tracks.values()]
}
function androidSearchParams(session, uuid) {
  return new URLSearchParams({
    device_platform: 'android', os: 'android', ssmix: 'a', channel: 'xiaomi_8478_64', aid: '386088', app_name: 'luna',
    version_code: '100198030', version_name: '19.8.0', manifest_version_code: '100198030', update_version_code: '100198030',
    resolution: '1080*1920', dpi: '480', device_type: 'ABR-AL80', device_brand: 'HUAWEI', language: 'zh', os_api: '35', os_version: '15',
    ac: 'wifi', device_model: 'ABR-AL80', save_power: '0', font_size: '1.00', luna_first_launch_apk_type: 'normal_apk',
    diversion_channel_name: 'xiaomi_8478_64', is_car_play: '0', battery: '0.99', network_speed: '10156', hybrid_version_code: '100198030',
    tz_name: 'Asia/Shanghai', tz_offset: '28800', luna_register_time: '1784311292',
    diversion_category_level_two: 'Xiaomi%E5%95%86%E5%BA%97-%E8%87%AA%E7%84%B6', package: 'com.luna.music', charge: '0', luna_apk_type: 'normal_apk',
    output_device_type: 'Phone', volume: '1.00', brightness: '0.08', need_personal_recommend: '1', is_teen_mode: '0', sim_region: 'cn',
    diversion_category_level_one: '%E5%8E%82%E5%95%86%E5%95%86%E5%BA%97-%E8%87%AA%E7%84%B6', android_device_type: 'default',
    _rticket: String(Date.now()), device_id: session.deviceID, iid: session.installID, cdid: uuid,
  })
}
