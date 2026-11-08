import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { libraryWritePaths } from '../../helper/catalog-core.mjs'

// Previously adding a Go signing route alone still failed inside the independent C++ allowlist.
test('native helper and signer permit the same exact catalogue routes', async () => {
  const worker = await readFile(new URL('../../native/worker/sign.go', import.meta.url), 'utf8')
  const signer = await readFile(new URL('../../native/signer/signer.cpp', import.meta.url), 'utf8')
  const goBlock = worker.match(/var signPaths = map\[string\]bool\{([\s\S]*?)\n\}/)?.[1]
  const cppBlock = signer.match(/const char\* allowed\[\]=\{([\s\S]*?)\};/)?.[1]
  assert.ok(goBlock && cppBlock)
  const paths = block => [...block.matchAll(/"(\/luna\/pc\/[^"\s]+)"/g)].map(m => m[1]).sort()
  const allowed = paths(goBlock)
  assert.deepEqual(paths(cppBlock), allowed)
  for (const path of [...libraryWritePaths, '/luna/pc/comments', '/luna/pc/me/playlist']) assert.ok(allowed.includes(path), 'missing required route: ' + path)
  for (const path of allowed) assert.match(path, /^\/luna\/pc\/[a-z0-9_/-]+$/)
  assert.equal(new Set(allowed).size, allowed.length)
})
