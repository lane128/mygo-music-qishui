// Rewrap the existing synthetic AAC stress signal in the edit-list layout used by grants.
// This changes metadata only; it does not encode or alter AAC payload bytes.
import { readFile, writeFile } from 'node:fs/promises'
import { box, u32 } from '../test/fixtures/m4a-layout.mjs'
const input = new URL('../test/fixtures/aac-fullscale.m4a', import.meta.url)
const output = process.argv[2] || new URL('../test/fixtures/aac-editlist.m4a', import.meta.url)
const source = await readFile(input)
const priming = 2112, frames = 44100
let delta = 0
function rewrite(data) {
  const out = []
  for (let p = 0; p < data.length;) {
    const n = data.readUInt32BE(p), type = data.toString('ascii', p + 4, p + 8)
    if (n < 8 || n > data.length - p) throw Error('Unexpected fixture layout')
    let body = Buffer.from(data.subarray(p + 8, p + n))
    if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) body = rewrite(body)
    if (type === 'udta') { p += n; continue }
    if (type === 'trak') body = Buffer.concat([body, box('edts', box('elst', u32(0), u32(1), u32(frames), u32(priming), u32(65536)))])
    if (type === 'mdhd' || type === 'mvhd') body.writeUInt32BE(frames, 16)
    if (type === 'stts') {
      if (body.readUInt32BE(4) !== 1 || body.readUInt32BE(12) !== 1024) throw Error('Unexpected timing table')
      const count = body.readUInt32BE(8), tail = priming + frames - (count - 1) * 1024
      if (tail <= 0 || tail > 1024) throw Error('Invalid fixture timing')
      body = Buffer.concat([u32(0), u32(2), u32(count - 1), u32(1024), u32(1), u32(tail)])
    }
    if (type === 'stco') for (let q = 8; q < body.length; q += 4) body.writeUInt32BE(body.readUInt32BE(q) + delta, q)
    out.push(box(type, body)); p += n
  }
  return Buffer.concat(out)
}
const first = rewrite(source), oldStart = source.indexOf('mdat') + 4
// Find the rewritten mdat to adjust sample offsets after changing the headers.
for (let p = 0; p < first.length; p += first.readUInt32BE(p)) if (first.toString('ascii', p + 4, p + 8) === 'mdat') { delta = p + 8 - oldStart; break }
await writeFile(output, rewrite(source), { flag: 'wx' })
