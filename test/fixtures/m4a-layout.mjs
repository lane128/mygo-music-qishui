// Structural fixtures only: payload bytes are not an encoded audio signal.
import { withTextTrack } from './mp4-text-track.mjs'
export const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
export const box = (type, ...parts) => { const b = Buffer.concat(parts); return Buffer.concat([u32(b.length + 8), Buffer.from(type), b]) }
const descriptor = (tag, ...parts) => { const b = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag, b.length]), b]) }
export function m4aLayout({ asc = '1210', wide = false, encrypted = false, durationIncludesPriming = false } = {}) {
  const zero = u32(0), payload = Buffer.from('0102030405060708', 'hex')
  const ftyp = box('ftyp', Buffer.from('M4A '), zero)
  const mdhd = Buffer.alloc(wide ? 36 : 24); mdhd[0] = wide ? 1 : 0
  mdhd.writeUInt32BE(44100, wide ? 20 : 12)
  const duration = durationIncludesPriming ? 2048 : 1024
  if (wide) mdhd.writeBigUInt64BE(BigInt(duration), 24); else mdhd.writeUInt32BE(duration, 16)
  const hdlr = Buffer.alloc(12); hdlr.write('soun', 8)
  const elst = Buffer.alloc(wide ? 28 : 20); elst[0] = wide ? 1 : 0; elst.writeUInt32BE(1, 4)
  if (wide) { elst.writeBigUInt64BE(1024n, 8); elst.writeBigInt64BE(1024n, 16) }
  else { elst.writeUInt32BE(1024, 8); elst.writeInt32BE(1024, 12) }
  elst.writeUInt32BE(65536, wide ? 24 : 16)
  const sample = Buffer.alloc(28); sample.writeUInt16BE(1, 6); sample.writeUInt16BE(2, 16); sample.writeUInt16BE(16, 18); sample.writeUInt32BE(44100 * 65536, 24)
  const config = Buffer.alloc(13); config[0] = 0x40; config[1] = 0x15
  const esds = box('esds', zero, descriptor(3, Buffer.from([0, 1, 0]), descriptor(4, config, descriptor(5, Buffer.from(asc, 'hex'))), descriptor(6, Buffer.from([2]))))
  const movie = offset => box('moov', box('trak', box('edts', box('elst', elst)), box('mdia', box('mdhd', mdhd), box('hdlr', hdlr), box('minf', box('stbl',
    box('stsd', zero, u32(1), box('mp4a', sample, esds, ...(encrypted ? [box('sinf')] : []))),
    box('stsz', zero, zero, u32(2), u32(4), u32(4)), box('stts', zero, u32(1), u32(2), u32(1024)),
    box('stsc', zero, u32(1), u32(1), u32(2), u32(1)),
    wide ? box('co64', zero, u32(1), u32(0), u32(offset)) : box('stco', zero, u32(1), u32(offset)),
  )))))
  return Buffer.concat([ftyp, movie(ftyp.length + movie(0).length + 8), box('mdat', payload)])
}
export function m4aCases() {
  const base = m4aLayout()
  const mutate = (name, type, offset, value) => { const b = Buffer.from(base); if (typeof value === 'string') b.write(value, b.indexOf(type) + offset, 'ascii'); else b.writeUInt32BE(value, b.indexOf(type) + offset); return { name, valid: false, hex: b.toString('hex') } }
  const text = withTextTrack(base)
  const badText = (name, change) => { const b = Buffer.from(text); change(b); return { name, valid: false, hex: b.toString('hex') } }
  return [
    ...[{ prefix: true }, { prefix: false }, { textFirst: true }, { wide: true }].map((options, i) => ({ name: 'text-track-' + i, valid: true, hex: withTextTrack(base, options).toString('hex') })),
    ...['soun', 'vide'].map(handler => ({ name: 'unsupported-extra-' + handler, valid: false, hex: withTextTrack(base, { handler }).toString('hex') })),
    badText('text-overlaps-audio', b => b.writeUInt32BE(b.readUInt32BE(b.lastIndexOf('stco') + 12) + 1, b.lastIndexOf('stco') + 12)),
    badText('text-outside-mdat', b => b.writeUInt32BE(0, b.lastIndexOf('stco') + 12)),
    badText('text-wrong-description', b => b.writeUInt32BE(2, b.lastIndexOf('stsc') + 20)),
    badText('text-wrong-reference', b => b.writeUInt16BE(2, b.lastIndexOf('stsd') + 26)),
    badText('text-extra-sample', b => b.writeUInt32BE(2, b.lastIndexOf('stsz') + 12)),
    badText('text-zero-size', b => b.writeUInt32BE(0, b.lastIndexOf('stsz') + 16)),
    badText('text-size-over-limit', b => b.writeUInt32BE(65537, b.lastIndexOf('stsz') + 16)),
    ...['senc', 'saio', 'saiz', 'ctts'].map(extraTable => ({ name: 'text-forbidden-' + extraTable, valid: false, hex: withTextTrack(base, { extraTable }).toString('hex') })),
    badText('text-wrong-timing', b => b.writeUInt32BE(2, b.lastIndexOf('stts') + 12)),
    badText('audio-overlaps-text', b => b.writeUInt32BE(b.readUInt32BE(b.indexOf('stco') + 12) - 1, b.indexOf('stco') + 12)),
    { name: 'lc', valid: true, hex: base.toString('hex') },
    { name: 'sbr-absent-extension', valid: true, hex: m4aLayout({ asc: '121056e500' }).toString('hex') },
    { name: '64-bit', valid: true, hex: m4aLayout({ wide: true }).toString('hex') },
    // The original guard rejected real AAC-LC songs whose MDHD retained priming.
    { name: 'duration-includes-priming', valid: true, hex: m4aLayout({ durationIncludesPriming: true }).toString('hex') },
    { name: '64-bit-duration-includes-priming', valid: true, hex: m4aLayout({ wide: true, durationIncludesPriming: true }).toString('hex') },
    { name: 'ps-absent-extension', valid: true, hex: m4aLayout({ asc: '121056e55480' }).toString('hex') },
    ...['121056e5000000', '2b9208', 'eb9208', '121056e59d4880', '121056e504', '1214', '1212', '1211', '1210ffff', '12'].map(asc => ({ name: 'unsupported-asc-' + asc, valid: false, hex: m4aLayout({ asc }).toString('hex') })),
    { name: 'encrypted', valid: false, hex: m4aLayout({ encrypted: true }).toString('hex') },
    { name: 'truncated', valid: false, hex: base.subarray(0, -1).toString('hex') },
    { name: 'fragmented', valid: false, hex: Buffer.concat([base, box('moof')]).toString('hex') },
    mutate('missing-chunks', 'stco', 0, 'free'), mutate('offset-outside-mdat', 'stco', 12, 0),
    mutate('missing-map', 'stsc', 0, 'free'), mutate('wrong-first-chunk', 'stsc', 12, 2),
    mutate('wrong-sample-count', 'stsc', 16, 1), mutate('wrong-description', 'stsc', 20, 2),
    mutate('wrong-timing', 'mdhd', 20, 1023), mutate('negative-priming', 'elst', 16, 0xffffffff),
    mutate('duration-between-timing-variants', 'mdhd', 20, 1536), mutate('duration-beyond-samples', 'mdhd', 20, 2049),
    mutate('zero-duration', 'mdhd', 20, 0),
    ...[2048, 2049].map(prime => {
      const b = m4aLayout({ durationIncludesPriming: true }); b.writeUInt32BE(prime, b.indexOf('elst') + 16)
      return { name: 'priming-at-or-beyond-end-' + prime, valid: false, hex: b.toString('hex') }
    }),
    mutate('no-edit-list', 'elst', 0, 'free'), mutate('too-many-edits', 'elst', 8, 2),
    mutate('sample-overflow', 'stsz', 12, 1000001), mutate('packet-too-long', 'stts', 16, 2048),
  ]
}
