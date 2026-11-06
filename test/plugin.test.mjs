import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { test } from 'node:test'

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
const profile = { id: '7123456789012345678', name: '测试账号' }
const session = { version: 1, deviceID: '1234567890123456', installID: '123456789012345', cookies: [{ name: 'sessionid', value: 'test' }] }
const started = { ok: true, qr: 'https://bff-pc.qishui.com/test', expiresIn: 60000 }
const confirmed = { ok: true, status: 'confirmed', session, account: profile }

async function sandbox(queues, saved) {
  const state = new Map(saved ? [['session', saved]] : [])
  const prompts = []
  const calls = []
  let closed = 0
  let spawned = 0
  const context = vm.createContext({
    host: {
      platform: 'darwin', arch: 'arm64',
      t: text => text, setting: () => { throw new Error('login must not require settings') }, signInPrompt: value => prompts.push(value),
      storage: { get: key => state.get(key), set: (key, value) => state.set(key, value), remove: key => state.delete(key) },
      spawn: (command, args) => {
        assert.equal(command, 'bin/node-darwin-arm64')
        assert.deepEqual(Array.from(args), ['helper/worker.mjs'])
        const queue = queues[spawned++]
        return {
          write: raw => calls.push(JSON.parse(raw)),
          readLine: async () => {
            const value = queue.shift()
            return typeof value === 'function' ? value() : JSON.stringify(value)
          },
          closeStdin: () => { closed++ }, wait: async () => 0, kill: () => {},
        }
      },
    },
    // Advance only the polling delay; deadline timers remain real and are cleared.
    setTimeout: (callback, ms) => ms === 3000 ? (queueMicrotask(callback), 0) : setTimeout(callback, ms),
    clearTimeout,
  })
  const module = new vm.SourceTextModule(source, { context })
  await module.link(() => { throw new Error('plugin must be standalone') })
  await module.evaluate()
  return { api: module.namespace, state, prompts, calls, closed: () => closed, spawned: () => spawned }
}

// Only a confirmed login with an account lookup can replace the stored session.
test('shows the original QR and saves the validated account', async () => {
  const s = await sandbox([[started, { ok: true, status: 'scanned' }, confirmed]])
  const account = await s.api.signIn()
  assert.equal(account.id, profile.id)
  assert.equal(s.prompts[0].qr, started.qr)
  assert.equal(s.prompts[1].qr, started.qr)
  assert.equal(s.state.get('session').account.id, profile.id)
  assert.equal(s.closed(), 1)
})

// An unsuccessful replacement login must leave an existing session intact.
test('keeps the previous credentials after verification or network failure', async () => {
  for (const kind of ['verify', 'rateLimit', 'network']) {
    const s = await sandbox([[started, { ok: false, error: kind }]], session)
    await assert.rejects(s.api.signIn())
    assert.equal(s.state.get('session'), session)
    assert.equal(s.closed(), 1)
  }
})

// Sign-out racing a successful reply must not resurrect the old credentials.
test('sign-out invalidates an in-flight successful login', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const s = await sandbox([[started, () => pending]], session)
  const signingIn = s.api.signIn()
  while (s.calls.length < 2) await new Promise(resolve => setImmediate(resolve))
  await s.api.signOut()
  finish(JSON.stringify(confirmed))
  await assert.rejects(signingIn)
  assert.equal(s.state.has('session'), false)
  assert.equal(s.closed(), 1)
})

// Account restoration validates on the server; temporary failures keep the session.
test('restores an account and clears only an invalid session', async () => {
  const s = await sandbox([
    [{ ok: true, account: profile }], [{ ok: false, error: 'network' }], [{ ok: false, error: 'session' }],
  ], session)
  assert.equal((await s.api.account()).id, profile.id)
  await assert.rejects(s.api.account())
  assert.equal(s.state.has('session'), true)
  assert.equal(await s.api.account(), null)
  assert.equal(s.state.has('session'), false)
  assert.equal(s.closed(), 3)
  assert.equal(await s.api.account(), null)
  assert.equal(s.spawned(), 3)
})

// Content exports must pass the saved session and present the helper's MyGO-shaped results.
test('loads music after login without settings and keeps stream URLs alive until sign-out', async () => {
  const home = { title: '汽水音乐', sections: [{ playlists: [{ id: '123', name: '歌单' }] }] }
  const audio = { url: 'http://127.0.0.1:12345/private', type: 'flac', quality: 'high' }
  const s = await sandbox([[{ ok: true, result: home }], [{ ok: true, result: audio }]], session)
  assert.equal((await s.api.home()).sections[0].playlists[0].id, '123')
  assert.equal(s.calls[0].method, 'home')
  assert.equal(s.calls[0].session.deviceID, session.deviceID)
  assert.equal(s.closed(), 1)
  assert.equal((await s.api.stream({ id: '123', quality: 'high' })).url, audio.url)
  assert.equal(s.closed(), 1)
  await s.api.signOut()
  assert.equal(s.closed(), 2)
  await assert.rejects(s.api.home(), error => error.code === 'signIn')
})

// Background prefetch must not make a new stream wait behind another song's 25-second budget.
test('resolves concurrent streams independently and bounds retained audio helpers', async () => {
  let first, second;
  const waitingFirst = new Promise(resolve => { first = resolve });
  const waitingSecond = new Promise(resolve => { second = resolve });
  const frame = { ok: true, result: { url: 'http://127.0.0.1:12345/fixture', type: 'mp3', quality: 'high' } };
  const s = await sandbox([[() => waitingFirst], [() => waitingSecond], [frame], [frame], [frame]], session);
  const a = s.api.stream({ id: '1' });
  const b = s.api.stream({ id: '2' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.calls.length, 2, 'both stream requests must start before either reply');
  second(JSON.stringify(frame));
  assert.equal((await b).type, 'mp3');
  first(JSON.stringify(frame));
  await a;
  for (const id of ['3', '4', '5']) await s.api.stream({ id });
  assert.equal(s.closed(), 1, 'only the oldest completed helper is evicted');
  await s.api.signOut();
  assert.equal(s.closed(), 5);
})

// The next MyGO search offset must reuse the opaque server cursor within the same account.
test('forwards search cursors and maps entitlement and unsupported errors', async () => {
  const s = await sandbox([
    [{ ok: true, result: { tracks: [{ id: '1' }], more: true }, cursor: 'opaque', nextOffset: 1 }],
    [{ ok: true, result: { tracks: [{ id: '2' }], more: false } }],
    [{ ok: false, error: 'unsupported' }],
    [{ ok: false, error: 'preview' }],
  ], session)
  await s.api.search({ query: '音乐' })
  const page = await s.api.search({ query: '音乐', offset: 1 })
  assert.equal(s.calls[1].params.cursor, 'opaque')
  assert.equal(page.tracks[0].id, '2')
  await assert.rejects(s.api.search({ query: '音乐', kind: 'albums' }), error => error.code === 'unsupported')
  await assert.rejects(s.api.stream({ id: '3' }), error => error.code === 'unavailable')
  await s.api.signOut()
})

// A stream started with the old account while a replacement QR is pending must be canceled on commit.
test('replacement login invalidates music started during QR confirmation', async () => {
  let confirm, finishAudio;
  const confirmation = new Promise(resolve => { confirm = resolve });
  const audio = new Promise(resolve => { finishAudio = resolve });
  const s = await sandbox([[started, () => confirmation], [() => audio]], { ...session, account: { id: '1', name: 'Account A' } });
  const signing = s.api.signIn();
  while (s.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  const playing = s.api.stream({ id: '123' });
  while (s.calls.length < 3) await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.calls[2].session.account.id, '1');
  confirm(JSON.stringify(confirmed));
  await signing;
  assert.equal(s.state.get('session').account.id, profile.id);
  finishAudio(JSON.stringify({ ok: true, result: { url: 'http://127.0.0.1/old-account', type: 'mp3' } }));
  await assert.rejects(playing, error => error.code === 'signIn');
  assert.equal(s.closed(), 2);
})

// A response from an account that signed out must never reach the new content page.
test('discards in-flight catalog results after sign-out', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const s = await sandbox([[() => pending]], session)
  const loading = s.api.playlist({ id: '123' })
  while (!s.calls.length) await new Promise(resolve => setImmediate(resolve))
  await s.api.signOut()
  finish(JSON.stringify({ ok: true, result: { id: '123', tracks: [] } }))
  await assert.rejects(loading, error => error.code === 'signIn')
})

// A late invalid-session reply must not erase a new successful login.
test('a stale account check cannot discard newly signed-in credentials', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const s = await sandbox([[() => pending], [started, confirmed]], session)
  const checking = s.api.account()
  await s.api.signIn()
  finish(JSON.stringify({ ok: false, error: 'session' }))
  assert.equal(await checking, null)
  assert.equal(s.state.get('session').account.id, profile.id)
})

// Recommendation continuation consumes counters on failed attempts and keeps feedback isolated per station.
test('continues recommendation and mode batches with independent lifecycle and bounded pending tracks', async () => {
  const tracks = Array.from({ length: 35 }, (_, i) => ({ id: String(i), duration: 181234 }))
  const s = await sandbox([
    [{ ok: true, result: tracks }], [{ ok: false, error: 'network' }], [{ ok: true, result: [{ id: '35', duration: 200000 }] }],
    [{ ok: true, result: [{ id: 'mode', duration: 1000 }] }], [{ ok: true, result: [] }],
  ], session)
  await s.api.stationNext({ id: 'recommendations' })
  await assert.rejects(s.api.stationNext({ id: 'recommendations' }))
  await s.api.stationNext({ id: 'recommendations' })
  await s.api.stationNext({ id: 'scene:0' })
  await s.api.stationNext({ id: 'preference:fresh' })
  assert.equal(s.calls[0].params.count, 1)
  assert.equal(s.calls[0].params.firstDeviceRequest, true)
  assert.ok(s.calls[0].params.firstUseTime > 0)
  assert.equal(s.calls[1].params.count, 2)
  assert.equal(s.calls[1].params.played.length, 30)
  assert.equal(s.calls[1].params.played[0].id, '5')
  assert.equal(s.calls[1].params.played[0].duration, 181234)
  assert.equal(s.calls[1].params.firstDeviceRequest, undefined)
  assert.equal(s.calls[2].params.count, 3)
  assert.deepEqual(s.calls[2].params.played, s.calls[1].params.played)
  for (const call of s.calls.slice(3)) {
    assert.equal(call.params.count, 1)
    assert.deepEqual(call.params.played, [])
    assert.equal(call.params.firstUseTime, undefined)
  }
  await s.api.signOut()
  assert.equal(s.closed(), 5)
})

// Same-station prefetch is coalesced while a different mode can resolve independently.
test('coalesces only concurrent requests for the same station', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const frame = { ok: true, result: [{ id: '1', duration: 1000 }] }
  const s = await sandbox([[() => pending], [frame], [frame]], session)
  const first = s.api.stationNext({ id: 'recommendations' })
  const same = s.api.stationNext({ id: 'recommendations' })
  const mode = s.api.stationNext({ id: 'preference:fresh' })
  assert.equal((await mode)[0].id, '1')
  assert.equal(s.calls.length, 2)
  finish(JSON.stringify(frame))
  assert.equal((await first)[0].id, '1')
  assert.equal((await same)[0].id, '1')
  await s.api.stationNext({ id: 'recommendations' })
  assert.equal(s.calls[2].params.count, 2)
  await s.api.signOut()
})

// Following the plugin's continuation link loads another batch instead of relying on unsupported browse offsets.
test('recommendation pages expose continuation and modes map to playable station IDs', async () => {
  const modes = [{ id: 'preference:fresh', name: 'Fresh', group: 'A' }, { id: 'scene:0', name: 'Zero', group: 'B', imageUrl: 'https://example.invalid/cover' }]
  const s = await sandbox([
    [{ ok: true, result: [{ id: '1', duration: 1000 }] }], [{ ok: true, result: [{ id: '2', duration: 1000 }] }],
    [{ ok: true, result: modes }], [{ ok: true, result: modes }],
  ], session)
  const first = await s.api.browse({ page: 'recommendations' })
  const next = await s.api.browse({ page: first.sections[1].links[0].page })
  assert.equal(first.sections[1].tracks[0].id, '1')
  assert.equal(next.sections[1].tracks[0].id, '2')
  assert.notEqual(first.sections[1].links[0].page, next.sections[1].links[0].page)
  assert.equal(first.sections[0].stations[0].id, 'recommendations')
  const page = await s.api.browse({ page: 'listening-modes' })
  assert.equal(page.sections[1].stations[0].id, 'scene:0')
  const stations = await s.api.stations()
  assert.equal(stations[0].id, 'recommendations')
  assert.equal(stations[2].id, 'scene:0')
  assert.equal(stations[2].imageUrl, modes[1].imageUrl)
  await assert.rejects(s.api.browse({ page: 'unsupported' }), error => error.code === 'unsupported')
  await s.api.signOut()
})

// Account replacement must discard pending old-account feeds and reset mode counters/history.
test('replacement login invalidates pending feeds and resets continuation for the new device', async () => {
  let finish, confirm
  const pending = new Promise(resolve => { finish = resolve })
  const confirmation = new Promise(resolve => { confirm = resolve })
  const newSession = { ...session, deviceID: '2345678901234567' }
  const s = await sandbox([
    [started, () => confirmation], [() => pending], [{ ok: true, result: [] }],
  ], session)
  const signing = s.api.signIn()
  while (s.calls.length < 2) await new Promise(resolve => setImmediate(resolve))
  const old = s.api.stationNext({ id: 'recommendations' })
  while (s.calls.length < 3) await new Promise(resolve => setImmediate(resolve))
  confirm(JSON.stringify({ ...confirmed, session: newSession }))
  await signing
  finish(JSON.stringify({ ok: true, result: [{ id: 'old', duration: 1000 }] }))
  await assert.rejects(old, error => error.code === 'signIn')
  await s.api.stationNext({ id: 'recommendations' })
  const latest = s.calls.at(-1)
  assert.equal(latest.session.deviceID, newSession.deviceID)
  assert.equal(latest.params.count, 1)
  assert.equal(latest.params.firstDeviceRequest, true)
  assert.deepEqual(latest.params.played, [])
  await s.api.signOut()
})

// Server-side account expiry must cancel a concurrent feed rather than accepting its stale result.
test('invalid account restoration invalidates pending station results', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const s = await sandbox([[() => pending], [{ ok: false, error: 'session' }]], session)
  const next = s.api.stationNext({ id: 'scene:0' })
  assert.equal(await s.api.account(), null)
  finish(JSON.stringify({ ok: true, result: [{ id: 'old', duration: 1000 }] }))
  await assert.rejects(next, error => error.code === 'signIn')
  await assert.rejects(s.api.stationNext({ id: 'scene:0' }), error => error.code === 'signIn')
})
