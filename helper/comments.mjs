import { error } from './protocol.mjs'
import { avatarURL as avatar } from './avatar.mjs'

const PAGE_SIZE = 20
const MAX_TRACKS = 8
const MAX_PAGES = 128
const MAX_CURSOR = 8192
const KINDS = new Set(['response', 'network', 'session', 'expired', 'verify', 'rateLimit', 'rejected', 'signature', 'canceled', 'unsupported'])

function idOf(value, wire = false) {
  if (wire && Number.isSafeInteger(value) && value >= 0) value = String(value)
  if (typeof value !== 'string' || !/^\d{1,32}$/.test(value)) throw error('response')
  return value
}
function integer(value) {
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || value < 0) throw error('response')
  return value
}
async function send(request, path, options) {
  if (typeof request !== 'function') throw error('response')
  try { return await request(path, options) }
  catch (cause) { throw error(KINDS.has(cause?.kind) ? cause.kind : 'network') }
}

function commentOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.content !== 'string') throw error('response')
  const artist = raw.user_artist_info?.artist_brief
  const isArtist = typeof artist?.name === 'string' && !!artist.name.trim()
  const author = isArtist ? artist.name : typeof raw.user?.nickname === 'string' && raw.user.nickname.trim() ? raw.user.nickname : '汽水音乐用户'
  const avatarUrl = isArtist ? avatar(artist.url_avatar) || avatar(artist.thumb_avatar_url) : avatar(raw.user?.url_avatar) || avatar(raw.user?.thumb_avatar_url)
  const result = { id: idOf(raw.id, true), author, ...(avatarUrl ? { avatarUrl } : {}), text: raw.content }
  if (raw.count_digged != null) result.likes = integer(raw.count_digged)
  if (raw.time_created != null) {
    const seconds = integer(raw.time_created)
    if (!Number.isSafeInteger(seconds * 1000)) throw error('response')
    result.time = seconds * 1000
  }
  if (raw.user_digged != null) {
    if (typeof raw.user_digged !== 'boolean') throw error('response')
    result.liked = raw.user_digged
  }
  return result
}
function cursorOf(value) {
  if (Number.isSafeInteger(value) && value >= 0) value = String(value)
  if (typeof value !== 'string' || value.length > MAX_CURSOR || /[\x00-\x1f\x7f]/.test(value)) throw error('response')
  return value
}
function emptyState() {
  return { comments: [], ids: new Set(), cursor: '', cursors: new Set(['']), pages: 0, more: true, total: 0 }
}
function copyState(value) {
  return { ...value, comments: [...value.comments], ids: new Set(value.ids), cursors: new Set(value.cursors) }
}

// state belongs to one account and is held by the caller. Offset counts unique
// displayed comments, never upstream rows. Offset zero explicitly refreshes.
// Both cursor history and cached rows are bounded by MAX_PAGES * PAGE_SIZE;
// hitting a bound is an error, never an apparently complete truncated result.
export async function readComments(request, { trackId, offset = 0, state = new Map() }) {
  idOf(trackId)
  if (!Number.isSafeInteger(offset) || offset < 0 || !(state instanceof Map)) throw error('response')
  const cached = state.get(trackId)
  const next = offset === 0 || !cached ? emptyState() : copyState(cached)
  while (next.comments.length <= offset && next.more) {
    if (next.pages >= MAX_PAGES) throw error('response')
    const result = await send(request, '/luna/pc/comments', {
      signed: true,
      query: { group_id: trackId, group_type: 0, cursor: next.cursor, count: PAGE_SIZE, image_strategy: 2 },
    })
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw error('response')
    const rows = result.comments ?? []
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE || (result.has_more != null && typeof result.has_more !== 'boolean')) throw error('response')
    const comments = rows.map(commentOf)
    const more = result.has_more ?? false
    const cursor = cursorOf(result.cursor ?? '')
    if (more && (!cursor || next.cursors.has(cursor))) throw error('response')
    const total = result.count == null ? next.total : integer(result.count)
    for (const comment of comments) {
      if (next.ids.has(comment.id)) continue
      next.ids.add(comment.id)
      next.comments.push(comment)
    }
    next.pages++
    next.total = Math.max(total, next.comments.length)
    next.more = more
    next.cursor = cursor
    next.cursors.add(cursor)
  }
  // A caller can mutate its returned objects without corrupting future pages.
  const comments = next.comments.slice(offset, offset + PAGE_SIZE).map(comment => ({ ...comment }))
  state.delete(trackId)
  state.set(trackId, next)
  while (state.size > MAX_TRACKS) state.delete(state.keys().next().value)
  return { comments, total: next.total, more: offset + comments.length < next.comments.length || next.more }
}

export async function likeComment(request, { trackId, commentId, on }) {
  idOf(trackId)
  idOf(commentId)
  if (typeof on !== 'boolean') throw error('response')
  await send(request, '/luna/pc/comments/action', {
    signed: true, body: { comment_id: commentId, reply_id: '', group_id: trackId, type: on ? 1 : 3, scene_name: 'comment_detail' },
  })
}

function commentText(value) {
  if (typeof value !== 'string') throw error('response')
  const text = value.trim().replace(/\n+/g, '\n')
  if (!text || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw error('response')
  // Intl.Segmenter implements Unicode graphemes when available. Embedded
  // QuickJS may lack Intl: code points are a conservative upper bound, so
  // long combining/ZWJ/flag sequences can be rejected earlier there. This
  // fallback deliberately never merges code points with an incomplete UAX29.
  const segments = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text) : text
  let count = 0
  for (const _ of segments) if (++count > 280) throw error('response')
  return text
}

export async function postComment(request, { trackId, text, account }) {
  idOf(trackId)
  text = commentText(text)
  if (!account || typeof account !== 'object' || Array.isArray(account) || typeof account.name !== 'string' || !account.name.trim() || account.name.length > 512 || (account.imageUrl != null && (typeof account.imageUrl !== 'string' || !avatar(account.imageUrl)))) throw error('session')
  // Capture the known author before the write; no post-success profile lookup
  // can turn a successful write into an apparent failure and prompt a retry.
  const author = account.name
  const avatarUrl = account.imageUrl
  const result = await send(request, '/luna/pc/comments/create', {
    signed: true,
    body: { group_id: trackId, group_type: 0, comment_type: 0, text, hashtags: [], reply_id: '', reply_to_reply_id: '', reply_to_user_id: '', text_extra: [] },
  })
  const id = idOf(result?.created_comment, true)
  if (/^0+$/.test(id)) throw error('response')
  return { id, author, ...(avatarUrl ? { avatarUrl } : {}), text }
}
