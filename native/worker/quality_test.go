package main

import (
	"bytes"
	"context"
	"testing"
)

func TestHighestSameGrantFallbackAndDownloadCancellation(t *testing.T) {
	for _, mode := range []string{"validation", "decode", "download-cancel"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			downloads := 0
			var auths []string
			w := &worker{
				download: func(_ context.Context, url string) ([]byte, error) {
					downloads++
					if mode == "download-cancel" {
						cancel()
						return nil, errUnavailable
					}
					if url == "https://media.douyinvod.com/flac" {
						return []byte("invalid FLAC"), nil
					}
					return fixtureM4A(t), nil
				},
				decode: func(_ context.Context, data []byte, auth string) ([]byte, error) {
					auths = append(auths, auth)
					if auth == "flac" && mode == "decode" {
						return nil, errUnavailable
					}
					return data, nil
				},
			}
			got, e := resolvePlayback(ctx, fixtureGrant(fixtureCandidate("aac", "medium", "excluded"), fixtureCandidate("aac", "higher", "lower"), fixtureCandidate("aac", "highest", "best"), fixtureCandidate("flac", "lossless", "flac")), "123", "lossless", w)
			if mode == "download-cancel" {
				if e != errUnavailable || downloads != 1 || len(auths) != 0 {
					t.Fatal("download cancellation retried")
				}
				return
			}
			if e != nil || downloads != 2 || len(auths) != 2 || auths[0] != "flac" || auths[1] != "best" || got.Type != "m4a" || got.Quality != "high" || !bytes.Equal(got.Data, fixtureM4A(t)) {
				t.Fatal("highest matching AAC fallback failed")
			}
		})
	}
}

func TestHostQualityMappingAndMediumExclusion(t *testing.T) {
	for _, c := range []struct {
		request string
		tiers   []string
		actual  string
	}{
		{"standard", []string{"medium", "higher", "highest", "lossless"}, "standard"},
		{"high", []string{"medium", "higher"}, "standard"},
		{"high", []string{"higher", "highest"}, "high"},
		{"lossless", []string{"medium", "highest"}, "high"},
		{"lossless", []string{"medium", "higher"}, "standard"},
		{"lossless", []string{"higher", "highest", "lossless"}, "lossless"},
	} {
		t.Run(c.request+"-"+c.actual, func(t *testing.T) {
			var list []map[string]any
			for _, tier := range c.tiers {
				codec := "aac"
				if tier == "lossless" {
					codec = "flac"
				}
				list = append(list, fixtureCandidate(codec, tier, ""))
			}
			w := &worker{download: func(_ context.Context, url string) ([]byte, error) {
				if url == "https://media.douyinvod.com/flac" {
					return fixtureFLAC(), nil
				}
				return fixtureM4A(t), nil
			}}
			got, e := resolvePlayback(context.Background(), fixtureGrant(list...), "123", c.request, w)
			typ := "m4a"
			data := fixtureM4A(t)
			if c.actual == "lossless" {
				typ = "flac"
				data = fixtureFLAC()
			}
			if e != nil || got.Type != typ || got.Quality != c.actual || !bytes.Equal(got.Data, data) {
				t.Fatal("quality mapping or byte preservation failed")
			}
		})
	}
	for _, quality := range []string{"standard", "high", "lossless", "unknown"} {
		downloads := 0
		w := &worker{download: func(context.Context, string) ([]byte, error) { downloads++; return fixtureM4A(t), nil }}
		if _, e := resolvePlayback(context.Background(), fixtureGrant(fixtureCandidate("aac", "medium", "")), "123", quality, w); e != errUnavailable || downloads != 0 {
			t.Fatal("medium reached playback")
		}
	}
	for _, tier := range []string{"highest", "hi_res", "spatial", "unknown"} {
		if _, _, e := grantedCandidates(fixtureGrant(fixtureCandidate("aac", tier, "")), "123", "standard"); e != errUnavailable {
			t.Fatal("higher or unknown tier admitted")
		}
	}
	downloads := 0
	w := &worker{download: func(context.Context, string) ([]byte, error) { downloads++; return []byte("invalid FLAC"), nil }}
	if _, e := resolvePlayback(context.Background(), fixtureGrant(fixtureCandidate("flac", "lossless", ""), fixtureCandidate("aac", "medium", "")), "123", "lossless", w); e != errUnavailable || downloads != 1 {
		t.Fatal("FLAC failure fell back to medium")
	}
}
