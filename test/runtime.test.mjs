import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginRoot } from '../helper/runtime.mjs'

// Node/native resources must resolve from the installation, independent of the host's cwd.
test('resolves the installed plugin root for native resources', () => {
  assert.equal(path.isAbsolute(pluginRoot), true)
  assert.equal(pluginRoot, fileURLToPath(new URL('..', import.meta.url)))
})
