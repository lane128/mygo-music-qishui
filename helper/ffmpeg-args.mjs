// One invocation contract for the Windows runtime and native codec verification.
export const MAX_CONVERTED_AUDIO = 128 * 1024 * 1024
export function aacConversionArgs(input, output) {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode', '-y',
    '-protocol_whitelist', 'file,pipe', '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
    '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-compression_level', '5', '-threads', '1',
    '-fs', String(MAX_CONVERTED_AUDIO), '-f', 'flac', output]
}
