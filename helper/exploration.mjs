// Public discovery cards are separate from FeedMode. Preserve resource types:
// a radio continues through its radio feed; a playlist opens the actual playlist.
import { error } from './protocol.mjs'

const MAX_EXPOSURES = 256
// A station ID also survives the host's saved radio queue. Keep its selection
// self-contained rather than resolving a stale card through mutable page state.
export const MAX_RADIO_STATION_ID_LENGTH = 100000
const THEMED_RADIO_PREFIX = 'radio-theme:v1:'
export function isRadioStationID(id) {
  return typeof id === 'string' && (id.startsWith('radio:') || id.startsWith(THEMED_RADIO_PREFIX))
}
function radioSelection(params) {
  const flow_type = Number(params.get('flow_type') ?? '2')
  if (!Number.isSafeInteger(flow_type) || flow_type < 0 || flow_type > 2147483647) throw error('response')
  const trigger_info = boundedText(params.get('trigger_info') ?? '', 8192)
  return { flow_type, trigger_info }
}
function radioStationID(rawID, selection) {
  rawID = identity(rawID)
  // Legacy radio: suffixes are opaque, including literal query syntax. Use a
  // separate namespace for selectors so saved resource IDs are never guessed.
  if (selection.flow_type === 2 && selection.trigger_info === '') return 'radio:' + rawID
  return THEMED_RADIO_PREFIX + encodeURIComponent(rawID) + '?' + new URLSearchParams(selection)
}
function radioOf(rawID, link) {
  let params = new URLSearchParams()
  if (link != null) {
    boundedText(link, 100000)
    try { params = new URL(link).searchParams } catch { throw error('response') }
  }
  // Only read navigation parameters; never follow a provider-supplied link.
  return radioStationID(rawID, radioSelection(params))
}
export function radioRequest(id) {
  if (!isRadioStationID(id)) throw error('unsupported')
  if (id.length > MAX_RADIO_STATION_ID_LENGTH) throw error('response')
  if (id.startsWith('radio:')) return { radio_id: identity(id.slice(6), 512), flow_type: 2, trigger_info: '' }
  const [raw, query] = id.slice(THEMED_RADIO_PREFIX.length).split('?')
  let radio_id
  try { radio_id = identity(decodeURIComponent(raw)) } catch { throw error('response') }
  const selection = radioSelection(new URLSearchParams(query))
  if (radioStationID(radio_id, selection) !== id) throw error('response')
  return { radio_id, ...selection }
}
function identity(value, limit = 128) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw error('response')
    value = String(value)
  }
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw error('response')
  return value
}
function boundedText(value, limit) {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw error('response')
  return value
}
export function discoveryState(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('response')
  const exposure = value.exposure ?? []
  if (!Array.isArray(exposure) || exposure.length > MAX_EXPOSURES) throw error('response')
  return {
    exposure: [...new Set(exposure.map(value => identity(value)))],
    ...(value.cursor == null ? {} : { cursor: boundedText(value.cursor, 8192) }),
    ...(value.sessionID == null ? {} : { sessionID: boundedText(value.sessionID, 512) }),
  }
}
export function discoveryBody(state) {
  state = discoveryState(state)
  return {
    block_type: 'discover_playlist_mix', sub_channel_id: -2,
    exposure_radio_list: state.exposure,
    ...(state.cursor == null ? {} : { cursor: state.cursor }),
    ...(state.sessionID == null ? {} : { session_id: state.sessionID }),
  }
}
export function discoveryOf(result, { initial = false, state, cover } = {}) {
  const previous = discoveryState(state)
  let blocks
  if (initial) {
    if (!Array.isArray(result?.blocks)) throw error('response')
    blocks = result.blocks.filter(block => block?.type === 'discover_playlist_mix').flatMap(block => {
      if (!Array.isArray(block.inner_block)) throw error('response')
      return block.inner_block
    })
  } else {
    if (!Array.isArray(result?.inner_block) || typeof result.has_more !== 'boolean') throw error('response')
    blocks = result.inner_block
  }
  if (blocks.length > 256 || (result.has_more != null && typeof result.has_more !== 'boolean')) throw error('response')
  const exposed = new Set(previous.exposure), seenResources = new Set(), items = []
  let advanced = false
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw error('response')
    const supported = ['discover_radio', 'discover_playlist', 'discover_track_top_list'].includes(block.type)
    // Unknown future blocks need not have the same schema as known cards.
    if (!supported) continue
    const blockID = identity(block.inner_block_id)
    if (exposed.has(blockID)) continue
    exposed.add(blockID)
    advanced = true
    if (!Array.isArray(block.resources) || !block.resources.length) throw error('response')
    const resource = block.resources[0]
    if (!resource || typeof resource !== 'object') throw error('response')
    if (!['radio', 'playlist'].includes(resource.type)) continue
    const rawID = identity(resource.resource_id)
    const style = resource.style
    const id = resource.type === 'radio' ? radioOf(rawID, style?.link) : rawID
    const key = resource.type + ':' + id
    if (seenResources.has(key)) continue
    if (!style || typeof style !== 'object' || !boundedText(style.title, 512).trim()) throw error('response')
    if (style.cover_url_list != null && !Array.isArray(style.cover_url_list)) throw error('response')
    seenResources.add(key)
    const imageUrl = (style.cover_url_list || []).map(cover).find(Boolean)
    const item = {
      id,
      name: style.title,
      ...(style.desc == null ? {} : { description: boundedText(style.desc, 2048) }),
      ...(imageUrl ? { imageUrl } : {}),
    }
    items.push({ type: resource.type, item })
  }
  const next = discoveryState({
    ...previous,
    exposure: [...exposed].slice(-MAX_EXPOSURES),
    ...(result.next_cursor == null ? {} : { cursor: result.next_cursor }),
    ...(result.session_id == null ? {} : { sessionID: result.session_id }),
  })
  // Repeated exposure IDs cannot lead to an endless chain of empty pages.
  const more = (result.has_more ?? true) && advanced && items.length > 0
  return { items, state: next, more }
}
export function discoverySection(items) {
  if (!Array.isArray(items)) throw error('response')
  const stations = items.filter(entry => entry.type === 'radio').map(entry => entry.item)
  const playlists = items.filter(entry => entry.type === 'playlist').map(entry => entry.item)
  return { title: '探索更多新模式', ...(stations.length ? { stations } : {}), ...(playlists.length ? { playlists } : {}) }
}
