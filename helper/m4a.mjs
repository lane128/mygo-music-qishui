// Conservative passthrough for the non-fragmented AAC-LC layout verified in real grants.
// Unknown ASC extensions, encryption and timing layouts fail closed; audio is never rewritten.
function boxes(b, start = 0, end = b.length) {
  const out = []
  for (let p = start; p < end;) {
    if (end - p < 8 || out.length >= 1000000) throw 0
    let n = b.readUInt32BE(p), h = 8
    if (n === 1) { if (end - p < 16) throw 0; n = Number(b.readBigUInt64BE(p + 8)); h = 16 }
    if (n === 0) n = end - p
    if (!Number.isSafeInteger(n) || n < h || n > end - p) throw 0
    out.push({ type: b.toString('ascii', p + 4, p + 8), body: p + h, end: p + n }); p += n
  }
  return out
}
function one(list, type) { const items = list.filter(x => x.type === type); if (items.length !== 1) throw 0; return items[0] }
function enough(x, p, n) { if (p < x.body || n < 0 || n > x.end - p) throw 0 }
// One sound track, with an optional plain QuickTime text sample at an mdat edge.
function audioTrack(b, movie, mdat) {
  const tracks = boxes(b, movie.body, movie.end).filter(x => x.type === 'trak')
  if (!tracks.length || tracks.length > 2) throw 0
  let sound, text
  for (const track of tracks) {
    const mdia = one(boxes(b, track.body, track.end), 'mdia'), hdlr = one(boxes(b, mdia.body, mdia.end), 'hdlr'); enough(hdlr, hdlr.body, 12)
    const type = b.toString('ascii', hdlr.body + 8, hdlr.body + 12)
    if (type === 'soun' && !sound) sound = track
    else if (type === 'text' && !text) text = track
    else throw 0
  }
  if (!sound) throw 0
  let start = mdat.body, end = mdat.end
  if (!text) return { track: sound, start, end }
  const mdia = one(boxes(b, text.body, text.end), 'mdia'), minf = one(boxes(b, mdia.body, mdia.end), 'minf'), stbl = one(boxes(b, minf.body, minf.end), 'stbl'), tables = boxes(b, stbl.body, stbl.end)
  if (tables.some(x => ['senc', 'saio', 'saiz', 'ctts'].includes(x.type))) throw 0
  const stsd = one(tables, 'stsd'); enough(stsd, stsd.body, 8)
  if (b.readUInt32BE(stsd.body) !== 0 || b.readUInt32BE(stsd.body + 4) !== 1) throw 0
  const entries = boxes(b, stsd.body + 8, stsd.end), entry = one(entries, 'text'); enough(entry, entry.body, 8)
  if (entries.length !== 1 || b.readUInt16BE(entry.body + 6) !== 1) throw 0
  const stsz = one(tables, 'stsz'); enough(stsz, stsz.body, 12)
  if (b.readUInt32BE(stsz.body) !== 0 || b.readUInt32BE(stsz.body + 8) !== 1) throw 0
  let size = b.readUInt32BE(stsz.body + 4)
  if (!size) { enough(stsz, stsz.body + 12, 4); size = b.readUInt32BE(stsz.body + 12) }
  if (!size || size > 65536) throw 0
  const stsc = one(tables, 'stsc'); enough(stsc, stsc.body, 20)
  if (b.readUInt32BE(stsc.body) !== 0 || [4, 8, 12, 16].some(at => b.readUInt32BE(stsc.body + at) !== 1)) throw 0
  const stts = one(tables, 'stts'); enough(stts, stts.body, 16)
  if (b.readUInt32BE(stts.body) !== 0 || b.readUInt32BE(stts.body + 4) !== 1 || b.readUInt32BE(stts.body + 8) !== 1 || !b.readUInt32BE(stts.body + 12)) throw 0
  const offsets = tables.filter(x => ['stco', 'co64'].includes(x.type))
  if (offsets.length !== 1) throw 0
  const chunk = offsets[0], wide = chunk.type === 'co64'; enough(chunk, chunk.body, wide ? 16 : 12)
  if (b.readUInt32BE(chunk.body) !== 0 || b.readUInt32BE(chunk.body + 4) !== 1) throw 0
  const offset = wide ? Number(b.readBigUInt64BE(chunk.body + 8)) : b.readUInt32BE(chunk.body + 8)
  if (!Number.isSafeInteger(offset) || offset < start || offset > end || size > end - offset) throw 0
  if (offset === start) start += size
  else { if (offset + size !== end) throw 0; end -= size }
  if (start >= end) throw 0
  return { track: sound, start, end }
}
function descriptors(b, start, end) {
  const out = []
  for (let p = start; p < end;) {
    const tag = b[p++]; let n = 0, done = false
    for (let i = 0; i < 4; i++) { if (p >= end) throw 0; const v = b[p++]; n = n * 128 + (v & 127); if (!(v & 128)) { done = true; break } }
    if (!done || n > end - p) throw 0
    out.push({ type: tag, body: p, end: p + n }); p += n
  }
  return out
}
export function aacLCConfig(asc) {
  try {
    if (!Buffer.isBuffer(asc) || asc.length < 2 || asc.length > 8) return null
    let at = 0
    const read = n => { if (n > asc.length * 8 - at) throw 0; let v = 0; for (let i = 0; i < n; i++, at++) v = v * 2 + ((asc[at >> 3] >> (7 - (at & 7))) & 1); return v }
    if (read(5) !== 2) return null
    const index = read(4), channels = read(4)
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
    if (index >= rates.length || ![1, 2].includes(channels) || read(3) !== 0) return null
    if (asc.length * 8 - at > 7) {
      // ISO 14496-3 sync extension: accept only an explicit SBR-absent declaration.
      if (read(11) !== 0x2b7 || read(5) !== 5 || read(1) !== 0) return null
      if (asc.length * 8 - at > 7 && (read(11) !== 0x548 || read(1) !== 0)) return null
    }
    if (asc.length * 8 - at > 7 || read(asc.length * 8 - at) !== 0) return null
    return { sampleRate: rates[index], channels }
  } catch { return null }
}
export function nativeM4A(b) {
  try {
    if (!Buffer.isBuffer(b) || b.length < 32 || b.length > 128 * 1024 * 1024) return false
    const top = boxes(b), moov = one(top, 'moov'), mdat = one(top, 'mdat'), ftyp = one(top, 'ftyp')
    if (ftyp.end - ftyp.body < 8 || top.some(x => x.type === 'moof')) return false
    const movie = boxes(b, moov.body, moov.end)
    if (movie.some(x => x.type === 'mvex')) return false
    const { track: trak, start: audioStart, end: audioEnd } = audioTrack(b, moov, mdat)
    const track = boxes(b, trak.body, trak.end), mdia = one(track, 'mdia'), media = boxes(b, mdia.body, mdia.end)
    const handler = one(media, 'hdlr'); enough(handler, handler.body, 12)
    if (b.toString('ascii', handler.body + 8, handler.body + 12) !== 'soun') return false
    const mdhd = one(media, 'mdhd'); enough(mdhd, mdhd.body, 24)
    let scale, duration
    if (b[mdhd.body] === 0) { scale = b.readUInt32BE(mdhd.body + 12); duration = b.readUInt32BE(mdhd.body + 16) }
    else if (b[mdhd.body] === 1) { enough(mdhd, mdhd.body, 36); scale = b.readUInt32BE(mdhd.body + 20); duration = Number(b.readBigUInt64BE(mdhd.body + 24)) }
    else return false
    const edts = one(track, 'edts'), elst = one(boxes(b, edts.body, edts.end), 'elst'); enough(elst, elst.body, 8)
    if (b.readUInt32BE(elst.body) !== 0 && b.readUInt32BE(elst.body) !== 0x1000000 || b.readUInt32BE(elst.body + 4) !== 1) return false
    const wide = b[elst.body] === 1; enough(elst, elst.body + 8, wide ? 20 : 12)
    const segment = wide ? Number(b.readBigUInt64BE(elst.body + 8)) : b.readUInt32BE(elst.body + 8)
    const priming = wide ? Number(b.readBigInt64BE(elst.body + 16)) : b.readInt32BE(elst.body + 12)
    if (!Number.isSafeInteger(segment) || segment <= 0 || !Number.isSafeInteger(priming) || priming < 0 || b.readUInt32BE(elst.body + (wide ? 24 : 16)) !== 0x10000) return false
    const minf = one(media, 'minf'), stbl = one(boxes(b, minf.body, minf.end), 'stbl'), tables = boxes(b, stbl.body, stbl.end)
    if (tables.some(x => ['senc', 'saio', 'saiz'].includes(x.type))) return false
    const stsd = one(tables, 'stsd'); enough(stsd, stsd.body, 8)
    if (b.readUInt32BE(stsd.body) !== 0 || b.readUInt32BE(stsd.body + 4) !== 1) return false
    const entries = boxes(b, stsd.body + 8, stsd.end), entry = one(entries, 'mp4a'); enough(entry, entry.body, 28)
    if (entries.length !== 1 || b.readUInt16BE(entry.body + 8) !== 0) return false
    const children = boxes(b, entry.body + 28, entry.end)
    if (children.some(x => x.type === 'sinf')) return false
    const esds = one(children, 'esds'); enough(esds, esds.body, 4)
    if (b.readUInt32BE(esds.body) !== 0) return false
    const es = one(descriptors(b, esds.body + 4, esds.end), 3); enough(es, es.body, 3)
    let p = es.body + 3; const flags = b[es.body + 2]
    if (flags & 128) p += 2
    if (flags & 64) { enough(es, p, 1); p += 1 + b[p] }
    if (flags & 32) p += 2
    enough(es, p, 0)
    const decoder = one(descriptors(b, p, es.end), 4); enough(decoder, decoder.body, 13)
    if (b[decoder.body] !== 0x40 || b[decoder.body + 1] >> 2 !== 5) return false
    const config = one(descriptors(b, decoder.body + 13, decoder.end), 5), asc = aacLCConfig(b.subarray(config.body, config.end))
    if (!asc || scale !== asc.sampleRate || b.readUInt32BE(entry.body + 24) !== asc.sampleRate * 65536 || b.readUInt16BE(entry.body + 16) !== asc.channels) return false
    const stsz = one(tables, 'stsz'); enough(stsz, stsz.body, 12)
    const fixed = b.readUInt32BE(stsz.body + 4), count = b.readUInt32BE(stsz.body + 8)
    if (!count || count > 1000000) return false
    if (!fixed) enough(stsz, stsz.body + 12, count * 4)
    let bytes = 0
    for (let i = 0; i < count; i++) { const size = fixed || b.readUInt32BE(stsz.body + 12 + i * 4); if (!size) return false; bytes += size }
    if (bytes !== audioEnd - audioStart) return false
    const offsets = tables.filter(x => ['stco', 'co64'].includes(x.type))
    if (offsets.length !== 1 || tables.some(x => x.type === 'ctts')) return false
    const chunks = offsets[0], width = chunks.type === 'co64' ? 8 : 4; enough(chunks, chunks.body, 8)
    const chunkCount = b.readUInt32BE(chunks.body + 4)
    if (b.readUInt32BE(chunks.body) !== 0 || !chunkCount || chunkCount > count) return false
    enough(chunks, chunks.body + 8, chunkCount * width)
    const stsc = one(tables, 'stsc'); enough(stsc, stsc.body, 8)
    const mappings = b.readUInt32BE(stsc.body + 4)
    if (b.readUInt32BE(stsc.body) !== 0 || !mappings || mappings > chunkCount) return false
    enough(stsc, stsc.body + 8, mappings * 12)
    const mapping = []
    for (let i = 0; i < mappings; i++) {
      const p = stsc.body + 8 + i * 12, first = b.readUInt32BE(p), samples = b.readUInt32BE(p + 4)
      if ((!i && first !== 1) || (i && first <= mapping[i - 1].first) || first > chunkCount || !samples || samples > count || b.readUInt32BE(p + 8) !== 1) return false
      mapping.push({ first, samples })
    }
    let sample = 0, offset = audioStart, run = 0
    for (let i = 1; i <= chunkCount; i++) {
      if (run + 1 < mappings && mapping[run + 1].first === i) run++
      const p = chunks.body + 8 + (i - 1) * width
      const declared = width === 8 ? Number(b.readBigUInt64BE(p)) : b.readUInt32BE(p)
      if (declared !== offset || sample + mapping[run].samples > count) return false
      for (let j = 0; j < mapping[run].samples; j++, sample++) offset += fixed || b.readUInt32BE(stsz.body + 12 + sample * 4)
    }
    if (sample !== count || offset !== audioEnd) return false
    const stts = one(tables, 'stts'); enough(stts, stts.body, 8)
    const runs = b.readUInt32BE(stts.body + 4); if (!runs || runs > count) return false; enough(stts, stts.body + 8, runs * 8)
    let packets = 0, ticks = 0
    for (let i = 0; i < runs; i++) { const n = b.readUInt32BE(stts.body + 8 + i * 8), delta = b.readUInt32BE(stts.body + 12 + i * 8); if (!n || !delta || delta > 1024) return false; packets += n; ticks += n * delta }
    // Real grants use MDHD durations both including and excluding edit-list priming.
    // The host derives playback length from STTS minus priming in either layout.
    return packets === count && Number.isSafeInteger(duration) && duration > 0 && priming < ticks &&
      (duration === ticks || duration === ticks - priming)
  } catch { return false }
}
