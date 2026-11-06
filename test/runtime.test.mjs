import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { browserCandidates, browserRuntime, findBrowser, pluginRoot } from '../helper/runtime.mjs'

// Finder's PATH is irrelevant: Chrome is found at standard system or user installation locations.
test('discovers Chrome without PATH or a configured executable', async () => {
  const candidates = browserCandidates('darwin', '/test-user', {})
  const userChrome = '/test-user/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const visited = []
  const found = await findBrowser(candidates, async candidate => {
    visited.push(candidate)
    return candidate === userChrome
  })
  assert.equal(found, userChrome)
  assert.equal(visited[0], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  await assert.rejects(findBrowser(candidates, async () => false), { kind: 'browserMissing' })
})

// Runtime resources must resolve relative to the installed plugin, never the source checkout.
test('resolves bundled dependencies relative to the plugin', async () => {
  const old = {}
  for (const key of ['PLAYWRIGHT_CORE', 'QISHUI_SECURITY_DIR', 'QISHUI_CHROMIUM_PATH']) {
    old[key] = process.env[key]
    delete process.env[key]
  }
  try {
    const config = await browserRuntime({ chromiumPath: '/test/chrome' })
    assert.equal(config.playwrightPath, path.join(pluginRoot, 'node_modules/playwright-core'))
    assert.equal(config.securityDir, path.join(pluginRoot, 'runtime/security'))
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
