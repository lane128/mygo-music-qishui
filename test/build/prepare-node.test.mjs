import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { prepareNode } from '../../scripts/prepare-node.mjs'

const mac = process.platform === 'darwin'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'qishui-node-trim-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  await writeFile(source, 'source must remain unchanged')
  return { root, source, destination: path.join(root, 'derived') }
}

test('prepareNode refuses source aliases and existing output without modifying either', { skip: !mac }, async t => {
  const { root, source, destination } = await fixture(t)
  const before = await readFile(source)
  await assert.rejects(prepareNode({ source, destination: source }), /different files/)
  await symlink(source, destination)
  await assert.rejects(prepareNode({ source, destination }), /overwrite/)
  const parentAlias = path.join(root, 'alias')
  await symlink(root, parentAlias)
  await assert.rejects(prepareNode({ source, destination: path.join(parentAlias, 'source') }), /different files/)
  const another = path.join(root, 'another')
  await writeFile(another, 'existing output')
  await assert.rejects(prepareNode({ source, destination: another }), /overwrite/)
  await assert.rejects(prepareNode({ source, destination: path.join(root, 'unused'), metadataPath: source }), /different files/)
  assert.deepEqual(await readFile(source), before)
  assert.equal(await readFile(another, 'utf8'), 'existing output')
})

test('prepareNode rejects an unsigned input before producing or executing a candidate', { skip: !mac }, async t => {
  const { source, destination } = await fixture(t)
  await assert.rejects(prepareNode({ source, destination }), /codesign/)
  assert.equal(await readFile(source, 'utf8'), 'source must remain unchanged')
  await assert.rejects(readFile(destination), { code: 'ENOENT' })
  await assert.rejects(readFile(`${destination}.json`), { code: 'ENOENT' })
})

test('prepareNode preserves actual official Node behavior, entitlements and exports with explicit ad hoc provenance', {
  skip: !mac || !process.env.QISHUI_NODE_SOURCE,
}, async t => {
  const { root, destination } = await fixture(t)
  const source = process.env.QISHUI_NODE_SOURCE
  const original = await readFile(source)
  const metadataPath = path.join(root, 'provenance.json')
  const metadata = await prepareNode({ source, destination, metadataPath })
  const derived = await readFile(destination)
  assert.equal(metadata.source.sha256, hash(original))
  assert.equal(metadata.derived.sha256, hash(derived))
  assert.equal(metadata.derived.version, metadata.source.version)
  assert.ok(metadata.derived.bytes < metadata.source.bytes)
  assert.equal(metadata.derived.bytes, derived.length)
  assert.equal(metadata.derived.signing.flags, metadata.source.signing.flags | 0x2)
  assert.ok(metadata.derived.signing.flags & 0x10000)
  assert.deepEqual(metadata.derived.signing.entitlements, metadata.source.signing.entitlements)
  assert.equal(metadata.derived.signing.kind, 'ad-hoc')
  assert.equal(metadata.derived.signing.vendorSignatureApplies, false)
  assert.equal(metadata.derived.signing.strictVerificationPassed, true)
  assert.deepEqual(metadata.provenance.strip.flags, ['-x'])
  assert.ok(metadata.provenance.exports.count > 0)
  assert.equal(metadata.provenance.exports.unchanged, true)
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', destination])
  assert.equal(execFileSync(destination, ['--version'], { encoding: 'utf8' }).trim(), metadata.source.version)
  assert.deepEqual(JSON.parse(await readFile(metadataPath, 'utf8')), metadata)
  assert.deepEqual(await readFile(source), original)
})
