package main

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Only anonymous, content-addressed PNGs in the verified public scene icon
// collection; neither a URL, a filesystem path nor headers come from IPC.
var sceneIconKey = regexp.MustCompile(`^[0-9a-f]{32}(\.png)?$`)

const sceneIconLimit = 64

var sceneClient = &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func sceneIcons(ctx context.Context, keys []string) map[string]string {
	base, e := os.UserCacheDir()
	if e != nil {
		return nil
	}
	dir := filepath.Join(base, "mygo-qishui-scene-icons-v1")
	if os.MkdirAll(dir, 0700) != nil {
		return nil
	}
	st, e := os.Lstat(dir)
	if e != nil || !st.IsDir() {
		return nil
	}
	return cacheSceneIcons(ctx, dir, keys, sceneClient)
}

func cacheSceneIcons(ctx context.Context, dir string, keys []string, client *http.Client) map[string]string {
	result := make(map[string]string)
	if len(keys) > sceneIconLimit {
		return result
	}
	entries, e := os.ReadDir(dir)
	if e != nil {
		return result
	}
	slots := 192
	for _, entry := range entries {
		n := entry.Name()
		if !strings.HasSuffix(n, ".png") || !sceneIconKey.MatchString(strings.TrimSuffix(n, ".png")) || !entry.Type().IsRegular() {
			continue
		}
		st, e := entry.Info()
		if e == nil && time.Since(st.ModTime()) > 30*24*time.Hour && os.Remove(filepath.Join(dir, n)) == nil {
			continue
		}
		slots--
	}
	jobs := make(chan string, sceneIconLimit)
	seen := map[string]bool{}
	localURL := func(name string) string {
		p := filepath.ToSlash(filepath.Join(dir, name+".png"))
		if !strings.HasPrefix(p, "/") {
			p = "/" + p
		}
		return (&url.URL{Scheme: "file", Path: p}).String()
	}
	for _, key := range keys {
		if seen[key] || !sceneIconKey.MatchString(key) {
			continue
		}
		seen[key] = true
		path := filepath.Join(dir, key+".png")
		st, e := os.Lstat(path)
		if e == nil {
			if st.Mode().IsRegular() && validSceneIcon(path) {
				result[key] = localURL(key)
				continue
			}
			if !st.Mode().IsRegular() {
				continue // Not one of our icon files; never replace it.
			}
			// A truncated or corrupt file must be refetched. It is replaced in
			// place on success and never unlinked, so a slower worker cannot
			// delete a valid replacement another process has already installed.
			jobs <- key
			continue
		}
		if !os.IsNotExist(e) {
			continue
		}
		if slots > 0 {
			jobs <- key
			slots--
		}
	}
	close(jobs)
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	var mu sync.Mutex
	count := min(4, len(jobs))
	wg.Add(count)
	for range count {
		go func() {
			defer wg.Done()
			for key := range jobs {
				if ctx.Err() != nil {
					return
				}
				if saveSceneIcon(ctx, dir, key, client) {
					mu.Lock()
					result[key] = localURL(key)
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()
	return result
}

// A cache hit is usable only if the host can decode it; an interrupted write or
// external damage must lead to a refetch instead of a blank card. The header is
// validated before decoding so a damaged size field cannot force a large allocation.
func validSceneIcon(path string) bool {
	f, e := os.Open(path)
	if e != nil {
		return false
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil || st.Size() < 32 || st.Size() > 4<<20 {
		return false
	}
	cfg, e := png.DecodeConfig(f)
	if e != nil || cfg.Width != cfg.Height || cfg.Width < 16 || cfg.Width > 1024 {
		return false
	}
	if _, e = f.Seek(0, io.SeekStart); e != nil {
		return false
	}
	_, e = png.Decode(f)
	return e == nil
}
func saveSceneIcon(ctx context.Context, dir, key string, client *http.Client) bool {
	req, e := http.NewRequestWithContext(ctx, "GET", "https://p3-luna.douyinpic.com/img/tos-cn-i-b829550vbb/"+key+"~tplv-b829550vbb-resize:320:320.png", nil)
	if e != nil {
		return false
	}
	resp, e := client.Do(req)
	if e != nil {
		return false
	}
	defer resp.Body.Close()
	const limit = 256 << 10
	if resp.StatusCode != 200 || resp.ContentLength > limit {
		return false
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if e != nil || len(b) > limit {
		return false
	}
	img, ok := renderSceneIcon(b)
	if !ok {
		return false
	}
	f, e := os.CreateTemp(dir, ".icon-*.tmp")
	if e != nil {
		return false
	}
	defer os.Remove(f.Name())
	e = png.Encode(f, img)
	ce := f.Close()
	return e == nil && ce == nil && os.Rename(f.Name(), filepath.Join(dir, key+".png")) == nil
}
func renderSceneIcon(data []byte) (image.Image, bool) {
	cfg, e := png.DecodeConfig(bytes.NewReader(data))
	if e != nil {
		return nil, false
	}
	w, h := cfg.Width, cfg.Height
	n := max(w, h)
	// The CDN keeps the source aspect ratio for some icons, answering a
	// 320:320 resize with 318x320. A square is not required, only a close fit;
	// anything far from square is a screenshot or cover, not a glyph.
	if w < 16 || h < 16 || n > 512 || max(w, h)-min(w, h) > n/8 {
		return nil, false
	}
	im, e := png.Decode(bytes.NewReader(data))
	if e != nil {
		return nil, false
	}
	clear, ink := 0, 0
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			p := color.NRGBAModel.Convert(im.At(x, y)).(color.NRGBA)
			if p.A == 0 {
				clear++
			}
			if p.A >= 64 {
				if min(p.R, p.G, p.B) < 230 || max(p.R, p.G, p.B)-min(p.R, p.G, p.B) > 12 {
					return nil, false
				}
				ink++
			}
		}
	}
	if clear < w*h/6 || ink < w*h/100 {
		return nil, false
	}
	// A 10%-opaque neutral surface composites differently on the host's page;
	// the same image URL works after theme switches, including from its cache.
	pad := n / 8
	dst := image.NewNRGBA(image.Rect(0, 0, n+2*pad, n+2*pad))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.NRGBA{158, 158, 158, 26}), image.Point{}, draw.Src)
	b := im.Bounds()
	r := b.Add(image.Pt(pad+(n-b.Dx())/2, pad+(n-b.Dy())/2))
	draw.DrawMask(dst, r, image.NewUniform(color.NRGBA{128, 133, 137, 255}), image.Point{}, im, b.Min, draw.Over)
	return dst, true
}
