// Test-only rewrapper: preserve audio packets, add a single plain chapter sample.
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const box = (type, ...parts) => { const b = Buffer.concat(parts); return Buffer.concat([u32(b.length + 8), Buffer.from(type), b]) }
export const chapter = Buffer.from('000c436861707465722074657874', 'hex')
export function withTextTrack(input, { prefix = true, textFirst = false, wide = false, handler = 'text', extraTable } = {}) {
  function boxes(start, end) {
    const out = []
    for (let p = start; p < end;) { const n = input.readUInt32BE(p); if (n < 8 || p + n > end) throw Error('fixture boxes'); out.push({ type: input.toString('ascii', p + 4, p + 8), body: p + 8, end: p + n }); p += n }
    return out
  }
  const top = boxes(0, input.length), mdat = top.find(x => x.type === 'mdat'), moov = top.find(x => x.type === 'moov')
  const zero = u32(0), entry = Buffer.alloc(8); entry.writeUInt16BE(1, 6)
  const text = offset => box('trak', box('mdia', box('hdlr', zero, zero, Buffer.from(handler)), box('minf', box('stbl',
    box('stsd', zero, u32(1), box('text', entry)), box('stsz', zero, zero, u32(1), u32(chapter.length)),
    box('stts', zero, u32(1), u32(1), u32(1024)), box('stsc', zero, u32(1), u32(1), u32(1), u32(1)),
    wide ? box('co64', zero, u32(1), u32(0), u32(offset)) : box('stco', zero, u32(1), u32(offset)),
    ...(extraTable ? [box(extraTable, zero, u32(0))] : []),
  ))))
  const delta = text(0).length, audioDelta = delta + (prefix ? chapter.length : 0)
  function rewrite(start, end) {
    return Buffer.concat(boxes(start, end).map(x => {
      let body = Buffer.from(input.subarray(x.body, x.end))
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(x.type)) body = rewrite(x.body, x.end)
      if (x.type === 'stco') for (let p = 8; p < body.length; p += 4) body.writeUInt32BE(body.readUInt32BE(p) + audioDelta, p)
      if (x.type === 'co64') for (let p = 8; p < body.length; p += 8) body.writeBigUInt64BE(body.readBigUInt64BE(p) + BigInt(audioDelta), p)
      return box(x.type, body)
    }))
  }
  const chapterOffset = prefix ? mdat.body + delta : mdat.end + delta
  const audioTracks = rewrite(moov.body, moov.end), extra = text(chapterOffset)
  return Buffer.concat(top.map(x => x.type === 'moov' ? box('moov', ...(textFirst ? [extra, audioTracks] : [audioTracks, extra])) : x.type === 'mdat' ? box('mdat', ...(prefix ? [chapter, input.subarray(x.body, x.end)] : [input.subarray(x.body, x.end), chapter])) : input.subarray(x.body - 8, x.end)))
}
