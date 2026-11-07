import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { sandbox, session, json, until } from './fixtures/plugin-sandbox.mjs'
import { catalogService, feed, track } from './fixtures/catalog-service.mjs'

// MyGO lacks JSON.rawJSON: the exact int64 scene token must survive body serialization, digesting and signing.
test('sandbox signs exact int64 scene bodies and retains the default history cover without process permission', async () => {
  let body
  const service = catalogService({ feed: [call => { body = call.options.body; return feed([track('91')]) }] })
  const s = await sandbox([], session, { sign: true, request: service.request })
  assert.equal((await s.api.stationNext({ id: 'scene:9223372036854775807' }))[0].id, '91')
  assert.match(body, /"scene_mode_id":9223372036854775807(?:[,}])/)
  assert.doesNotMatch(body, /"scene_mode_id":"/)
  assert.equal(s.calls[0].params.headers['x-ss-stub'], createHash('md5').update(body).digest('hex').toUpperCase())
  const lists = await sandbox([], session, { allowSpawn: false, request: () => json({ playlists: [] }) })
  const history = (await lists.api.playlists())[0]
  assert.equal(history.imageUrl, undefined)
  await s.api.signOut(); await lists.api.signOut()
})

test('sidebar loads without history or helper calls while history detail uses the first song cover', async () => {
  const cover = 'https://p3-luna.douyinpic.com/img/history-first.jpg'
  const first = { ...track('91'), album: { cover_url: cover } }
  const service = catalogService({ playlists: [{ playlists: [] }], history: [{ media: [{ entity: { track: first } }], has_more: false }] })
  const s = await sandbox([], session, { sign: true, request: service.request })
  try {
    const sidebar = (await s.api.playlists())[0]
    assert.equal(sidebar.imageUrl, undefined)
    assert.equal(service.for('history').length, 0)
    assert.equal(s.spawned(), 0)
    const history = await s.api.playlist({ id: 'qishui:history' })
    assert.equal(history.imageUrl, cover)
    assert.equal(service.for('history').length, 1)
    assert.equal(service.for('history')[0].parsed.searchParams.get('count'), '1000')
    assert.equal(s.closed(), 1)
  } finally { await s.api.signOut() }
})

// Response and body failures must stay bounded and sanitized after moving networking out of Node.
test('sandbox bounds catalogue bytes, sanitizes rejections and refuses credential-forwarding redirects', async () => {
  for (const reply of [
    () => new Response(JSON.stringify({ playlists: [], detail: '中'.repeat(400000) })),
    () => json({ error_code: 2046, message: 'private remote diagnostic' }),
    () => json({ error_code: 7, message: 'private remote diagnostic' }),
    () => json({}, [], 401),
  ]) {
    const s = await sandbox([], session, { allowSpawn: false, request: (url, options) => {
      assert.equal(new URL(url).origin, 'https://api.qishui.com')
      assert.equal(options.redirect, 'error')
      return reply()
    } })
    await assert.rejects(s.api.playlists(), error => !error.message.includes('private remote diagnostic'))
    assert.equal(s.spawned(), 0)
    assert.equal(s.timers.size, 0)
    await s.api.signOut()
  }
})

// Sign-out during a native signing result must prevent the subsequent authenticated HTTP request.
test('cancels a late signature before it can dispatch an old-account request', async () => {
  let finish, requests = 0
  const waiting = new Promise(resolve => { finish = resolve })
  const s = await sandbox([[() => waiting]], session, { request: () => { requests++; throw Error('unexpected network') } })
  const loading = s.api.home()
  const rejected = assert.rejects(loading, error => error.code === 'signIn')
  await until(() => s.calls.length === 1)
  assert.equal(s.calls[0].method, 'sign')
  await s.api.signOut()
  finish(JSON.stringify({ ok: true, result: { 'x-helios': 'fixture-helios', 'x-medusa': 'fixture-medusa' } }))
  await rejected
  assert.equal(requests, 0)
  assert.equal(s.timers.size, 0)
})

// Aborting a signing request and then signing out must await the same worker shutdown, not return while its first close is pending.
test('sign-out waits for an already-started signer shutdown', async () => {
  let signatureDone, closeDone
  const signature = new Promise(resolve => { signatureDone = resolve })
  const closing = new Promise(resolve => { closeDone = resolve })
  const s = await sandbox([[() => signature]], session, { waitForClose: () => closing })
  const loading = s.api.home(), rejected = assert.rejects(loading, error => error.code === 'signIn')
  await until(() => s.calls.length === 1)
  let stopped = false
  const stopping = s.api.signOut().then(() => { stopped = true })
  try {
    await until(() => s.closed() === 1)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stopped, false, 'sign-out returned before the signer stopped')
  } finally {
    closeDone(0)
    signatureDone(JSON.stringify({ ok: true, result: { 'x-helios': 'fixture-helios', 'x-medusa': 'fixture-medusa' } }))
    await stopping
    await rejected
  }
  assert.equal(stopped, true)
  assert.equal(s.timers.size, 0)
})

// A completed signature remains tracked until its process has actually closed, so a simultaneous account change can await it.
test('tracks completed signers through final shutdown before account cleanup returns', async () => {
  let closeDone, stopped = false, requests = 0
  const closing = new Promise(resolve => { closeDone = resolve })
  const s = await sandbox([[{ ok: true, result: { 'x-helios': 'fixture-helios', 'x-medusa': 'fixture-medusa' } }]], session, {
    waitForClose: () => closing, request: () => { requests++; throw Error('unexpected network') },
  })
  const loading = s.api.home(), rejected = assert.rejects(loading, error => error.code === 'signIn')
  await until(() => s.closed() === 1)
  const stopping = s.api.signOut().then(() => { stopped = true })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stopped, false, 'completed signer was untracked while it was still closing')
  } finally {
    closeDone(0)
    await stopping
    await rejected
  }
  assert.equal(requests, 0)
})

// The host transport must abort body reads at the request deadline, independently of the overall catalogue deadline.
test('catalogue request timeout aborts the actual fetch signal using a controlled timer', async () => {
  const timers = new Map()
  let signal
  const s = await sandbox([], session, {
    allowSpawn: false,
    timer: (callback, ms) => { const token = {}; timers.set(ms, callback); return token },
    request: (url, options) => {
      signal = options.signal
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('private transport error')), { once: true }))
    },
  })
  const loading = s.api.playlists(), rejected = assert.rejects(loading, error => !error.message.includes('private transport error'))
  await until(() => signal !== undefined)
  timers.get(20000)()
  await rejected
  assert.equal(signal.aborted, true)
  await s.api.signOut()
})
