import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cookieHeader, decodeResponse, parseJSON, profileOf } from '../helper/protocol.mjs'

const accountBody = '{"my_info":{"id":7123456789012345678,"public_name":"测试账号 7123456789012345678","medium_avatar_url":{"urls":["https://p3-luna.douyinpic.com/img"],"uri":"test/avatar"}}}'
const reply = value => ({ status: 200, body: typeof value === 'string' ? value : JSON.stringify(value) })
const cookies = () => [{ name: 'sessionid_ss', value: 'test-session', expires: -1 }]

// API error_code 2 means expired; numeric QR states are handled by the host sandbox.
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

// Shared parsing preserves the actual account's identity, name and avatar.
test('parses account profiles without losing large IDs', () => {
  assert.deepEqual(profileOf(decodeResponse(reply(accountBody))), {
    id: '7123456789012345678', name: '测试账号 7123456789012345678',
    imageUrl: 'https://p3-luna.douyinpic.com/img/test/avatar~c5_%7Bsize%7Dx%7Bsize%7D.jpg',
  })
  assert.throws(() => profileOf({}), { kind: 'response' })
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

// Fresh upstream membership decisions must preserve the avatar and identity.
test('refreshes member display from the current account profile', () => {
  for (const [is_vip, name] of [[true, 'SVIP · Example'], [false, 'Example']]) {
    const account = profileOf({ my_info: { id: '123', nickname: 'Example', is_vip, vip_stage: 'svip', avatar_url: 'https://example.invalid/avatar.jpg' } })
    assert.deepEqual(account, { id: '123', name, imageUrl: 'https://example.invalid/avatar.jpg' })
  }
})

// Expired or invalid saved credentials cannot be sent as a Cookie header.
test('rejects expired sessions and header injection', () => {
  assert.throws(() => cookieHeader([{ name: 'sessionid', value: 'test', expires: 1 }]), { kind: 'session' })
  assert.throws(() => cookieHeader([{ name: 'sessionid', value: 'test; injected=value' }]), { kind: 'session' })
  assert.throws(() => cookieHeader([{ name: 'sessionid', value: 'test\r\nInjected: value' }]), { kind: 'session' })
  assert.equal(cookieHeader(cookies()), ['sessionid_ss', 'test-session'].join('='))
})
