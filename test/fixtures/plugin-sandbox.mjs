import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { grant } from './grant.mjs'

const source = await readFile(new URL('../../index.js', import.meta.url), 'utf8')
export const profile = { id: '7123456789012345678', name: '测试账号' }
export const session = { version: 1, deviceID: '1234567890123456', installID: '123456789012345', cookies: [{ name: 'sessionid', value: 'test' }] }
export const qrURL = 'https://bff-pc.qishui.com/synthetic?scanner=original&channel=pc'
export const json = (value, cookies = [], status = 200) => new Response(JSON.stringify(value), { status, headers: [['content-type', 'application/json'], ...cookies.map(c => ['set-cookie', c])] })
export const sessionCookie = (value = 'synthetic-session', attributes = 'Path=/; Secure; HttpOnly') => [['sessionid', value].join('='), attributes].join('; ')
export const qrReply = () => json({ error_code: 0, data: { token: 'synthetic-qr-challenge', qrcode_index_url: qrURL, is_frontier: false } })
export const confirmedReply = () => json({ error_code: 0, data: { status: 'confirmed' } }, [sessionCookie()])
export const profileReply = (id = profile.id) => json({ my_info: { id, nickname: profile.name } })

// Execute the real standalone plugin; only the remote service and music worker are replaced.
export async function sandbox(queues = [], saved, { replies = [], request, commerce = () => json({}), sign = false, allowSpawn = true, clock, timer, crypto, platform = 'darwin', arch = 'arm64', dir = '/plugin fixture #1', waitForClose = async () => 0 } = {}) {
  const state = new Map(saved ? [['session', saved]] : [])
  const prompts = [], calls = [], authCalls = [], pendingTimers = new Set()
  let closed = 0, spawned = 0, queued = 0
  const invokeFetch = async (url, options) => {
    authCalls.push({ url, options })
    if (request) { const reply = await request(url, options); if (reply !== undefined) return reply }
    if (new URL(url).pathname === '/luna/pc/commerce/v2/commerce_info') return commerce(url, options)
    if (new URL(url).pathname === '/luna/pc/track_v2') {
      assert.equal(options.headers['x-helios'], 'fixture-helios')
      assert.equal(options.headers['x-medusa'], 'fixture-medusa')
      const body = JSON.parse(options.body)
      assert.equal(typeof body.track_id, 'string')
      return json(grant(body.track_id))
    }
    const next = replies.shift()
    assert.notEqual(next, undefined, 'unexpected authentication request')
    return typeof next === 'function' ? next(url, options) : next
  }
  const context = vm.createContext({
    host: {
      platform, arch, dir, t: text => text,
      crypto: { md5: text => createHash('md5').update(text).digest('hex') },
      setting: () => { throw new Error('login must not require settings') },
      signInPrompt: value => prompts.push(value),
      storage: { get: key => state.get(key), set: (key, value) => state.set(key, value), remove: key => state.delete(key) },
      spawn: (command, args) => {
        assert.equal(allowSpawn, true, 'authentication must not start a program')
        assert.equal(command, ['bin/qishui-helper', platform, arch].join('-') + (platform === 'windows' ? '.exe' : ''))
        assert.deepEqual(Array.from(args), [])
        spawned++
        let spec, queue
        return {
          write: raw => { spec = JSON.parse(raw); calls.push(spec) },
          readLine: async () => {
            if (spec.method === 'sign' && (sign || new URL(spec.params.url).pathname === '/luna/pc/track_v2')) return JSON.stringify({ ok: true, result: { 'x-helios': 'fixture-helios', 'x-medusa': 'fixture-medusa' } })
            queue ??= queues[queued++]
            assert.ok(queue, 'unexpected music helper')
            const next = queue.shift(); return typeof next === 'function' ? next() : JSON.stringify(next)
          },
          closeStdin: () => { closed++ }, wait: waitForClose, kill: () => {},
        }
      },
    },
    fetch: invokeFetch, URL, URLSearchParams, AbortController, TextDecoder, Uint8Array, crypto,
    setTimeout: (callback, ms) => {
      if (timer) return timer(callback, ms)
      if (ms === 3500) { queueMicrotask(callback); return 0 }
      const id = setTimeout(callback, ms); pendingTimers.add(id); return id
    },
    clearTimeout: id => { pendingTimers.delete(id); clearTimeout(id) },
  })
  if (clock) context.Date = clock
  const module = new vm.SourceTextModule(source, { context })
  await module.link(() => { throw new Error('plugin must be standalone') })
  await module.evaluate()
  return { api: module.namespace, state, prompts, calls, authCalls, closed: () => closed, spawned: () => spawned, timers: pendingTimers }
}

export async function until(predicate) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('expected synthetic state was not reached')
}
