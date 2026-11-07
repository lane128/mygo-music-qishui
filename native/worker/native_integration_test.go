package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// Optional offline native verification. The extracted validation package supplies
// the helper, SDK, converter/runner and the six existing generated AAC fixtures.
// No account, signed media URL, network request or child diagnostic is printed.
func nativeRoot(t *testing.T) string {
	t.Helper()
	root := os.Getenv("QISHUI_NATIVE_ROOT")
	if root == "" {
		t.Skip("set QISHUI_NATIVE_ROOT to an extracted validation package")
	}
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("native verification requires a supported packaged platform")
	}
	actual, e := canonical(root)
	if e != nil {
		t.Fatal("native validation root unavailable")
	}
	return actual
}
func TestNativeSigner(t *testing.T) {
	root := nativeRoot(t)
	ctx, cancel := context.WithTimeout(context.Background(), 24*time.Second)
	defer cancel()
	var req request
	_ = json.Unmarshal(signFrame(), &req)
	spec, e := parseSign(req.Params, req.Session.DeviceID)
	if e != nil {
		t.Fatal("sign fixture invalid")
	}
	signed, e := signRequest(ctx, root, spec)
	if e != nil || len(signed) != 2 || signed["x-helios"] == "" || signed["x-medusa"] == "" {
		t.Fatal("isolated official signer failed")
	}
}
func TestNativeDecode(t *testing.T) {
	root := nativeRoot(t)
	for _, iv := range []int{8, 16} {
		ctx, cancel := context.WithTimeout(context.Background(), 24*time.Second)
		got, e := decodeResource(ctx, root, encryptedFixture("fLaC", iv, nil, false), fixtureAuth())
		cancel()
		if e != nil || !bytes.Equal(got, fixtureFLAC()) {
			t.Fatal("isolated matching-resource decode failed")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 24*time.Second)
	defer cancel()
	if _, e := decodeResource(ctx, root, []byte("malformed resource"), fixtureAuth()); e != errUnavailable {
		t.Fatal("isolated decoder accepted malformed input")
	}
}
func TestNativeConvertFixtures(t *testing.T) { runNativeConvertFixtures(t, nativeRoot(t), "") }
func TestNativeBaselineConverter(t *testing.T) {
	root := nativeRoot(t)
	baseline := os.Getenv("QISHUI_BASELINE_CONVERTER")
	if baseline == "" || runtime.GOOS != "darwin" {
		t.Skip("set QISHUI_BASELINE_CONVERTER for developer baseline equivalence")
	}
	runNativeConvertFixtures(t, root, baseline)
}
func runNativeConvertFixtures(t *testing.T, root, baseline string) {
	baselineRoot := ""
	if baseline != "" && runtime.GOOS == "darwin" {
		baselineRoot = t.TempDir()
		native := filepath.Join(baselineRoot, "runtime", "native")
		if os.MkdirAll(native, 0700) != nil {
			t.Fatal("baseline converter scratch unavailable")
		}
	}
	cases := []struct {
		name                     string
		rate, channels, min, max int
	}{
		{"aac-lc.m4a", 48000, 1, 4000, 7000}, {"aac-lc.aac", 44100, 2, 44100, 53000},
		{"aac-he.m4a", 44100, 2, 44100, 53000}, {"aac-he.aac", 44100, 2, 44100, 53000},
		{"aac-hev2.m4a", 44100, 2, 44100, 53000}, {"aac-hev2.aac", 44100, 2, 44100, 53000},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			input, e := os.ReadFile(filepath.Join(root, "test", "fixtures", c.name))
			if e != nil || len(input) > 65536 {
				t.Fatal("AAC validation fixture unavailable")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 24*time.Second)
			result, e := convertAAC(ctx, root, input)
			cancel()
			if e != nil || !nativeFLAC(result) {
				t.Fatal("isolated AAC conversion failed")
			}
			// STREAMINFO packs sample rate, channels, precision and total samples in 64 bits.
			info := binary.BigEndian.Uint64(result[18:26])
			rate := int(info >> 44)
			channels := int(info>>41&7) + 1
			precision := int(info>>36&31) + 1
			frames := int(info & 0xfffffffff)
			if rate != c.rate || channels != c.channels || precision != 24 || frames < c.min || frames > c.max {
				t.Fatal("converted FLAC stream metadata mismatch")
			}
			reference := nativeReferencePCM(t, root, input, c.name)
			actual := nativeReferencePCM(t, root, result, "converted.flac")
			if len(reference) == 0 || len(actual) != len(reference) {
				t.Fatal("conversion changed decoded sample count")
			}
			width, threshold := 3, int64(4)
			if runtime.GOOS == "windows" {
				width, threshold = 4, 256
			} else if c.name == "aac-he.m4a" || c.name == "aac-he.aac" {
				// Measured against the unchanged P1 converter through this exact
				// isolated launch: baseline/current PCM differ by <=1, while both
				// HE references can differ by 8 units. Other Mac fixtures retain 4.
				threshold = 8
			}
			maxDifference, nonzero := comparePCM(t, reference, actual, width)
			t.Logf("frames=%d referenceMaximumDifference=%d", frames, maxDifference)
			if baselineRoot != "" {
				// Even byte-identical AudioToolbox executables at different paths can
				// select slightly different HE rounding paths. Compare both binary
				// versions at the same private executable path and isolation policy.
				staged := filepath.Join(baselineRoot, "runtime", "native", "audio-convert")
				launch := func(source string) []byte {
					if e := os.Remove(staged); e != nil && !os.IsNotExist(e) {
						t.Fatal("comparison staging failed")
					}
					if copyPrivate(source, staged) != nil {
						t.Fatal("comparison converter unavailable")
					}
					ctx, cancel := context.WithTimeout(context.Background(), 24*time.Second)
					data, e := convertAAC(ctx, baselineRoot, input)
					cancel()
					if e != nil {
						t.Fatal("isolated comparison conversion failed")
					}
					return data
				}
				stagedCurrentPCM := nativeReferencePCM(t, root, launch(filepath.Join(root, "runtime", "native", "audio-convert")), "staged-current.flac")
				baselinePCM := nativeReferencePCM(t, root, launch(baseline), "baseline.flac")
				delta, _ := comparePCM(t, baselinePCM, stagedCurrentPCM, width)
				baselineMax, _ := comparePCM(t, reference, baselinePCM, width)
				stagedCurrentMax, _ := comparePCM(t, reference, stagedCurrentPCM, width)
				pathDelta, _ := comparePCM(t, actual, stagedCurrentPCM, width)
				t.Logf("baselineCurrentMaximumDifference=%d baselineReferenceMaximumDifference=%d stagedCurrentReferenceMaximumDifference=%d installedStagedCurrentMaximumDifference=%d", delta, baselineMax, stagedCurrentMax, pathDelta)
				if delta > 1 || baselineMax > threshold || stagedCurrentMax > threshold || stagedCurrentMax > 4 && baselineMax <= 4 {
					t.Fatal("baseline precision equivalence failed")
				}
			}
			if maxDifference > threshold {
				t.Errorf("reference PCM maximum difference: %d", maxDifference)
			}
			if !nonzero {
				t.Fatal("conversion produced silent PCM")
			}
		})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 24*time.Second)
	defer cancel()
	if _, e := convertAAC(ctx, root, []byte("malformed audio")); e != errUnavailable {
		t.Fatal("native converter accepted malformed audio")
	}
}
func comparePCM(t *testing.T, reference, actual []byte, width int) (int64, bool) {
	t.Helper()
	if len(reference) != len(actual) || len(actual)%width != 0 {
		t.Fatal("invalid PCM framing")
	}
	maxDifference := int64(0)
	nonzero := false
	sample := func(b []byte) int64 {
		if width == 4 {
			return int64(int32(binary.LittleEndian.Uint32(b)))
		}
		v := int32(b[0]) | int32(b[1])<<8 | int32(b[2])<<16
		return int64(v << 8 >> 8)
	}
	for i := 0; i < len(actual); i += width {
		a, b := sample(actual[i:i+width]), sample(reference[i:i+width])
		if a != 0 {
			nonzero = true
		}
		d := a - b
		if d < 0 {
			d = -d
		}
		if d > maxDifference {
			maxDifference = d
		}
	}
	return maxDifference, nonzero
}
func nativeReferencePCM(t *testing.T, plugin string, data []byte, name string) []byte {
	t.Helper()
	scratch, e := os.MkdirTemp("", "qishui-verify-")
	if e != nil {
		t.Fatal("reference scratch unavailable")
	}
	defer cleanupScratch(scratch)
	input := filepath.Join(scratch, name)
	if os.WriteFile(input, data, 0600) != nil {
		t.Fatal("reference input unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 24*time.Second)
	defer cancel()
	if runtime.GOOS == "windows" {
		exe := filepath.Join(scratch, "verify.exe")
		if copyPrivate(filepath.Join(plugin, "runtime", "native", "ffmpeg.exe"), exe) != nil {
			t.Fatal("reference decoder unavailable")
		}
		runner := filepath.Join(plugin, "runtime", "native", "windows-runner.exe")
		args := []string{"--root", scratch, "--parent", processID(), "--timeout-ms", "22000", "--", exe, "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", input, "-map", "0:a:0", "-c:a", "pcm_s32le", "-f", "s32le", "pipe:1"}
		out, e := runIsolated(ctx, runner, args, nil, 2*1024*1024, scratch, true)
		if e != nil {
			t.Fatal("isolated reference PCM decode failed")
		}
		return out
	}
	output := filepath.Join(scratch, "reference.wav")
	// Only this independent reference over bundled generated test fixtures uses
	// ordinary afconvert, matching the established P1 comparison. Production
	// convertAAC above always remains isolated; reference rounding tolerances
	// were checked against the unchanged baseline through the same isolation.
	cmd := exec.CommandContext(ctx, "/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI24", input, output)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "TMPDIR=" + scratch, "LANG=en_US.UTF-8"}
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if cmd.Run() != nil {
		t.Fatal("reference PCM decode failed")
	}
	wave, e := os.ReadFile(output)
	if e != nil {
		t.Fatal("reference PCM output unavailable")
	}
	for p := 12; p+8 <= len(wave); {
		size := int(binary.LittleEndian.Uint32(wave[p+4 : p+8]))
		if size > len(wave)-p-8 {
			break
		}
		if string(wave[p:p+4]) == "data" {
			return wave[p+8 : p+8+size]
		}
		p += 8 + size + size%2
	}
	t.Fatal("reference PCM framing invalid")
	return nil
}
func processID() string { // Kept fixed-format; never appears in diagnostics.
	b, _ := json.Marshal(os.Getpid())
	return string(b)
}
func TestNativeIPCEOF(t *testing.T) {
	root := nativeRoot(t)
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	exe := filepath.Join(root, "bin", "qishui-helper-"+runtime.GOOS+"-"+runtime.GOARCH+ext)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe)
	cmd.Stderr = io.Discard
	in, e := cmd.StdinPipe()
	if e != nil {
		t.Fatal("native IPC setup failed")
	}
	out, e := cmd.StdoutPipe()
	if e != nil {
		t.Fatal("native IPC setup failed")
	}
	if cmd.Start() != nil {
		t.Fatal("native helper failed to start")
	}
	if _, e = in.Write(signFrame()); e != nil {
		t.Fatal("native sign IPC failed")
	}
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 4096), 131072)
	if !scanner.Scan() {
		t.Fatal("native sign response missing")
	}
	var reply response
	if json.Unmarshal(scanner.Bytes(), &reply) != nil || !reply.OK {
		t.Fatal("native sign IPC response failed")
	}
	_ = in.Close()
	wait := make(chan error, 1)
	go func() { wait <- cmd.Wait() }()
	select {
	case e := <-wait:
		if e != nil || ctx.Err() != nil {
			t.Fatal("native helper failed after EOF")
		}
	case <-time.After(3 * time.Second):
		cancel()
		<-wait
		t.Fatal("native helper did not exit promptly on EOF")
	}
}
