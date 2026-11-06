// One helper per operation/login attempt. JSON lines are private pipe messages.
import readline from 'node:readline'
import { Login, error, restoreAccount } from './protocol.mjs'
import { createBrowser } from './browser.mjs'
import { Catalog } from './catalog.mjs'
import { audioServer } from './audio-server.mjs'

const send = frame => process.stdout.write(JSON.stringify(frame) + '\n')
const controller = new AbortController()
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let browser
let login
let idle
let ended = false
let music = false
let audio
const stop = () => {
  if (ended) return
  ended = true
  controller.abort()
  lines.close()
  process.stdin.destroy()
  browser?.close().catch(() => {})
  audio?.close().catch(() => {})
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
lines.on('close', stop)
const lifetime = setTimeout(stop, 270000)
const armIdle = () => {
  clearTimeout(idle)
  if (!music) idle = setTimeout(stop, 40000)
}
armIdle()
try {
  for await (const line of lines) {
    if (ended) break
    clearTimeout(idle)
    try {
      if (line.length > 131072) throw error('response')
      const spec = JSON.parse(line)
      if (spec.op === 'start' && !browser) {
        browser = await createBrowser(spec.config, controller.signal)
        login = new Login(browser)
        const qr = await login.start()
        if (ended) break
        send({ ok: true, ...qr })
      } else if (spec.op === 'check' && login) {
        const result = await login.check()
        if (ended) break
        if (result.status === 'confirmed') {
          await browser.close()
          send({ ok: true, ...result })
          break
        }
        send({ ok: true, ...result })
      } else if (spec.op === 'account' && !browser) {
        const account = await restoreAccount(spec.session)
        if (!ended) send({ ok: true, account })
        break
      } else if (spec.op === 'music' && !browser) {
        music = true
        clearTimeout(lifetime)
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(24000)])
        const catalog = new Catalog(spec.session, { signal })
        const params = spec.params || {}
        let result
        switch (spec.method) {
          case 'home': result = await catalog.home(); break
          case 'playlists': result = await catalog.playlists(); break
          case 'playlist': result = await catalog.playlist(params.id); break
          case 'search': {
            const page = await catalog.search(params)
            if (!ended) send({ ok: true, ...page })
            continue
          }
          case 'modes': result = await catalog.listeningModes(); break
          case 'feed': result = await catalog.recommendationBatch(params); break
          case 'lyrics': result = await catalog.lyrics(params.id); break
          case 'stream': {
            const { resolvePlayback } = await import('./playback.mjs')
            const stream = await resolvePlayback(spec.session, params, { signal })
            if (ended) break
            audio ||= await audioServer()
            result = audio.add(stream)
            break
          }
          default: throw error('unsupported')
        }
        if (!ended) send({ ok: true, result })
      } else {
        throw error('response')
      }
      armIdle()
    } catch (err) {
      if (!ended) send({ ok: false, error: ['setup', 'browserMissing', 'signature', 'rateLimit', 'verify', 'expired', 'rejected', 'session', 'network', 'response', 'unsupported', 'unavailable', 'preview'].includes(err.kind) ? err.kind : 'response' })
      if (!music) break
    }
  }
} finally {
  clearTimeout(idle)
  clearTimeout(lifetime)
  stop()
  await browser?.close().catch(() => {})
}
