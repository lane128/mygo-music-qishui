package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func mediaResponse(status int, body []byte, h http.Header) *http.Response {
	return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: -1}
}
func TestMediaRedirects(t *testing.T) {
	for _, tc := range []struct {
		url               string
		verified, allowed bool
	}{
		{"https://cdn.byteimg.com/final", false, true}, {"https://edge.qrstuvwxyzab.com/final", true, true},
		{"https://edge.qrstuvwxyzab.com/final", false, false}, {"https://nested.edge.qrstuvwxyzab.com/final", true, false},
		{"http://cdn.byteimg.com/final", true, false}, {"https://cdn.byteimg.com:444/final", true, false},
		{"https://user@cdn.byteimg.com/final", true, false}, {"https://cdn.byteimg.com/final#x", true, false}, {"https://outside.example/final", true, false},
	} {
		count := 0
		rt := roundTripFunc(func(r *http.Request) (*http.Response, error) {
			count++
			if len(r.Header) != 2 || r.Header.Get("Accept-Encoding") != "identity" || r.Header.Get("User-Agent") == "" {
				t.Fatal("unexpected transport headers")
			}
			if count == 1 {
				res := mediaResponse(302, nil, http.Header{"Location": {tc.url}})
				if tc.verified {
					res.TLS = &tls.ConnectionState{VerifiedChains: [][]*x509.Certificate{{{}}}}
				}
				return res, nil
			}
			return mediaResponse(200, []byte("data"), nil), nil
		})
		got, e := downloadWithTransport(context.Background(), "https://media.qishui.com/fixture", rt, 4)
		if tc.allowed {
			if e != nil || string(got) != "data" || count != 2 {
				t.Fatal("allowed redirect failed")
			}
		} else if e != errUnavailable || count != 1 {
			t.Fatal("forbidden redirect accepted")
		}
	}
	for _, u := range []string{"https://edge.qrstuvwxyzab.com/direct", "https://127.0.0.1/x", "https://qishui.com.evil/x", "https://qishui.com:443/x", "https://user@qishui.com/x", "https://qishui.com/x\n"} {
		if mediaURL(u) {
			t.Fatal("invalid media origin accepted")
		}
	}
}
func TestDownloadBounds(t *testing.T) {
	cases := []struct {
		body    string
		headers http.Header
		length  int64
		status  int
	}{
		{"12345", nil, -1, 200}, {"123", http.Header{"Content-Length": {"4"}}, -1, 200}, {"12", http.Header{"Content-Length": {"5"}}, -1, 200},
		{"12", http.Header{"Content-Length": {"2", "2"}}, -1, 200}, {"12", http.Header{"Content-Length": {"+2"}}, -1, 200},
		{"12", http.Header{"Content-Encoding": {"gzip"}}, -1, 200}, {"12", nil, 3, 200}, {"", nil, -1, 200}, {"12", nil, -1, 403},
	}
	for _, c := range cases {
		rt := roundTripFunc(func(*http.Request) (*http.Response, error) {
			r := mediaResponse(c.status, []byte(c.body), c.headers)
			r.ContentLength = c.length
			return r, nil
		})
		if _, e := downloadWithTransport(context.Background(), "https://media.qishui.com/audio", rt, 4); e != errUnavailable {
			t.Fatal("invalid response accepted")
		}
	}
	calls := 0
	rt := roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return mediaResponse(302, nil, http.Header{"Location": {"/loop"}}), nil
	})
	if _, e := downloadWithTransport(context.Background(), "https://media.qishui.com/audio", rt, 4); e != errUnavailable || calls != 4 {
		t.Fatal("redirect limit failed")
	}
	rt = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("untrusted diagnostic") })
	if _, e := downloadWithTransport(context.Background(), "https://media.qishui.com/audio", rt, 4); e != errUnavailable {
		t.Fatal("transport diagnostic escaped")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls = 0
	rt = roundTripFunc(func(*http.Request) (*http.Response, error) { calls++; return nil, errUnavailable })
	if _, e := downloadWithTransport(ctx, "https://media.qishui.com/audio", rt, 4); e != errUnavailable || calls != 0 {
		t.Fatal("canceled download started")
	}
}
func TestDownloadBodyCancellation(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan struct{})
	finished := make(chan error, 1)
	rt := roundTripFunc(func(*http.Request) (*http.Response, error) {
		close(started)
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: reader, ContentLength: -1}, nil
	})
	go func() { _, e := downloadWithTransport(ctx, "https://media.qishui.com/audio", rt, 4); finished <- e }()
	<-started
	cancel()
	select {
	case e := <-finished:
		if e != errUnavailable {
			t.Fatal("body cancellation failed")
		}
	case <-time.After(time.Second):
		t.Fatal("body read remained blocked")
	}
}
func fixtureCandidate(codec, quality, auth string) map[string]any {
	return map[string]any{"main_url": "https://media.douyinvod.com/" + codec, "video_meta": map[string]any{"codec_type": codec, "quality": quality, "bitrate": 256000, "size": 4}, "encrypt_info": map[string]any{"spade_a": auth}}
}
func fixtureGrant(list ...map[string]any) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"track": map[string]any{"id": "123", "duration": 180000}, "track_player": map[string]any{"video_model": map[string]any{"video_duration": 180, "video_list": list}}})
	return b
}
func TestGrantedSelectionAndPreview(t *testing.T) {
	grant := fixtureGrant(fixtureCandidate("aac", "medium", "a"), fixtureCandidate("aac", "highest", "b"), fixtureCandidate("flac", "lossless", "c"))
	for _, tc := range []struct{ quality, auth string }{{"standard", "a"}, {"high", "b"}, {"lossless", "c"}} {
		selected, _, e := grantedCandidates(grant, "123", tc.quality)
		if e != nil || selected.Auth != tc.auth {
			t.Fatal("wrong granted quality selected")
		}
	}
	for _, raw := range [][]byte{bytes.Replace(grant, []byte(`"video_duration":180`), []byte(`"video_duration":60`), 1), bytes.Replace(grant, []byte(`"id":"123"`), []byte(`"id":"124"`), 1), bytes.Replace(grant, []byte(`"video_duration":180`), []byte(`"is_preview":true,"video_duration":180`), 1), fixtureGrant(fixtureCandidate("mp3", "high", "auth")), []byte(`{"status_code":7}`)} {
		if _, _, e := grantedCandidates(raw, "123", "high"); e != errUnavailable {
			t.Fatal("invalid grant accepted")
		}
	}
	// String encoded models preserve track IDs without float conversion.
	var payload map[string]json.RawMessage
	_ = json.Unmarshal(grant, &payload)
	player := object(payload["track_player"])
	encoded, _ := json.Marshal(string(player["video_model"]))
	player["video_model"] = encoded
	payload["track_player"], _ = json.Marshal(player)
	raw, _ := json.Marshal(payload)
	if _, _, e := grantedCandidates(raw, "123", "high"); e != nil {
		t.Fatal("encoded model rejected")
	}
}
func TestSameGrantFallback(t *testing.T) {
	for _, mode := range []string{"format", "network", "canceled", "setup"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			downloads := 0
			w := &worker{}
			w.download = func(context.Context, string) ([]byte, error) {
				downloads++
				if mode == "network" {
					return nil, errUnavailable
				}
				return []byte{0, 0, 0, 8, 'f', 't', 'y', 'p'}, nil
			}
			w.decode = func(_ context.Context, data []byte, auth string) ([]byte, error) {
				if auth == "flac" {
					if mode == "canceled" {
						cancel()
					}
					if mode == "setup" {
						return nil, errSetup
					}
					return nil, errUnavailable
				}
				if auth != "aac" {
					t.Fatal("wrong matching authorization")
				}
				return data, nil
			}
			w.convert = func(context.Context, []byte) ([]byte, error) { return fixtureFLAC(), nil }
			result, e := resolvePlayback(ctx, fixtureGrant(fixtureCandidate("flac", "lossless", "flac"), fixtureCandidate("aac", "highest", "aac")), "123", "lossless", w)
			if mode == "format" {
				if e != nil || downloads != 2 || result.Type != "flac" || result.Quality != "high" {
					t.Fatal("same grant fallback failed")
				}
			} else {
				want := errUnavailable
				if mode == "setup" {
					want = errSetup
				}
				if e != want || downloads != 1 {
					t.Fatal("unexpected download retry")
				}
			}
		})
	}
}
func TestFormatAndActualQuality(t *testing.T) {
	mp3 := append([]byte{0xff, 0xfb, 0x90, 0x64}, make([]byte, 413)...)
	for _, tc := range []struct {
		codec   string
		data    []byte
		success bool
	}{{"mp3", mp3, true}, {"mp3", []byte("ID3bad"), false}, {"flac", fixtureFLAC(), true}, {"flac", []byte("fLaCbad"), false}, {"aac", []byte("bad audio"), false}} {
		w := &worker{download: func(context.Context, string) ([]byte, error) { return tc.data, nil }}
		result, _, e := materialize(context.Background(), candidate{Codec: tc.codec, Quality: "high"}, w)
		if tc.success {
			if e != nil || result.Type != tc.codec || !bytes.Equal(result.Data, tc.data) {
				t.Fatal("valid format rejected")
			}
		} else if e != errUnavailable {
			t.Fatal("invalid format accepted")
		}
	}
	var calls atomic.Int32
	w := &worker{download: func(context.Context, string) ([]byte, error) { calls.Add(1); return nil, errUnavailable }}
	if _, e := resolvePlayback(context.Background(), json.RawMessage(strings.Repeat(" ", 10)), "123", "high", w); e != errUnavailable || calls.Load() != 0 {
		t.Fatal("invalid grant reached media transport")
	}
}
