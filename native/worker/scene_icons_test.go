package main

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type iconTransport func(*http.Request) (*http.Response, error)

func (f iconTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestSceneIconCache(t *testing.T) {
	key := strings.Repeat("a", 32) + ".png"
	dir := t.TempDir()
	icon := image.NewNRGBA(image.Rect(0, 0, 96, 96))
	for y := 20; y < 76; y++ {
		for x := 20; x < 76; x++ {
			icon.SetNRGBA(x, y, color.NRGBA{255, 255, 255, 255})
		}
	}
	var calls int
	client := &http.Client{Transport: iconTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "p3-luna.douyinpic.com" || r.URL.Path != "/img/tos-cn-i-b829550vbb/"+key+"~tplv-b829550vbb-resize:320:320.png" || r.Header.Get("Cookie") != "" {
			t.Fatal("unexpected icon request")
		}
		var buf bytes.Buffer
		png.Encode(&buf, icon)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(&buf), Header: make(http.Header)}, nil
	})}
	for i := 0; i < 2; i++ {
		got := cacheSceneIcons(context.Background(), dir, []string{key, key, "../other", "https://example.invalid/photo"}, client)
		if len(got) != 1 || !strings.HasPrefix(got[key], "file:///") {
			t.Fatalf("missing derived cover: %v", got)
		}
	}
	if calls != 1 {
		t.Fatalf("cache miss or invalid URL fetched (%d calls)", calls)
	}
	f, e := os.Open(filepath.Join(dir, key+".png"))
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	img, e := png.Decode(f)
	if e != nil {
		t.Fatal(e)
	}
	_, _, _, a := img.At(0, 0).RGBA()
	if a < 0x1600 || a > 0x2000 {
		t.Fatalf("background cannot follow the host: alpha %d", a)
	}
	s := img.Bounds().Dx() / 2
	r, _, _, a := img.At(s, s).RGBA()
	if r < 0x7500 || r > 0x9000 || a != 65535 {
		t.Fatalf("icon not readable in both themes: %d %d", r, a)
	}
}
func TestSceneIconRepairsInvalidCacheFiles(t *testing.T) {
	for _, cached := range [][]byte{nil, []byte("<html>not a png</html>")} {
		key := strings.Repeat("c", 32) + ".png"
		dir := t.TempDir()
		if e := os.WriteFile(filepath.Join(dir, key+".png"), cached, 0600); e != nil {
			t.Fatal(e)
		}
		icon := image.NewNRGBA(image.Rect(0, 0, 96, 96))
		for y := 20; y < 76; y++ {
			for x := 20; x < 76; x++ {
				icon.SetNRGBA(x, y, color.NRGBA{255, 255, 255, 255})
			}
		}
		var calls int
		client := &http.Client{Transport: iconTransport(func(r *http.Request) (*http.Response, error) {
			calls++
			var buf bytes.Buffer
			png.Encode(&buf, icon)
			return &http.Response{StatusCode: 200, Body: io.NopCloser(&buf), Header: make(http.Header)}, nil
		})}
		got := cacheSceneIcons(context.Background(), dir, []string{key}, client)
		if calls != 1 || !strings.HasPrefix(got[key], "file:///") {
			t.Fatalf("invalid cache file reused: calls=%d url=%q", calls, got[key])
		}
		f, e := os.Open(filepath.Join(dir, key+".png"))
		if e != nil {
			t.Fatal(e)
		}
		img, e := png.Decode(f)
		f.Close()
		if e != nil {
			t.Fatalf("cache file not repaired: %v", e)
		}
		if b := img.Bounds(); b.Dx() != b.Dy() || b.Dx() < 16 {
			t.Fatalf("repaired cache has unexpected size: %v", b)
		}
	}
}
func TestSceneIconRepairsCorruptEntryAtCapacity(t *testing.T) {
	dir := t.TempDir()
	var buf bytes.Buffer
	blank := image.NewNRGBA(image.Rect(0, 0, 16, 16))
	if e := png.Encode(&buf, blank); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 191; i++ {
		name := fmt.Sprintf("%032x.png", i)
		if e := os.WriteFile(filepath.Join(dir, name), buf.Bytes(), 0600); e != nil {
			t.Fatal(e)
		}
	}
	key := strings.Repeat("e", 32) + ".png"
	if e := os.WriteFile(filepath.Join(dir, key+".png"), nil, 0600); e != nil {
		t.Fatal(e)
	}
	icon := image.NewNRGBA(image.Rect(0, 0, 96, 96))
	for y := 20; y < 76; y++ {
		for x := 20; x < 76; x++ {
			icon.SetNRGBA(x, y, color.NRGBA{255, 255, 255, 255})
		}
	}
	var calls int
	client := &http.Client{Transport: iconTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		var out bytes.Buffer
		png.Encode(&out, icon)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(&out), Header: make(http.Header)}, nil
	})}
	got := cacheSceneIcons(context.Background(), dir, []string{key}, client)
	if calls != 1 || !strings.HasPrefix(got[key], "file:///") {
		t.Fatalf("corrupt entry skipped at capacity: calls=%d url=%q", calls, got[key])
	}
}
func TestSceneIconFailedRepairKeepsCacheFile(t *testing.T) {
	key := strings.Repeat("f", 32) + ".png"
	dir := t.TempDir()
	path := filepath.Join(dir, key+".png")
	if e := os.WriteFile(path, []byte("<html>not a png</html>"), 0600); e != nil {
		t.Fatal(e)
	}
	client := &http.Client{Transport: iconTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	})}
	got := cacheSceneIcons(context.Background(), dir, []string{key}, client)
	if _, ok := got[key]; ok {
		t.Fatalf("unusable file handed to the host: %v", got)
	}
	// Removing it first would leave nothing at all if the refetch fails, and a
	// slower worker could delete a valid replacement made by another process.
	if _, e := os.Stat(path); e != nil {
		t.Fatalf("corrupt cache entry was deleted without a replacement: %v", e)
	}
}
func TestSceneIconAcceptsNearlySquareIcons(t *testing.T) {
	// The official CDN preserves the source aspect ratio for some icons and
	// answers a 320:320 resize with 318x320.
	icon := image.NewNRGBA(image.Rect(0, 0, 96, 98))
	for y := 20; y < 78; y++ {
		for x := 20; x < 76; x++ {
			icon.SetNRGBA(x, y, color.NRGBA{255, 255, 255, 255})
		}
	}
	var b bytes.Buffer
	if e := png.Encode(&b, icon); e != nil {
		t.Fatal(e)
	}
	img, ok := renderSceneIcon(b.Bytes())
	if !ok {
		t.Fatal("official nearly square icon rejected")
	}
	if bounds := img.Bounds(); bounds.Dx() != bounds.Dy() {
		t.Fatalf("derived cover is not square: %v", bounds)
	}
}
func TestSceneIconRejectsPhotosAndBlankImages(t *testing.T) {
	for _, c := range []color.NRGBA{{255, 255, 255, 255}, {0, 0, 0, 0}, {220, 15, 18, 255}} {
		im := image.NewNRGBA(image.Rect(0, 0, 48, 48))
		for y := 0; y < 48; y++ {
			for x := 0; x < 48; x++ {
				if c.R != 220 || x%4 != 0 {
					im.SetNRGBA(x, y, c)
				}
			}
		}
		var b bytes.Buffer
		png.Encode(&b, im)
		if _, ok := renderSceneIcon(b.Bytes()); ok {
			t.Fatalf("non white-transparent icon accepted: %v", c)
		}
	}
}
