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
