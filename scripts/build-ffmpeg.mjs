// Build-only: macOS arm64 -> Windows x64, with a native codec-check build option.
// No global installation, network access, or changes to supplied archives.
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { checkDigest, inspectWindowsAudio, sha256 } from './runtime-assets.mjs'
import { FFMPEG_SOURCE, FFMPEG_SOURCE_BUNDLE, ZIG_TOOLCHAIN, FFMPEG_FLAGS } from './ffmpeg-config.mjs'

export async function buildFFmpeg(output, { sourceArchive, toolchainArchive, native = false } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The pinned build toolchain requires macOS arm64')
  if (!output || !path.isAbsolute(output) || !sourceArchive || (!native && !toolchainArchive)) throw new Error('Usage: build-ffmpeg.mjs <new absolute output> <source.tar.gz> <zig.tar.xz> [--native]')
  const source = await readFile(sourceArchive)
  const bundled = sha256(source) === FFMPEG_SOURCE_BUNDLE.sha256
  if (!bundled) checkDigest(source, FFMPEG_SOURCE.sha256, 'FFmpeg source archive')
  const compiler = native ? null : await readFile(toolchainArchive)
  if (compiler) checkDigest(compiler, ZIG_TOOLCHAIN.sha256, 'Zig compiler archive')
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw new Error('FFmpeg output directory must be empty')
  const work = await mkdtemp(path.join(tmpdir(), 'qishui-ffmpeg-build-'))
  function command(exe, args, { cwd = work, env = process.env, input, capture = false, timeout = 120000 } = {}) {
    const result = spawnSync(exe, args, { cwd, env, input, stdio: capture ? undefined : 'inherit', timeout, maxBuffer: 256 * 1024 * 1024 })
    if (result.error || result.status !== 0) throw new Error('FFmpeg build command failed: ' + exe + (result.error ? ' (' + result.error.code + ')' : ''))
    return result.stdout
  }
  try {
    const extracted = path.join(work, 'source'), tools = path.join(work, 'tools'), build = path.join(work, 'build'), wrappers = path.join(work, 'bin')
    for (const directory of [extracted, tools, build, wrappers]) await mkdir(directory)
    // Both archives are fixed and authenticated before invoking the archive tool.
    command('/usr/bin/tar', ['-xf', path.resolve(sourceArchive), '-C', extracted])
    const tree = path.join(extracted, 'FFmpeg-' + FFMPEG_SOURCE.commit)
    // The GitHub tag archive omits release-generated VERSION; no codec source is changed.
    await writeFile(path.join(tree, 'VERSION'), FFMPEG_SOURCE.version + '\n')
    const env = { ...process.env, LC_ALL: 'C', TZ: 'UTC', SOURCE_DATE_EPOCH: '1781663823',
      PATH: wrappers + path.delimiter + process.env.PATH, QISHUI_FFMPEG_WORK: work }
    let targetFlags, zigRoot
    if (native) {
      targetFlags = ['--disable-debug', '--cc=clang', '--extra-ldflags=-Wl,-dead_strip']
    } else {
      command('/usr/bin/tar', ['-xf', path.resolve(toolchainArchive), '-C', tools])
      zigRoot = path.join(tools, 'zig-' + ZIG_TOOLCHAIN.host + '-' + ZIG_TOOLCHAIN.version)
      env.QISHUI_ZIG = path.join(zigRoot, 'zig')
      env.ZIG_LOCAL_CACHE_DIR = path.join(work, 'zig-local-cache')
      env.ZIG_GLOBAL_CACHE_DIR = path.join(work, 'zig-global-cache')
      for (const [name, body] of Object.entries({
        'qishui-cc': 'exec "$QISHUI_ZIG" cc -target x86_64-windows-gnu -ffile-prefix-map="$QISHUI_FFMPEG_WORK=/build" "$@"',
        'qishui-ar': 'exec "$QISHUI_ZIG" ar "$@"',
        'qishui-ranlib': 'exec "$QISHUI_ZIG" ranlib "$@"',
      })) await writeFile(path.join(wrappers, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 })
      // -g0 emits no debug data while avoiding FFmpeg's GNU ld-only -pie workaround.
      // Zig already retains PE relocations for ASLR; verify PE hardening on the result.
      targetFlags = ['--enable-debug=0', '--enable-cross-compile', '--target-os=mingw32', '--arch=x86_64', '--cc=qishui-cc', '--ar=qishui-ar', '--ranlib=qishui-ranlib', '--windres=false', '--extra-ldflags=-s']
      await cp(path.join(zigRoot, 'lib/libc/mingw/COPYING'), path.join(output, 'MINGW-LICENSE'))
      await cp(path.join(zigRoot, 'LICENSE'), path.join(output, 'ZIG-LICENSE'))
    }
    const flags = [...FFMPEG_FLAGS, ...targetFlags]
    command('/bin/sh', [path.join(tree, 'configure'), ...flags], { cwd: build, env })
    command('/usr/bin/make', ['-j8', native ? 'ffmpeg' : 'ffmpeg.exe'], { cwd: build, env, timeout: 600000 })
    const executable = native ? 'ffmpeg' : 'ffmpeg.exe'
    await cp(path.join(build, executable), path.join(output, executable))
    const binary = await readFile(path.join(output, executable))
    if (!native) inspectWindowsAudio(binary)
    await cp(path.join(tree, 'COPYING.GPLv3'), path.join(output, 'FFMPEG-LICENSE'))
    // Ship the full unmodified corresponding source, compressed without timestamps.
    const sourceTar = bundled ? command('xz', ['-dc', path.resolve(sourceArchive)], { capture: true }) : gunzipSync(source, { maxOutputLength: 256 * 1024 * 1024 })
    checkDigest(sourceTar, FFMPEG_SOURCE_BUNDLE.tarSha256, 'FFmpeg source TAR')
    const compressed = command('xz', ['-9', '--threads=1', '--check=crc64', '-c'], { input: sourceTar, capture: true })
    await writeFile(path.join(output, 'FFMPEG-SOURCE.tar.xz'), compressed)
    let crtSourceBundleSha256
    if (!native) {
      // Preserve per-file CRT copyright/license notices, not just the umbrella ZPL.
      const files = ['LICENSE', 'lib/compiler_rt.zig']
      async function collect(relative) {
        for (const entry of (await readdir(path.join(zigRoot, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
          const name = relative + '/' + entry.name
          if (entry.isDirectory()) await collect(name)
          else if (entry.isFile()) files.push(name)
          else throw new Error('Unexpected CRT source file type')
        }
      }
      for (const relative of ['lib/libc/mingw', 'lib/libc/include/any-windows-any', 'lib/compiler_rt']) await collect(relative)
      const list = path.join(work, 'crt-files.txt')
      await writeFile(list, files.sort().join('\n') + '\n')
      const tar = command('/usr/bin/tar', ['--format=ustar', '--uid=0', '--gid=0', '--uname=root', '--gname=root', '--no-xattrs', '--no-acls', '--no-mac-metadata', '-cf', '-', '-C', zigRoot, '-T', list], { capture: true })
      const crt = command('xz', ['-9', '--threads=1', '--check=crc64', '-c'], { input: tar, capture: true })
      await writeFile(path.join(output, 'WINDOWS-CRT-SOURCE.tar.xz'), crt)
      crtSourceBundleSha256 = sha256(crt)
    }
    const metadata = { source: FFMPEG_SOURCE, toolchain: native ? { compiler: 'Apple clang', validationOnly: true } : ZIG_TOOLCHAIN,
      target: native ? 'darwin-arm64-validation' : 'windows-amd64', flags,
      generatedSourceFile: { VERSION: FFMPEG_SOURCE.version + '\n' },
      sourceTarSha256: sha256(sourceTar), sourceBundleSha256: sha256(compressed), crtSourceBundleSha256, executableSha256: sha256(binary) }
    await writeFile(path.join(output, 'FFMPEG-BUILD.json'), JSON.stringify(metadata, null, 2) + '\n')
    await writeFile(path.join(output, 'FFMPEG-README.txt'),
      'MyGO Qishui audio-only FFmpeg ' + FFMPEG_SOURCE.version + '\n' +
      'Built from official FFmpeg commit ' + FFMPEG_SOURCE.commit + '.\n' +
      'GPL version 3 or later; see FFMPEG-LICENSE and the complete FFMPEG-SOURCE.tar.xz.\n' +
      'Build recipe: scripts/build-ffmpeg.mjs and scripts/ffmpeg-config.mjs.\n' +
      'Fixed inputs, configuration and output digest: FFMPEG-BUILD.json.\n' +
      'VERSION is generated for release identification; codec source is unchanged.\n' +
      'Only local file/pipe protocols, AAC/FLAC/PCM audio and FLAC/PCM encoding.\n' +
      'No network, video, device support, external codec libraries or lossy encoding.\n' +
      'Windows CRT notices and source: MINGW-LICENSE, ZIG-LICENSE, WINDOWS-CRT-SOURCE.tar.xz.\n')
    return metadata
  } catch (cause) {
    await cp(path.join(work, 'build/ffbuild/config.log'), path.join(output, 'FFMPEG-config-failure.log')).catch(() => {})
    throw cause
  } finally { await rm(work, { recursive: true, force: true }) }
}
const entry = process.argv[1] && await realpath(process.argv[1]).catch(() => null)
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const [output, sourceArchive, toolchainArchive, mode] = process.argv.slice(2)
  if (mode && mode !== '--native') throw new Error('Unknown build mode')
  console.log(JSON.stringify(await buildFFmpeg(output, { sourceArchive, toolchainArchive, native: mode === '--native' }), null, 2))
}
