// Shared audio-only conversion, with explicit gapless timing when available.
export const MAX_CONVERTED_AUDIO = 128 * 1024 * 1024
export function aacConversionArgs(input, output, trim) {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode', '-y',
    '-protocol_whitelist', 'file,pipe', ...(trim ? ['-copyts', '-flags2', '+skip_manual'] : []),
    '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', ...(trim ? ['-af', trim] : []),
    '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-compression_level', '5', '-threads', '1',
    '-fs', String(MAX_CONVERTED_AUDIO), '-f', 'flac', output]
}
