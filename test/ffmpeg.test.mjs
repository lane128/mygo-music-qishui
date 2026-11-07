// Same codec configuration is exercised natively on macOS, or with the real
// shipped executable on Windows. Native runs do not establish AppContainer support.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aacConversionArgs } from '../helper/ffmpeg-args.mjs'
import { aacCases, comparePCM, referencePCM } from './fixtures/aac-cases.mjs'
const ffmpeg = process.env.QISHUI_TEST_FFMPEG || (process.platform === 'win32' && process.env.QISHUI_TEST_WINDOWS === '1'
  ? fileURLToPath(new URL('../runtime/native/ffmpeg.exe', import.meta.url)) : null)
function run(args) {
  return spawnSync(ffmpeg, args, { windowsHide: true, shell: false, encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 })
}

test('audio-only FFmpeg exposes no network, video decoder or lossy encoder', { skip: !ffmpeg }, async () => {
  const protocols = run(['-hide_banner', '-protocols'])
  assert.equal(protocols.status, 0)
  assert.deepEqual(protocols.stdout.split('\n').map(line => line.trim()).filter(line => line && !/^(Supported|Input:|Output:)/.test(line)), ['file', 'pipe', 'file', 'pipe'])
  const decoders = run(['-hide_banner', '-decoders']), encoders = run(['-hide_banner', '-encoders'])
  assert.equal(decoders.status, 0); assert.equal(encoders.status, 0)
  assert.doesNotMatch(decoders.stdout, /^ V\S*\s+\w+/m)
  const names = encoders.stdout.split('\n').map(line => /^ A\S*\s+(\w+)/.exec(line)?.[1]).filter(Boolean)
  assert.deepEqual(names.sort(), ['flac', 'pcm_s32le'])
  const root = await mkdtemp(path.join(tmpdir(), 'qishui-ffmpeg-denied-'))
  try {
    const network = run(['-nostdin', '-hide_banner', '-i', 'https://127.0.0.1:1/unavailable', '-f', 'flac', path.join(root, 'out.flac')])
    assert.notEqual(network.status, 0)
    assert.match(network.stderr, /Protocol not found/)
    const bad = path.join(root, 'bad.m4a')
    await writeFile(bad, 'invalid AAC')
    assert.notEqual(run(aacConversionArgs(bad, path.join(root, 'bad.flac'))).status, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const fixture of aacCases) test('audio-only FFmpeg preserves sample count and 24-bit PCM: ' + fixture.name, { skip: !ffmpeg }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qishui-ffmpeg-precision-'))
  try {
    const source = fileURLToPath(new URL('./fixtures/' + fixture.name, import.meta.url)), output = path.join(root, 'converted.flac')
    const result = run(aacConversionArgs(source, output))
    assert.ifError(result.error); assert.equal(result.status, 0, 'audio-only conversion failed')
    const measured = comparePCM(referencePCM(ffmpeg, source), referencePCM(ffmpeg, output), fixture)
    assert.ok(measured.frames > 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
