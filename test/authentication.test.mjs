import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { test } from 'node:test'
import { sandbox, session, profile, qrURL, json, sessionCookie, qrReply, confirmedReply, profileReply, until } from './fixtures/plugin-sandbox.mjs'

// The real sandbox entry must complete and restore a newly confirmed session without any process capability.
test('pure login preserves the server QR, signs only the form digest, verifies profile and restores without spawn', async () => {
  const s = await sandbox([], undefined, { allowSpawn: false, replies: [
    qrReply(), json({ error_code: 0, data: { status: 'scanned' } }), confirmedReply(),
    json({ my_info: { id: profile.id, nickname: 'Long account 1234567890123456789', is_vip: true, vip_stage: 'svip', avatar_url: 'https://example.invalid/avatar.png' } }),
  ] })
  const account = await s.api.signIn()
  assert.equal(account.id, profile.id)
  assert.equal(account.name, 'SVIP · Long account 1234567890123456789')
  assert.equal(account.imageUrl, 'https://example.invalid/avatar.png')
  assert.equal(s.prompts[0].qr, qrURL)
  assert.equal(s.prompts[1].qr, qrURL)
  assert.equal(s.spawned(), 0)
  const [created, polled] = s.authCalls
  const u = new URL(created.url), body = polled.options.body
  assert.equal(created.options.headers.Cookie, undefined)
  assert.equal(u.searchParams.get('device_id'), s.state.get('session').deviceID)
  assert.match(u.searchParams.get('device_id'), /^[1-9]\d{15}$/)
  assert.match(u.searchParams.get('install_id'), /^[1-9]\d{14}$/)
  assert.match(u.searchParams.get('msToken'), /^[\w-]{118}==$/)
  assert.match(created.options.headers['x-tt-passport-verify-portrait'], /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.login$/)
  assert.notEqual(new URL(polled.url).searchParams.get('biz_trace_id'), u.searchParams.get('biz_trace_id'))
  assert.equal(polled.options.method, 'POST')
  assert.equal(polled.options.headers['x-ss-stub'], createHash('md5').update(body).digest('hex').toUpperCase())
  assert.equal(new URLSearchParams(body).get('token'), 'synthetic-qr-challenge')
  const saved = s.state.get('session')
  assert.equal(saved.version, 1)
  assert.equal(saved.cookies.length, 1)
  const restored = await sandbox([], saved, { allowSpawn: false, replies: [profileReply()] })
  assert.equal((await restored.api.account()).id, profile.id)
  assert.equal(restored.authCalls[0].options.headers.Cookie, ['sessionid', 'synthetic-session'].join('='))
  await restored.api.signOut()
  assert.equal(await restored.api.account(), null)
  assert.equal(restored.spawned(), 0)
  assert.equal(restored.state.has('session'), false)
  assert.equal(s.timers.size, 0)
})

// Auth errors must stop without retries, private response text, or replacing the old account.
test('failed replacement preserves old session and sanitizes all remote errors', async t => {
  for (const [name, reply, kind] of [
    ['verification', json({ data: { error_code: 2046, description: 'private-upstream-detail' } }), 'verify'],
    ['rate-limit-code', json({ error_code: 7 }), 'rateLimit'],
    ['rate-limit-http', json({}, [], 429), 'rateLimit'],
    ['refused-http', json({}, [], 403), 'rejected'],
    ['expired-code', json({ error_code: 2 }), 'expired'],
    ['denied-state', json({ error_code: 0, data: { status: 'denied' } }), 'rejected'],
    ['expired-state', json({ error_code: 0, data: { status: 'timeout' } }), 'expired'],
    ['unknown-state', json({ error_code: 0, data: { status: 'unrecognized' } }), 'response'],
    ['invalid-json', new Response('private-upstream-detail'), 'response'],
    ['network', () => { throw new Error('private-upstream-detail') }, 'network'],
  ]) await t.test(name, async () => {
    const s = await sandbox([], session, { allowSpawn: false, replies: [qrReply(), reply] })
    await assert.rejects(s.api.signIn(), e => e.kind === kind && !e.message.includes('private-upstream-detail'))
    assert.equal(s.state.get('session'), session)
    assert.equal(s.authCalls.length, 2)
    assert.equal(s.timers.size, 0)
  })
})

// A pending QR or a confirmed response without new credentials must never borrow an existing session.
test('requires explicit confirmation and a new usable session before looking up an account', async t => {
  for (const [status, cookies, kind] of [
    ['confirmed', [], 'session'],
    ['confirmed', [sessionCookie('expired', 'Path=/; Max-Age=0')], 'session'],
    ['confirmed', [sessionCookie('wrong-path', 'Path=/passport; Secure')], 'session'],
    ['confirmed', [sessionCookie('wrong-domain', 'Domain=other.qishui.com; Path=/')], 'session'],
    ['confirmed', [sessionCookie('foreign', ['Domain', 'evil.invalid'].join('=') + '; Path=/')], 'session'],
    ['unexpected', [sessionCookie()], 'response'],
  ]) await t.test(status + ':' + (cookies[0] || 'absent'), async () => {
    const s = await sandbox([], session, { allowSpawn: false, replies: [qrReply(), json({ error_code: 0, data: { status } }, cookies)] })
    await assert.rejects(s.api.signIn(), e => e.kind === kind)
    assert.equal(s.authCalls.length, 2)
    assert.equal(s.state.get('session'), session)
  })
})

// Cookie values from the QR response cannot override the confirmation state or account verification.
test('pending cookies and failed profile lookups cannot be committed', async () => {
  const pending = await sandbox([], session, { allowSpawn: false, replies: [qrReply(), json({ error_code: 0, data: { status: 'new' } }, [sessionCookie()]), json({ error_code: 0, data: { status: 'denied' } })] })
  await assert.rejects(pending.api.signIn(), e => e.kind === 'rejected')
  assert.equal(pending.state.get('session'), session)
  for (const reply of [json({}, [], 401), json({ my_info: { nickname: 'Missing ID' } })]) {
    const s = await sandbox([], session, { allowSpawn: false, replies: [qrReply(), confirmedReply(), reply] })
    await assert.rejects(s.api.signIn())
    assert.equal(s.state.get('session'), session)
  }
})

// Redirects are followed manually; a host-only cookie must not cross to another login subdomain.
test('completion redirects isolate hosts and persist only API cookies', async () => {
  const s = await sandbox([], undefined, { allowSpawn: false, replies: [qrReply(),
    json({ error_code: 0, data: { status: 'confirmed', redirect_url: 'https://api.qishui.com/complete' } }),
    new Response('', { status: 307, headers: { location: 'https://passport.qishui.com/final', 'set-cookie': 'private=synthetic-only; Path=/; Secure' } }),
    (url, options) => { assert.equal(options.headers.Cookie, undefined); return json({}, [sessionCookie('synthetic-session', 'Domain=.qishui.com; Path=/; Secure'), 'login-only=synthetic-only; Path=/']) },
    profileReply(),
  ] })
  await s.api.signIn()
  assert.equal(s.authCalls[3].url, 'https://passport.qishui.com/final')
  assert.ok(s.authCalls.every(c => c.options.redirect === 'manual'))
  const cookies = s.state.get('session').cookies
  assert.ok(cookies.some(c => c.name === 'sessionid'))
  assert.equal(cookies.some(c => c.name === 'login-only'), false)
  assert.equal(s.authCalls[4].options.headers.Cookie.includes('login-only'), false)
})

// Each redirect hop must keep HTTPS, credentials out of URLs, and the actual service domain boundary.
test('rejects unsafe QR and completion URLs before contacting them', async t => {
  const invalid = ['http://api.qishui.com/final', 'https://qishui.com.evil.invalid/final', 'https://evilqishui.com/final', 'https://' + ['user', 'synthetic'].join(':') + '@api.qishui.com/final', 'https://api.qishui.com:8443/final']
  for (const url of invalid) await t.test(url, async () => {
    const qr = await sandbox([], undefined, { allowSpawn: false, replies: [json({ error_code: 0, data: { token: 'synthetic', qrcode_index_url: url } })] })
    await assert.rejects(qr.api.signIn(), e => e.kind === 'response')
    assert.equal(qr.authCalls.length, 1)
    const completion = await sandbox([], undefined, { allowSpawn: false, replies: [qrReply(), json({ error_code: 0, data: { status: 'confirmed', redirect_url: 'https://api.qishui.com/complete' } }), new Response('', { status: 308, headers: { location: url } })] })
    await assert.rejects(completion.api.signIn(), e => e.kind === 'response')
    assert.equal(completion.authCalls.length, 3)
    assert.equal(completion.state.has('session'), false)
  })
})

// Passport requests must never follow a redirect and forward their form or QR challenge to another host.
test('rejects redirected Passport requests and bounds completion loops', async () => {
  const redirected = await sandbox([], undefined, { allowSpawn: false, replies: [qrReply(), new Response('', { status: 307, headers: { location: 'https://passport.qishui.com/final' } })] })
  await assert.rejects(redirected.api.signIn(), e => e.kind === 'response')
  assert.equal(redirected.authCalls.length, 2)
  const looping = await sandbox([], undefined, { allowSpawn: false, replies: [qrReply(), json({ error_code: 0, data: { status: 'confirmed', redirect_url: 'https://api.qishui.com/loop' } }), ...Array.from({ length: 6 }, () => new Response('', { status: 302, headers: { location: '/loop' } }))] })
  await assert.rejects(looping.api.signIn(), e => e.kind === 'response')
  assert.equal(looping.authCalls.length, 8)
})

// Old browser-shaped v1 cookies remain usable, including session cookies whose expiry is -1.
test('restores legacy browser sessions, preserves network failures, and clears only expired auth', async () => {
  const legacy = { ...session, cookies: [{ name: 'sessionid', value: 'legacy-synthetic', domain: '.qishui.com', path: '/', expires: -1 }] }
  const s = await sandbox([], legacy, { allowSpawn: false, replies: [profileReply(), () => { throw Error('synthetic network') }, json({}, [], 401)] })
  assert.equal((await s.api.account()).id, profile.id)
  await assert.rejects(s.api.account(), e => e.kind === 'network')
  assert.deepEqual(JSON.parse(JSON.stringify(s.state.get('session').cookies)), [{
    name: 'sessionid', value: legacy.cookies[0].value, domain: 'qishui.com', path: '/', hostOnly: false, expires: 0,
  }])
  assert.equal(s.state.get('session').account.id, profile.id)
  assert.equal(await s.api.account(), null)
  assert.equal(s.state.has('session'), false)
  assert.equal(await s.api.account(), null)
  assert.equal(s.authCalls.length, 4)
  assert.equal(s.spawned(), 0)
})

// A malformed stored cookie must not inject a header, reach a foreign domain, or crash with private data.
test('invalid persisted sessions are removed without any network request', async () => {
  for (const cookies of [
    [{ name: 'sessionid', value: 'bad\r\nInjected: private' }],
    [{ name: 'sessionid', value: 'bad; injected=value' }],
    [{ name: 'sessionid', value: 'synthetic', domain: 'evil.invalid', path: '/' }],
    [{ name: 'sessionid', value: 'synthetic', path: '/' }],
    [{ name: 'sessionid', value: 'synthetic', expires: 1 }],
  ]) {
    const s = await sandbox([], { ...session, cookies }, { allowSpawn: false })
    assert.equal(await s.api.account(), null)
    assert.equal(s.authCalls.length, 0)
    assert.equal(s.state.has('session'), false)
  }
})

// Cancellation before the first await or during fetch/body reading must invalidate late success and stop timers.
test('sign-out cancels startup, in-flight requests, and the polling wait', async t => {
  await t.test('startup', async () => {
    const s = await sandbox([], undefined, { allowSpawn: false })
    const login = s.api.signIn(), rejected = assert.rejects(login, e => e.kind === 'cancelled')
    await s.api.signOut(); await rejected
    assert.equal(s.authCalls.length, 0)
  })
  for (const phase of ['create', 'poll', 'profile']) await t.test(phase, async () => {
    let entered = false
    const held = (url, options) => new Promise((resolve, reject) => { entered = true; options.signal.addEventListener('abort', () => reject(Error('private abort')), { once: true }) })
    const replies = phase === 'create' ? [held] : phase === 'poll' ? [qrReply(), held] : [qrReply(), confirmedReply(), held]
    const s = await sandbox([], undefined, { allowSpawn: false, replies })
    const login = s.api.signIn(), rejected = assert.rejects(login, e => e.kind === 'cancelled')
    await until(() => entered)
    await s.api.signOut(); await rejected
    assert.equal(s.state.has('session'), false)
    assert.equal(s.timers.size, 0)
  })
  await t.test('poll wait', async () => {
    let waiting = false
    const s = await sandbox([], undefined, { allowSpawn: false, replies: [qrReply()], timer: (cb, ms) => { if (ms === 3500) { waiting = true; return 0 }; return setTimeout(cb, ms) } })
    const login = s.api.signIn(), rejected = assert.rejects(login, e => e.kind === 'cancelled')
    await until(() => waiting)
    await s.api.signOut(); await rejected
    assert.equal(s.authCalls.length, 1)
  })
})

// A superseded login keeps its own cookie jar and cannot save over the newer attempt.
test('concurrent login replacement discards a late confirmation and keeps isolated devices', async () => {
  let finish
  const held = new Promise(resolve => { finish = resolve })
  const s = await sandbox([], undefined, { allowSpawn: false, replies: [qrReply(), () => held, qrReply(), confirmedReply(), profileReply()] })
  const old = s.api.signIn(), rejected = assert.rejects(old, e => e.kind === 'cancelled')
  await until(() => s.authCalls.length === 2)
  await s.api.signIn()
  finish(confirmedReply()); await rejected
  assert.equal(s.authCalls[2].options.headers.Cookie, undefined)
  assert.notEqual(new URL(s.authCalls[0].url).searchParams.get('device_id'), new URL(s.authCalls[2].url).searchParams.get('device_id'))
  assert.equal(s.state.get('session').account.id, profile.id)
})

// A login superseded while old audio helpers are closing must never persist its cancelled account.
test('defers session commit until helper cleanup completes and the login is still current', async () => {
  let confirm, releaseClose, closing = false
  const confirmation = new Promise(resolve => { confirm = resolve })
  const cleanup = new Promise(resolve => { releaseClose = resolve })
  const s = await sandbox([[{ ok: true, result: { url: 'http://127.0.0.1:12345/test-audio', type: 'mp3' } }]], session, {
    replies: [qrReply(), () => confirmation, profileReply(), () => { throw Error('replacement network failure') }],
    waitForClose: () => { closing = true; return cleanup },
  })
  const first = s.api.signIn(), cancelled = assert.rejects(first, e => e.kind === 'cancelled')
  await until(() => s.authCalls.length === 2)
  await s.api.stream({ id: '123' })
  confirm(confirmedReply())
  await until(() => closing)
  try {
    await assert.rejects(s.api.signIn(), e => e.kind === 'network')
  } finally { releaseClose() }
  await cancelled
  assert.equal(s.state.get('session'), session, 'cancelled login must preserve the original session')
})

// A refresh of the old expired account must invalidate its content, while the independent QR login continues.
test('expired account refresh cannot cancel a pending replacement login or accept old music', async () => {
  let confirm, finishMusic
  const confirmation = new Promise(resolve => { confirm = resolve })
  const music = new Promise(resolve => { finishMusic = resolve })
  const s = await sandbox([[() => music]], session, { replies: [qrReply(), () => confirmation, json({}, [], 401), profileReply()] })
  const login = s.api.signIn()
  const loginResult = login.then(value => ({ value }), error => ({ error }))
  await until(() => s.authCalls.length === 2)
  const oldMusic = s.api.home(), rejectedMusic = assert.rejects(oldMusic)
  await until(() => s.calls.length === 1)
  assert.equal(await s.api.account(), null)
  finishMusic(JSON.stringify({ ok: true, result: { title: 'Old private content', sections: [] } }))
  await rejectedMusic
  confirm(confirmedReply())
  const result = await loginResult
  assert.equal(result.error, undefined, 'old account expiry must not cancel the new QR')
  assert.equal(result.value.id, profile.id)
  assert.equal(s.state.get('session').account.id, profile.id)
})

// Expiry detected during the final audio cleanup must not invalidate the independently verified new session.
test('keeps the confirmed replacement current if the old account expires during final cleanup', async () => {
  let confirm, releaseClose, closing = false
  const confirmation = new Promise(resolve => { confirm = resolve })
  const cleanup = new Promise(resolve => { releaseClose = resolve })
  const s = await sandbox([[{ ok: true, result: { url: 'http://127.0.0.1:12345/old-audio', type: 'mp3' } }]], session, {
    replies: [qrReply(), () => confirmation, profileReply(), json({}, [], 401)],
    waitForClose: () => { closing = true; return cleanup },
  })
  const login = s.api.signIn(), outcome = login.then(value => ({ value }), error => ({ error }))
  await until(() => s.authCalls.length === 2)
  await s.api.stream({ id: '123' })
  confirm(confirmedReply())
  await until(() => closing)
  try { assert.equal(await s.api.account(), null) } finally { releaseClose() }
  const result = await outcome
  assert.equal(result.error, undefined)
  assert.equal(result.value.id, profile.id)
  assert.equal(s.state.get('session').account.id, profile.id)
})

// A streamed response must stop at the byte limit instead of buffering arbitrarily large private responses.
test('bounds response bytes and reports only sanitized parsing errors', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1048577)) }, cancel() { cancelled = true } }))
  const s = await sandbox([], session, { allowSpawn: false, replies: [qrReply(), response] })
  await assert.rejects(s.api.signIn(), e => e.kind === 'response')
  assert.equal(cancelled, true)
  assert.equal(s.state.get('session'), session)
  assert.equal(s.timers.size, 0)
})

// IDs above JS's safe integer range must survive raw numeric JSON, and unknown VIP flags must not create badges.
test('preserves integer account IDs and re-evaluates membership on account restore', async () => {
  const s = await sandbox([], session, { allowSpawn: false, replies: [new Response('{"my_info":{"id":7123456789012345678,"nickname":"Example","is_vip":false,"vip_stage":"svip"}}')] })
  const account = await s.api.account()
  assert.equal(account.id, '7123456789012345678')
  assert.equal(account.name, 'Example')
})

// The request deadline must abort a hung service, and local QR expiry must stop before another poll.
test('bounds requests and QR lifetime using controlled test clocks', async () => {
  const hung = (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('synthetic timeout')), { once: true }))
  const s = await sandbox([], session, { allowSpawn: false, replies: [hung], timer: (callback, ms) => { assert.equal(ms, 20000); queueMicrotask(callback); return 0 } })
  await assert.rejects(s.api.signIn(), e => e.kind === 'network')
  assert.equal(s.state.get('session'), session)
  assert.equal(s.authCalls.length, 1)
  let reads = 0
  class Clock extends Date { static now() { return reads++ === 0 ? 1000 : 211001 } }
  const expired = await sandbox([], session, { allowSpawn: false, clock: Clock, replies: [qrReply()] })
  await assert.rejects(expired.api.signIn(), e => e.kind === 'expired')
  assert.equal(expired.authCalls.length, 1)
  assert.equal(expired.state.get('session'), session)
})

// Cancel during a streamed response must abort its read and keep the cancelled attempt from committing.
test('cancels a response body while it is being read', async () => {
  let reading = false
  const response = (url, options) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{'))
    options.signal.addEventListener('abort', () => controller.error(Error('private stream failure')), { once: true })
  }, pull() { reading = true } }))
  const s = await sandbox([], undefined, { allowSpawn: false, replies: [qrReply(), confirmedReply(), response] })
  const login = s.api.signIn(), rejected = assert.rejects(login, e => e.kind === 'cancelled')
  await until(() => reading)
  await s.api.signOut(); await rejected
  assert.equal(s.state.has('session'), false)
  assert.equal(s.timers.size, 0)
})

// Anonymous identity generation works both with Web Crypto and the actual MyGO-compatible metadata fallback.
test('login has no Node or crypto API requirement and uses Web Crypto when available', async () => {
  let randomCalls = 0
  const crypto = { getRandomValues(bytes) { randomCalls++; return webcrypto.getRandomValues(bytes) } }
  for (const value of [undefined, crypto]) {
    const s = await sandbox([], undefined, { allowSpawn: false, crypto: value, replies: [qrReply(), confirmedReply(), profileReply()] })
    await s.api.signIn()
    assert.equal(s.spawned(), 0)
  }
  assert.ok(randomCalls > 0)
})
