// Build-only, fixed upstream distributions. No runtime downloads or user paths.
// FFmpeg is not shipped: keep only the original signer SDK in runtime assets.
// The offline FFmpeg build recipe and audio guards remain reference tooling;
// they are never required by package.mjs or prepare-windows.mjs.
import { createHash } from 'node:crypto'

export const WINDOWS_FILES = {
  'bdms.node': '73017455010b58aabae15b5560f82463f425acf1f4a813d91370abd1f35fac0f',
  'metasecml.dll': '53f322a7731cf64e6187d2fde1bb07558c2ab0a64fa6db0ef7c95d618ea9a226',
}
// Intel SDK from the official x64 update archive; never substitute arm64 assets.
export const DARWIN_AMD64_FILES = {
  'bdms.node': '85b3cfd1964486473b1e82b53c126f9442ec9097261b7bc6a3603073c45eed85',
  'libMetaSecML.dylib': '6752e57ba5bf6d286dac1bce05b4668accf38c5b361dfe799bb59aea8dd577cd',
}
export const DARWIN_AMD64_DOWNLOAD = {
  url: 'https://lf-luna-release.qishui.com/obj/luna-release/3.7.0/452316191/SodaMusic-v3.7.0-official-darwin_x64.tgz',
  sha256: '6da004452e20ba719fac5f393d70f09073d3fa908f536ca0c9877d823bac328b',
}

export function darwinAssets(arch) {
  if (arch === 'arm64') return { files: DARWIN_FILES }
  if (arch === 'amd64') return { files: DARWIN_AMD64_FILES }
  throw new Error('Unsupported macOS architecture: ' + arch)
}
export const DARWIN_FILES = {
  'bdms.node': 'bb8858680af4360d4da706caccfbbc73cfdf3f8cafebcb4f521ca7b782cb4bb2',
  'libMetaSecML.dylib': '078db186b335c8400f5b8bb48762ef8ac36ff055f60576775a4334587bba760c',
}
export const WINDOWS_DOWNLOADS = [
  {
    url: 'https://lf-luna-release.qishui.com/obj/luna-release/3.7.0/452316191/SodaMusic-v3.7.0-official-win32_x64.tgz',
    sha256: '30fe7762ccdb3c978cd51f8ca4696aed5e8cad876d7bfc20b25168d4cd2d40ac',
    type: 'tgz', files: { 'app.asar.unpacked/bdms.node': 'bdms.node', 'app.asar.unpacked/metasecml.dll': 'metasecml.dll' },
  },
]
export const sha256 = data => createHash('sha256').update(data).digest('hex')
export function checkDigest(data, expected, name) {
  if (sha256(data) !== expected) throw new Error('Runtime checksum mismatch: ' + name)
}
export function checkWindowsPE(data, name, arch = 'amd64') {
  const machine = { amd64: 0x8664, arm64: 0xaa64 }[arch]
  if (data.length < 64 || data.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not a Windows executable: ' + name)
  const offset = data.readUInt32LE(0x3c)
  if (!machine || offset > data.length - 26 || data.toString('ascii', offset, offset + 4) !== 'PE\0\0' || data.readUInt16LE(offset + 4) !== machine || data.readUInt16LE(offset + 24) !== 0x20b) throw new Error('Expected Windows ' + (arch === 'amd64' ? 'x64' : arch) + ' executable: ' + name)
}
// The audio build must retain ASLR/DEP and need only DLLs present on Windows 10/11.
export function inspectWindowsAudio(data) {
  checkWindowsPE(data, 'ffmpeg.exe')
  const pe = data.readUInt32LE(0x3c), optional = pe + 24
  const optionalSize = data.readUInt16LE(pe + 20), count = data.readUInt16LE(pe + 6)
  if (optionalSize < 240 || !count || count > 96 || optional + optionalSize + count * 40 > data.length) throw new Error('Invalid audio PE headers')
  const dllCharacteristics = data.readUInt16LE(optional + 70)
  if ((dllCharacteristics & 0x160) !== 0x160) throw new Error('Audio PE must retain ASLR, high-entropy ASLR and DEP')
  const relocationsBytes = data.readUInt32LE(optional + 112 + 5 * 8 + 4)
  if (!data.readUInt32LE(optional + 112 + 5 * 8) || !relocationsBytes) throw new Error('Audio PE must retain relocation data')
  function offset(rva, length) {
    for (let i = 0; i < count; i++) {
      const at = optional + optionalSize + i * 40, start = data.readUInt32LE(at + 12), size = data.readUInt32LE(at + 16), raw = data.readUInt32LE(at + 20)
      if (rva >= start && rva - start + length <= size && raw + rva - start + length <= data.length) return raw + rva - start
    }
    throw new Error('Invalid audio PE directory')
  }
  if (data.readUInt32LE(optional + 112 + 13 * 8)) throw new Error('Unexpected delayed audio DLL imports')
  const rva = data.readUInt32LE(optional + 120), size = data.readUInt32LE(optional + 124), imports = []
  if (!rva || size < 20 || size > 128 * 20) throw new Error('Invalid audio PE imports')
  let terminated = false
  for (let i = 0; i + 20 <= size; i += 20) {
    const at = offset(rva + i, 20)
    if (data.subarray(at, at + 20).every(value => value === 0)) { terminated = true; break }
    const name = offset(data.readUInt32LE(at + 12), 1), end = data.indexOf(0, name)
    if (end < name || end - name > 128) throw new Error('Invalid audio DLL name')
    const library = data.toString('ascii', name, end).toLowerCase()
    if (!['kernel32.dll', 'shell32.dll', 'bcrypt.dll'].includes(library) && !/^api-ms-win-crt-[a-z]+-l1-1-0\.dll$/.test(library)) throw new Error('Unexpected audio DLL dependency: ' + library)
    imports.push(library)
  }
  if (!terminated || !imports.includes('kernel32.dll')) throw new Error('Incomplete audio DLL imports')
  return { timestamp: data.readUInt32LE(pe + 8), dllCharacteristics, relocationsBytes, imports: imports.sort() }
}
// The bundled Mac executable must support the same macOS 12 floor as the signer.
export function inspectDarwinAudio(data, arch = 'arm64') {
  const cpu = { arm64: 0x0100000c, amd64: 0x01000007 }[arch]
  if (!cpu || data.length < 32 || data.readUInt32LE(0) !== 0xfeedfacf || data.readUInt32LE(4) !== cpu || data.readUInt32LE(12) !== 2) throw new Error('Expected macOS ' + arch + ' audio executable')
  const count = data.readUInt32LE(16), bytes = data.readUInt32LE(20)
  if (!count || count > 4096 || bytes > data.length - 32) throw new Error('Invalid audio Mach-O commands')
  let p = 32, minimumMacOS
  for (let i = 0; i < count; i++) {
    if (p + 8 > 32 + bytes) throw new Error('Invalid audio Mach-O command')
    const command = data.readUInt32LE(p), size = data.readUInt32LE(p + 4)
    if (size < 8 || size > 32 + bytes - p) throw new Error('Invalid audio Mach-O command')
    if (command === 0x32) {
      if (size < 24 || data.readUInt32LE(p + 8) !== 1 || minimumMacOS !== undefined) throw new Error('Invalid audio macOS build version')
      minimumMacOS = data.readUInt32LE(p + 12)
    }
    p += size
  }
  if (p !== 32 + bytes || minimumMacOS === undefined || minimumMacOS < 0x000b0000 || minimumMacOS > 0x000c0000) throw new Error('Audio executable must support macOS 12')
  return { minimumMacOS }
}
export function packageTarget(value = `${process.platform}-${process.arch}`) {
  if (value === 'darwin-arm64') return { platform: 'darwin', arch: 'arm64', windows: false }
  if (value === 'darwin-amd64' || value === 'darwin-x64') return { platform: 'darwin', arch: 'amd64', windows: false }
  if (value === 'windows-amd64' || value === 'win32-x64') return { platform: 'windows', arch: 'amd64', windows: true }
  if (value === 'windows-arm64' || value === 'win32-arm64') return { platform: 'windows', arch: 'arm64', windows: true }
  throw new Error('Supported package targets: darwin-arm64, darwin-amd64, windows-amd64, windows-arm64. Windows ARM64 requires Windows 11 x64 emulation; Linux needs a supported signing backend. No x32/386 host is listed by MyGO.')
}
