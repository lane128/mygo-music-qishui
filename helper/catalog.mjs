// Ported from mygo-cloudmusic/internal/qishui/{catalog,client,feed,pc}.go.
import { createHash, randomUUID } from 'node:crypto'
import { API, cookieHeader, decodeResponse, error } from './protocol.mjs'
import { feedBody, modesOf } from './discovery.mjs'
import { sceneCover } from './scene-art.mjs'
import { discoveryBody, discoveryOf } from './exploration.mjs'

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
const paths = new Set(['/luna/pc/me/playlist', '/luna/pc/playlist/detail', '/luna/search/track', '/luna/pc/track_v2', '/luna/pc/feed/mode', '/luna/pc/feed/song-tab', '/luna/pc/discover', '/luna/pc/discover/mix', '/luna/pc/feed/radio/tracks'])
export async function requestJSON(session, path, { query = {}, body, signed = false, signal } = {}, deps = {}) {
  if (!paths.has(path)) throw error('response')
  const cookies = validateSession(session)
  const params = signed ? pcCatalogParams(session) : new URLSearchParams()
  for (const [name, value] of new URLSearchParams(query)) params.set(name, value)
  const headers = { 'User-Agent': 'LunaPC/3.0.0(290101097)', Accept: 'application/json', Cookie: cookies }
  let data
  if (body !== undefined) {
    data = JSON.stringify(body)
    headers['Content-Type'] = 'application/json; charset=utf-8'
  }
  if (path === '/luna/search/track') {
    headers['User-Agent'] = 'com.luna.music/100198030 (Linux; U; Android 15; zh_CN; ABR-AL80; Build/V417IR;tt-ok/3.12.13.19)'
    headers['Content-Type'] = 'application/json; charset=UTF-8'
  }
  if (signed) {
    if (data === undefined) throw error('response')
    params.set('version_name', '3.7.0')
    params.set('version_code', '30070000')
    params.set('device_platform', 'mac')
    params.set('device_type', 'Mac')
    params.set('os_version', 'darwin')
    Object.assign(headers, {
      'User-Agent': 'LunaPC/3.7.0(452316191)', 'Accept-Encoding': 'identity',
      'X-Luna-Background-Type': 'foreground', 'X-Luna-Is-Background-Req': '0', 'X-Luna-Is-Local-User': '0',
      'X-SS-STUB': createHash('md5').update(data).digest('hex').toUpperCase(),
    })
  }
  params.sort()
  const url = API + path + '?' + params
  if (signed) {
    const sign = deps.sign || (await import('./native.mjs')).signRequest
    const result = await sign({ url, headers, did: session.deviceID, signal })
    const names = Object.keys(result || {})
    if (names.length !== 2 || names.some(name => !/^x-(helios|medusa)$/i.test(name)) ||
        !names.some(name => /^x-helios$/i.test(name)) || !names.some(name => /^x-medusa$/i.test(name)) ||
        Object.values(result).some(value => typeof value !== 'string' || !value || /[\r\n\0]/.test(value))) throw error('signature')
    Object.assign(headers, result)
  }
  return fetchJSON(url, { headers, body: data, method: data === undefined ? 'GET' : 'POST', signal }, deps.fetch)
}

async function fetchJSON(url, options, request = fetch) {
  let response
  try {
    response = await request(url, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(20000) })
  } catch { throw error('network') }
  let body = ''
  let bytes = 0
  try {
    const decoder = new TextDecoder()
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > 1048576) {
        await response.body.cancel?.().catch(() => {})
        throw error('response')
      }
      body += decoder.decode(chunk, { stream: true })
    }
    body += decoder.decode()
  } catch (err) { throw err.kind ? err : error('network') }
  return decodeResponse({ status: response.status, body })
}

export function image(raw, suffix = '~c5_375x375.jpg') {
  if (typeof raw === 'string') {
    try { return new URL(raw).protocol === 'https:' ? raw : undefined } catch { return undefined }
  }
  if (raw?.uri && raw.template_prefix) return `https://p3-luna.douyinpic.com/img/${raw.uri}~${raw.template_prefix}-resize:960:960.png`
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
  return {
    id: idOf(raw.id), name: raw.name || '', duration: raw.duration ?? 0,
    artists: (raw.artists || []).map(a => ({ id: a.id == null || a.id === '' ? '' : idOf(a.id), name: a.name || '' })),
    album: { id: raw.album?.id == null ? '' : idOf(raw.album.id), name: raw.album?.name || '', imageUrl: image(raw.album?.cover_url || raw.album?.url_cover) },
  }
}
export function playlistOf(raw) {
  if (!raw || typeof (raw.title || raw.public_title) !== 'string') throw error('response')
  return {
    id: idOf(raw.id), name: raw.title || raw.public_title,
    trackCount: raw.count_tracks || raw.resource_cnt?.track_cnt || 0,
    imageUrl: image(raw.cover_url || raw.url_cover, '~c5_300x300.jpg'), description: raw.desc || '',
  }
}

export class Catalog {
  constructor(session, { request = requestJSON, signal, publicFetch } = {}) {
    validateSession(session)
    this.session = session
    this.request = (path, opts) => request(session, path, { ...opts, signal })
    this.signal = signal
    this.publicFetch = publicFetch
  }
  async playlists() {
    const result = await this.request('/luna/pc/me/playlist', { query: { aid: '386088', version_code: '30020100' } })
    if (!Array.isArray(result.playlists)) throw error('response')
    return result.playlists.map(playlistOf)
  }
  async playlistPage(id, cursor = '') {
    idOf(id)
    const query = pcCatalogParams(this.session)
    query.set('playlist_id', id)
    query.set('cursor', cursor)
    query.set('count', '100')
    const result = await this.request('/luna/pc/playlist/detail', { query })
    const playlist = playlistOf(result.playlist)
    if (playlist.id !== id) throw error('response')
    const next = result.next_cursor ?? ''
    if (typeof next !== 'string' || (result.has_more != null && typeof result.has_more !== 'boolean')) throw error('response')
    if (!Array.isArray(result.media_resources)) {
      if (!('media_resources' in result) && cursor && !result.has_more && (!next || next === cursor)) return { playlist, tracks: [], more: false, cursor: next }
      throw error('response')
    }
    const tracks = result.media_resources.filter(item => item.type === 'track').map(item => trackOf(item.entity?.track_wrapper?.track))
    let more = result.has_more ?? !!(next && next !== cursor)
    if (result.has_more == null && !more && !cursor && (playlist.trackCount > tracks.length || (tracks.length && !playlist.trackCount))) throw error('response')
    if (more && (!next || next === cursor)) throw error('response')
    return { playlist, tracks, more, cursor: next }
  }
  async playlist(id) {
    const tracks = new Map()
    const cursors = new Set([''])
    let cursor = ''
    for (let count = 0; count < 500; count++) {
      const page = await this.playlistPage(id, cursor)
      for (const track of page.tracks) tracks.set(track.id, track)
      if (!page.more) return { ...page.playlist, tracks: [...tracks.values()] }
      if (cursors.has(page.cursor)) throw error('response')
      cursor = page.cursor
      cursors.add(cursor)
    }
    throw error('response')
  }
  async searchPage(query, cursor = '0') {
    const params = androidSearchParams(this.session)
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
    if (kind !== 'tracks') throw error('unsupported')
    if (typeof query !== 'string' || !query.trim() || query.length > 512 || !Number.isSafeInteger(offset) || offset < 0) throw error('response')
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
    return { title: '汽水音乐', sections: [
      { title: '我的歌单', playlists: await this.playlists() },
      { title: '发现音乐', links: [{ title: '推荐', page: 'recommendations' }, { title: '听歌模式', page: 'listening-modes' }] },
      { title: '持续听歌', stations: [{ id: 'recommendations', name: '播放推荐', description: '按当前账号持续推荐歌曲' }] },
    ] }
  }
  async listeningModes() {
    const result = await this.request('/luna/pc/feed/mode', { signed: true, body: {} })
    return modesOf(result, raw => image(raw, '~c5_300x300.jpg')).map(mode => ({ ...mode, imageUrl: sceneCover(mode) }))
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
      if (typeof lyric.content === 'string') return { lrc: normalizeLyrics(lyric.content) }
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
export function normalizeLyrics(raw) {
  // Preserve ordinary LRC too; the PC response uses [milliseconds,duration].
  return raw.split('\n').flatMap(line => {
    line = line.trim()
    const match = /^\[(\d+),(\d+)\](.*)$/.exec(line)
    if (!match) return /^\[\d+:\d+(?:\.\d+)?\]/.test(line) ? [line] : []
    const ms = Number(match[1])
    if (!Number.isSafeInteger(ms)) return []
    return [`[${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(Math.floor(ms % 1000 / 10)).padStart(2, '0')}]${match[3].replace(/<[^>]*>/g, '')}`]
  }).join('\n')
}
function androidSearchParams(session) {
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
    _rticket: String(Date.now()), device_id: session.deviceID, iid: session.installID, cdid: randomUUID(),
  })
}
