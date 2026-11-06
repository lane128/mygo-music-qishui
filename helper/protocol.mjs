// Ported from mygo-cloudmusic/internal/qishui/{client,passport,session}.go.
import { createHash, randomBytes, randomUUID } from 'node:crypto'

export const API = 'https://api.qishui.com'
export const SESSION_NAMES = new Set(['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt'])
export const error = kind => Object.assign(new Error(kind), { kind })

export function accountURL(raw) {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      (u.hostname === 'qishui.com' || u.hostname.endsWith('.qishui.com'))
  } catch { return false }
}

// Tokenize strings as well as numbers, so digits in a nickname are untouched.
// Account IDs can exceed Number.MAX_SAFE_INTEGER; preserve them before parsing.
export function parseJSON(raw) {
  if (typeof raw !== 'string' || raw.length > 1048576) throw error('response')
  try {
    return JSON.parse(raw.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token =>
      /^-?\d{16,}$/.test(token) ? JSON.stringify(token) : token))
  } catch { throw error('response') }
}

export function decodeResponse({ status, body }) {
  if (status === 401) throw error('session')
  if (status === 429) throw error('rateLimit')
  if (status === 403) throw error('rejected')
  if (status !== 200) throw error('network')
  const value = parseJSON(body)
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
  return {
    id: String(p.id),
    name: p.nickname || p.public_name || '汽水音乐用户',
    imageUrl: imageURL(p.avatar_url) || imageURL(p.larger_avatar_url) ||
      imageURL(p.medium_avatar_url, '~c5_300x300.jpg') || imageURL(p.thumb_avatar_url, '~c5_100x100.jpg') ||
      imageURL(p.url_avatar, '~c5_300x300.jpg'),
  }
}

export function newIdentity() {
  const digits = n => Array.from(randomBytes(n), (v, i) => String(i ? v % 10 : 1 + v % 9)).join('')
  return {
    deviceID: digits(16), installID: digits(15),
    msToken: randomBytes(88).toString('base64url') + '==',
    portraitID: randomUUID() + '.login',
  }
}

export function passportParams(identity) {
  return new URLSearchParams({
    aid: '386088', passport_jssdk_version: '2.4.13', passport_jssdk_type: 'normal',
    is_from_ttaccountsdk: '1', language: 'zh', account_sdk_source: 'web',
    p_js_v: '2.4.13', p_js_t: 'pro', p_zt: '3.3.5', p_ver: '1.0.29',
    request_host: 'app%3A%2F%2Fresources', p_bd: '1.0.0.41',
    is_new_login: '1', is_from_iesaccountsaas: '1', device_platform: 'PC',
    version_code: '3.5.2', account_sdk_source_info: '00', biz_trace_id: randomBytes(4).toString('hex'),
    device_id: identity.deviceID, did: identity.deviceID,
    install_id: identity.installID, iid: identity.installID, msToken: identity.msToken,
  })
}

export class Login {
  constructor(transport) {
    this.transport = transport
    this.identity = newIdentity()
    this.qr = null
  }

  async request(path, form, extra = {}) {
    const query = passportParams(this.identity)
    for (const [key, value] of Object.entries(extra)) query.set(key, value)
    const headers = {
      Accept: 'application/json, text/javascript',
      'x-tt-passport-verify-portrait': this.identity.portraitID,
      'x-tt-passport-trace-id': query.get('biz_trace_id'),
    }
    let body
    if (form) {
      // Match Go url.Values.Encode, including the order of POST body bytes.
      const params = new URLSearchParams(form)
      params.sort()
      body = params.toString()
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      headers['x-ss-stub'] = createHash('md5').update(body).digest('hex').toUpperCase()
    }
    query.sort()
    return decodeResponse(await this.transport.request({
      method: form ? 'POST' : 'GET', url: API + path + '?' + query, headers, body,
    }))
  }

  async start() {
    const payload = await this.request('/passport/web/get_qrcode/', null, {
      next: API, need_logo: 'false', need_short_url: 'false', is_new_login: '1',
    })
    const qr = payload.data
    if (!qr || typeof qr.token !== 'string' || !qr.token || !accountURL(qr.qrcode_index_url)) throw error('response')
    this.qr = qr
    // Preserve the full server URL, including its selected scanner and channel.
    return { qr: qr.qrcode_index_url, expiresIn: 210000 }
  }

  async check() {
    if (!this.qr) throw error('response')
    const { data } = await this.request('/passport/web/check_qrconnect/', {
      token: this.qr.token, next: API, need_logo: 'false', need_short_url: 'false',
      is_frontier: String(this.qr.is_frontier === true), is_new_login: '1',
    })
    const status = String(data?.status).trim().toLowerCase()
    if (['new', '1'].includes(status)) return { status: 'new' }
    if (['scanned', '2'].includes(status)) return { status: 'scanned' }
    if (['expired', 'expire', 'timeout'].includes(status)) throw error('expired')
    if (['cancelled', 'canceled', 'rejected', 'denied'].includes(status)) throw error('rejected')
    if (!['confirmed', 'success', '3'].includes(status)) throw error('response')
    let cookies = await this.transport.cookies()
    let hasSession = () => cookies.some(c => SESSION_NAMES.has(c.name) && c.value && !(c.expires > 0 && c.expires <= Date.now() / 1000))
    // A successful browser response may already contain the session; do not
    // unconditionally follow a completion URL that could now fail.
    if (!hasSession() && data.redirect_url) {
      if (!accountURL(data.redirect_url)) throw error('response')
      await this.transport.request({ method: 'GET', url: data.redirect_url, headers: {} })
      cookies = await this.transport.cookies()
    }
    if (!hasSession()) throw error('session')
    cookieHeader(cookies)
    const account = profileOf(decodeResponse(await this.transport.request({
      method: 'GET', url: API + '/luna/pc/me?aid=386088', headers: {},
    })))
    cookies = await this.transport.cookies()
    cookieHeader(cookies)
    return {
      status: 'confirmed', account,
      session: { version: 1, deviceID: this.identity.deviceID, installID: this.identity.installID, cookies },
    }
  }
}

export async function restoreAccount(session, request = fetch) {
  if (!session || session.version !== 1 || !/^\d{16}$/.test(session.deviceID) || !/^\d{15}$/.test(session.installID)) throw error('session')
  const headers = { 'User-Agent': 'LunaPC/3.0.0(290101097)', Cookie: cookieHeader(session.cookies) }
  let response
  try {
    response = await request(API + '/luna/pc/me?aid=386088', {
      headers, redirect: 'error', signal: AbortSignal.timeout(20000),
    })
  } catch { throw error('network') }
  // Read with a bound rather than buffering an arbitrary upstream response.
  let body = ''
  try {
    const decoder = new TextDecoder()
    for await (const chunk of response.body) {
      body += decoder.decode(chunk, { stream: true })
      if (body.length > 1048576) throw error('response')
    }
    body += decoder.decode()
  } catch (err) { throw err.kind ? err : error('network') }
  return profileOf(decodeResponse({ status: response.status, body }))
}
