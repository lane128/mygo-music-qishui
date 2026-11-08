import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { aacLCConfig, nativeM4A } from '../helper/m4a.mjs'
import { m4aCases } from './fixtures/m4a-layout.mjs'
import { withTextTrack } from './fixtures/mp4-text-track.mjs'

test('Go and JS share reproducible M4A acceptance and rejection cases', async () => {
  const cases = JSON.parse(await readFile(new URL('./fixtures/m4a-layout.json', import.meta.url)))
  assert.deepEqual(cases, m4aCases())
  for (const c of cases) {
    const b = Buffer.from(c.hex, 'hex'), before = Buffer.from(b)
    assert.equal(nativeM4A(b), c.valid, c.name)
    assert.deepEqual(b, before, c.name)
  }
})
test('complete ASC checks include implicit SBR and PS extensions', () => {
  for (const hex of ['1210', '121056e500']) assert.deepEqual(aacLCConfig(Buffer.from(hex, 'hex')), { sampleRate: 44100, channels: 2 })
  for (const hex of ['', '12', '2b9208', 'eb9208', '121056e59d4880', '121056e504', '1214', '1212', '1211', '1210ffff']) assert.equal(aacLCConfig(Buffer.from(hex, 'hex')), null, hex)
})
// Valid MDHD durations retaining priming were rejected before the timing fix.
test('encoded AAC preserves bytes with either MDHD duration convention', async () => {
  const original = await readFile(new URL('./fixtures/aac-editlist.m4a', import.meta.url))
  const included = Buffer.from(original), mdhd = included.indexOf('mdhd'), elst = included.indexOf('elst')
  assert.equal(included[mdhd + 4], 0)
  assert.equal(included[elst + 4], 0)
  included.writeUInt32BE(included.readUInt32BE(mdhd + 20) + included.readUInt32BE(elst + 16), mdhd + 20)
  for (const b of [original, included]) {
    const before = Buffer.from(b)
    assert.equal(nativeM4A(b), true)
    assert.deepEqual(b, before)
  }
})
// A plain chapter sample must not make an otherwise supported AAC file unplayable.
test('encoded AAC accepts a bounded text track without rewriting bytes', async () => {
  const original = await readFile(new URL('./fixtures/aac-editlist.m4a', import.meta.url))
  for (const options of [{ prefix: true }, { prefix: false }, { textFirst: true }, { wide: true }]) {
    const b = withTextTrack(original, options), before = Buffer.from(b)
    assert.equal(nativeM4A(b), true)
    assert.deepEqual(b, before)
  }
})
test('encoded edit-list fixture passes, while legacy iTunes and HE fixtures stay outside the guard', async () => {
  for (const name of ['aac-editlist.m4a', 'aac-lc.m4a', 'aac-he.m4a', 'aac-hev2.m4a']) assert.equal(nativeM4A(await readFile(new URL('./fixtures/' + name, import.meta.url))), name === 'aac-editlist.m4a', name)
})
