// These checks require a real Windows x64 runtime and the validation package.
// No account, network service or installed Node/FFmpeg is required.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertAAC } from '../helper/native.mjs'
import { aacCases, comparePCM, referencePCM } from './fixtures/aac-cases.mjs'
const enabled = process.platform === 'win32' && process.arch === 'x64' && process.env.QISHUI_TEST_WINDOWS === '1'
const ffmpeg = fileURLToPath(new URL('../runtime/native/ffmpeg.exe', import.meta.url))

test('Windows AppContainer preserves AAC-LC, HE-AAC and HE-AACv2 sample count and 24-bit PCM in M4A/ADTS', { skip: !enabled }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'qishui-win-conversion-test-'))
  try {
    for (const fixture of aacCases) await t.test(fixture.name, async () => {
      const source = fileURLToPath(new URL('./fixtures/' + fixture.name, import.meta.url))
      const converted = await convertAAC(await readFile(source)), output = path.join(root, fixture.name + '.flac')
      await writeFile(output, converted)
      comparePCM(referencePCM(ffmpeg, source), referencePCM(ffmpeg, output), fixture)
    })
    await assert.rejects(convertAAC(Buffer.from('invalid AAC')), cause => cause.kind === 'unavailable')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }) }
})
