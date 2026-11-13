import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sandbox, session, profile, json, profileReply, qrReply, until } from './fixtures/plugin-sandbox.mjs'

const complete = { type: 'complete', cookie: 'sessionid=fresh-browser-session; csrf_token=csrf' }
const verifyReply = () => json({data:{error_code:2046}})
const options = extra => ({ arch: 'amd64', replies: [qrReply(), verifyReply(), profileReply()], login: complete, ...extra })

test('macOS verification opens an isolated helper and verifies its new account before persisting', async () => {
  const s = await sandbox([], session, options())
  assert.equal((await s.api.signIn()).id, profile.id)
  assert.equal(s.loginCalls.length, 1)
  const request = s.loginCalls[0]
  assert.equal(request.type, 'start')
  assert.equal(request.device.did, s.state.get('session').deviceID)
  assert.equal(JSON.stringify(request).includes('sessionid'), false)
  assert.equal(s.authCalls[2].options.headers.Cookie, 'sessionid=fresh-browser-session; csrf_token=csrf')
  assert.equal(s.state.get('session').cookies[0].value, 'fresh-browser-session')
  assert.equal(s.loginKilled(), 1)
  assert.equal(s.timers.size, 0)
})

test('browser cancellation, malformed credentials and failed profile leave the old account intact', async t => {
  for (const login of [
    { type: 'error', code: 'closed', message: 'private-error-detail' },
    { type: 'error', code: 'unknown', message: 'private-error-detail' },
    { type: 'complete', cookie: '' },
    { type: 'complete', cookie: 'sessionid=value\r\nInjected: bad' },
    { type: 'complete', cookie: 'sessionid=value; malformed' },
    { type: 'complete', cookie: 'other=value' },
    { type: 'unknown', cookie: complete.cookie },
  ]) await t.test(JSON.stringify(login), async () => {
    const s = await sandbox([], session, options({ login }))
    await assert.rejects(s.api.signIn(), e => !e.message.includes('private-error-detail'))
    assert.equal(s.state.get('session'), session)
    assert.equal(s.authCalls.length, 2)
    assert.equal(s.loginKilled(), 1)
    assert.equal(s.timers.size, 0)
  })
  const s = await sandbox([], session, options({ replies: [qrReply(), verifyReply(), json({}, [], 401)] }))
  await assert.rejects(s.api.signIn(), e => e.kind === 'session')
  assert.equal(s.state.get('session'), session)
})

test('signOut kills the verification window and ignores its late credentials', async () => {
  let finish
  const held = new Promise(resolve => { finish = resolve })
  const s = await sandbox([], session, options({ login: () => held }))
  const signing = s.api.signIn()
  const rejected = assert.rejects(signing, e => e.kind === 'cancelled')
  await until(() => s.loginCalls.length === 1)
  await s.api.signOut()
  assert.equal(s.loginKilled(), 1)
  finish(JSON.stringify(complete))
  await rejected
  assert.equal(s.state.has('session'), false)
  assert.equal(s.authCalls.length, 2)
  assert.equal(s.timers.size, 0)
})

test('a superseded browser login cannot replace a newer confirmed session', async () => {
  let finish
  const held = new Promise(resolve => { finish = resolve })
  let started = 0
  const s = await sandbox([], session, options({
    replies: [qrReply(), verifyReply(), qrReply(), verifyReply(), profileReply()],
    login: () => ++started === 1 ? held : JSON.stringify(complete),
  }))
  const first = s.api.signIn()
  const rejected = assert.rejects(first, e => e.kind === 'cancelled')
  await until(() => s.loginCalls.length === 1)
  await s.api.signIn()
  const saved = s.state.get('session')
  finish(JSON.stringify({ type: 'complete', cookie: 'sessionid=obsolete' }))
  await rejected
  assert.equal(s.state.get('session'), saved)
  assert.equal(saved.cookies[0].value, 'fresh-browser-session')
})


test('a helper that exits immediately after its final frame cannot override the login result', async () => {
  const s = await sandbox([], session, options({ loginKill() { throw new Error('os: process already finished') } }))
  assert.equal((await s.api.signIn()).id, profile.id)
  assert.equal(s.state.get('session').cookies[0].value, 'fresh-browser-session')
})


test('Apple Silicon uses its matching helper only when verification is required', async () => {
  const s = await sandbox([], session, options({ arch: 'arm64' }))
  assert.equal((await s.api.signIn()).id, profile.id)
  assert.equal(s.loginCalls.length, 1)
})

test('Windows retains its verification error without starting a macOS program', async () => {
  const s = await sandbox([], session, options({ platform: 'windows' }))
  await assert.rejects(s.api.signIn(), e => e.kind === 'verify')
  assert.equal(s.loginCalls.length, 0)
  assert.equal(s.state.get('session'), session)
})
