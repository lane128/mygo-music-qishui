// Development-only AAC fixtures from stereo sine waves; use a new empty output directory.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
const output = process.argv[2]
if (process.platform !== 'darwin' || !output || !path.isAbsolute(output)) throw new Error('Use macOS: build-audio-fixtures.mjs <new absolute directory>')
await mkdir(output, { recursive: true })
if ((await readdir(output)).length) throw new Error('Fixture output directory must be empty')
const frames = 44100, wave = Buffer.alloc(44 + frames * 4)
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8)
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22)
wave.writeUInt32LE(44100, 24); wave.writeUInt32LE(176400, 28); wave.writeUInt16LE(4, 32)
wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(frames * 4, 40)
for (let i = 0; i < frames; i++) {
  wave.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 44100) * 10000), 44 + i * 4)
  wave.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 660 / 44100) * 8000), 46 + i * 4)
}
const source = path.join(output, 'source.wav')
await writeFile(source, wave, { flag: 'wx' })
for (const [profile, codec, bitrate] of [['lc', 'aac', 128000], ['he', 'aach', 48000], ['hev2', 'aacp', 32000]]) {
  for (const [extension, format] of [['m4a', 'm4af'], ['aac', 'adts']]) {
    if (profile === 'lc' && extension === 'm4a') continue // Keep the existing AAC-LC regression fixture.
    const result = spawnSync('/usr/bin/afconvert', ['-f', format, '-d', codec, '-b', String(bitrate), source, path.join(output, `aac-${profile}.${extension}`)], { stdio: 'inherit', timeout: 20000 })
    if (result.error || result.status !== 0) throw new Error('Synthetic AAC fixture encoding failed')
  }
}
await rm(source)
console.log(output)
