// Shared music response and session helpers, ported from mygo-cloudmusic.
export const API = 'https://api.qishui.com'
export const SESSION_NAMES = new Set(['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt'])
export const error = kind => Object.assign(new Error(kind), { kind })

// Tokenize strings as well as numbers, so digits in a nickname are untouched.
// Account IDs can exceed Number.MAX_SAFE_INTEGER; preserve them before parsing.
export function parseJSON(raw, limit = 1048576) {
  if (typeof raw !== 'string' || raw.length > limit) throw error('response')
  try {
    return JSON.parse(raw.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token =>
      /^-?\d{16,}$/.test(token) ? JSON.stringify(token) : token))
  } catch { throw error('response') }
}

export function decodeResponse({ status, body }, limit = 1048576) {
  if (status === 401) throw error('session')
  if (status === 429) throw error('rateLimit')
  if (status === 403) throw error('rejected')
  if (status !== 200) throw error('network')
  const value = parseJSON(body, limit)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('response')
  for (const code of [value.error_code, value.status_code, value.status_info?.code, value.data?.error_code]) {
    if (code == null || Number(code) === 0) continue
    if (Number(code) === 7) throw error('rateLimit')
    if (Number(code) === 2046) throw error('verify')
    if (Number(code) === 2) throw error('expired')
    throw error('rejected')
  }
  return value
}

export function cookieHeader(cookies, now = Date.now() / 1000) {
  if (!Array.isArray(cookies) || cookies.length > 128) throw error('session')
  const pairs = []
  for (const c of cookies) {
    if (!c || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(c.name) ||
        typeof c.value !== 'string' || !/^[\x21-\x3A\x3C-\x7E]+$/.test(c.value)) throw error('session')
    if (c.expires > 0 && c.expires <= now) continue
    pairs.push(`${c.name}=${c.value}`)
  }
  if (!pairs.some(pair => SESSION_NAMES.has(pair.slice(0, pair.indexOf('='))))) throw error('session')
  const header = pairs.join('; ')
  if (header.length > 65536) throw error('session')
  return header
}

function imageURL(value, suffix = '') {
  if (typeof value === 'string') {
    try { return new URL(value).protocol === 'https:' ? value : undefined } catch { return undefined }
  }
  if (!value || typeof value !== 'object') return undefined
  if (value.uri && value.template_prefix) {
    return `https://p3-luna.douyinpic.com/img/${value.uri}~${value.template_prefix}-resize:960:960.png`
  }
  for (const raw of value.urls || []) {
    try {
      const u = new URL(raw)
      if (u.protocol !== 'https:') continue
      if (value.uri && !u.pathname.includes(value.uri)) u.pathname = u.pathname.replace(/\/$/, '') + '/' + value.uri.replace(/^\//, '')
      if (!u.pathname.includes('~')) u.pathname += suffix
      return u.href
    } catch { /* Try the next image. */ }
  }
}

export function profileOf(payload) {
  const p = payload.my_info || payload.user
  if (!p || !/^\d+$/.test(String(p.id || ''))) throw error('response')
  const nickname = [p.nickname, p.public_name].find(value => typeof value === 'string' && value.trim()) || '汽水音乐用户'
  // is_vip is the account service's current membership decision. A tier alone,
  // an unknown flag or an expired/non-member profile must never create a badge.
  const tier = p.is_vip === true ? (p.vip_stage === 'svip' ? 'SVIP' : ['vip', 'free_vip'].includes(p.vip_stage) ? 'VIP' : '') : ''
  return {
    id: String(p.id),
    name: tier ? `${tier} · ${nickname}` : nickname,
    imageUrl: imageURL(p.avatar_url) || imageURL(p.larger_avatar_url) ||
      imageURL(p.medium_avatar_url, '~c5_300x300.jpg') || imageURL(p.thumb_avatar_url, '~c5_100x100.jpg') ||
      imageURL(p.url_avatar, '~c5_300x300.jpg'),
  }
}
