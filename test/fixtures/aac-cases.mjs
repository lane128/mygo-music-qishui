import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
export const aacCases = [
  { name: 'aac-lc.m4a', rate: 48000, channels: 1, minimumFrames: 4000, maximumFrames: 7000 },
  ...['lc', 'he', 'hev2'].flatMap(profile => (profile === 'lc' ? ['aac'] : ['m4a', 'aac']).map(extension => ({
    name: `aac-${profile}.${extension}`, rate: 44100, channels: 2, minimumFrames: 44100, maximumFrames: 53000,
  }))),
]
export function referencePCM(ffmpeg, file) {
  const result = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'info', '-xerror', '-i', file, '-map', '0:a:0', '-c:a', 'pcm_s32le', '-f', 's32le', 'pipe:1'], {
    windowsHide: true, shell: false, timeout: 10000, maxBuffer: 2 * 1024 * 1024,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, 'reference PCM decode failed')
  return { bytes: result.stdout, description: result.stderr.toString() }
}
export function comparePCM(reference, actual, fixture) {
  assert.match(reference.description, new RegExp(`Audio: aac[^\\n]*${fixture.rate} Hz, ${fixture.channels === 1 ? 'mono' : 'stereo'}`))
  const frames = reference.bytes.length / (fixture.channels * 4)
  assert.ok(frames >= fixture.minimumFrames && frames <= fixture.maximumFrames, 'wrong decoded AAC duration')
  assert.equal(actual.bytes.length, reference.bytes.length, 'conversion changed sample count')
  assert.match(actual.description, /Audio: flac[^\n]*s32 \(24 bit\)/)
  let maximumDifference = 0, nonzero = false
  for (let i = 0; i < actual.bytes.length; i += 4) {
    maximumDifference = Math.max(maximumDifference, Math.abs(actual.bytes.readInt32LE(i) - reference.bytes.readInt32LE(i)))
    nonzero ||= actual.bytes.readInt32LE(i) !== 0
  }
  assert.equal(nonzero, true)
  assert.ok(maximumDifference <= 256, 'conversion lost more than one 24-bit quantization step')
  return { frames, maximumDifference }
}
