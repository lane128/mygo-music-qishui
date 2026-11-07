// Build-time Node only. The resulting executable has no Node/JS runtime.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, link, lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
export const napiExports = Object.freeze(['add_finalizer', 'close_handle_scope', 'create_error', 'create_function', 'create_object', 'create_reference', 'create_string_utf8', 'create_type_error', 'define_properties', 'delete_reference', 'fatal_error', 'get_and_clear_last_exception', 'get_cb_info', 'get_last_error_info', 'get_named_property', 'get_property', 'get_reference_value', 'get_undefined', 'get_value_string_utf8', 'has_property', 'is_exception_pending', 'open_handle_scope', 'set_property', 'throw', 'typeof'].map(n => 'napi_' + n).sort())
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
async function command(file, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    const chunks = []; let bytes = 0
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { bytes += data.length; if (bytes <= 1048576) chunks.push(data); else child.kill() })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error(`Signer build tool failed (${path.basename(file)}, exit ${code}): ${Buffer.concat(chunks).toString().slice(0, 4000)}`)))
  })
}

// Inspect PE independently of the cross compiler and without executing it.
export function inspectWindows(bytes) {
  assert.equal(bytes.toString('ascii', 0, 2), 'MZ')
  const pe = bytes.readUInt32LE(0x3c)
  assert.equal(bytes.toString('ascii', pe, pe + 4), 'PE\0\0')
  assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, 'Windows AMD64 required')
  const optional = pe + 24
  assert.equal(bytes.readUInt16LE(optional), 0x20b, 'PE32+ required')
  assert.equal(bytes.readUInt16LE(pe + 22) & 1, 0, 'Relocations stripped')
  const flags = bytes.readUInt16LE(optional + 70)
  assert.equal(flags & 0x160, 0x160, 'ASLR, high entropy ASLR and DEP required')
  const sections = [], count = bytes.readUInt16LE(pe + 6)
  for (let i = 0; i < count; i++) {
    const at = optional + bytes.readUInt16LE(pe + 20) + i * 40
    sections.push({ name: bytes.toString('ascii', at, at + 8).replace(/\0.*$/, ''), virtualSize: bytes.readUInt32LE(at + 8), rva: bytes.readUInt32LE(at + 12), size: bytes.readUInt32LE(at + 16), offset: bytes.readUInt32LE(at + 20) })
  }
  function offset(rva) { const s = sections.find(s => rva >= s.rva && rva < s.rva + Math.max(s.virtualSize, s.size)); assert.ok(s, 'Unmapped PE address'); const at = s.offset + rva - s.rva; assert.ok(at < bytes.length); return at }
  function cstr(at) { const end = bytes.indexOf(0, at); assert.ok(end >= at && end - at < 4096); return bytes.toString('ascii', at, end) }
  const directory = i => [bytes.readUInt32LE(optional + 112 + i * 8), bytes.readUInt32LE(optional + 116 + i * 8)]
  const [exportRva] = directory(0); assert.ok(exportRva)
  const exp = offset(exportRva), names = offset(bytes.readUInt32LE(exp + 32)), exports = []
  for (let i = 0; i < bytes.readUInt32LE(exp + 24); i++) exports.push(cstr(offset(bytes.readUInt32LE(names + 4 * i))))
  assert.deepEqual(exports.sort(), napiExports)
  const imports = [], [importRva] = directory(1)
  if (importRva) for (let at = offset(importRva); bytes.readUInt32LE(at + 12); at += 20) imports.push(cstr(offset(bytes.readUInt32LE(at + 12))))
  assert.ok(imports.length)
  for (const dll of imports) assert.match(dll, /^(kernel32|msvcrt|ucrtbase|api-ms-win-crt-[a-z0-9-]+)\.dll$/i, 'Non-system runtime dependency')
  const [relocRva, relocSize] = directory(5)
  assert.ok(relocRva && relocSize && sections.some(s => s.name === '.reloc'), 'Relocation directory required')
  return { napiExports: exports.length, imports: imports.sort(), aslr: true, dep: true, relocations: true }
}

/** Build a fresh executable. Its parent directory must already exist.
 * SDK files are NOT copied/changed: packaging puts bdms.node + platform library
 * alongside output. zig is required for Windows and must report exactly 0.15.2.
 * Compilation happens in a temporary sibling; hard-link installation refuses
 * overwrite atomically (including existing symlinks). No commit or publication.
 */
export async function buildSigner({ platform, arch, output, zig } = {}) {
  assert.ok((platform === 'darwin' && arch === 'arm64') || (platform === 'windows' && arch === 'amd64'), 'Unsupported signer target')
  assert.ok(typeof output === 'string' && path.isAbsolute(output), 'Absolute output file required')
  if (zig !== undefined) assert.ok(typeof zig === 'string' && path.isAbsolute(zig), 'Absolute Zig path required')
  try { await lstat(output); throw new Error('Signer output already exists') } catch (e) { if (e.code !== 'ENOENT') throw e }
  for (const directory of ['include', 'licenses']) {
    const provenance = JSON.parse(await readFile(path.join(root, directory, 'provenance.json'), 'utf8'))
    for (const [name, info] of Object.entries(provenance)) assert.equal(sha256(await readFile(path.join(root, directory, name))), info.sha256, `Pinned header/license changed: ${name}`)
  }
  if (platform === 'darwin') assert.equal(process.platform, 'darwin', 'Darwin build requires macOS clang++')
  else { assert.ok(zig, 'Windows build requires Zig 0.15.2'); assert.equal((await command(zig, ['version'])).trim(), '0.15.2', 'Zig 0.15.2 required') }
  const scratch = await mkdtemp(path.join(path.dirname(output), '.signer-build-'))
  const temporary = path.join(scratch, platform === 'windows' ? 'signer.exe' : 'signer')
  try {
    const common = ['-std=c++17', '-Os', '-fvisibility=hidden', '-fstack-protector-strong', '-I', path.join(root, 'include'), path.join(root, 'signer.cpp'), '-o', temporary]
    let checks
    if (platform === 'darwin') {
      await command('/usr/bin/clang++', ['-arch', 'arm64', '-mmacosx-version-min=12.0', ...common, '-Wl,-export_dynamic', ...napiExports.map(n => '-Wl,-exported_symbol,_' + n)])
      await command('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'qishui-native-signer', temporary])
      await command('/usr/bin/codesign', ['--verify', '--strict', temporary])
      const symbols = (await command('/usr/bin/nm', ['-gjU', temporary])).trim().split('\n').filter(n => n.startsWith('_napi_')).map(n => n.slice(1)).sort()
      assert.deepEqual(symbols, napiExports)
      const libraries = await command('/usr/bin/otool', ['-L', temporary])
      assert.ok(!/Foundation|libnode|libobjc/i.test(libraries), 'Unexpected signer dependency')
      for (const line of libraries.trim().split('\n').slice(1)) assert.match(line.trim(), /^\/usr\/lib\//, 'Non-system dylib dependency')
      checks = { napiExports: symbols.length, strictAdHocSignature: true, systemLibrariesOnly: true }
    } else {
      await command(zig, ['c++', '-target', 'x86_64-windows-gnu', ...common, '-static', '-Wl,--dynamicbase,--high-entropy-va,--nxcompat'])
      checks = inspectWindows(await readFile(temporary))
    }
    await chmod(temporary, 0o755)
    const bytes = await readFile(temporary)
    await link(temporary, output) // Atomic no-overwrite publish to the caller's local build path.
    return { output, platform, arch, bytes: bytes.length, sha256: sha256(bytes), ...checks }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
