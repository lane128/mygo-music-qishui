// Adapted from mygo-cloudmusic/internal/qishui/browser.mjs (AGPL-3.0).
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { installRequestGuard } from './browser-guard.mjs'
import { API, accountURL, error } from './protocol.mjs'
import { browserRuntime } from './runtime.mjs'

const origin = 'http://127.0.0.1:8799'
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.2.1 Chrome/136.0.7103.59 Electron/36.4.0 Safari/537.36'

export async function createBrowser(config = {}, signal) {
  let context
  let root
  let closing
  const onAbort = () => { if (context) close().catch(() => {}) }
  const close = () => closing ||= (async () => {
    signal?.removeEventListener('abort', onAbort)
    try { await context?.close() } finally {
      if (root) await rm(root, { recursive: true, force: true })
    }
  })()
  const cancelled = () => { if (signal?.aborted) throw error('network') }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    cancelled()
    const require = createRequire(import.meta.url)
    const { playwrightPath, securityDir: assets, chromiumPath: executablePath } = await browserRuntime(config)
    const { chromium } = require(playwrightPath)
    const [glue, bdms] = await Promise.all([
      readFile(path.join(assets, 'sdk-glue.js')), readFile(path.join(assets, 'bdms.js')),
    ])
    root = await mkdtemp(path.join(tmpdir(), 'mygo-qishui-'))
    cancelled()
    // Own the profile as well as artifacts; no existing Chrome profile is read.
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
      executablePath, headless: true, chromiumSandbox: true, timeout: 10000,
      userAgent: ua, serviceWorkers: 'block', artifactsDir: root, downloadsPath: root,
      args: ['--disable-web-security', '--disable-features=BlockThirdPartyCookies,ThirdPartyStoragePartitioning'],
    })
    cancelled()
    const page = context.pages()[0] || await context.newPage()
    const guard = await installRequestGuard(context, page, { origin, glue, bdms, accountURL })
    await page.goto(origin, { waitUntil: 'load', timeout: 15000 })
    await page.waitForFunction(() => typeof window.bdms === 'object' && !window._SdkGlueLoadingMap?.bdms,
      null, { timeout: 15000 })
    cancelled()
    let token = ''
    return {
      close,
      async cookies() {
        // Match Go's export of only the cookies applicable to this API URL.
        return (await context.cookies(API + '/')).map(({ name, value, expires }) => ({ name, value, expires }))
      },
      async request(spec) {
        cancelled()
        if (!accountURL(spec.url) || !['GET', 'POST'].includes(spec.method)) throw error('response')
        const msToken = new URL(spec.url).searchParams.get('msToken')
        if (msToken && token && msToken !== token) throw error('response')
        if (msToken && !token) {
          token = msToken
          await page.evaluate(value => {
            localStorage.setItem('xmst', value)
            localStorage.setItem('xmsty', value)
          }, token)
        }
        const headers = { ...spec.headers }
        for (const name of Object.keys(headers)) {
          if (/^(cookie|host|user-agent|content-length|origin|referer)$/i.test(name)) delete headers[name]
        }
        guard.signatureMissing = false
        const before = guard.signedRequests
        let result
        try {
          result = await page.evaluate(spec => new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open(spec.method, spec.url, true)
            xhr.withCredentials = true
            xhr.timeout = 20000
            for (const [key, value] of Object.entries(spec.headers)) xhr.setRequestHeader(key, value)
            xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText, url: xhr.responseURL })
            xhr.onerror = xhr.ontimeout = () => reject(new Error('network'))
            xhr.send(spec.body ?? null)
          }), { ...spec, headers })
        } catch { throw error(guard.signatureMissing ? 'signature' : 'network') }
        if (guard.signatureMissing || (new URL(spec.url).pathname.startsWith('/passport/') && before === guard.signedRequests)) throw error('signature')
        if (!accountURL(result.url) || result.body.length > 1048576) throw error('response')
        return result
      },
    }
  } catch (err) {
    await close().catch(() => {})
    // Never expose browser errors, command lines, cookies or login URLs.
    throw error(err.kind === 'browserMissing' ? 'browserMissing' : 'setup')
  }
}
