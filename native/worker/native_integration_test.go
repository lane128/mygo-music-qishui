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
	"strings"
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

// Every allowed catalogue route must traverse both native validators and the real isolated SDK.
func TestNativeCatalogSigners(t *testing.T) {
	root := nativeRoot(t)
	var req request
	_ = json.Unmarshal(signFrame(), &req)
	base, err := parseSign(req.Params, req.Session.DeviceID)
	if err != nil {
		t.Fatal("sign fixture invalid")
	}
	for endpoint := range signPaths {
		t.Run(endpoint, func(t *testing.T) {
			spec := base
			spec.URL = strings.Replace(base.URL, "/luna/pc/track_v2", endpoint, 1)
			ctx, cancel := context.WithTimeout(context.Background(), 24*time.Second)
			defer cancel()
			signed, err := signRequest(ctx, root, spec)
			if err != nil || len(signed) != 2 {
				t.Fatal("isolated catalogue signing failed")
			}
		})
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
func TestNativeConvertFixtures(t *testing.T) {
	root := nativeRoot(t)
	cases := []struct {
		name                     string
		rate, channels, min, max int
	}{
		{"aac-lc.m4a", 48000, 1, 4000, 7000}, {"aac-lc.aac", 44100, 2, 44100, 53000},
		{"aac-he.m4a", 44100, 2, 44100, 53000}, {"aac-he.aac", 44100, 2, 44100, 53000},
		{"aac-hev2.m4a", 44100, 2, 44100, 53000}, {"aac-hev2.aac", 44100, 2, 44100, 53000},
		{"aac-fullscale.m4a", 44100, 2, 44100, 53000}, {"aac-transient.m4a", 44100, 2, 44100, 53000},
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
			// Both platforms use FFmpeg. One 24-bit step is 256 in signed 32-bit PCM.
			width, threshold := 4, int64(256)
			if runtime.GOOS == "darwin" {
				if trim := m4aGapless(input); trim != nil && uint64(frames)*uint64(trim.timescale) != trim.samples*uint64(rate) {
					t.Fatal("gapless conversion changed valid sample count")
				}
			}
			maxDifference, nonzero := comparePCM(t, reference, actual, width)
			t.Logf("frames=%d referenceMaximumDifference=%d", frames, maxDifference)
			if c.name == "aac-fullscale.m4a" {
				positivePeaks := 0
				for i := 0; i < len(reference); i += 4 {
					if int32(binary.LittleEndian.Uint32(reference[i:])) >= 2147483392 {
						positivePeaks++
						if int32(binary.LittleEndian.Uint32(actual[i:])) < 0 {
							t.Fatal("positive peak reversed polarity")
						}
					}
				}
				if positivePeaks == 0 {
					t.Fatal("full-scale fixture did not exercise positive saturation")
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
	exe := filepath.Join(plugin, "runtime", "native", "ffmpeg")
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", input, "-map", "0:a:0", "-c:a", "pcm_s32le", "-f", "s32le", "pipe:1"}
	if trim := m4aGapless(data); trim != nil {
		args = gaplessArgs(args, trim)
	}
	home, e := os.UserHomeDir()
	if e != nil {
		t.Fatal("reference home unavailable")
	}
	policy, e := sandboxPolicy(scratch, []string{exe, input}, home)
	if e != nil {
		t.Fatal("reference sandbox unavailable")
	}
	out, e := runIsolated(ctx, "/usr/bin/sandbox-exec", append([]string{"-p", policy, exe}, args...), nil, 2*1024*1024, scratch, false)
	if e != nil {
		t.Fatal("isolated reference PCM decode failed")
	}
	return out
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
