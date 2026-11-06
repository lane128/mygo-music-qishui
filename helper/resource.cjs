// Local experiment for the resource and play_auth returned together by the
// authorized API. Never retrieves keys or changes the granted resource length.
// Spade interpretation follows sodahub-org/libresoda, AGPL-3.0-or-later,
// commit 5edd2ff3b825f0a16b1e281204822ee06842df9c, src/soda/crypto.rs.
// MP4 handling below deliberately accepts only one non-fragmented audio track.
const { createDecipheriv } = require('node:crypto');
const fs = require('node:fs');

class DecodeError extends Error {}

function resourceKey(auth) {
  if (typeof auth !== 'string' || auth.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(auth)) throw new DecodeError('invalid play auth');
  const raw = Buffer.from(auth, 'base64');
  if (raw.length < 4) throw new DecodeError('short play auth');
  const padding = (raw[0] ^ raw[1] ^ raw[2]) - 48;
  if (padding < 0 || padding + 2 >= raw.length) throw new DecodeError('invalid play auth padding');
  const inner = raw.subarray(1, raw.length - padding);
  const plain = Buffer.alloc(inner.length);
  for (let i = 0; i < inner.length; i++) {
    let bits = i, count = 0;
    while (bits) { count += bits & 1; bits >>>= 1; }
    let value = (inner[i] ^ (i === 0 ? 0xfa : i === 1 ? 0x55 : inner[i - 2])) - count - 21;
    while (value < 0) value += 255;
    plain[i] = value;
  }
  const first = String.fromCharCode(plain[0]);
  if (!/^[0-9a-z]$/.test(first)) throw new DecodeError('invalid play auth prefix');
  const skip = parseInt(first, 36);
  if (skip >= plain.length - 1) throw new DecodeError('invalid play auth length');
  const hex = plain.subarray(1, plain.length - skip).toString('ascii');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new DecodeError('invalid resource key');
  return Buffer.from(hex, 'hex');
}

function boxes(data, begin, end) {
  const result = [];
  for (let pos = begin; pos < end;) {
    if (pos + 8 > end) throw new DecodeError('truncated MP4 header');
    let size = data.readUInt32BE(pos), header = 8;
    if (size === 1) {
      if (pos + 16 > end) throw new DecodeError('truncated MP4 extended header');
      const extended = data.readBigUInt64BE(pos + 8);
      if (extended > BigInt(end - pos)) throw new DecodeError('oversized MP4 box');
      size = Number(extended); header = 16;
    } else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) throw new DecodeError('invalid MP4 box size');
    result.push({type: data.toString('ascii', pos + 4, pos + 8), pos, body: pos + header, end: pos + size});
    pos += size;
  }
  return result;
}

function one(list, type) {
  const found = list.filter(box => box.type === type);
  if (found.length !== 1) throw new DecodeError('unsupported MP4 structure: ' + type);
  return found[0];
}

function enough(box, offset, bytes) {
  if (offset < box.body || offset + bytes > box.end) throw new DecodeError('truncated MP4 table');
}

function decodeWithKey(input, key) {
  if (!Buffer.isBuffer(key) || key.length !== 16 || input.length > 128 * 1024 * 1024) throw new DecodeError('invalid input');
  const output = Buffer.from(input);
  const top = boxes(output, 0, output.length);
  if (top.some(box => box.type === 'moof')) throw new DecodeError('fragmented MP4 unsupported');
  const mdat = one(top, 'mdat');
  let parent = one(top, 'moov');
  for (const type of ['trak', 'mdia', 'minf', 'stbl']) parent = one(boxes(output, parent.body, parent.end), type);
  const tables = boxes(output, parent.body, parent.end);
  const stsz = one(tables, 'stsz'); enough(stsz, stsz.body, 12);
  const fixedSize = output.readUInt32BE(stsz.body + 4);
  const count = output.readUInt32BE(stsz.body + 8);
  if (!count || count > 1000000) throw new DecodeError('invalid sample count');
  if (!fixedSize) enough(stsz, stsz.body + 12, count * 4);
  const sizes = Array.from({length: count}, (_, i) => fixedSize || output.readUInt32BE(stsz.body + 12 + i * 4));
  if (sizes.some(size => !size) || sizes.reduce((sum, size) => sum + size, 0) !== mdat.end - mdat.body) throw new DecodeError('unsupported sample layout');
  // Verify that chunk offsets follow this one-track, contiguous sample order.
  // Chunk reordering and interleaved media are rejected instead of corrupted.
  const offsets = tables.filter(box => box.type === 'stco' || box.type === 'co64');
  if (offsets.length !== 1) throw new DecodeError('unsupported chunk offsets');
  const stco = offsets[0]; enough(stco, stco.body, 8);
  const chunkCount = output.readUInt32BE(stco.body + 4), stride = stco.type === 'co64' ? 8 : 4;
  if (!chunkCount || chunkCount > count) throw new DecodeError('invalid chunk count');
  enough(stco, stco.body + 8, chunkCount * stride);
  const stsc = one(tables, 'stsc'); enough(stsc, stsc.body, 8);
  const runCount = output.readUInt32BE(stsc.body + 4);
  if (!runCount || runCount > chunkCount) throw new DecodeError('invalid chunk mapping');
  enough(stsc, stsc.body + 8, runCount * 12);
  const runs = Array.from({length: runCount}, (_, i) => {
    const p = stsc.body + 8 + i * 12;
    return {first: output.readUInt32BE(p), count: output.readUInt32BE(p + 4), entry: output.readUInt32BE(p + 8)};
  });
  if (runs[0].first !== 1 || runs.some((run, i) => !run.count || run.entry !== 1 || run.first > chunkCount || (i > 0 && run.first <= runs[i - 1].first))) throw new DecodeError('invalid chunk mapping');
  let sample = 0, expected = mdat.body, run = 0;
  for (let i = 0; i < chunkCount; i++) {
    while (run + 1 < runs.length && runs[run + 1].first <= i + 1) run++;
    const p = stco.body + 8 + i * stride;
    const offset = stride === 8 ? output.readBigUInt64BE(p) : BigInt(output.readUInt32BE(p));
    if (offset !== BigInt(expected) || sample + runs[run].count > count) throw new DecodeError('noncontiguous chunks unsupported');
    for (let n = 0; n < runs[run].count; n++) expected += sizes[sample++];
  }
  if (sample !== count) throw new DecodeError('incomplete chunk mapping');
  const stsd = one(tables, 'stsd'); enough(stsd, stsd.body, 8);
  if (output.readUInt32BE(stsd.body + 4) !== 1) throw new DecodeError('multiple sample descriptions unsupported');
  const entry = one(boxes(output, stsd.body + 8, stsd.end), 'enca');
  enough(entry, entry.body, 28);
  if (output.readUInt16BE(entry.body + 8) !== 0) throw new DecodeError('unsupported audio sample entry version');
  const sinf = one(boxes(output, entry.body + 28, entry.end), 'sinf');
  const protection = boxes(output, sinf.body, sinf.end);
  const frma = one(protection, 'frma'); enough(frma, frma.body, 4);
  const format = output.toString('ascii', frma.body, frma.body + 4);
  if (!['mp4a', 'fLaC'].includes(format)) throw new DecodeError('unsupported audio sample entry');
  let flacMetadata;
  if (format === 'fLaC') {
    // ISO FLAC mapping: dfLa is a FullBox followed by native metadata blocks,
    // without the fLaC signature. Frames remain one per MP4 sample.
    const config = one(boxes(output, entry.body + 28, entry.end), 'dfLa');
    enough(config, config.body, 8);
    if (output.readUInt32BE(config.body) !== 0) throw new DecodeError('unsupported FLAC configuration');
    flacMetadata = output.subarray(config.body + 4, config.end);
    let pos = 0, blocks = 0, last = false;
    while (pos < flacMetadata.length) {
      if (last || pos + 4 > flacMetadata.length) throw new DecodeError('invalid FLAC metadata');
      const type = flacMetadata[pos] & 0x7f;
      const size = flacMetadata.readUIntBE(pos + 1, 3);
      if ((!blocks && (type !== 0 || size !== 34)) || (blocks && type === 0) || type === 127) throw new DecodeError('invalid FLAC metadata');
      last = (flacMetadata[pos] & 0x80) !== 0;
      pos += 4 + size;
      if (pos > flacMetadata.length) throw new DecodeError('truncated FLAC metadata');
      blocks++;
    }
    if (!blocks || !last) throw new DecodeError('incomplete FLAC metadata');
  }
  const schm = one(protection, 'schm'); enough(schm, schm.body, 8);
  if (output.toString('ascii', schm.body + 4, schm.body + 8) !== 'cenc') throw new DecodeError('only CENC CTR supported');
  const schi = one(protection, 'schi');
  const tenc = one(boxes(output, schi.body, schi.end), 'tenc'); enough(tenc, tenc.body, 24);
  const ivSize = output[tenc.body + 7];
  if (output[tenc.body] !== 0 || output[tenc.body + 6] !== 1 || ![8, 16].includes(ivSize)) throw new DecodeError('unsupported CENC defaults');
  const senc = one(tables, 'senc'); enough(senc, senc.body, 8);
  const flags = output.readUIntBE(senc.body + 1, 3);
  if (output[senc.body] !== 0 || (flags & ~2) !== 0 || output.readUInt32BE(senc.body + 4) !== count) throw new DecodeError('unsupported CENC sample table');
  let p = senc.body + 8, offset = mdat.body;
  for (const size of sizes) {
    enough(senc, p, ivSize);
    const iv = Buffer.alloc(16); output.copy(iv, 0, p, p + ivSize); p += ivSize;
    const cipher = createDecipheriv('aes-128-ctr', key, iv);
    const end = offset + size;
    if (flags & 2) {
      enough(senc, p, 2); const subs = output.readUInt16BE(p); p += 2;
      enough(senc, p, subs * 6);
      if (!subs) {
        cipher.update(output.subarray(offset, end)).copy(output, offset);
        offset = end;
      }
      for (let i = 0; i < subs; i++) {
        const clear = output.readUInt16BE(p), encrypted = output.readUInt32BE(p + 2); p += 6;
        if (offset + clear + encrypted > end) throw new DecodeError('invalid CENC subsample sizes');
        offset += clear;
        cipher.update(output.subarray(offset, offset + encrypted)).copy(output, offset);
        offset += encrypted;
      }
      if (offset !== end) throw new DecodeError('incomplete CENC subsample coverage');
    } else cipher.update(output.subarray(offset, end)).copy(output, offset);
    cipher.final(); offset = end;
  }
  if (p !== senc.end || offset !== mdat.end) throw new DecodeError('trailing CENC sample data');
  if (format === 'fLaC') {
    // The shared player reads native FLAC. Rewrap metadata and decrypted frames
    // without transcoding, changing samples, or extending the granted resource.
    return Buffer.concat([Buffer.from('fLaC'), flacMetadata, output.subarray(mdat.body, mdat.end)]);
  }
  // Preserve box lengths and chunk offsets while removing encryption markers.
  output.write('mp4a', entry.pos + 4, 4, 'ascii');
  output.write('free', sinf.pos + 4, 4, 'ascii');
  for (const box of tables) if (['senc', 'saio', 'saiz'].includes(box.type)) output.write('free', box.pos + 4, 4, 'ascii');
  return output;
}

exports.resourceKey = resourceKey;
exports.decodeWithKey = decodeWithKey;

if (process.argv.includes('--decode')) {
  try {
    const req = JSON.parse(fs.readFileSync(0, 'utf8'));
    fs.writeSync(1, decodeWithKey(Buffer.from(req.audio, 'base64'), resourceKey(req.auth)));
  } catch (error) {
    // DecodeError messages are our fixed diagnostics, never upstream contents.
    fs.writeSync(2, JSON.stringify({error: error instanceof DecodeError ? error.message : 'unexpected decoder error'}));
    process.exitCode = 1;
  }
}
