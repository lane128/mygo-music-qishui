import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sandbox, session, json, until } from './fixtures/plugin-sandbox.mjs'
import { catalogService, resource, track, stale } from './fixtures/catalog-service.mjs'

const historyID = 'qishui:history'
const historyPath = '/luna/pc/me/recently-played-media'
const ack = { status_code: 0 }

// A successful-play callback must append through the official API, independently
// of stream resolution, including when MyGO plays cached audio without stream().
test('played appends a signed start-only history entry and a later read sees the new song', async () => {
  let newest = '1'
  const read = call => {
    assert.equal(call.options.method, 'GET')
    return { media: [resource({ ...track(newest), album: { cover_url: `https://p3-luna.douyinpic.com/img/${newest}.jpg` } })], has_more: false }
  }
  const append = call => {
    assert.equal(call.options.method, 'POST')
    assert.equal(call.options.headers['X-Luna-Is-Local-User'], '1')
    assert.deepEqual(call.body, { media: [{ type: 'track', id: '9223372036854775807' }] })
    newest = call.body.media[0].id
    return ack
  }
  const service = catalogService({ playlists: [{ playlists: [] }], history: [read, append, read, call => { append(call); return {} }] })
  const s = await sandbox([], session, { sign: true, request: service.request })
  try {
    assert.equal((await s.api.playlists())[0].imageUrl, undefined)
    assert.equal(service.for('history').length, 0)
    assert.equal((await s.api.playlist({ id: historyID })).tracks[0].id, '1')
    await s.api.played({ id: '9223372036854775807' })
    const page = await s.api.playlist({ id: historyID })
    assert.equal(page.tracks[0].id, '9223372036854775807')
    assert.equal(page.imageUrl, `https://p3-luna.douyinpic.com/img/${newest}.jpg`)
    await s.api.played({ id: '9223372036854775807' })
    assert.equal(service.for('history').filter(c => c.options.method === 'POST').length, 2, 'a later playback of the same cached song must be recorded again')
    assert.ok(s.calls.every(c => c.method === 'sign'), 'cached playback reporting must not resolve or download audio')
  } finally { await s.api.signOut() }
})

// Fetching audio, even for a track that will be prefetched, says nothing about
// whether it plays. Reporting failures must leave the retained audio helper open.
test('stream resolution never appends history and a failed report leaves audio available', async () => {
  const frame = { ok: true, result: { url: 'http://127.0.0.1:12345/fixture', type: 'flac', quality: 'high' } }
  const service = catalogService({ history: [new Response('private upstream details', { status: 503 })] })
  const s = await sandbox([[frame]], session, { sign: true, request: service.request })
  try {
    assert.equal((await s.api.stream({ id: '91' })).url, frame.result.url)
    assert.equal(service.for('history').length, 0)
    assert.equal(s.closed(), 0)
    await assert.rejects(s.api.played({ id: '91' }), e => !e.message.includes('private') && e.code !== 'signIn')
    assert.equal(service.for('history').length, 1)
    assert.equal(s.spawned(), 2)
    assert.equal(s.closed(), 1, 'only the report signer closes; the audio helper stays open')
  } finally { await s.api.signOut() }
  assert.equal(s.closed(), 2)
})

// A malformed or unauthenticated callback cannot create an upstream mutation.
test('rejects invalid track IDs and signed-out history reports before network or native calls', async () => {
  const s = await sandbox([], session, { request: () => { throw Error('unexpected HTTP') } })
  try {
    for (const id of [undefined, null, 1, '', 'x', '1\n2', '1'.repeat(33)]) {
      await assert.rejects(s.api.played({ id }))
    }
    assert.equal(s.spawned(), 0)
    await s.api.signOut()
    await assert.rejects(s.api.played({ id: '91' }), e => e.code === 'signIn')
    assert.equal(s.spawned(), 0)
  } finally { await s.api.signOut() }
})

// Rate limits and verification errors must stay errors, without raw service
// details or automatic retries that could duplicate account mutations.
test('history reporting sanitizes service failures and does not retry', async () => {
  for (const [reply, kind] of [
    [json({ error_code: 7, message: 'private remote error' }), 'rateLimit'],
    [json({ status_info: { code: 2046, message: 'private remote error' } }), 'verify'],
    [json({ error_code: 2156, message: 'private remote error' }), 'rejected'],
    [json({ status_code: 1000016, message: 'private remote error' }), 'rejected'],
    [json({}, [], 401), 'session'],
    [json({}, [], 429), 'rateLimit'],
    [new Response('private malformed body'), 'response'],
  ]) {
    const service = catalogService({ history: [reply] })
    const s = await sandbox([], session, { sign: true, request: service.request })
    try {
      await assert.rejects(s.api.played({ id: '91' }), e => e.kind === kind && !e.message.includes('private'))
      assert.equal(service.for('history').length, 1)
      assert.equal(s.spawned(), 1)
      assert.equal(s.closed(), 1)
      assert.equal(s.timers.size, 0)
    } finally { await s.api.signOut() }
  }
})

// Signing can finish after sign-out. It must never dispatch the old-account POST.
test('sign-out cancels a pending history signature before the POST', async () => {
  let finish, requests = 0
  const pending = new Promise(resolve => { finish = resolve })
  const s = await sandbox([[() => pending]], session, { request: () => { requests++; return json(ack) } })
  const reporting = s.api.played({ id: '91' })
  const rejected = assert.rejects(reporting, stale)
  await until(() => s.calls.length === 1)
  await s.api.signOut()
  finish(JSON.stringify({ ok: true, result: { 'x-helios': 'fixture-helios', 'x-medusa': 'fixture-medusa' } }))
  await rejected
  assert.equal(requests, 0)
  assert.equal(s.closed(), 1)
  assert.equal(s.timers.size, 0)
})

// An already-sent POST cannot be undone, but it must be aborted and must not
// succeed late or retry with the replacement account's credentials.
test('account replacement aborts the old history POST and isolates later callbacks', async () => {
  let finish, oldSignal
  const pending = new Promise(resolve => { finish = resolve })
  const service = catalogService({ history: [call => { oldSignal = call.options.signal; return pending }, ack] })
  const s = await sandbox([], session, { sign: true, request: service.request })
  const reporting = s.api.played({ id: '91' })
  const rejected = assert.rejects(reporting, stale)
  await until(() => oldSignal)
  await s.api.signOut()
  const replacement = { ...session, cookies: [{ name: 'sessionid', value: 'replacement-fixture' }] }
  s.state.set('session', replacement)
  finish(ack)
  await rejected
  assert.equal(oldSignal.aborted, true)
  await s.api.played({ id: '92' })
  assert.deepEqual(service.for('history').map(c => c.body.media[0].id), ['91', '92'])
  assert.equal(service.for('history')[0].options.headers.Cookie, 'sessionid=test')
  assert.equal(service.for('history')[1].options.headers.Cookie, 'sessionid=replacement-fixture')
  assert.equal(s.timers.size, 0)
  await s.api.signOut()
})
