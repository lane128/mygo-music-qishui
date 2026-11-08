import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DARWIN_AMD64_FILES, DARWIN_FILES, WINDOWS_FILES, checkDigest, checkWindowsPE, inspectWindowsAudio, inspectDarwinAudio, packageTarget, darwinAssets } from '../../scripts/runtime-assets.mjs'
import { extractSelected, prepareWindows } from '../../scripts/prepare-windows.mjs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

// FFmpeg is reference tooling, not a runtime asset: manifests must not require
// its executable, licenses or corresponding source from package inputs.
test('runtime asset manifests omit bundled FFmpeg binaries, source and licenses', () => {
  assert.deepEqual(Object.keys(WINDOWS_FILES).sort(), ['bdms.node', 'metasecml.dll'])
  assert.deepEqual(darwinAssets('arm64'), { files: DARWIN_FILES })
  assert.deepEqual(darwinAssets('amd64'), { files: DARWIN_AMD64_FILES })
  for (const name of Object.keys(WINDOWS_FILES)) assert.doesNotMatch(name, /ffmpeg|FFMPEG|MINGW|ZIG|CRT/)
  for (const assets of [darwinAssets('arm64'), darwinAssets('amd64')]) {
    assert.equal(Object.hasOwn(assets, 'ffmpeg'), false)
    for (const name of Object.keys(assets.files)) assert.doesNotMatch(name, /ffmpeg/i)
  }
})

// A 32-bit or wrong-platform binary must never enter an amd64 plugin ZIP.
test('Windows package validation accepts supported hosts and enforces each PE architecture', () => {
  assert.equal(packageTarget('windows-amd64').arch, 'amd64')
  assert.equal(packageTarget('win32-x64').platform, 'windows')
  for (const target of ['windows-arm64', 'win32-arm64']) assert.deepEqual(packageTarget(target), { platform: 'windows', arch: 'arm64', windows: true })
  for (const target of ['windows-386', 'win32-ia32', 'linux-amd64', 'linux-arm64']) assert.throws(() => packageTarget(target))
  const pe = Buffer.alloc(256)
  pe.write('MZ'); pe.writeUInt32LE(128, 0x3c); pe.write('PE\0\0', 128); pe.writeUInt16LE(0x8664, 132); pe.writeUInt16LE(0x20b, 152)
  assert.doesNotThrow(() => checkWindowsPE(pe, 'fixture.exe'))
  for (const machine of [0x14c, 0xaa64]) {
    pe.writeUInt16LE(machine, 132)
    assert.throws(() => checkWindowsPE(pe, 'fixture.exe'), /x64/)
  }
  pe.writeUInt16LE(0xaa64, 132)
  assert.doesNotThrow(() => checkWindowsPE(pe, 'arm64.exe', 'arm64'))
  pe.writeUInt16LE(0x8664, 132)
  assert.throws(() => checkWindowsPE(pe, 'arm64.exe', 'arm64'), /arm64/)
  assert.throws(() => checkWindowsPE(pe, 'unknown.exe', 'other'))
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

test('macOS Intel target uses amd64 host naming and rejects cross-architecture audio', () => {
  for (const target of ['darwin-amd64', 'darwin-x64']) assert.deepEqual(packageTarget(target), { platform: 'darwin', arch: 'amd64', windows: false })
  const executable = Buffer.alloc(56)
  executable.writeUInt32LE(0xfeedfacf, 0); executable.writeUInt32LE(0x01000007, 4); executable.writeUInt32LE(2, 12)
  executable.writeUInt32LE(1, 16); executable.writeUInt32LE(24, 20)
  executable.writeUInt32LE(0x32, 32); executable.writeUInt32LE(24, 36); executable.writeUInt32LE(1, 40); executable.writeUInt32LE(0x000c0000, 44)
  assert.equal(inspectDarwinAudio(executable, 'amd64').minimumMacOS, 0x000c0000)
  assert.throws(() => inspectDarwinAudio(executable), /arm64/)
  executable.writeUInt32LE(0x0100000c, 4)
  assert.throws(() => inspectDarwinAudio(executable, 'amd64'), /amd64/)
  assert.throws(() => inspectDarwinAudio(executable, 'other'), /executable/)
})

test('macOS audio guard rejects newer OS requirements and wrong architecture', () => {
  const executable = Buffer.alloc(56)
  executable.writeUInt32LE(0xfeedfacf, 0); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12)
  executable.writeUInt32LE(1, 16); executable.writeUInt32LE(24, 20)
  executable.writeUInt32LE(0x32, 32); executable.writeUInt32LE(24, 36); executable.writeUInt32LE(1, 40); executable.writeUInt32LE(0x000c0000, 44)
  assert.equal(inspectDarwinAudio(executable).minimumMacOS, 0x000c0000)
  executable.writeUInt32LE(0x001b0000, 44)
  assert.throws(() => inspectDarwinAudio(executable), /macOS 12/)
  executable.writeUInt32LE(0x000c0000, 44); executable.writeUInt32LE(0x01000007, 4)
  assert.throws(() => inspectDarwinAudio(executable), /arm64/)
  executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(0xffffffff, 36)
  assert.throws(() => inspectDarwinAudio(executable), /command/)
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
    await assert.rejects(prepareWindows(path.join(directory, 'fresh'), { fetcher: async () => new Response('changed archive') }), /checksum/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
