// Fixed source and portable compiler inputs for the audio-only Windows converter.
export const FFMPEG_SOURCE = {
  version: '8.1.2', commit: '38b88335f99e76ed89ff3c93f877fdefce736c13',
  url: 'https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/38b88335f99e76ed89ff3c93f877fdefce736c13',
  sha256: '2ae7e42343cfffb811d15cfe98b6d005f082595fcdf034d30a4ff90cfed9f9c6',
}
// The shipped source bundle is accepted directly for offline rebuilds.
export const FFMPEG_SOURCE_BUNDLE = {
  sha256: '1bab41925ca9a4cf5c8fe4da285b5966e81eeb041b951522c7ae82ce5993df6a',
  tarSha256: '7415e112e3e4ea817f189ff928d0a849317aabe58e6d097f414d8278e0726731',
}
export const ZIG_TOOLCHAIN = {
  version: '0.15.2', host: 'aarch64-macos',
  url: 'https://ziglang.org/download/0.15.2/zig-aarch64-macos-0.15.2.tar.xz',
  sha256: '3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b',
}
// Reference PCM decode is retained for the independent validation ZIP. No video,
// network, external codecs, audio devices, AAC encoder or MP3 encoder is included.
export const FFMPEG_FLAGS = [
  '--disable-everything', '--disable-autodetect', '--disable-programs', '--enable-ffmpeg',
  '--disable-doc', '--disable-network', '--disable-avdevice',
  '--disable-swscale', '--disable-asm', '--disable-iconv', '--disable-mediafoundation',
  '--disable-stripping', '--enable-small', '--enable-gpl', '--enable-version3',
  '--enable-decoder=aac,flac,pcm_s16le,pcm_s24le,pcm_s32le',
  '--enable-encoder=flac,pcm_s32le', '--enable-demuxer=mov,aac,flac,wav',
  '--enable-muxer=flac,pcm_s32le', '--enable-parser=aac,flac',
  '--enable-protocol=file,pipe', '--enable-filter=aresample,aformat,anull',
]
