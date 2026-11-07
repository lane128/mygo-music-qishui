package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestAudioBridgeHTTP(t *testing.T) {
	b, e := newAudioBridge()
	if e != nil {
		t.Fatal("bridge setup failed")
	}
	defer b.close()
	added, e := b.add(audioStream{Data: []byte("0123456789"), Type: "flac", Quality: "high", BitRate: 256000})
	if e != nil {
		t.Fatal("bridge add failed")
	}
	u, _ := url.Parse(added.URL)
	if added.Type != "flac" || added.Quality != "high" || added.BitRate != 256000 || added.Size != 10 || len(u.Path) != 49 {
		t.Fatal("bridge metadata mismatch")
	}
	cases := []struct {
		method, host, path, r string
		status                int
		body, contentRange    string
	}{
		{"GET", b.host, u.Path, "", 200, "0123456789", ""}, {"HEAD", b.host, u.Path, "", 200, "", ""},
		{"GET", b.host, u.Path, "bytes=2-5", 206, "2345", "bytes 2-5/10"}, {"HEAD", b.host, u.Path, "bytes=2-", 206, "", "bytes 2-9/10"},
		{"GET", b.host, u.Path, "bytes=-3", 206, "789", "bytes 7-9/10"}, {"GET", b.host, u.Path, "bytes=-30", 206, "0123456789", "bytes 0-9/10"},
		{"GET", b.host, u.Path, "bytes=2-99", 206, "23456789", "bytes 2-9/10"}, {"GET", b.host, u.Path, "bytes=10-", 416, "", "bytes */10"},
		{"GET", b.host, u.Path, "bytes=4-1", 416, "", "bytes */10"}, {"GET", b.host, u.Path, "bytes=-0", 416, "", "bytes */10"},
		{"GET", b.host, u.Path, "bytes=0-1,2-3", 416, "", "bytes */10"}, {"GET", b.host, u.Path, "bytes=9007199254740992-", 416, "", "bytes */10"},
		{"GET", "localhost", u.Path, "", 403, "", ""}, {"POST", b.host, u.Path, "", 403, "", ""}, {"GET", b.host, u.Path + "?x", "", 404, "", ""},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, c.path, nil)
		r.Host = c.host
		if c.r != "" {
			r.Header.Set("Range", c.r)
		}
		rec := httptest.NewRecorder()
		b.ServeHTTP(rec, r)
		if rec.Code != c.status || rec.Body.String() != c.body || rec.Header().Get("Content-Range") != c.contentRange {
			t.Fatal("unexpected bridge HTTP semantics")
		}
	}
	r := httptest.NewRequest("GET", u.Path, nil)
	r.Host = b.host
	r.Header["Range"] = []string{"bytes=0-1", "bytes=3-4"}
	rec := httptest.NewRecorder()
	b.ServeHTTP(rec, r)
	if rec.Code != 416 {
		t.Fatal("multiple range fields accepted")
	}
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: time.Second}
	defer client.CloseIdleConnections()
	res, e := client.Get(added.URL)
	if e != nil {
		t.Fatal("loopback bridge unavailable")
	}
	_ = res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal("loopback bridge failed")
	}
}
func TestBridgeBoundsTTLAndClose(t *testing.T) {
	b, e := newAudioBridge()
	if e != nil {
		t.Fatal("bridge setup failed")
	}
	defer b.close()
	now := time.Unix(1, 0)
	b.now = func() time.Time { return now }
	b.limit = 12
	b.ttl = time.Minute
	first, _ := b.add(audioStream{Data: []byte("12345678"), Type: "mp3"})
	second, _ := b.add(audioStream{Data: []byte("12345678"), Type: "mp3"})
	b.mu.Lock()
	if b.bytes != 8 || len(b.entries) != 1 {
		t.Fatal("byte eviction failed")
	}
	b.mu.Unlock()
	for _, raw := range []string{first.URL, second.URL} {
		u, _ := url.Parse(raw)
		r := httptest.NewRequest("GET", u.Path, nil)
		r.Host = b.host
		rec := httptest.NewRecorder()
		b.ServeHTTP(rec, r)
		want := 200
		if raw == first.URL {
			want = 404
		}
		if rec.Code != want {
			t.Fatal("eviction lookup failed")
		}
	}
	now = now.Add(time.Minute)
	u, _ := url.Parse(second.URL)
	r := httptest.NewRequest("GET", u.Path, nil)
	r.Host = b.host
	rec := httptest.NewRecorder()
	b.ServeHTTP(rec, r)
	if rec.Code != 404 {
		t.Fatal("expired stream survived")
	}
	b.limit = 100
	for i := 0; i < 6; i++ {
		if _, e = b.add(audioStream{Data: []byte("x"), Type: "ogg"}); e != nil {
			t.Fatal("entry add failed")
		}
	}
	b.mu.Lock()
	if len(b.entries) != 5 || b.bytes != 5 {
		t.Fatal("entry count bound failed")
	}
	b.mu.Unlock()
	b.discardURL("http://" + b.host + b.entries[0].key)
	b.mu.Lock()
	if len(b.entries) != 4 || b.bytes != 4 {
		t.Fatal("canceled entry cleanup failed")
	}
	b.mu.Unlock()
	b.close()
	if _, e = b.add(audioStream{Data: []byte("x"), Type: "mp3"}); e != errUnavailable {
		t.Fatal("closed server accepted data")
	}
	conn, e := net.DialTimeout("tcp", b.host, time.Second)
	if e == nil {
		_ = conn.Close()
		t.Fatal("bridge listener survived close")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.bytes != 0 || len(b.entries) != 0 {
		t.Fatal("close retained audio")
	}
}
func signFrame() []byte {
	raw, _ := json.Marshal(map[string]any{"op": "music", "method": "sign", "session": session{Version: 1, DeviceID: "1234567890123456", InstallID: "123456789012345"}, "params": map[string]any{"url": "https://api.qishui.com/luna/pc/track_v2?aid=386088&app_name=luna_pc&device_id=1234567890123456&fp=1234567890123456", "did": "1234567890123456", "headers": map[string]string{"Accept": "application/json"}}})
	return append(raw, '\n')
}
func TestIPCInvalidLinesContinue(t *testing.T) {
	reader, writer := io.Pipe()
	outReader, outWriter := io.Pipe()
	defer writer.Close()
	defer outReader.Close()
	w := newWorker("")
	w.sign = func(context.Context, signSpec) (map[string]string, error) {
		return map[string]string{"x-helios": "fixture", "x-medusa": "fixture"}, nil
	}
	done := make(chan struct{})
	go func() {
		runIPC(context.Background(), reader, outWriter, w, time.Second)
		_ = outWriter.Close()
		close(done)
	}()
	cases := [][]byte{[]byte("bad-json\n"), []byte(strings.Repeat("x", maxFrame+1) + "\n"), []byte(`{"op":"music","op":"music"}` + "\n"), signFrame()}
	scanner := bufio.NewScanner(outReader)
	for i, input := range cases {
		if _, e := writer.Write(input); e != nil {
			t.Fatal("IPC input failed")
		}
		if !scanner.Scan() {
			t.Fatal("worker stopped after invalid frame")
		}
		var got response
		if json.Unmarshal(scanner.Bytes(), &got) != nil || got.OK != (i == len(cases)-1) {
			t.Fatal("unexpected IPC response")
		}
	}
	_ = writer.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker ignored EOF")
	}
}
func TestEOFStopsActiveRequestAndBridge(t *testing.T) {
	b, e := newAudioBridge()
	if e != nil {
		t.Fatal("bridge setup failed")
	}
	defer b.close()
	reader, writer := io.Pipe()
	defer writer.Close()
	started := make(chan struct{})
	canceled := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	w := newWorker("")
	w.audio = b
	w.sign = func(ctx context.Context, _ signSpec) (map[string]string, error) {
		close(started)
		<-ctx.Done()
		close(canceled)
		<-release
		return nil, errUnavailable
	}
	var output bytes.Buffer
	go func() { runIPC(context.Background(), reader, &output, w, time.Second); close(done) }()
	if _, e = writer.Write(signFrame()); e != nil {
		t.Fatal("IPC write failed")
	}
	<-started
	_ = writer.Close()
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("active operation ignored stdin EOF")
	}
	// Child cleanup can still be running. The HTTP listener must already close.
	deadline := time.Now().Add(time.Second)
	closed := false
	for time.Now().Before(deadline) {
		c, e := net.DialTimeout("tcp", b.host, 50*time.Millisecond)
		if e != nil {
			closed = true
			break
		}
		_ = c.Close()
		time.Sleep(time.Millisecond)
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker teardown stalled")
	}
	if !closed || output.Len() != 0 {
		t.Fatal("EOF did not stop bridge and suppress response")
	}
}

type notifyingWriter struct {
	*io.PipeWriter
	entered chan struct{}
}

func (w notifyingWriter) Write(p []byte) (int, error) { close(w.entered); return w.PipeWriter.Write(p) }
func TestEOFCancelsBlockedResponseWrite(t *testing.T) {
	in, send := io.Pipe()
	receive, out := io.Pipe()
	defer send.Close()
	defer receive.Close()
	entered := make(chan struct{})
	done := make(chan struct{})
	w := newWorker("")
	w.sign = func(context.Context, signSpec) (map[string]string, error) {
		return map[string]string{"x-helios": "fixture", "x-medusa": "fixture"}, nil
	}
	go func() { runIPC(context.Background(), in, notifyingWriter{out, entered}, w, time.Second); close(done) }()
	if _, e := send.Write(signFrame()); e != nil {
		t.Fatal("IPC input failed")
	}
	<-entered
	_ = send.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("EOF left response write blocked")
	}
}
func TestStartupIdleAndParentCancellation(t *testing.T) {
	for _, mode := range []string{"idle", "parent"} {
		reader, writer := io.Pipe()
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { runIPC(ctx, reader, io.Discard, newWorker(""), 20*time.Millisecond); close(done) }()
		if mode == "parent" {
			cancel()
		}
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("worker shutdown stalled")
		}
		cancel()
		_ = writer.Close()
	}
}
