import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountTier, commentTier, COMMERCE_PATH } from '../helper/membership.mjs'
import { profileOf } from '../helper/protocol.mjs'
import { readComments } from '../helper/comments.mjs'
import { sandbox, session, profile, json, sessionCookie, qrReply, confirmedReply, until } from './fixtures/plugin-sandbox.mjs'

const base = { id: '123', nickname: '听歌的人', is_vip: true, vip_stage: 'vip' }
const membership = fields => ({ membership: { is_membership: true, membership_type: 'svip', ...fields } })

// /me can report VIP while the current commerce membership explicitly reports SVIP.
test('prefers the commerce tier and rejects expired, inactive or unrecognized memberships', () => {
  const now = 1700000000
  for (const [commerce, expected] of [
    [membership({ expire_time: now + 1 }), 'SVIP'],
    [membership({}), 'SVIP'],
    [membership({ membership_type: 'vip' }), 'VIP'],
    [membership({ membership_type: 'free_vip' }), 'VIP'],
    [membership({ is_membership: false }), ''],
    [membership({ expire_time: now }), ''],
    [membership({ expire_time: now - 1 }), ''],
    [membership({ expire_time: -1 }), ''],
    [membership({ expire_time: '1900000000' }), ''],
    [membership({ membership_type: 'future' }), ''],
    [{ membership: { membership_type: 'svip' } }, 'VIP'],
    [{}, 'VIP'], [undefined, 'VIP'],
  ]) assert.equal(accountTier(base, commerce, now), expected)
  assert.equal(accountTier({ ...base, is_vip: false }, membership({}), now), 'SVIP')
  assert.equal(profileOf({ my_info: base }, membership({})).name, 'SVIP · 听歌的人')
  assert.equal(base.nickname, '听歌的人')
})

// Comment briefs use vip_stage and may omit is_vip; no guessed numeric tiers or stale false flags.
test('adds VIP and SVIP prefixes to comments while preserving artist identity and avatars', async () => {
  const cases = [
    [{ is_vip: true, vip_stage: 'svip' }, 'SVIP · '],
    [{ is_vip: true, vip_stage: 'vip' }, 'VIP · '],
    [{ vip_stage: 'free_vip' }, 'VIP · '],
    [{ vip_stage: 'svip' }, 'SVIP · '],
    [{ is_vip: false, vip_stage: 'svip' }, ''],
    [{ is_vip: 'true', vip_stage: 'svip' }, ''],
    [{ is_vip: true, vip_stage: 'future' }, ''],
    [{ is_vip: true, vip_stage: 2 }, ''], [{}, ''],
  ]
  const rows = cases.map(([fields], index) => ({ id: String(index + 1), content: '测试评论', user: { nickname: '听众', ...fields } }))
  rows.push({ id: '99', content: '测试评论', user: { nickname: '听众', is_vip: true, vip_stage: 'svip' }, user_artist_info: { artist_brief: { name: '歌手', url_avatar: 'https://example.test/artist.jpg' } } })
  const page = await readComments(async () => ({ comments: rows }), { trackId: '123' })
  cases.forEach(([fields, prefix], i) => {
    assert.equal(page.comments[i].author, prefix + '听众')
    assert.equal(commentTier(fields), prefix.replace(' · ', ''))
  })
  assert.equal(page.comments.at(-1).author, 'SVIP · 歌手')
  assert.equal(page.comments.at(-1).avatarUrl, 'https://example.test/artist.jpg')
})

// Both login and restoration need the commerce result; a refresh must update the author used on a new post.
test('login and restore correct VIP to SVIP without spawning and refresh the posted author', async () => {
  const commerce = (url, options) => {
    const u = new URL(url)
    assert.equal(u.pathname, COMMERCE_PATH)
    assert.equal(u.searchParams.get('device_platform'), 'mac')
    assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), { includes: ['membership'] })
    assert.ok(options.headers.Cookie)
    assert.equal(options.redirect, 'manual')
    return json(membership({}))
  }
  const profileReply = () => json({ my_info: { ...base, id: profile.id } })
  const login = await sandbox([], undefined, { allowSpawn: false, commerce, replies: [qrReply(), confirmedReply(), profileReply()] })
  assert.equal((await login.api.signIn()).name, 'SVIP · 听歌的人')
  assert.equal(login.state.get('session').account.name, 'SVIP · 听歌的人')
  const restored = await sandbox([], { ...session, account: { id: profile.id, name: 'VIP · 听歌的人' } }, { sign: true, commerce, replies: [profileReply()], request: url => {
    if (new URL(url).pathname === '/luna/pc/comments/create') return json({ created_comment: '42' })
  } })
  assert.equal((await restored.api.account()).name, 'SVIP · 听歌的人')
  assert.equal(restored.state.get('session').account.name, 'SVIP · 听歌的人')
  const posted = await restored.api.postComment({ trackId: '123', text: '测试评论' })
  assert.equal(posted.author, 'SVIP · 听歌的人')
  assert.equal(login.spawned(), 0)
  assert.equal(login.timers.size, 0)
  await restored.api.signOut()
})

// Optional entitlement failure must preserve verified identity and the /me fallback without leaking errors.
test('failed or absent commerce metadata falls back to the verified profile', async () => {
  for (const commerce of [() => { throw Error('private detail') }, () => json({}, [], 403), () => json({}), () => new Response('private detail')]) {
    const s = await sandbox([], session, { allowSpawn: false, commerce, replies: [json({ my_info: base })] })
    assert.equal((await s.api.account()).name, 'VIP · 听歌的人')
    assert.equal(s.timers.size, 0)
  }
})

// An optional metadata request cannot retain credentials the server explicitly invalidated.
test('commerce invalidation clears restored sessions and rejects replacement logins', async () => {
  for (const [status, cookies] of [[401, []], [401, [sessionCookie('', 'Path=/; Max-Age=0')]], [200, [sessionCookie('', 'Path=/; Max-Age=0')]], [403, [sessionCookie('', 'Path=/; Max-Age=0')]]]) {
    const restored = await sandbox([], session, { allowSpawn: false,
      replies: [json({ my_info: base })], commerce: () => json(membership({}), cookies, status),
    })
    assert.equal(await restored.api.account(), null)
    assert.equal(restored.state.has('session'), false)
    assert.equal(restored.timers.size, 0)
    const replacement = await sandbox([], session, { allowSpawn: false,
      replies: [qrReply(), confirmedReply(), json({ my_info: base })], commerce: () => json(membership({}), cookies, status),
    })
    await assert.rejects(replacement.api.signIn(), error => error.kind === 'session')
    assert.equal(replacement.state.get('session'), session)
    assert.equal(replacement.timers.size, 0)
  }
})

// A valid rotated API cookie must be used by subsequent calls instead of the old stored value.
test('restoration persists cookies rotated by the profile and commerce requests', async () => {
  for (const rotateAt of ['profile', 'commerce']) {
    const restored = await sandbox([], session, { allowSpawn: false,
      replies: [json({ my_info: base }, rotateAt === 'profile' ? [sessionCookie('rotated-fixture')] : []), json({ my_info: base })],
      commerce: () => json(membership({}), rotateAt === 'commerce' ? [sessionCookie('rotated-fixture')] : []),
    })
    await restored.api.account()
    assert.equal(restored.state.get('session').cookies.find(cookie => cookie.name === 'sessionid').value, 'rotated-fixture')
    await restored.api.account()
    assert.equal(restored.authCalls[2].options.headers.Cookie, 'sessionid=rotated-fixture')
  }
})

// Overlapping restores share the same verified cookie rotation instead of racing to persist different jars.
test('overlapping restorations share a refresh and preserve its rotated cookie', async () => {
  let finish
  const held = new Promise(resolve => { finish = resolve })
  const s = await sandbox([], session, { allowSpawn: false,
    replies: [() => held, json({ my_info: base })], commerce: () => json(membership({})),
  })
  const first = s.api.account()
  await until(() => s.authCalls.length === 1)
  const second = s.api.account()
  finish(json({ my_info: base }, [sessionCookie('shared-rotation')]))
  const accounts = await Promise.all([first, second])
  assert.equal(accounts[0].id, accounts[1].id)
  assert.equal(s.authCalls.filter(call => new URL(call.url).pathname === '/luna/pc/me').length, 1)
  assert.equal(s.state.get('session').cookies[0].value, 'shared-rotation')
  assert.equal(s.timers.size, 0)
})

// A restore started during login cleanup cannot survive the new-session commit or be reused afterward.
test('committing a replacement invalidates restores started during final cleanup', async () => {
  let confirm, finishOld, releaseClose, closing = false
  const confirmation = new Promise(resolve => { confirm = resolve })
  const oldProfile = new Promise(resolve => { finishOld = resolve })
  const cleanup = new Promise(resolve => { releaseClose = resolve })
  const nextProfile = () => json({ my_info: { ...base, id: '456' } })
  const s = await sandbox([[{ ok: true, result: { url: 'http://127.0.0.1:12345/fixture', type: 'mp3' } }]], session, {
    replies: [qrReply(), () => confirmation, nextProfile(), () => oldProfile, nextProfile()],
    waitForClose: () => { closing = true; return cleanup },
  })
  const signingIn = s.api.signIn()
  await until(() => s.authCalls.length === 2)
  await s.api.stream({ id: '123' })
  confirm(confirmedReply())
  await until(() => closing)
  const old = s.api.account()
  await until(() => s.authCalls.filter(call => new URL(call.url).pathname === '/luna/pc/me').length === 2)
  releaseClose()
  assert.equal((await signingIn).id, '456')
  const current = s.api.account()
  finishOld(json({ my_info: base }))
  assert.equal(await old, null)
  assert.equal((await current).id, '456')
  assert.equal(s.state.get('session').account.id, '456')
  assert.equal(s.timers.size, 0)
})

// Expiring the old account must leave an independent new QR attempt able to commit its own credentials.
test('commerce expiry during a replacement login cannot discard the replacement', async () => {
  let finish
  const held = new Promise(resolve => { finish = resolve })
  let commerceCalls = 0
  const s = await sandbox([], session, { allowSpawn: false,
    replies: [qrReply(), () => held, json({ my_info: base }), json({ my_info: { ...base, id: '456' } })],
    commerce: () => ++commerceCalls === 1 ? json({}, [sessionCookie('', 'Path=/; Max-Age=0')], 401) : json(membership({})),
  })
  const replacement = s.api.signIn()
  await until(() => s.authCalls.length === 2)
  assert.equal(await s.api.account(), null)
  finish(confirmedReply())
  assert.equal((await replacement).id, '456')
  assert.equal(s.state.get('session').account.id, '456')
  assert.equal(s.timers.size, 0)
})

// A late commerce response must not resurrect a signed-out account or overwrite a replacement session.
test('discarding an account during commerce lookup cancels both login and restore', async () => {
  for (const signingIn of [false, true]) {
    let finish, entered = false
    const held = new Promise(resolve => { finish = resolve })
    const s = await sandbox([], signingIn ? undefined : session, { allowSpawn: false,
      replies: [...(signingIn ? [qrReply(), confirmedReply()] : []), json({ my_info: base })],
      commerce: () => { entered = true; return held },
    })
    const pending = signingIn ? s.api.signIn() : s.api.account()
    const result = pending.then(value => ({ value }), error => ({ error }))
    await until(() => entered)
    await s.api.signOut()
    finish(json(membership({})))
    const done = await result
    if (signingIn) assert.equal(done.error?.kind, 'cancelled')
    else assert.equal(done.value, null)
    assert.equal(s.state.has('session'), false)
    assert.equal(s.timers.size, 0)
  }
})

// A stalled optional lookup has a shorter deadline and returns the verified fallback after abort.
test('commerce lookup times out without breaking account restoration', async () => {
  let abort
  const s = await sandbox([], session, { allowSpawn: false, replies: [json({ my_info: base })],
    timer: (callback, ms) => { if (ms === 5000) abort = callback; return 0 },
    commerce: (_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('private timeout')), { once: true })),
  })
  const pending = s.api.account()
  await until(() => abort)
  abort()
  assert.equal((await pending).name, 'VIP · 听歌的人')
  assert.equal(s.timers.size, 0)
})
