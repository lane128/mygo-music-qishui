package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestSignerRequestValidation(t *testing.T) {
	var req request
	if json.Unmarshal(signFrame(), &req) != nil {
		t.Fatal("fixture request malformed")
	}
	spec, e := parseSign(req.Params, req.Session.DeviceID)
	if e != nil || spec.HeaderLines != "accept\r\napplication/json" {
		t.Fatal("deterministic header normalization failed")
	}
	var base map[string]any
	_ = json.Unmarshal(req.Params, &base)
	cases := []struct {
		key   string
		value any
	}{
		{"url", "http://api.qishui.com/luna/pc/track_v2?device_id=1234567890123456"},
		{"url", "https://api.qishui.com:443/luna/pc/track_v2?device_id=1234567890123456"},
		{"url", "https://user@api.qishui.com/luna/pc/track_v2?device_id=1234567890123456"},
		{"url", "https://api.qishui.com/luna/pc/track_v2?device_id=1234567890123456#"},
		{"url", "https://api.qishui.com/luna/pc/track_v2?device_id=1234567890123456&device_id=1234567890123456"},
		{"url", "https://api.qishui.com/luna/pc/unknown?device_id=1234567890123456"},
		{"url", "https://api.qishui.com/luna/pc/artists/92?device_id=1234567890123456"},
		{"did", "1234567890123457"}, {"headers", map[string]any{"Bad\nName": "v"}}, {"headers", map[string]any{"Accept": "bad\r\nvalue"}},
		{"headers", map[string]any{"Accept": 1}}, {"headers", map[string]any{"Accept": nil}}, {"headers", map[string]any{"Accept": "x", "accept": "x"}},
		{"headerLines", nil},
		{"headerLines", "accept\r\nwrong"}, {"headerLines", "accept\r\napplication/json\r\n"},
	}
	for _, c := range cases {
		copy := map[string]any{}
		for k, v := range base {
			copy[k] = v
		}
		copy[c.key] = c.value
		raw, _ := json.Marshal(copy)
		if _, e := parseSign(raw, req.Session.DeviceID); e != errResponse {
			t.Fatal("invalid signing input accepted")
		}
	}
	base["headers"] = map[string]string{"B": "two", "A": "one"}
	base["headerLines"] = "b\r\ntwo\r\na\r\none"
	raw, _ := json.Marshal(base)
	spec, e = parseSign(raw, req.Session.DeviceID)
	if e != nil || spec.HeaderLines != "b\r\ntwo\r\na\r\none" {
		t.Fatal("explicit SDK order lost")
	}
	base["headerLines"] = "b\r\ntwo\r\nB\r\ntwo"
	raw, _ = json.Marshal(base)
	if _, e := parseSign(raw, req.Session.DeviceID); e != errResponse {
		t.Fatal("duplicate ordered header accepted")
	}
}

func TestSignerOutputValidation(t *testing.T) {
	valid := "X-Helios\r\nfixture-a\r\nx-medusa\r\nfixture-b"
	for _, s := range []string{valid, valid + "\r\n"} {
		got, e := parseSignatures([]byte(s))
		if e != nil || len(got) != 2 {
			t.Fatal("complete signature pairs rejected")
		}
	}
	for _, s := range []string{"", valid + "\r\n\r\n", valid + "\r\nextra", strings.Replace(valid, "x-medusa", "x-helios", 1), strings.Replace(valid, "x-medusa", "x-other", 1), strings.Replace(valid, "fixture-b", "", 1), valid + "\n", valid + "\x00", strings.Repeat("x", 65537)} {
		if _, e := parseSignatures([]byte(s)); e != errUnavailable {
			t.Fatal("invalid signer output accepted")
		}
	}
}
func TestSandboxPolicy(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Seatbelt syntax applies to macOS")
	}
	home := t.TempDir()
	scratch := t.TempDir()
	dir := filepath.Join(home, "allowed")
	if os.Mkdir(dir, 0700) != nil {
		t.Fatal("fixture setup failed")
	}
	file := filepath.Join(dir, "program")
	if os.WriteFile(file, []byte("fixture"), 0600) != nil {
		t.Fatal("fixture setup failed")
	}
	alias := filepath.Join(home, "alias")
	if os.Symlink(dir, alias) != nil {
		t.Fatal("fixture setup failed")
	}
	policy, e := sandboxPolicy(scratch, []string{filepath.Join(alias, "program")}, home)
	canonicalHome, _ := canonical(home)
	canonicalScratch, _ := canonical(scratch)
	canonicalFile, _ := canonical(file)
	canonicalDir, _ := canonical(dir)
	for _, required := range []string{"(deny network*)", "(subpath " + quotePolicy(canonicalHome) + ")", "(subpath " + quotePolicy(canonicalScratch) + ")", "(require-not (literal " + quotePolicy(canonicalFile) + "))", "(deny file-read-data (literal " + quotePolicy(canonicalDir) + "))", "/Library/Keychains"} {
		if e != nil || !strings.Contains(policy, required) {
			t.Fatal("sandbox policy missing required constraint")
		}
	}
	if strings.Contains(policy, quotePolicy(alias)) {
		t.Fatal("sandbox policy used noncanonical path")
	}
}
func TestSandboxDiagnosticSinkAndRestrictions(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Seatbelt execution requires macOS")
	}
	root := t.TempDir()
	scratch, home := filepath.Join(root, "scratch"), filepath.Join(root, "home")
	for _, dir := range []string{scratch, home} {
		if os.Mkdir(dir, 0700) != nil {
			t.Fatal("fixture directory unavailable")
		}
	}
	private := filepath.Join(home, "private-fixture")
	outside, inside := filepath.Join(root, "outside"), filepath.Join(scratch, "inside")
	for _, file := range []string{private, outside} {
		if os.WriteFile(file, []byte("fixture"), 0600) != nil {
			t.Fatal("fixture control write failed")
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("fixture")) }))
	defer server.Close()
	policy, e := sandboxPolicy(scratch, []string{"/bin/sh", "/bin/cat", "/usr/bin/curl"}, home)
	if e != nil {
		t.Fatal("sandbox policy unavailable")
	}
	script := `printf fixture >/dev/null || exit 10
if /bin/cat "$1" >/dev/null 2>&1; then exit 11; fi
if (printf forbidden >"$2") 2>/dev/null; then exit 12; fi
if /usr/bin/curl -fsS --connect-timeout 1 --max-time 1 "$4" >/dev/null 2>&1; then exit 13; fi
printf allowed >"$3" || exit 14
printf ok`
	out, e := runIsolated(context.Background(), "/usr/bin/sandbox-exec", []string{"-p", policy, "/bin/sh", "-c", script, "probe", private, outside, inside, server.URL}, nil, 64, scratch, false)
	if e != nil || string(out) != "ok" {
		t.Fatal("sandbox diagnostic sink or read/write/network restrictions failed")
	}
	before, _ := os.ReadFile(outside)
	allowed, _ := os.ReadFile(inside)
	if string(before) != "fixture" || string(allowed) != "allowed" {
		t.Fatal("sandbox file boundaries changed")
	}
}

func TestNativeMissingRuntimeIsSetup(t *testing.T) {
	_, e := isolatedNative(context.Background(), t.TempDir(), "sign", nil, 65536)
	if e != errSetup {
		t.Fatal("missing runtime did not fail closed")
	}
}
func TestBoundedSubprocess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX test command")
	}
	scratch := t.TempDir()
	_, e := runIsolated(context.Background(), "/usr/bin/printf", []string{"12345"}, nil, 4, scratch, false)
	if e != errUnavailable {
		t.Fatal("child output exceeded bound")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e = runIsolated(ctx, "/usr/bin/printf", []string{"123"}, nil, 4, scratch, false); e != errUnavailable {
		t.Fatal("canceled child started")
	}
}
func TestFFmpegArguments(t *testing.T) {
	got := aacConversionArgs("input", "output")
	expected := "-nostdin -hide_banner -loglevel error -xerror -err_detect explode -y -protocol_whitelist file,pipe -i input -map 0:a:0 -vn -sn -dn -map_metadata -1 -c:a flac -sample_fmt s32 -bits_per_raw_sample 24 -compression_level 5 -threads 1 -fs 134217728 -f flac output"
	if strings.Join(got, " ") != expected {
		t.Fatal("conversion contract changed")
	}
}
func TestRequestDeadlineCancellation(t *testing.T) {
	w := newWorker("")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	w.sign = func(ctx context.Context, _ signSpec) (map[string]string, error) {
		<-ctx.Done()
		return nil, errUnavailable
	}
	if _, e := w.handle(ctx, signFrame()); e != errUnavailable {
		t.Fatal("operation ignored deadline")
	}
}
