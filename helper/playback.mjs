// Playback uses only a resource and its matching authorization from one account grant.
import https from 'node:https'
import { rootCertificates } from 'node:tls'
import { error, cookieHeader, parseJSON } from './protocol.mjs'
import { decodeResource, convertAAC } from './native.mjs'

export const MAX_AUDIO_BYTES = 128 * 1024 * 1024
const UA = 'LunaPC/3.7.0(452316191)'
const domains = ['qishui.com', 'douyinvod.com', 'byteimg.com', 'bytegecko.com', 'zjcdn.com', 'pstatp.com', 'snssdk.com']
const levels = ['standard', 'higher', 'exhigh', 'lossless', 'hires', 'spatial']
const aliases = { low: 'standard', medium: 'standard', standard: 'standard', higher: 'higher', high: 'exhigh', highest: 'exhigh', exhigh: 'exhigh', lossless: 'lossless', hi_res: 'hires', hires: 'hires', spatial: 'spatial' }
const rank = quality => levels.indexOf(aliases[quality] || 'exhigh')

function safeURL(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 65536 || /[^\x21-\x7e]/.test(raw)) return null
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return null
    return u
  } catch { return null }
}

export function mediaURL(raw) {
  const u = safeURL(raw)
  return !!u && domains.some(domain => u.hostname === domain || u.hostname.endsWith('.' + domain))
}

function redirectAllowed(destination, source, publiclyVerified) {
  if (mediaURL(destination)) return true
  const u = safeURL(destination)
  // A delegated zone is accepted only from a verified official CDN response.
  return !!u && mediaURL(source) && publiclyVerified === true &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.qrstuvwxyzab\.com$/.test(u.hostname)
}

function publicRequest(url, { signal, headers }) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers, signal, agent: false, ca: rootCertificates, rejectUnauthorized: true,
    }, response => resolve({
      status: response.statusCode, headers: response.headers, body: response,
      publiclyVerified: response.socket.authorized === true,
    }))
    req.once('error', reject)
  })
}

export async function downloadGranted(raw, { signal, request = publicRequest, limit = MAX_AUDIO_BYTES } = {}) {
  try {
    if (!mediaURL(raw)) throw error('unavailable')
    let current = raw
    for (let hop = 0; hop <= 3; hop++) {
      if (signal?.aborted) throw error('canceled')
      // Recreate headers on every hop. Account cookies/signatures and Referer never enter this transport.
      const response = await request(current, {
        signal, headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' },
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        response.body?.destroy?.()
        if (hop === 3 || typeof response.headers?.location !== 'string') throw error('unavailable')
        const destination = new URL(response.headers.location, current).href
        if (!redirectAllowed(destination, current, response.publiclyVerified)) throw error('unavailable')
        current = destination
        continue
      }
      if (response.status !== 200) {
        response.body?.destroy?.()
        throw error('unavailable')
      }
      const encoding = response.headers?.['content-encoding']
      const length = response.headers?.['content-length']
      if (encoding && encoding !== 'identity' || length != null && (!/^\d+$/.test(String(length)) || Number(length) > limit)) {
        response.body?.destroy?.()
        throw error('unavailable')
      }
      const chunks = []
      let size = 0
      try {
        for await (const chunk of response.body) {
          if (signal?.aborted) throw error('canceled')
          const bytes = Buffer.from(chunk)
          size += bytes.length
          if (size > limit) throw error('unavailable')
          chunks.push(bytes)
        }
      } catch (cause) {
        response.body?.destroy?.()
        throw cause
      }
      if (!size || length != null && size !== Number(length)) throw error('unavailable')
      return Buffer.concat(chunks)
    }
    throw error('unavailable')
  } catch {
    throw error(signal?.aborted ? 'canceled' : 'unavailable')
  }
}

function candidateQuality(candidate) {
  const meta = candidate.video_meta
  const level = aliases[String(meta.quality).toLowerCase()]
  if (level === 'hires' || level === 'spatial') return level
  if (meta.codec_type.toLowerCase() === 'flac') return 'lossless'
  if (['standard', 'higher', 'exhigh'].includes(level)) return level
  return meta.bitrate > 0 && meta.bitrate <= 96000 ? 'standard' : meta.bitrate > 0 && meta.bitrate <= 192000 ? 'higher' : 'exhigh'
}

export function grantedCandidates(payload, id, quality) {
  try {
    if (!payload || typeof payload !== 'object' || [payload.error_code, payload.status_code, payload.status_info?.code].some(code => code != null && Number(code) !== 0)) throw error('unavailable')
    if (String(payload.track?.id) !== id || !Number.isFinite(payload.track?.duration) || payload.track.duration <= 0) throw error('unavailable')
    const raw = payload.track_player?.video_model
    const model = typeof raw === 'string' ? parseJSON(raw) : raw
    if (!model || !Number.isFinite(model.video_duration) || model.video_duration <= 0 || model.video_duration > 86400 || !Array.isArray(model.video_list)) throw error('unavailable')
    // MyGO has no preview contract. Refuse short grants before any media is fetched.
    if (Math.round(model.video_duration * 1000) + 2000 < payload.track.duration ||
        payload.track_player?.is_preview === true || model.is_preview === true) throw error('unavailable')
    const list = model.video_list.filter(item => {
      const meta = item?.video_meta, auth = item?.encrypt_info?.spade_a
      if (!meta || typeof meta.codec_type !== 'string' || !mediaURL(item.main_url)) return false
      const codec = meta.codec_type.toLowerCase()
      if (!['aac', 'flac', 'mp3'].includes(codec) || auth != null && (typeof auth !== 'string' || auth.length > 4096)) return false
      if (auth && !['aac', 'flac'].includes(codec)) return false
      if (meta.size != null && (!Number.isFinite(meta.size) || meta.size < 0 || meta.size > MAX_AUDIO_BYTES)) return false
      return meta.bitrate == null || Number.isFinite(meta.bitrate) && meta.bitrate >= 0
    }).sort((a, b) => rank(candidateQuality(a)) - rank(candidateQuality(b)) || (a.video_meta.bitrate || 0) - (b.video_meta.bitrate || 0))
    if (!list.length) throw error('unavailable')
    let selected = list[0]
    for (const candidate of list) if (rank(candidateQuality(candidate)) <= rank(quality)) selected = candidate
    // At most one format fallback, always from this exact grant, with its own auth.
    const aac = list.filter(item => item.video_meta.codec_type.toLowerCase() === 'aac')
    let fallback = aac[0]
    for (const candidate of aac) if (rank(candidateQuality(candidate)) <= rank(quality)) fallback = candidate
    return { selected, fallback }
  } catch { throw error('unavailable') }
}

function nativeFLAC(data) {
  if (data.length < 42 || data.toString('ascii', 0, 4) !== 'fLaC') return false
  let pos = 4, blocks = 0
  for (;;) {
    if (pos + 4 > data.length) return false
    const type = data[pos] & 0x7f, last = data[pos] & 0x80, size = data.readUIntBE(pos + 1, 3)
    if ((!blocks && (type !== 0 || size !== 34)) || (blocks && type === 0) || type === 127) return false
    pos += 4 + size
    if (pos > data.length) return false
    blocks++
    if (last) return pos < data.length
  }
}

function mp3(data) {
  let offset = 0
  if (data.toString('ascii', 0, 3) === 'ID3') {
    if (data.length < 10 || data.subarray(6, 10).some(byte => byte & 0x80)) return false
    offset = 10 + data[6] * 2097152 + data[7] * 16384 + data[8] * 128 + data[9]
    if (data[5] & 0x10) offset += 10
  }
  return offset + 4 <= data.length && data[offset] === 0xff && (data[offset + 1] & 0xe0) === 0xe0 &&
    (data[offset + 1] & 0x18) !== 0x08 && (data[offset + 1] & 0x06) === 0x02 &&
    (data[offset + 2] & 0xf0) !== 0 && (data[offset + 2] & 0xf0) !== 0xf0 && (data[offset + 2] & 0x0c) !== 0x0c
}

async function materialize(candidate, deps, signal) {
  // Transport errors cannot trigger a second download.
  let data = await deps.download(candidate.main_url, { signal })
  if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_AUDIO_BYTES) throw error('unavailable')
  try {
    const auth = candidate.encrypt_info?.spade_a
    if (auth) data = await deps.decode(data, auth, { signal })
    if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_AUDIO_BYTES) throw error('unavailable')
    const codec = candidate.video_meta.codec_type.toLowerCase()
    if (codec === 'aac') {
      if (data.length < 8 || data.toString('ascii', 4, 8) !== 'ftyp') throw error('unavailable')
      data = await deps.convert(data, { signal })
    }
    const type = codec === 'mp3' ? 'mp3' : 'flac'
    if (!Buffer.isBuffer(data) || data.length > MAX_AUDIO_BYTES || !(type === 'flac' ? nativeFLAC(data) : mp3(data))) throw error('unavailable')
    const actual = candidateQuality(candidate)
    const result = { data, type, quality: codec === 'flac' ? 'lossless' : actual === 'standard' ? 'standard' : 'high' }
    if (candidate.video_meta.bitrate > 0) result.bitRate = candidate.video_meta.bitrate
    return result
  } catch (cause) {
    const kind = signal.aborted ? 'canceled' : cause?.kind === 'setup' ? 'setup' : 'unavailable'
    throw Object.assign(error(kind), { unsupported: candidate.video_meta.codec_type.toLowerCase() === 'flac' && kind === 'unavailable' })
  }
}

// Tests can replace the account request, media transport, resource decoder and converter.
export async function resolvePlayback(session, { id, quality = 'high' }, deps = {}) {
  const deadline = AbortSignal.timeout(24000)
  const signal = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline
  try {
    if (typeof id !== 'string' || !/^\d{1,32}$/.test(id)) throw error('unavailable')
    if (!session || session.version !== 1 || !/^\d{16}$/.test(session.deviceID) || !/^\d{15}$/.test(session.installID)) throw error('session')
    cookieHeader(session.cookies)
    const requestJSON = deps.requestJSON || (await import('./catalog.mjs')).requestJSON
    const payload = await requestJSON(session, '/luna/pc/track_v2', {
      body: { track_id: id, media_type: 'track', queue_type: 'favorite_track_playlist', scene_name: 'library' }, signed: true, signal,
    })
    const { selected, fallback } = grantedCandidates(payload, id, quality)
    const runtime = { download: deps.download || downloadGranted, decode: deps.decode || decodeResource, convert: deps.convert || convertAAC }
    let result
    try { result = await materialize(selected, runtime, signal) }
    catch (cause) {
      if (!cause.unsupported || !fallback || signal.aborted) throw cause
      result = await materialize(fallback, runtime, signal)
    }
    if (signal.aborted) throw error('canceled')
    return result
  } catch (cause) {
    throw error(signal.aborted ? 'canceled' : ['session', 'expired', 'rateLimit', 'verify', 'rejected', 'setup'].includes(cause?.kind) ? cause.kind : 'unavailable')
  }
}
