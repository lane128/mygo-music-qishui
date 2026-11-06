import assert from 'node:assert/strict'
import http from 'node:http'
import { chromium } from 'playwright-core'
import { test } from 'node:test'
import { installRequestGuard } from '../helper/browser-guard.mjs'
import { createBrowser } from '../helper/browser.mjs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const executablePath = process.env.QISHUI_CHROMIUM_PATH

// Every HTTP redirect must retain domain and signature boundaries before sending a form.
test('real Chrome blocks foreign redirects and unsigned Passport requests', { skip: !executablePath, timeout: 30000 }, async t => {
  let sinkHits = 0
  const sink = http.createServer((req, res) => { sinkHits++; res.end('unexpected') })
  await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => sink.close(resolve)))
  const sinkOrigin = `http://127.0.0.1:${sink.address().port}`
  const received = []
  const source = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received.push({ path: req.url, body: Buffer.concat(chunks).toString() })
    const u = new URL(req.url, 'http://localhost')
    if (u.pathname === '/redirect') {
      res.writeHead(Number(u.searchParams.get('code')), {
        Location: u.searchParams.get('target') === 'foreign' ? `${sinkOrigin}/sink` :
          u.searchParams.get('target') === 'unsigned' ? '/passport/web/check_qrconnect/' : '/landing',
      })
    }
    res.end('ok')
  })
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => source.close(resolve)))
  const sourceOrigin = `http://127.0.0.1:${source.address().port}`
  const browser = await chromium.launch({ executablePath, chromiumSandbox: true, headless: true, args: ['--disable-web-security'] })
  t.after(() => browser.close())
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  const origin = 'http://127.0.0.1:8799'
  const guard = await installRequestGuard(context, page, {
    origin, glue: Buffer.from('window._SdkGlueInit = () => {}'), bdms: Buffer.alloc(0),
    accountURL: raw => new URL(raw).origin === sourceOrigin,
  })
  await page.goto(origin)
  const post = url => page.evaluate(url => new Promise(resolve => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.onload = () => resolve(xhr.status)
    xhr.onerror = () => resolve(0)
    xhr.send('test-form')
  }), url)
  for (const code of [307, 308]) {
    assert.equal(await post(`${sourceOrigin}/redirect?code=${code}&target=foreign`), 0)
    assert.equal(sinkHits, 0)
  }
  assert.equal(await post(`${sourceOrigin}/redirect?code=307&target=unsigned`), 0)
  assert.equal(guard.signatureMissing, true)
  assert.equal(received.some(req => req.path.startsWith('/passport/')), false)
  assert.equal(await post(`${sourceOrigin}/redirect?code=307&target=allowed`), 200)
  assert.deepEqual(received.at(-1), { path: '/landing', body: 'test-form' })
})

// A missing signature must fail locally, and the temporary persistent profile must be removed.
test('real Chrome reports missing SDK signatures and cleans up the profile', { skip: !executablePath, timeout: 30000 }, async t => {
  const assets = await mkdtemp(path.join(tmpdir(), 'mygo-test-sdk-'))
  t.after(() => rm(assets, { recursive: true, force: true }))
  await writeFile(path.join(assets, 'sdk-glue.js'), 'window.bdms = {}; window._SdkGlueInit = () => {};')
  await writeFile(path.join(assets, 'bdms.js'), '')
  const profiles = async () => (await readdir(tmpdir())).filter(name => name.startsWith('mygo-qishui-'))
  const before = new Set(await profiles())
  const browser = await createBrowser({ securityDir: assets, chromiumPath: executablePath })
  t.after(() => browser.close())
  await assert.rejects(browser.request({ method: 'GET', url: 'https://api.qishui.com/passport/web/get_qrcode/', headers: {} }), { kind: 'signature' })
  await browser.close()
  assert.deepEqual((await profiles()).filter(name => !before.has(name)), [])
})

// Cancellation during SDK startup must interrupt page waits and delete the owned Chrome profile.
test('cancelling during browser bootstrap removes the temporary profile', { skip: !executablePath, timeout: 20000 }, async t => {
  const assets = await mkdtemp(path.join(tmpdir(), 'mygo-test-sdk-'))
  t.after(() => rm(assets, { recursive: true, force: true }))
  // No bdms readiness signal: bootstrap would otherwise wait for its timeout.
  await writeFile(path.join(assets, 'sdk-glue.js'), 'window._SdkGlueInit = () => {};')
  await writeFile(path.join(assets, 'bdms.js'), '')
  const profiles = async () => (await readdir(tmpdir())).filter(name => name.startsWith('mygo-qishui-'))
  const before = new Set(await profiles())
  const controller = new AbortController()
  const starting = createBrowser({ securityDir: assets, chromiumPath: executablePath }, controller.signal)
  const timer = setTimeout(() => controller.abort(), 1000)
  t.after(() => clearTimeout(timer))
  await assert.rejects(starting, { kind: 'setup' })
  assert.deepEqual((await profiles()).filter(name => !before.has(name)), [])
})
