package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var domains = []string{"qishui.com", "douyinvod.com", "byteimg.com", "bytegecko.com", "zjcdn.com", "pstatp.com", "snssdk.com"}
var delegatedHost = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.qrstuvwxyzab\.com$`)

func safeURL(raw string) *url.URL {
	if len(raw) == 0 || len(raw) > 65536 {
		return nil
	}
	for _, c := range raw {
		if c < 0x21 || c > 0x7e {
			return nil
		}
	}
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Host == "" || strings.Contains(u.Host, ":") || u.Fragment != "" || strings.Contains(raw, "#") {
		return nil
	}
	return u
}
func mediaURL(raw string) bool {
	u := safeURL(raw)
	if u == nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	// Account/API requests belong exclusively to the MyGO JavaScript sandbox.
	if host == "api.qishui.com" {
		return false
	}
	for _, d := range domains {
		if host == d || strings.HasSuffix(host, "."+d) {
			return true
		}
	}
	return false
}
func redirectAllowed(destination, source string, verified bool) bool {
	if mediaURL(destination) {
		return true
	}
	u := safeURL(destination)
	return u != nil && mediaURL(source) && verified && delegatedHost.MatchString(strings.ToLower(u.Hostname()))
}
func downloadGranted(ctx context.Context, raw string) ([]byte, error) {
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: -1}).DialContext, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 10 * time.Second, DisableCompression: true, DisableKeepAlives: true, MaxResponseHeaderBytes: 65536}
	defer transport.CloseIdleConnections()
	return downloadWithTransport(ctx, raw, transport, maxAudio)
}
func downloadWithTransport(ctx context.Context, raw string, transport http.RoundTripper, limit int) ([]byte, error) {
	if !mediaURL(raw) || limit <= 0 || limit > maxAudio {
		return nil, errUnavailable
	}
	current := raw
	for hop := 0; hop <= 3; hop++ {
		if ctx.Err() != nil {
			return nil, errUnavailable
		}
		req, e := http.NewRequestWithContext(ctx, http.MethodGet, current, nil)
		if e != nil {
			return nil, errUnavailable
		}
		req.Header.Set("User-Agent", "LunaPC/3.7.0(452316191)")
		req.Header.Set("Accept-Encoding", "identity")
		res, e := transport.RoundTrip(req)
		if e != nil {
			if res != nil && res.Body != nil {
				_ = res.Body.Close()
			}
			return nil, errUnavailable
		}
		if res == nil || res.Body == nil {
			return nil, errUnavailable
		}
		stop := context.AfterFunc(ctx, func() { _ = res.Body.Close() })
		closeBody := func() { stop(); _ = res.Body.Close() }
		if res.StatusCode == 301 || res.StatusCode == 302 || res.StatusCode == 303 || res.StatusCode == 307 || res.StatusCode == 308 {
			closeBody()
			if hop == 3 || len(res.Header.Values("Location")) != 1 {
				return nil, errUnavailable
			}
			base, _ := url.Parse(current)
			location, e := url.Parse(res.Header.Get("Location"))
			if e != nil {
				return nil, errUnavailable
			}
			destination := base.ResolveReference(location).String()
			verified := res.TLS != nil && len(res.TLS.VerifiedChains) > 0
			if !redirectAllowed(destination, current, verified) {
				return nil, errUnavailable
			}
			current = destination
			continue
		}
		if res.StatusCode != 200 || len(res.Header.Values("Content-Encoding")) > 1 || len(res.Header.Values("Content-Length")) > 1 {
			closeBody()
			return nil, errUnavailable
		}
		encoding := res.Header.Get("Content-Encoding")
		length := res.Header.Get("Content-Length")
		expected := int64(-1)
		if encoding != "" && encoding != "identity" {
			closeBody()
			return nil, errUnavailable
		}
		if length != "" {
			for _, c := range length {
				if c < '0' || c > '9' {
					closeBody()
					return nil, errUnavailable
				}
			}
			expected, e = strconv.ParseInt(length, 10, 64)
			if e != nil || expected > int64(limit) {
				closeBody()
				return nil, errUnavailable
			}
		}
		if res.ContentLength > int64(limit) || res.Uncompressed {
			closeBody()
			return nil, errUnavailable
		}
		data, e := io.ReadAll(io.LimitReader(res.Body, int64(limit)+1))
		closeBody()
		if e != nil || len(data) == 0 || len(data) > limit || expected >= 0 && int64(len(data)) != expected || res.ContentLength > 0 && int64(len(data)) != res.ContentLength || ctx.Err() != nil {
			return nil, errUnavailable
		}
		return data, nil
	}
	return nil, errUnavailable
}

var aliases = map[string]string{"low": "standard", "medium": "standard", "standard": "standard", "higher": "higher", "high": "exhigh", "highest": "exhigh", "exhigh": "exhigh", "lossless": "lossless", "hi_res": "hires", "hires": "hires", "spatial": "spatial"}

func qualityRank(q string) int {
	switch aliases[q] {
	case "standard":
		return 0
	case "higher":
		return 1
	case "lossless":
		return 3
	case "hires":
		return 4
	case "spatial":
		return 5
	}
	return 2
}

type candidate struct {
	URL, Codec, Quality, Auth string
	Bitrate                   float64
}

func candidateQuality(c candidate) string {
	level := aliases[strings.ToLower(c.Quality)]
	if level == "hires" || level == "spatial" {
		return level
	}
	if c.Codec == "flac" {
		return "lossless"
	}
	if level == "standard" || level == "higher" || level == "exhigh" {
		return level
	}
	if c.Bitrate > 0 && c.Bitrate <= 96000 {
		return "standard"
	}
	if c.Bitrate > 0 && c.Bitrate <= 192000 {
		return "higher"
	}
	return "exhigh"
}
func rawNumber(raw json.RawMessage) (float64, bool) {
	var n float64
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) || json.Unmarshal(raw, &n) != nil || math.IsInf(n, 0) || math.IsNaN(n) {
		return 0, false
	}
	return n, true
}
func object(raw json.RawMessage) map[string]json.RawMessage {
	var m map[string]json.RawMessage
	_ = json.Unmarshal(raw, &m)
	return m
}
func rawString(raw json.RawMessage) string { var s string; _ = json.Unmarshal(raw, &s); return s }
func optionalNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return 0, true
	}
	return rawNumber(raw)
}
func grantedCandidates(raw json.RawMessage, id, quality string) (candidate, *candidate, error) {
	payload := object(raw)
	if payload == nil {
		return candidate{}, nil, errUnavailable
	}
	codes := []json.RawMessage{payload["error_code"], payload["status_code"], object(payload["status_info"])["code"]}
	for _, code := range codes {
		if len(code) == 0 || bytes.Equal(code, []byte("null")) {
			continue
		}
		n, ok := rawNumber(code)
		if !ok {
			v := rawString(code)
			var e error
			n, e = strconv.ParseFloat(v, 64)
			ok = e == nil
		}
		if !ok || n != 0 {
			return candidate{}, nil, errUnavailable
		}
	}
	track := object(payload["track"])
	trackRawID := track["id"]
	trackText := rawString(trackRawID)
	if len(trackRawID) > 0 && trackRawID[0] != '"' {
		trackText = string(trackRawID)
	}
	duration, ok := rawNumber(track["duration"])
	if !ok || duration <= 0 || trackText != id {
		return candidate{}, nil, errUnavailable
	}
	player := object(payload["track_player"])
	modelRaw := player["video_model"]
	if len(modelRaw) > 0 && modelRaw[0] == '"' {
		modelRaw = []byte(rawString(modelRaw))
	}
	model := object(modelRaw)
	seconds, ok := rawNumber(model["video_duration"])
	if !ok || seconds <= 0 || seconds > 86400 || math.Floor(seconds*1000+0.5)+2000 < duration || string(player["is_preview"]) == "true" || string(model["is_preview"]) == "true" {
		return candidate{}, nil, errUnavailable
	}
	var list []json.RawMessage
	if json.Unmarshal(model["video_list"], &list) != nil {
		return candidate{}, nil, errUnavailable
	}
	candidates := make([]candidate, 0, len(list))
	for _, item := range list {
		m := object(item)
		meta := object(m["video_meta"])
		encrypt := object(m["encrypt_info"])
		codec := strings.ToLower(rawString(meta["codec_type"]))
		source := rawString(m["main_url"])
		if (codec != "aac" && codec != "flac" && codec != "mp3") || !mediaURL(source) {
			continue
		}
		authRaw := encrypt["spade_a"]
		auth := ""
		if len(authRaw) > 0 && string(authRaw) != "null" {
			if json.Unmarshal(authRaw, &auth) != nil || len(auth) > 4096 {
				continue
			}
		}
		if auth != "" && codec == "mp3" {
			continue
		}
		size, ok := optionalNumber(meta["size"])
		if !ok || size < 0 || size > maxAudio {
			continue
		}
		bitrate, ok := optionalNumber(meta["bitrate"])
		if !ok || bitrate < 0 {
			continue
		}
		candidates = append(candidates, candidate{URL: source, Codec: codec, Quality: rawString(meta["quality"]), Auth: auth, Bitrate: bitrate})
	}
	if len(candidates) == 0 {
		return candidate{}, nil, errUnavailable
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		ra, rb := qualityRank(candidateQuality(a)), qualityRank(candidateQuality(b))
		return ra < rb || ra == rb && a.Bitrate < b.Bitrate
	})
	selected := candidates[0]
	var fallback *candidate
	for i, c := range candidates {
		if qualityRank(candidateQuality(c)) <= qualityRank(quality) {
			selected = c
		}
		if c.Codec == "aac" && (fallback == nil || qualityRank(candidateQuality(c)) <= qualityRank(quality)) {
			fallback = &candidates[i]
		}
	}
	return selected, fallback, nil
}
func nativeFLAC(data []byte) bool {
	if len(data) < 42 || string(data[:4]) != "fLaC" {
		return false
	}
	p, blocks := 4, 0
	for {
		if len(data)-p < 4 {
			return false
		}
		typ := data[p] & 0x7f
		last := data[p]&0x80 != 0
		size := int(data[p+1])<<16 | int(data[p+2])<<8 | int(data[p+3])
		if blocks == 0 && (typ != 0 || size != 34) || blocks > 0 && typ == 0 || typ == 127 {
			return false
		}
		p += 4 + size
		if p > len(data) {
			return false
		}
		blocks++
		if last {
			return p < len(data)
		}
	}
}
func nativeMP3(data []byte) bool {
	p := 0
	if len(data) >= 3 && string(data[:3]) == "ID3" {
		if len(data) < 10 {
			return false
		}
		for _, b := range data[6:10] {
			if b&0x80 != 0 {
				return false
			}
		}
		p = 10 + int(data[6])*2097152 + int(data[7])*16384 + int(data[8])*128 + int(data[9])
		if data[5]&0x10 != 0 {
			p += 10
		}
	}
	return len(data)-p >= 4 && data[p] == 0xff && data[p+1]&0xe0 == 0xe0 && data[p+1]&0x18 != 0x08 && data[p+1]&0x06 == 0x02 && data[p+2]&0xf0 != 0 && data[p+2]&0xf0 != 0xf0 && data[p+2]&0x0c != 0x0c
}
func materialize(ctx context.Context, c candidate, w *worker) (audioStream, bool, error) {
	data, e := w.download(ctx, c.URL)
	if e != nil || ctx.Err() != nil {
		return audioStream{}, false, errUnavailable
	}
	if len(data) == 0 || len(data) > maxAudio {
		return audioStream{}, false, errUnavailable
	}
	fail := func(e error) (audioStream, bool, error) {
		if e != errSetup {
			e = errUnavailable
		}
		return audioStream{}, c.Codec == "flac" && e == errUnavailable && ctx.Err() == nil, e
	}
	if c.Auth != "" {
		data, e = w.decode(ctx, data, c.Auth)
		if e != nil {
			return fail(e)
		}
	}
	if len(data) == 0 || len(data) > maxAudio {
		return fail(errUnavailable)
	}
	if c.Codec == "aac" {
		if len(data) < 8 || string(data[4:8]) != "ftyp" {
			return fail(errUnavailable)
		}
		data, e = w.convert(ctx, data)
		if e != nil {
			return fail(e)
		}
	}
	typ := "flac"
	if c.Codec == "mp3" {
		typ = "mp3"
	}
	if len(data) > maxAudio || typ == "flac" && !nativeFLAC(data) || typ == "mp3" && !nativeMP3(data) {
		return fail(errUnavailable)
	}
	quality := "high"
	if c.Codec == "flac" {
		quality = "lossless"
	} else if candidateQuality(c) == "standard" {
		quality = "standard"
	}
	return audioStream{Data: data, Type: typ, Quality: quality, BitRate: c.Bitrate}, false, nil
}
func resolvePlayback(ctx context.Context, grant json.RawMessage, id, quality string, w *worker) (audioStream, error) {
	if quality == "" {
		quality = "high"
	}
	selected, fallback, e := grantedCandidates(grant, id, quality)
	if e != nil {
		return audioStream{}, e
	}
	result, retry, e := materialize(ctx, selected, w)
	if e != nil && retry && fallback != nil && ctx.Err() == nil {
		result, _, e = materialize(ctx, *fallback, w)
	}
	if ctx.Err() != nil {
		return audioStream{}, errUnavailable
	}
	return result, e
}
