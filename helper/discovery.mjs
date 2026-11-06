// Listening preferences and recommendation requests follow the official PC feed
// schema ported from mygo-cloudmusic/internal/qishui/feed.go.
import { error } from './protocol.mjs'

function sceneID(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw error('response')
    return String(value)
  }
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) throw error('response')
  return value
}
function preferenceID(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) throw error('response')
  return 'preference:' + encodeURIComponent(value)
}
export function feedPreference(id) {
  if (id === 'recommendations') return undefined
  if (typeof id !== 'string') throw error('unsupported')
  if (id.startsWith('scene:')) {
    const value = sceneID(id.slice(6))
    // JSON raw numbers preserve int64 scene IDs without rounding their identity.
    if (BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
      if (typeof JSON.rawJSON !== 'function') throw error('setup')
      return { scene_mode_id: JSON.rawJSON(value) }
    }
    return { scene_mode_id: Number(value) }
  }
  if (id.startsWith('preference:')) {
    let value
    try { value = decodeURIComponent(id.slice(11)) } catch { throw error('response') }
    if (preferenceID(value) !== id) throw error('response')
    return { preference_mode: value }
  }
  throw error('unsupported')
}

export function modesOf(result, cover) {
  if (!Array.isArray(result?.feed_mode_block)) throw error('response')
  const modes = new Map([
    ['preference:familiar', { id: 'preference:familiar', name: '熟悉模式', group: '常用模式' }],
    ['preference:fresh', { id: 'preference:fresh', name: '新鲜模式', group: '常用模式' }],
  ])
  for (const block of result.feed_mode_block) {
    if (!block || typeof block.title !== 'string' || !Array.isArray(block.feed_mode)) throw error('response')
    for (const entry of block.feed_mode) {
      if (!entry || typeof entry !== 'object') throw error('response')
      if (entry.type !== 'scene_mode') continue
      const scene = entry.entity?.feed_scene_mode
      if (!scene || typeof entry.text !== 'string' || !entry.text.trim()) throw error('response')
      const id = scene.scene_mode_id != null ? 'scene:' + sceneID(scene.scene_mode_id) : preferenceID(scene.sub_queue_type)
      if (!modes.has(id)) modes.set(id, { id, name: entry.text, group: block.title, imageUrl: cover(entry.url_info) })
    }
  }
  return [...modes.values()]
}

export function feedBody({ id = 'recommendations', count = 1, firstUseTime = 0, firstDeviceRequest = false, played = [] } = {}) {
  const preference = feedPreference(id)
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(firstUseTime) || firstUseTime < 0 || typeof firstDeviceRequest !== 'boolean' || !Array.isArray(played) || played.length > 30) throw error('response')
  const body = {
    played_media: played.map(media => {
      if (!media || typeof media.id !== 'string' || !media.id.trim() || media.id.length > 512 || /[\x00-\x1f\x7f]/.test(media.id) || !Number.isSafeInteger(media.duration) || media.duration < 0) throw error('response')
      // MyGO has no per-track listening feedback here. Offered tracks remain
      // pending (-1); never report invented play time to the service.
      return { type: 'track', media_id: media.id, duration: Math.floor(media.duration / 1000), played_mills: -1 }
    }),
    is_first_request: count === 1,
    is_did_first_request: preference ? false : firstDeviceRequest,
    feed_counts: { mix_session_count: count },
  }
  if (preference) body.feed_preference = preference
  else if (firstUseTime > 0) body.did_first_use_time = firstUseTime
  return body
}
