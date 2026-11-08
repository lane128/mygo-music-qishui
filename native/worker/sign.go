package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

var headerToken = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
var userInfoPath = regexp.MustCompile(`^/luna/users/[0-9]{1,32}$`)
var signPaths = map[string]bool{
	"/luna/pc/me/recently-played-media": true, "/luna/pc/feed/mode": true, "/luna/pc/feed/song-tab": true,
	"/luna/pc/discover": true, "/luna/pc/discover/mix": true, "/luna/pc/feed/radio/tracks": true, "/luna/pc/track_v2": true,
	"/luna/pc/comments": true, "/luna/pc/comments/action": true, "/luna/pc/comments/create": true,
	"/luna/pc/me/playlist": true, "/luna/pc/me/playlist/update": true, "/luna/pc/me/playlist/delete": true,
	"/luna/pc/me/playlist/media/append": true, "/luna/pc/me/playlist/media/delete": true,
	"/luna/pc/me/collection/media": true, "/luna/pc/me/collection/media/delete": true,
	"/luna/pc/me/collection/playlist": true, "/luna/pc/me/collection/playlist/delete": true,
	"/luna/pc/me/collection/artist": true, "/luna/pc/me/collection/artist/delete": true,
	"/luna/pc/me/collection/album": true, "/luna/pc/me/collection/album/delete": true,
	"/luna/pc/me/collection/mixed": true, "/luna/me/collection/artist": true,
	"/luna/me/playlist/media/sort": true,
	"/luna/pc/me/follow":           true, "/luna/pc/me/unfollow": true, "/luna/user/info": true,
}

type signSpec struct {
	URL         string
	DID         string
	HeaderLines string
}

func safeHeader(value string) bool { return !strings.ContainsAny(value, "\r\n\x00") }
func parseSign(raw []byte, did string) (signSpec, error) {
	var p struct {
		URL     string                     `json:"url"`
		DID     string                     `json:"did"`
		Headers map[string]json.RawMessage `json:"headers"`
		Lines   json.RawMessage            `json:"headerLines"`
	}
	if json.Unmarshal(raw, &p) != nil || p.DID != did || p.Headers == nil || len(p.Headers) > 64 {
		return signSpec{}, errResponse
	}
	u, e := url.Parse(p.URL)
	if e != nil || u.Scheme != "https" || u.Host != "api.qishui.com" || u.User != nil || u.Fragment != "" || (!signPaths[u.Path] && !userInfoPath.MatchString(u.Path)) || u.RawPath != "" || strings.Contains(p.URL, "#") {
		return signSpec{}, errResponse
	}
	query, e := url.ParseQuery(u.RawQuery)
	if e != nil || len(query["device_id"]) != 1 || query.Get("device_id") != did {
		return signSpec{}, errResponse
	}
	headers := map[string]string{}
	for k, value := range p.Headers {
		var v string
		if len(value) == 0 || value[0] != '"' || json.Unmarshal(value, &v) != nil {
			return signSpec{}, errResponse
		}
		lower := strings.ToLower(k)
		if !headerToken.MatchString(k) || !safeHeader(v) {
			return signSpec{}, errResponse
		}
		if _, exists := headers[lower]; exists {
			return signSpec{}, errResponse
		}
		headers[lower] = v
	}
	var lines string
	if p.Lines != nil {
		if len(p.Lines) == 0 || p.Lines[0] != '"' || json.Unmarshal(p.Lines, &lines) != nil {
			return signSpec{}, errResponse
		}
		pairs := strings.Split(lines, "\r\n")
		// Input is the SDK's alternating name/value representation, without a final separator.
		if len(headers) == 0 && lines == "" {
			pairs = nil
		}
		if len(pairs) != 2*len(headers) {
			return signSpec{}, errResponse
		}
		seen := map[string]bool{}
		for i := 0; i < len(pairs); i += 2 {
			k := strings.ToLower(pairs[i])
			v, ok := headers[k]
			if !headerToken.MatchString(pairs[i]) || !safeHeader(pairs[i+1]) || !ok || seen[k] || v != pairs[i+1] {
				return signSpec{}, errResponse
			}
			seen[k] = true
		}
	} else {
		names := make([]string, 0, len(headers))
		for k := range headers {
			names = append(names, k)
		}
		sort.Strings(names)
		pairs := make([]string, 0, len(headers)*2)
		for _, k := range names {
			pairs = append(pairs, k, headers[k])
		}
		lines = strings.Join(pairs, "\r\n")
	}
	return signSpec{URL: p.URL, DID: did, HeaderLines: lines}, nil
}
func parseSignatures(raw []byte) (map[string]string, error) {
	if len(raw) == 0 || len(raw) > 65536 {
		return nil, errUnavailable
	}
	s := string(raw)
	// Permit exactly one final empty separator; never filter arbitrary empty fields.
	s = strings.TrimSuffix(s, "\r\n")
	pairs := strings.Split(s, "\r\n")
	if len(pairs) != 4 {
		return nil, errUnavailable
	}
	out := map[string]string{}
	for i := 0; i < 4; i += 2 {
		k := strings.ToLower(pairs[i])
		v := pairs[i+1]
		if (k != "x-helios" && k != "x-medusa") || v == "" || !safeHeader(v) {
			return nil, errUnavailable
		}
		if _, ok := out[k]; ok {
			return nil, errUnavailable
		}
		out[k] = v
	}
	return out, nil
}
func signRequest(ctx context.Context, root string, s signSpec) (map[string]string, error) {
	var input bytes.Buffer
	for _, part := range []string{s.DID, s.URL, s.HeaderLines} {
		_ = binary.Write(&input, binary.BigEndian, uint32(len(part)))
		input.WriteString(part)
	}
	output, e := isolatedNative(ctx, root, "sign", input.Bytes(), 65536)
	if e != nil {
		return nil, e
	}
	return parseSignatures(output)
}
