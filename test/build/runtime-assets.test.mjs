import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkDigest, checkWindowsPE, inspectWindowsAudio, packageTarget } from '../../scripts/runtime-assets.mjs'
import { extractSelected, prepareWindows } from '../../scripts/prepare-windows.mjs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

// A 32-bit or wrong-platform binary must never enter an amd64 plugin ZIP.
test('Windows package validation rejects x32/ARM targets and wrong PE architectures', () => {
  assert.equal(packageTarget('windows-amd64').arch, 'amd64')
  assert.equal(packageTarget('win32-x64').platform, 'windows')
  for (const target of ['windows-386', 'win32-ia32', 'windows-arm64', 'linux-amd64']) assert.throws(() => packageTarget(target))
  const pe = Buffer.alloc(256)
  pe.write('MZ'); pe.writeUInt32LE(128, 0x3c); pe.write('PE\0\0', 128); pe.writeUInt16LE(0x8664, 132); pe.writeUInt16LE(0x20b, 152)
  assert.doesNotThrow(() => checkWindowsPE(pe, 'fixture.exe'))
  for (const machine of [0x14c, 0xaa64]) {
    pe.writeUInt16LE(machine, 132)
    assert.throws(() => checkWindowsPE(pe, 'fixture.exe'), /x64/)
  }
  assert.throws(() => checkWindowsPE(Buffer.from('not PE'), 'bad.exe'))
  pe.writeUInt32LE(0xffffffff, 0x3c)
  assert.throws(() => checkWindowsPE(pe, 'bad.exe'))
})

test('Windows preparation and validation CLI still execute through a directory alias', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qishui-cli-alias-'))
  try {
    const alias = path.join(directory, 'plugin alias')
    await symlink(fileURLToPath(new URL('../..', import.meta.url)), alias, process.platform === 'win32' ? 'junction' : 'dir')
    for (const [script, args, expected] of [
      ['prepare-windows.mjs', [], /Provide a new empty absolute output directory/],
      ['verify-windows.mjs', ['--check', path.join(directory, 'missing')], /ENOENT/],
    ]) {
      const result = spawnSync(process.execPath, [path.join(alias, 'scripts', script), ...args], { encoding: 'utf8', timeout: 10000 })
      assert.ifError(result.error)
      assert.notEqual(result.status, 0, 'CLI must validate its input rather than silently skip execution')
      assert.match(result.stderr, expected)
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('actual audio PE guard rejects removed hardening and injected external DLL dependencies', { skip: !process.env.QISHUI_TEST_FFMPEG_PE }, async () => {
  const original = await readFile(process.env.QISHUI_TEST_FFMPEG_PE)
  const inspected = inspectWindowsAudio(original)
  assert.ok(inspected.imports.includes('kernel32.dll'))
  const offset = original.readUInt32LE(0x3c) + 24
  const unsafe = Buffer.from(original)
  unsafe.writeUInt16LE(unsafe.readUInt16LE(offset + 70) & ~0x40, offset + 70)
  assert.throws(() => inspectWindowsAudio(unsafe), /ASLR/)
  const external = Buffer.from(original), name = external.indexOf(Buffer.from('KERNEL32.dll\0'))
  assert.ok(name >= 0)
  external.write('external.dll', name, 'ascii')
  assert.throws(() => inspectWindowsAudio(external), /dependency/)
  const relocation = Buffer.from(original)
  relocation.writeUInt32LE(0, offset + 112 + 5 * 8 + 4)
  assert.throws(() => inspectWindowsAudio(relocation), /relocation/)
})

// Authenticate archives before parsing, so even malformed ZIP64/TAR input does
// not reach a decompressor when its pinned distribution hash does not match.
test('runtime downloads fail closed on changed archives and refuse existing output', async () => {
  assert.throws(() => checkDigest(Buffer.from('modified'), '0'.repeat(64), 'fixture'), /checksum/)
  assert.throws(() => extractSelected(Buffer.from('malformed ZIP'), { sha256: '0'.repeat(64), type: 'zip', files: {} }), /checksum/)
  const directory = await mkdtemp(path.join(tmpdir(), 'qishui-prepare-test-'))
  try {
    await mkdir(path.join(directory, 'existing'))
    await writeFile(path.join(directory, 'existing/keep.txt'), 'keep')
    await assert.rejects(prepareWindows(path.join(directory, 'existing'), { fetcher: () => { throw Error('must not fetch') } }), /empty/)
    assert.equal(await readFile(path.join(directory, 'existing/keep.txt'), 'utf8'), 'keep')
    await assert.rejects(prepareWindows(path.join(directory, 'fresh'), { ffmpegDirectory: directory, fetcher: async () => new Response('changed archive') }), /checksum/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
