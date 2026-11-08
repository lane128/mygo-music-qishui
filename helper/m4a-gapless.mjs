// Explicit iTunes gapless metadata only; unknown layouts use FFmpeg's defaults.
function boxes(data) {
  const out = []
  for (let p = 0; p < data.length;) {
    if (data.length - p < 8 || out.length >= 4096) return
    let n = data.readUInt32BE(p), header = 8
    if (n === 1) {
      if (data.length - p < 16) return
      const wide = data.readBigUInt64BE(p + 8)
      if (wide > BigInt(data.length - p)) return
      n = Number(wide); header = 16
    }
    if (n === 0) n = data.length - p
    if (n < header || n > data.length - p) return
    out.push({ kind: data.toString('ascii', p + 4, p + 8), data: data.subarray(p + header, p + n) })
    p += n
  }
  return out
}
function one(list, kind) {
  const matches = list?.filter(box => box.kind === kind)
  return matches?.length === 1 ? matches[0].data : undefined
}
function child(data, kind) { return data && one(boxes(data), kind) }
export function m4aGapless(data) {
  const top = boxes(data)
  if (!top || top.some(box => box.kind === 'moof')) return
  const moov = one(top, 'moov'), movie = moov && boxes(moov)
  if (!movie || movie.some(box => box.kind === 'mvex')) return
  const trak = one(movie, 'trak'), track = trak && boxes(trak)
  if (!track || track.some(box => box.kind === 'edts')) return
  const mdia = one(track, 'mdia'), media = mdia && boxes(mdia)
  const handler = one(media, 'hdlr'), mdhd = one(media, 'mdhd')
  if (!handler || handler.length < 12 || handler.toString('ascii', 8, 12) !== 'soun' || !mdhd || mdhd.length < 24) return
  let timescale, duration
  if (mdhd[0] === 0) { timescale = mdhd.readUInt32BE(12); duration = BigInt(mdhd.readUInt32BE(16)) }
  else if (mdhd[0] === 1 && mdhd.length >= 36) { timescale = mdhd.readUInt32BE(20); duration = mdhd.readBigUInt64BE(24) }
  else return
  if (!timescale || !duration || duration > BigInt(Number.MAX_SAFE_INTEGER)) return
  const stsd = child(child(one(media, 'minf'), 'stbl'), 'stsd')
  if (!stsd || stsd.length < 8 || stsd.readUInt32BE(4) !== 1) return
  const entries = boxes(stsd.subarray(8))
  if (entries?.length !== 1 || entries[0].kind !== 'mp4a') return
  const meta = child(one(movie, 'udta'), 'meta')
  if (!meta || meta.length < 4 || meta.readUInt32BE(0) !== 0) return
  const ilst = child(meta.subarray(4), 'ilst'), tags = ilst && boxes(ilst)
  if (!tags) return
  let text, count = 0
  for (const tag of tags) {
    if (tag.kind !== '----') continue
    const fields = boxes(tag.data)
    if (!fields) return
    const name = one(fields, 'name')
    if (!name || name.length < 4 || name.toString('utf8', 4) !== 'iTunSMPB') continue
    count++
    const mean = one(fields, 'mean'), value = one(fields, 'data')
    if (!mean || mean.length < 4 || mean.toString('utf8', 4) !== 'com.apple.iTunes' || !value || value.length < 8 || value.readUInt32BE(0) !== 1 || value.readUInt32BE(4) !== 0) return
    text = value.toString('utf8', 8)
  }
  if (count !== 1 || text.length > 512) return
  const fields = text.trim().split(/\s+/)
  if (fields.length < 4 || fields.length > 16 || fields[0] !== '00000000' || fields.some((s, i) => !(i === 3 ? /^[\da-fA-F]{16}$/ : /^[\da-fA-F]{8}$/).test(s))) return
  const priming = BigInt('0x' + fields[1]), padding = BigInt('0x' + fields[2]), samples = BigInt('0x' + fields[3])
  if (!samples || priming + padding + samples !== duration) return
  return `atrim=start=${(Number(priming) / timescale).toFixed(9)}:duration=${(Number(samples) / timescale).toFixed(9)}`
}
