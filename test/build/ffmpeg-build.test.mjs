import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildFFmpeg } from '../../scripts/build-ffmpeg.mjs'

test('FFmpeg builder rejects changed source before extraction or touching existing output', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qishui-ffmpeg-input-test-'))
  try {
    const archive = path.join(root, 'source.tar.gz'), keep = path.join(root, 'keep')
    await writeFile(archive, 'changed source')
    await writeFile(keep, 'existing content')
    await assert.rejects(buildFFmpeg(root, { sourceArchive: archive, toolchainArchive: archive }), /checksum/)
    assert.equal(await readFile(keep, 'utf8'), 'existing content')
    await assert.rejects(readFile(path.join(root, 'ffmpeg.exe')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
