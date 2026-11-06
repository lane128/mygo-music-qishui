// One helper per operation/login attempt. JSON lines are private pipe messages.
import readline from 'node:readline'
import { Login, error, restoreAccount } from './protocol.mjs'
import { createBrowser } from './browser.mjs'

const send = frame => process.stdout.write(JSON.stringify(frame) + '\n')
const controller = new AbortController()
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let browser
let login
let idle
let ended = false
const stop = () => {
  if (ended) return
  ended = true
  controller.abort()
  lines.close()
  process.stdin.destroy()
  browser?.close().catch(() => {})
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
lines.on('close', stop)
const lifetime = setTimeout(stop, 270000)
const armIdle = () => {
  clearTimeout(idle)
  idle = setTimeout(stop, 40000)
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
      } else {
        throw error('response')
      }
      armIdle()
    } catch (err) {
      if (!ended) send({ ok: false, error: ['setup', 'browserMissing', 'signature', 'rateLimit', 'verify', 'expired', 'rejected', 'session', 'network', 'response'].includes(err.kind) ? err.kind : 'response' })
      break
    }
  }
} finally {
  clearTimeout(idle)
  clearTimeout(lifetime)
  stop()
  await browser?.close().catch(() => {})
}
