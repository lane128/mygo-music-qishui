import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { API, Login, accountURL, cookieHeader, decodeResponse, parseJSON, profileOf, restoreAccount } from '../helper/protocol.mjs'

const challenge = { token: 'test-challenge', qrcode_index_url: 'https://bff-pc.qishui.com/ucenter_web/app/sdk-next?token=test-challenge&uc_sdk=scan-auth', is_frontier: false }
const accountBody = '{"my_info":{"id":7123456789012345678,"public_name":"测试账号 7123456789012345678","medium_avatar_url":{"urls":["https://p3-luna.douyinpic.com/img"],"uri":"test/avatar"}}}'
const reply = value => ({ status: 200, body: typeof value === 'string' ? value : JSON.stringify(value) })
const saved = () => ({ version: 1, deviceID: '1234567890123456', installID: '123456789012345', cookies: [{ name: 'sessionid_ss', value: 'test-session', expires: -1 }] })
function transport() {
  const requests = []
  let jar = []
  return {
    requests, setCookies: value => { jar = value }, cookies: async () => jar,
    request: async spec => {
      requests.push(spec)
      const path = new URL(spec.url).pathname
      if (path.endsWith('/get_qrcode/')) return reply({ data: challenge })
      if (path.endsWith('/check_qrconnect/')) return reply({ data: { status: 2 } })
      if (path === '/luna/pc/me') return reply(accountBody)
      throw new Error('unexpected endpoint')
    },
  }
}

// The original QR URL and server-selected channel must survive creation and polling.
test('keeps the scanner URL, false/true frontier and per-attempt device identity', async () => {
  for (const frontier of [false, true]) {
    const wire = transport()
    const baseRequest = wire.request
    wire.request = spec => new URL(spec.url).pathname.endsWith('/get_qrcode/')
      ? (wire.requests.push(spec), reply({ data: { ...challenge, is_frontier: frontier } })) : baseRequest(spec)
    const login = new Login(wire)
    assert.equal((await login.start()).qr, challenge.qrcode_index_url)
    assert.equal((await login.check()).status, 'scanned')
    const [start, check] = wire.requests
    const first = new URL(start.url).searchParams
    const second = new URL(check.url).searchParams
    for (const key of ['device_id', 'install_id', 'msToken']) assert.equal(first.get(key), second.get(key))
    assert.notEqual(first.get('biz_trace_id'), second.get('biz_trace_id'))
    assert.equal(start.headers['x-tt-passport-verify-portrait'], check.headers['x-tt-passport-verify-portrait'])
    assert.equal(second.get('biz_trace_id'), check.headers['x-tt-passport-trace-id'])
    assert.equal(new URLSearchParams(check.body).get('is_frontier'), String(frontier))
    assert.equal(new URLSearchParams(check.body).get('token'), challenge.token)
    assert.equal(second.has('token'), false)
    assert.equal(check.headers['x-ss-stub'], createHash('md5').update(check.body).digest('hex').toUpperCase())
    assert.notEqual(login.identity.deviceID, new Login(transport()).identity.deviceID)
  }
})

// A preexisting cookie cannot turn an unconfirmed status into a successful login.
test('requires server confirmation before using session cookies', async () => {
  const wire = transport()
  wire.setCookies(saved().cookies)
  const login = new Login(wire)
  await login.start()
  assert.deepEqual(await login.check(), { status: 'scanned' })
  assert.equal(wire.requests.length, 2)
})

// Confirmation with an existing API session must skip a now-unnecessary completion URL.
test('validates the real account and skips completion when cookies already exist', async () => {
  const wire = transport()
  const base = wire.request
  wire.request = spec => new URL(spec.url).pathname.endsWith('/check_qrconnect/')
    ? reply({ data: { status: 3, redirect_url: 'https://api.qishui.com/unused' } }) : base(spec)
  wire.setCookies(saved().cookies)
  const login = new Login(wire)
  await login.start()
  const result = await login.check()
  assert.equal(result.status, 'confirmed')
  assert.equal(result.account.id, '7123456789012345678')
  assert.equal(result.account.name, '测试账号 7123456789012345678')
  assert.equal(result.account.imageUrl, 'https://p3-luna.douyinpic.com/img/test/avatar~c5_300x300.jpg')
  assert.equal(result.session.deviceID, login.identity.deviceID)
  assert.equal(wire.requests.some(spec => spec.url.includes('/unused')), false)
})

// Missing cookies require a trusted completion URL, and a usable account is still mandatory.
test('completion harvests cookies and refuses confirmed-without-session', async () => {
  const wire = transport()
  const base = wire.request
  wire.request = spec => {
    const path = new URL(spec.url).pathname
    if (path.endsWith('/check_qrconnect/')) return reply({ data: { status: 'confirmed', redirect_url: API + '/complete' } })
    if (path === '/complete') { wire.setCookies(saved().cookies); return { status: 500, body: '' } }
    return base(spec)
  }
  const login = new Login(wire)
  await login.start()
  assert.equal((await login.check()).status, 'confirmed')
  wire.request = () => reply({ data: { status: 'confirmed' } })
  wire.setCookies([])
  await assert.rejects(login.check(), { kind: 'session' })
  wire.request = () => reply({ data: { status: 'confirmed', redirect_url: 'https://example.com/steal' } })
  await assert.rejects(login.check(), { kind: 'response' })
})

// A malformed account response must not be replaced with a fabricated generic account.
test('does not persist a login without an account profile', async () => {
  const wire = transport()
  wire.setCookies(saved().cookies)
  const login = new Login(wire)
  await login.start()
  wire.request = spec => reply(new URL(spec.url).pathname === '/luna/pc/me' ? {} : { data: { status: 'confirmed' } })
  await assert.rejects(login.check(), { kind: 'response' })
})

// Numeric status 2 means scanned, whereas API error_code 2 means expired.
test('reports expiration, verification, rejection and rate limiting without leaking response text', () => {
  for (const [code, kind] of [[2, 'expired'], [7, 'rateLimit'], [2046, 'verify'], [2156, 'rejected']]) {
    assert.throws(() => decodeResponse(reply({ data: { error_code: code, description: 'private material' } })), err => err.kind === kind && !err.message.includes('private'))
  }
  assert.throws(() => decodeResponse({ status: 500, body: 'private material' }), { kind: 'network' })
})

// Large numeric IDs and quotes in strings must survive without precision loss or text corruption.
test('preserves large integers without touching quoted content', () => {
  assert.deepEqual(parseJSON('{"id":7123456789012345678,"nickname":"quote: \\\"7123456789012345678","n":1.25,"e":1e17}'),
    { id: '7123456789012345678', nickname: 'quote: "7123456789012345678', n: 1.25, e: 1e17 })
  assert.throws(() => parseJSON('not JSON'), { kind: 'response' })
})

// Restored sessions send only validated cookies to the fixed account endpoint, with no redirects.
test('restores the same account without a browser', async () => {
  const account = await restoreAccount(saved(), async (url, options) => {
    assert.equal(url, API + '/luna/pc/me?aid=386088')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Cookie, 'sessionid_ss=test-session')
    return new Response(accountBody)
  })
  assert.equal(account.id, '7123456789012345678')
  await assert.rejects(restoreAccount(saved(), async () => new Response('{}', { status: 401 })), { kind: 'session' })
  await assert.rejects(restoreAccount(saved(), async () => { throw new Error('private URL') }), { kind: 'network' })
})

// Membership belongs before a long nickname; stale tiers and unknown flags must not invent a badge.
test('formats confirmed membership prefixes without mutating the upstream nickname', () => {
  const nickname = '这是一位用户名比较长的汽水音乐用户'
  for (const [fields, prefix] of [
    [{ is_vip: true, vip_stage: 'vip' }, 'VIP · '],
    [{ is_vip: true, vip_stage: 'free_vip' }, 'VIP · '],
    [{ is_vip: true, vip_stage: 'svip' }, 'SVIP · '],
    [{ is_vip: false, vip_stage: 'svip' }, ''],
    [{ vip_stage: 'svip' }, ''],
    [{ is_vip: true, vip_stage: 'future-tier' }, ''],
    [{ is_vip: true }, ''],
    [{ is_vip: 'true', vip_stage: 'vip' }, ''],
    [{}, ''],
  ]) {
    const raw = { id: '123', nickname, ...fields }
    assert.equal(profileOf({ my_info: raw }).name, prefix + nickname)
    assert.equal(raw.nickname, nickname)
    assert.equal(profileOf({ user: raw }).id, '123')
  }
})

// Each restored account must recompute membership so an expired or downgraded account loses its prefix.
test('refreshes member display on account restoration and preserves avatar and identity', async () => {
  for (const [is_vip, name] of [[true, 'SVIP · Example'], [false, 'Example']]) {
    const account = await restoreAccount(saved(), async () => new Response(JSON.stringify({ my_info: { id: '123', nickname: 'Example', is_vip, vip_stage: 'svip', avatar_url: 'https://example.invalid/avatar.jpg' } })))
    assert.deepEqual(account, { id: '123', name, imageUrl: 'https://example.invalid/avatar.jpg' })
  }
})

// Expired or invalid saved credentials cannot be sent as a Cookie header.
test('rejects expired sessions and header injection', () => {
  assert.throws(() => cookieHeader([{ name: 'sessionid', value: 'test', expires: 1 }]), { kind: 'session' })
  assert.throws(() => cookieHeader([{ name: 'sessionid', value: 'test; injected=value' }]), { kind: 'session' })
  assert.throws(() => cookieHeader([{ name: 'sessionid', value: 'test\r\nInjected: value' }]), { kind: 'session' })
  assert.equal(cookieHeader(saved().cookies), 'sessionid_ss=test-session')
})

// Completion and request URLs must stay on HTTPS Qishui hosts, without embedded credentials.
test('rejects foreign, local and misleading account URLs', () => {
  assert.equal(accountURL(API + '/complete'), true)
  for (const raw of ['http://api.qishui.com', 'https://api.qishui.com.evil.test', 'https://user@api.qishui.com', 'https://api.qishui.com:8080', 'http://127.0.0.1']) assert.equal(accountURL(raw), false)
})
