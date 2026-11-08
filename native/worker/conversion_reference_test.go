package main

import "strconv"

// Offline reference tooling only. The runtime never executes a converter.
func aacConversionArgs(input, output string) []string {
	return []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-err_detect", "explode", "-y", "-protocol_whitelist", "file,pipe", "-i", input, "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", "-compression_level", "5", "-threads", "1", "-fs", strconv.Itoa(maxAudio), "-f", "flac", output}
}
