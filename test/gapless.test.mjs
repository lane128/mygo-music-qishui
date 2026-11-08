import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { m4aGapless } from '../helper/m4a-gapless.mjs'
import { aacConversionArgs } from '../helper/ffmpeg-args.mjs'

test('M4A gapless timing uses explicit core-clock priming and valid samples', async () => {
  for (const [name, start] of [['aac-he.m4a', '0.095782313'], ['aac-hev2.m4a', '0.095782313'], ['aac-fullscale.m4a', '0.047891156'], ['aac-transient.m4a', '0.047891156']]) {
    const data = await readFile(new URL('./fixtures/' + name, import.meta.url))
    const filter = m4aGapless(data)
    assert.equal(filter, `atrim=start=${start}:duration=1.000000000`)
    const args = aacConversionArgs('input', 'output', filter)
    assert.ok(args.indexOf('-copyts') < args.indexOf('-i'))
    assert.deepEqual(args.slice(args.indexOf('-flags2'), args.indexOf('-i')), ['-flags2', '+skip_manual'])
    assert.equal(args[args.indexOf('-af') + 1], filter)
    assert.equal(m4aGapless(data.subarray(0, data.length - 1)), undefined)
    const noTag = Buffer.from(data)
    noTag.write('otherTag', noTag.indexOf('iTunSMPB'))
    assert.equal(m4aGapless(noTag), undefined)
    assert.equal(m4aGapless(Buffer.concat([data, data])), undefined)
  }
  assert.equal(m4aGapless(Buffer.from('invalid input')), undefined)
})
