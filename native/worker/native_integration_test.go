package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Optional offline native verification: helper, isolated SDK and generated fixtures.
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

// Exercise the C++ route boundary directly so a permissive worker cannot bypass it.
func TestNativeUserInfoSigningRoute(t *testing.T) {
	root := nativeRoot(t)
	var req request
	_ = json.Unmarshal(signFrame(), &req)
	base, err := parseSign(req.Params, req.Session.DeviceID)
	if err != nil {
		t.Fatal("sign fixture invalid")
	}
	for _, tc := range userInfoRouteCases {
		spec := base
		spec.URL = strings.Replace(base.URL, "/luna/pc/track_v2", tc.path, 1)
		ctx, cancel := context.WithTimeout(context.Background(), 24*time.Second)
		signed, err := signRequest(ctx, root, spec)
		cancel()
		if (err == nil) != tc.valid || tc.valid && len(signed) != 2 {
			t.Fatalf("unexpected native route decision: %s", tc.path)
		}
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
func TestNativeM4APassthrough(t *testing.T) {
	root := nativeRoot(t)
	data, e := os.ReadFile(filepath.Join(root, "test", "fixtures", "aac-editlist.m4a"))
	if e != nil || !nativeM4A(data) {
		t.Fatal("verified AAC-LC fixture unavailable")
	}
	w := newWorker(root)
	defer w.close()
	// Exercise the real isolated CENC decoder, format guard and private bridge.
	encrypted := encryptM4AFixture(data)
	data, e = decodeWithKey(encrypted, fixtureKey)
	if e != nil || !nativeM4A(data) {
		t.Fatal("matching-resource fixture invalid")
	}
	w.download = func(context.Context, string) ([]byte, error) { return encrypted, nil }
	grant := fixtureGrant(fixtureCandidate("aac", "higher", fixtureAuth()))
	frame, _ := json.Marshal(map[string]any{"op": "music", "method": "stream", "session": session{Version: 1, DeviceID: "1234567890123456", InstallID: "123456789012345"}, "params": map[string]any{"id": "123", "quality": "standard", "grant": grant}})
	ctx, cancel := context.WithTimeout(context.Background(), 24*time.Second)
	defer cancel()
	raw, e := w.handle(ctx, frame)
	if e != nil {
		t.Fatal("native M4A stream failed")
	}
	result, ok := raw.(*streamResult)
	if !ok || result.Type != "m4a" || result.Quality != "standard" || result.Size != len(data) {
		t.Fatal("native M4A metadata mismatch")
	}
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: time.Second}
	defer client.CloseIdleConnections()
	res, e := client.Get(result.URL)
	if e != nil {
		t.Fatal("native bridge unavailable")
	}
	defer res.Body.Close()
	body, e := io.ReadAll(res.Body)
	if e != nil || res.Header.Get("Content-Type") != "audio/mp4" || !bytes.Equal(body, data) {
		t.Fatal("native M4A bytes changed")
	}
}
func processID() string { b, _ := json.Marshal(os.Getpid()); return string(b) }
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
