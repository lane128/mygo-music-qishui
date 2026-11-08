import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPackageLayout, copyPackageSource } from '../../scripts/package-layout.mjs'

// Reject Node executables and accidental test/legacy adapters at the archive boundary.
test('final runtime package guard rejects Node, artwork and validation-only files', () => {
  const runtime = ['plugin.json', 'index.js', 'bin/qishui-helper-windows-amd64.exe', 'runtime/native/qishui-sign.exe', 'runtime/native/bdms.node']
  assert.doesNotThrow(() => checkPackageLayout(runtime))
  for (const unwanted of ['assets/cover.png', 'helper/cover.png', 'test/fixtures/audio.m4a', 'runtime/native/runner.test.exe', 'native/windows-runner/tests/integration_windows_test.go', 'native/worker/server_test.go', 'native/worker/testdata/audio.m4a', 'native/signer/signer.test.cpp', 'native/signer/validate.mjs', 'helper/worker.mjs', 'helper/resource.cjs', 'scripts/verify-windows.cmd', 'scripts/build-audio-fixtures.mjs', 'scripts/release.mjs']) {
    assert.throws(() => checkPackageLayout([...runtime, unwanted]), /artwork|validation-only/)
  }
  for (const unwanted of ['runtime/native/ffmpeg', 'runtime/native/ffmpeg.exe', 'runtime/native/FFMPEG-LICENSE', 'runtime/native/FFMPEG-README.txt', 'runtime/native/FFMPEG-BUILD.json', 'runtime/native/FFMPEG-SOURCE.tar.xz', 'runtime/native/MINGW-LICENSE', 'runtime/native/ZIG-LICENSE', 'runtime/native/WINDOWS-CRT-SOURCE.tar.xz', 'runtime/native/audio-convert']) {
    for (const validation of [false, true]) assert.throws(() => checkPackageLayout([...runtime, unwanted], { validation }), /FFmpeg or converter/)
  }
  assert.doesNotThrow(() => checkPackageLayout([...runtime, 'scripts/build-ffmpeg.mjs', 'scripts/ffmpeg-config.mjs', 'helper/ffmpeg-args.mjs', 'helper/m4a-gapless.mjs'], { validation: true }))
  for (const name of [['bin/node', 'darwin', 'arm64'].join('-'), 'bin/node-windows-amd64.exe', 'runtime/node.exe', 'bin/NODE-BUILD.json']) for (const validation of [false, true]) assert.throws(() => checkPackageLayout([...runtime, name], { validation }), /Node runtime/)
  assert.doesNotThrow(() => checkPackageLayout([...runtime, 'test/native-worker.test.exe', 'scripts/verify-windows.cmd'], { validation: true }))
})

// Runtime source remains rebuildable without shipping its tests or old Node adapters.
test('runtime staging retains native source and validation adds independent tests without changing production files', async () => {
  const stage = await mkdtemp(path.join(tmpdir(), 'qishui-package-layout-'))
  const root = fileURLToPath(new URL('../..', import.meta.url))
  try {
    await copyPackageSource(root, stage)
    for (const name of ['assets', 'test', 'native/windows-runner/tests', 'scripts/release.mjs', 'scripts/verify-windows.cmd', 'helper/worker.mjs', 'helper/resource.cjs', 'scripts/prepare-node.mjs', 'native/signer/validate.mjs', 'native/signer/signer.test.cpp', 'scripts/build-ffmpeg.mjs', 'scripts/ffmpeg-config.mjs', 'helper/ffmpeg-args.mjs', 'helper/m4a-gapless.mjs']) await assert.rejects(access(path.join(stage, name)))
    for (const name of ['index.js', 'helper/catalog-core.mjs', 'helper/m4a.mjs', 'src/plugin.mjs', 'LICENSE', 'NOTICE.md', 'native/worker/go.mod', 'native/signer/signer.cpp', 'native/signer/include/NODE-LICENSE', 'native/windows-runner/main_windows.go', 'native/windows-runner/go.sum', 'scripts/package.mjs', 'scripts/build-native.mjs']) await access(path.join(stage, name))
    const entry = await readFile(path.join(stage, 'index.js')), signer = await readFile(path.join(stage, 'native/signer/signer.cpp'))
    await copyPackageSource(root, stage, { validation: true })
    for (const name of ['test/fixtures/aac-lc.m4a', 'native/windows-runner/tests/integration_windows_test.go', 'scripts/release.mjs', 'RELEASE.md', 'CLAUDE.md', 'scripts/verify-windows.cmd', 'scripts/verify-windows.mjs', 'scripts/build-ffmpeg.mjs', 'scripts/ffmpeg-config.mjs', 'helper/ffmpeg-args.mjs', 'helper/m4a-gapless.mjs', 'native/signer/signer.test.cpp']) await access(path.join(stage, name))
    assert.deepEqual(await readFile(path.join(stage, 'index.js')), entry)
    assert.deepEqual(await readFile(path.join(stage, 'native/signer/signer.cpp')), signer)
    await assert.rejects(access(path.join(stage, 'assets')))
  } finally { await rm(stage, { recursive: true, force: true }) }
})
