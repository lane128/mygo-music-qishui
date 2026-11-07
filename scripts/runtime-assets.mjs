// Build-only, fixed upstream distributions. No runtime downloads or user paths.
import { createHash } from 'node:crypto'
import { FFMPEG_SOURCE, ZIG_TOOLCHAIN } from './ffmpeg-config.mjs'

export const WINDOWS_FFMPEG_FILES = {
  'ffmpeg.exe': 'a33a01524efd6b5e65e2c8269a37b6ebb3262e78ac21bada34e88c6c346942ef',
  'FFMPEG-LICENSE': '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
  'FFMPEG-README.txt': '0511b5fec7b252dd93be894072c4ef0e32eff73c27e61a92d2f77c221180296e',
  'FFMPEG-BUILD.json': '5795d489dfaebb682785e789eb50ad5f8fb4b3792d67198b5e600db6bb01165c',
  'FFMPEG-SOURCE.tar.xz': '1bab41925ca9a4cf5c8fe4da285b5966e81eeb041b951522c7ae82ce5993df6a',
  'MINGW-LICENSE': '99a69660981156c21336fdb5661f89341b013c94e4bf9e1c7467b4745718397f',
  'ZIG-LICENSE': '5c537d6853e005298a285d508cff9ac7192cea23576c840d485b2b586a7ff177',
  'WINDOWS-CRT-SOURCE.tar.xz': '5d3b9e357ab33ef38cf82e022550c6e94060e27c02d5315bd0e22579c57cf55d',
}
export const WINDOWS_FILES = {
  'bdms.node': '73017455010b58aabae15b5560f82463f425acf1f4a813d91370abd1f35fac0f',
  'metasecml.dll': '53f322a7731cf64e6187d2fde1bb07558c2ab0a64fa6db0ef7c95d618ea9a226',
  ...WINDOWS_FFMPEG_FILES,
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
export const WINDOWS_SOURCES = [
  ...WINDOWS_DOWNLOADS,
  { build: 'scripts/build-ffmpeg.mjs', source: FFMPEG_SOURCE, toolchain: ZIG_TOOLCHAIN, files: WINDOWS_FFMPEG_FILES },
]
export const sha256 = data => createHash('sha256').update(data).digest('hex')
export function checkDigest(data, expected, name) {
  if (sha256(data) !== expected) throw new Error('Runtime checksum mismatch: ' + name)
}
export function checkWindowsPE(data, name) {
  if (data.length < 64 || data.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not a Windows executable: ' + name)
  const offset = data.readUInt32LE(0x3c)
  if (offset > data.length - 26 || data.toString('ascii', offset, offset + 4) !== 'PE\0\0' || data.readUInt16LE(offset + 4) !== 0x8664 || data.readUInt16LE(offset + 24) !== 0x20b) throw new Error('Expected Windows x64 executable: ' + name)
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
export function packageTarget(value = `${process.platform}-${process.arch}`) {
  if (value === 'darwin-arm64') return { platform: 'darwin', arch: 'arm64', windows: false }
  if (value === 'windows-amd64' || value === 'win32-x64') return { platform: 'windows', arch: 'amd64', windows: true }
  throw new Error('Supported package targets: darwin-arm64, windows-amd64. MyGO has no Windows x32/386 host; Windows ARM64 signing is not yet supported.')
}
