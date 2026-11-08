package main

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type audioStream struct {
	Data          []byte
	Type, Quality string
	BitRate       float64
}
type streamResult struct {
	URL     string  `json:"url"`
	Type    string  `json:"type"`
	Quality string  `json:"quality"`
	BitRate float64 `json:"bitRate,omitempty"`
	Size    int     `json:"size"`
}
type audioEntry struct {
	key     string
	stream  audioStream
	expires time.Time
}
type audioBridge struct {
	mu           sync.Mutex
	entries      []audioEntry
	bytes, limit int
	ttl          time.Duration
	now          func() time.Time
	closed       bool
	host         string
	server       *http.Server
	listener     net.Listener
	conns        map[net.Conn]bool
}

func newAudioBridge() (*audioBridge, error) {
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		return nil, errUnavailable
	}
	b := &audioBridge{limit: 256 * 1024 * 1024, ttl: 15 * time.Minute, now: time.Now, host: listener.Addr().String(), listener: listener, conns: map[net.Conn]bool{}}
	b.server = &http.Server{Handler: b, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 8192,
		ConnState: func(c net.Conn, state http.ConnState) {
			b.mu.Lock()
			defer b.mu.Unlock()
			if state == http.StateNew {
				if b.closed || len(b.conns) >= 8 {
					_ = c.Close()
				} else {
					b.conns[c] = true
				}
			} else if state == http.StateClosed || state == http.StateHijacked {
				delete(b.conns, c)
			}
		}}
	go func() { _ = b.server.Serve(listener) }()
	return b, nil
}
func (b *audioBridge) prune() {
	now := b.now()
	kept := b.entries[:0]
	for _, entry := range b.entries {
		if !entry.expires.After(now) {
			b.bytes -= len(entry.stream.Data)
		} else {
			kept = append(kept, entry)
		}
	}
	for i := len(kept); i < len(b.entries); i++ {
		b.entries[i] = audioEntry{}
	}
	b.entries = kept
}
func (b *audioBridge) add(s audioStream) (*streamResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.prune()
	if b.closed || len(s.Data) == 0 || len(s.Data) > b.limit || (s.Type != "flac" && s.Type != "mp3" && s.Type != "ogg" && s.Type != "m4a") {
		return nil, errUnavailable
	}
	for b.bytes+len(s.Data) > b.limit || len(b.entries) >= 5 {
		b.bytes -= len(b.entries[0].stream.Data)
		b.entries[0] = audioEntry{}
		b.entries = b.entries[1:]
	}
	var token [24]byte
	if _, e := rand.Read(token[:]); e != nil {
		return nil, errUnavailable
	}
	key := "/" + hex.EncodeToString(token[:])
	b.entries = append(b.entries, audioEntry{key: key, stream: s, expires: b.now().Add(b.ttl)})
	b.bytes += len(s.Data)
	return &streamResult{URL: "http://" + b.host + key, Type: s.Type, Quality: s.Quality, BitRate: s.BitRate, Size: len(s.Data)}, nil
}
func (b *audioBridge) discardURL(raw string) {
	u, e := url.Parse(raw)
	if e != nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for i, entry := range b.entries {
		if entry.key == u.Path {
			b.bytes -= len(entry.stream.Data)
			copy(b.entries[i:], b.entries[i+1:])
			b.entries[len(b.entries)-1] = audioEntry{}
			b.entries = b.entries[:len(b.entries)-1]
			return
		}
	}
}
func parseRange(raw string, size int) (int, int, bool) {
	if !strings.HasPrefix(raw, "bytes=") {
		return 0, 0, false
	}
	parts := strings.Split(strings.TrimPrefix(raw, "bytes="), "-")
	if len(parts) != 2 || parts[0] == "" && parts[1] == "" {
		return 0, 0, false
	}
	parse := func(s string) (uint64, bool) {
		if s == "" {
			return 0, false
		}
		for _, c := range s {
			if c < '0' || c > '9' {
				return 0, false
			}
		}
		n, e := strconv.ParseUint(s, 10, 53)
		return n, e == nil
	}
	start, end := uint64(0), uint64(size-1)
	if parts[0] == "" {
		n, ok := parse(parts[1])
		if !ok || n == 0 {
			return 0, 0, false
		}
		if n < uint64(size) {
			start = uint64(size) - n
		}
	} else {
		n, ok := parse(parts[0])
		if !ok {
			return 0, 0, false
		}
		start = n
		if parts[1] != "" {
			n, ok = parse(parts[1])
			if !ok {
				return 0, 0, false
			}
			if n < end {
				end = n
			}
		}
	}
	if start > end || start >= uint64(size) {
		return 0, 0, false
	}
	return int(start), int(end), true
}
func (b *audioBridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b.mu.Lock()
	b.prune()
	if b.closed || r.Host != b.host || (r.Method != "GET" && r.Method != "HEAD") {
		b.mu.Unlock()
		w.WriteHeader(403)
		return
	}
	var s audioStream
	for _, e := range b.entries {
		if e.key == r.RequestURI {
			s = e.stream
			break
		}
	}
	b.mu.Unlock()
	if len(s.Data) == 0 {
		w.WriteHeader(404)
		return
	}
	start, end, status := 0, len(s.Data)-1, 200
	if len(r.Header.Values("Range")) > 1 {
		w.Header().Set("Content-Range", "bytes */"+strconv.Itoa(len(s.Data)))
		w.WriteHeader(416)
		return
	}
	if raw := r.Header.Get("Range"); raw != "" {
		var ok bool
		start, end, ok = parseRange(raw, len(s.Data))
		if !ok {
			w.Header().Set("Content-Range", "bytes */"+strconv.Itoa(len(s.Data)))
			w.WriteHeader(416)
			return
		}
		status = 206
		w.Header().Set("Content-Range", "bytes "+strconv.Itoa(start)+"-"+strconv.Itoa(end)+"/"+strconv.Itoa(len(s.Data)))
	}
	contentType := map[string]string{"flac": "audio/flac", "mp3": "audio/mpeg", "ogg": "audio/ogg", "m4a": "audio/mp4"}[s.Type]
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(end-start+1))
	w.WriteHeader(status)
	if r.Method == "GET" {
		_, _ = w.Write(s.Data[start : end+1])
	}
}
func (b *audioBridge) close() {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	b.closed = true
	b.entries = nil
	b.bytes = 0
	b.mu.Unlock()
	_ = b.server.Close()
}
