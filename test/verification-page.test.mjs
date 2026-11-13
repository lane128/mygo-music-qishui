import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { test } from 'node:test'

const page = await readFile(new URL('../native/login/page/embedded-login.js', import.meta.url), 'utf8')
const verify = await readFile(new URL('../native/login/page/browser-verification.js', import.meta.url), 'utf8')

async function harness(decision, verificationResult = true, scriptResult = "ok") {
  const requests = [], scripts = [], timers = new Set()
  const window = {
    __mygoSignInData: { device: { did: '1234567890123456', iid: '123456789012345', clientVersion: '3.7.0' } },
    React: { createElement() {} }, ReactDOM: { render() {}, unmountComponentAtNode() {} },
  }
  let callback
  const context = vm.createContext({
    window, location: { origin: 'https://api.qishui.com' }, URL, URLSearchParams, AbortSignal,
    document: {
      readyState: 'loading', cookie: '', addEventListener() {}, createElement: () => ({ remove() {} }),
      head: { appendChild(script) {
        assert.equal(script.charset, 'utf-8')
        scripts.push(script.src)
        if (scriptResult !== "missingAPI") window.ucWebSecondVerify = options => { if (scriptResult === "exception") throw new TypeError("synthetic private detail"); callback = () => options.verifyFinishCallback({ status: verificationResult }) }
        queueMicrotask(() => scriptResult === "download" ? script.onerror() : script.onload())
      } },
    },
    setTimeout(fn, ms) {
      if (ms === 200) { queueMicrotask(() => { callback?.(); callback = null; fn() }); return 0 }
      const timer = setTimeout(fn, ms); timers.add(timer); return timer
    },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer) },
    fetch: async (url, options) => {
      requests.push({ url, options })
      const value = requests.length === 1 ? decision : { error_code: 0, data: { status: 'confirmed' } }
      return { ok: true, text: async () => JSON.stringify(value) }
    },
  })
  vm.runInContext(verify, context)
  vm.runInContext(page.replace('let statusNode, qrSection, qrImage, verificationMs = 0;', 'let statusNode, qrSection = {hidden: false}, qrImage, verificationMs = 0;')
    .replace('  function start() {', '  window.testRequest = verifiedRequest;\n  function start() {'), context)
  return { window, requests, scripts, timers }
}

const challenge = url => ({ data: { error_code: 2046, url, biz_params: { sms_code_key: 'synthetic-only' } } })
const endpoint = '/passport/web/check_qrconnect/?device_id=1234567890123456'
const body = new URLSearchParams({ token: 'same-qr-token', next: 'https://api.qishui.com' }).toString()
const flow = { trace: 'same-trace', portrait: 'same-portrait' }

test('official verification callback resumes the same QR and trace, with one bounded retry', async () => {
  const h = await harness(challenge('https://auth.zijieapi.com/official.js'))
  const value = await h.window.testRequest(endpoint, body, flow)
  assert.equal(value.data.status, 'confirmed')
  assert.equal(h.requests.length, 2)
  assert.equal(new URL(h.requests[1].url).searchParams.get('isResend'), 'true')
  assert.equal(new URLSearchParams(h.requests[1].options.body).get('token'), 'same-qr-token')
  assert.equal(new URLSearchParams(h.requests[1].options.body).get('sms_code_key'), 'synthetic-only')
  for (const { options } of h.requests) {
    assert.equal(options.headers['x-tt-passport-trace-id'], flow.trace)
    assert.equal(options.headers['x-tt-passport-verify-portrait'], flow.portrait)
    assert.equal(options.credentials, 'include')
  }
  assert.equal(h.window.__mygoVerificationState.status, 'success')
  assert.equal(h.timers.size, 0)
})

test('closing verification stops login without resending or accepting a session', async () => {
  const h = await harness(challenge('https://auth.zijieapi.com/official.js'), false)
  await assert.rejects(h.window.testRequest(endpoint, body, flow), e => e.code === 'cancelled')
  assert.equal(h.requests.length, 1)
  assert.equal(h.timers.size, 0)
})

test('foreign, insecure and credential-bearing verification scripts never load', async () => {
  for (const url of ['https://evil.invalid/verify.js', 'https://auth.zijieapi.com.evil.invalid/verify.js', 'http://auth.zijieapi.com/verify.js', 'https://auth.zijieapi.com:8443/verify.js', 'https://user:secret@auth.zijieapi.com/verify.js']) {
    const h = await harness(challenge(url))
    await assert.rejects(h.window.testRequest(endpoint, body, flow), e => e.code === '2046')
    assert.equal(h.scripts.length, 0)
    assert.equal(h.requests.length, 1)
    assert.equal(h.timers.size, 0)
  }
})


test('verification distinguishes download, missing SDK API and SDK runtime failures without exposing error text', async () => {
  for (const [scriptResult, reason] of [['download', 'scriptDownload'], ['missingAPI', 'missingAPI'], ['exception', 'sdkException']]) {
    const h = await harness(challenge('https://auth.zijieapi.com/official.js'), true, scriptResult)
    await assert.rejects(h.window.testRequest(endpoint, body, flow), e => e.code === '2046')
    assert.equal(h.window.__mygoLoginState.reason, reason)
    assert.equal(h.window.__mygoLoginState.verificationHost, 'auth.zijieapi.com')
    assert.equal(h.requests.length, 1)
    assert.equal(h.timers.size, 0)
    assert.equal(JSON.stringify(h.window.__mygoVerificationState).includes('private detail'), false)
  }
})
