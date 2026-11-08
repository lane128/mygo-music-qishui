package player

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"mygo-music/internal/music"

	aacpcm "github.com/tphakala/go-aac/pcm"
)

type qishuiRealSample struct {
	Label          string `json:"label"`
	Tier           string `json:"tier"`
	Type           string `json:"type"`
	File           string `json:"file"`
	Reference      string `json:"reference"`
	ExpectedFrames int    `json:"expectedFrames"`
	Metadata       struct {
		ASCHex string `json:"ascHex"`
	} `json:"metadata"`
}
type qishuiRealResult struct {
	Label                string          `json:"label"`
	Tier                 string          `json:"tier"`
	Rate                 int             `json:"rate"`
	Frames               int             `json:"frames"`
	ReferenceFrames      int             `json:"referenceFrames"`
	AdvertisedFrames     int64           `json:"advertisedFrames"`
	Peak                 float64         `json:"peak"`
	ReferenceSNRDB       float64         `json:"referenceSNRDB"`
	SeekChecks           int             `json:"seekChecks"`
	WorstSeekSNRDB       float64         `json:"worstSeekSNRDB"`
	CacheAndSave         bool            `json:"cacheAndSave"`
	Passed               bool            `json:"passed"`
	ExpectedFrames       int             `json:"expectedFrames"`
	ReferenceExtraFrames int             `json:"referenceExtraFrames"`
	MaxSeekDifference    float64         `json:"maxSeekDifference"`
	ASC                  *aacpcm.ASCInfo `json:"asc,omitempty"`
}

func qishuiRealDecode(s stream) ([]float32, error) {
	defer s.Close()
	buf := make([]float32, 8192)
	var out []float32
	for {
		n, err := s.Read(buf)
		if n < 0 || n > len(buf) || n%2 != 0 {
			return nil, errors.New("invalid PCM count")
		}
		for _, x := range buf[:n] {
			if math.IsNaN(float64(x)) || math.IsInf(float64(x), 0) {
				return nil, errors.New("nonfinite PCM")
			}
		}
		out = append(out, buf[:n]...)
		if err != nil {
			if err != io.EOF {
				return nil, errors.New("decode interrupted")
			}
			break
		}
		if n == 0 {
			return nil, errors.New("decode stalled before EOF")
		}
		if len(out) > s.SampleRate()*2*3600 {
			return nil, errors.New("unexpected decode length")
		}
	}
	return out, nil
}

func qishuiRealSNR(a, b []float32) float64 {
	n := min(len(a), len(b))
	var signal, noise float64
	for i := 0; i < n; i++ {
		signal += float64(b[i]) * float64(b[i])
		d := float64(a[i]) - float64(b[i])
		noise += d * d
	}
	if noise == 0 {
		return 300
	}
	if signal == 0 {
		return -300
	}
	return math.Max(-300, math.Min(300, 10*math.Log10(signal/noise)))
}

// Real authorized songs must decode to EOF, preserve timing, seek against sequential PCM, and survive host caching and saving.
func TestQishuiRealAudio(t *testing.T) {
	file := os.Getenv("QISHUI_REAL_AUDIO_MANIFEST")
	if file == "" {
		t.Skip("set QISHUI_REAL_AUDIO_MANIFEST to a private manifest of authorized local audio")
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal("cannot read private manifest")
	}
	var manifest struct {
		Samples []qishuiRealSample `json:"samples"`
	}
	if json.Unmarshal(raw, &manifest) != nil || len(manifest.Samples) == 0 {
		t.Fatal("invalid or empty private manifest")
	}
	results := make([]qishuiRealResult, 0, len(manifest.Samples))
	for _, sample := range manifest.Samples {
		t.Run(sample.Label+"_"+sample.Tier, func(t *testing.T) {
			result := qishuiRealResult{Label: sample.Label, Tier: sample.Tier, WorstSeekSNRDB: 300}
			defer func() { result.Passed = !t.Failed(); results = append(results, result) }()
			b, err := os.ReadFile(sample.File)
			if err != nil {
				t.Fatal("cannot read authorized audio")
			}
			s, err := openStream(downloaded(b), 0)
			if err != nil {
				t.Fatal("host rejected authorized audio")
			}
			result.Rate = s.SampleRate()
			result.AdvertisedFrames = s.Len()
			result.ExpectedFrames = sample.ExpectedFrames
			if sample.Type == "m4a" {
				raw, e := hex.DecodeString(sample.Metadata.ASCHex)
				if e != nil {
					t.Fatal("invalid ASC metadata")
				}
				asc, e := aacpcm.ParseASC(raw)
				result.ASC = &asc
				if e != nil {
					t.Error("full ASC is unsupported")
				}
			}
			got, err := qishuiRealDecode(s)
			if err != nil {
				t.Fatal(err)
			}
			result.Frames = len(got) / 2
			for _, x := range got {
				result.Peak = math.Max(result.Peak, math.Abs(float64(x)))
			}
			if result.Frames == 0 || result.Peak == 0 {
				t.Error("empty or silent audio")
			}
			if result.AdvertisedFrames != int64(result.Frames) {
				t.Errorf("length reports %d frames but decodes %d", result.AdvertisedFrames, result.Frames)
			}
			refBytes, err := os.ReadFile(sample.Reference)
			if err != nil {
				t.Fatal("cannot read independent reference")
			}
			reference, err := openStream(downloaded(refBytes), 0)
			if err != nil {
				t.Fatal("cannot open independent reference")
			}
			if reference.SampleRate() != result.Rate {
				t.Error("sample rate differs from reference")
			}
			ref, err := qishuiRealDecode(reference)
			if err != nil {
				t.Fatal(err)
			}
			result.ReferenceFrames = len(ref) / 2
			result.ReferenceExtraFrames = (len(ref) - len(got)) / 2
			// Use independently parsed STTS minus edit-list priming as the M4A oracle.
			// FFmpeg's default conversion can retain part of the final padded AAC packet.
			if sample.Type == "m4a" {
				if sample.ExpectedFrames <= 0 || len(got)/2 != sample.ExpectedFrames {
					t.Errorf("host decoded %d frames; container timing requires %d", len(got)/2, sample.ExpectedFrames)
				}
				if len(ref) < len(got) || len(ref)-len(got) >= 2048 {
					t.Error("reference duration differs by more than final AAC padding")
				}
			} else if len(got) != len(ref) {
				t.Error("lossless duration differs from reference")
			}
			result.ReferenceSNRDB = qishuiRealSNR(got, ref)
			if result.ReferenceSNRDB < 20 {
				t.Errorf("reference PCM differs: %.2f dB SNR", result.ReferenceSNRDB)
			}
			seek, err := openStream(downloaded(b), 0)
			if err != nil {
				t.Fatal("cannot reopen for seeking")
			}
			defer seek.Close()
			for _, frame := range []int64{0, 1, 1023, 1024, int64(result.Rate) * 30, int64(result.Frames / 2), int64(result.Frames - result.Rate), int64(result.Frames - 1), 0} {
				if frame < 0 || frame >= int64(result.Frames) {
					continue
				}
				if err := seek.SetPosition(frame); err != nil {
					t.Error("seek rejected")
					continue
				}
				want := min(result.Rate/2, result.Frames-int(frame)) * 2
				audio := make([]float32, want)
				n := 0
				for n < want {
					count, e := seek.Read(audio[n:])
					n += count
					if e != nil {
						if e != io.EOF {
							t.Error("seek decode interrupted")
						}
						break
					}
					if count == 0 {
						break
					}
				}
				if n != want {
					t.Errorf("seek frame %d returned %d samples, want %d", frame, n, want)
					continue
				}
				db := qishuiRealSNR(audio, got[frame*2:frame*2+int64(want)])
				result.WorstSeekSNRDB = math.Min(result.WorstSeekSNRDB, db)
				result.SeekChecks++
				diff := maxDiff(audio, got[frame*2:frame*2+int64(want)])
				result.MaxSeekDifference = math.Max(result.MaxSeekDifference, diff)
				t.Logf("seek frame=%d SNR=%.2fdB maxDifference=%.6f", frame, db, diff)
				// Match the host's AAC seek oracle: reconstructed noise may differ on seeks.
				if diff > 0.05 {
					t.Errorf("seek frame %d differs by %.6f (SNR %.2f dB)", frame, diff, db)
				}
			}
			quality := "high"
			if sample.Tier == "higher" {
				quality = "standard"
			} else if sample.Tier == "lossless" {
				quality = "lossless"
			}
			t.Run("cache_and_download", func(t *testing.T) {
				qishuiRealCacheAndSave(t, b, sample.Type, quality)
				result.CacheAndSave = !t.Failed()
			})
			t.Logf("rate=%d frames=%d reference=%d peak=%.5f referenceSNR=%.2fdB seekChecks=%d worstSeekSNR=%.2fdB cacheAndSave=%t", result.Rate, result.Frames, result.ReferenceFrames, result.Peak, result.ReferenceSNRDB, result.SeekChecks, result.WorstSeekSNRDB, result.CacheAndSave)
		})
	}
	if out := os.Getenv("QISHUI_REAL_AUDIO_RESULTS"); out != "" {
		b, e := json.MarshalIndent(results, "", "  ")
		if e != nil || os.WriteFile(out, b, 0o600) != nil {
			t.Error("cannot write sanitized results")
		}
	}
}

func qishuiRealCacheAndSave(t *testing.T, b []byte, kind, quality string) {
	t.Helper()
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1); w.Write(b) }))
	defer srv.Close()
	p := New(func(func()) {})
	p.Cache = NewCache(t.TempDir(), 1<<30)
	st := music.Stream{URL: srv.URL, Type: kind, Size: int64(len(b)), Quality: quality}
	dl := p.Cache.download("qishui-real-test", "sample", quality, &st)
	dl.waitFor(int64(len(b)) + 1)
	dl.mu.Lock()
	done, downloadErr := dl.done, dl.err
	dl.mu.Unlock()
	dl.Close()
	if !done || downloadErr != nil {
		t.Fatal("host cache download failed")
	}
	srv.Close()
	cached, meta, ok := p.Cache.lookup("qishui-real-test", "sample", quality)
	if !ok {
		t.Fatal("real file was not cached")
	}
	if meta.Type != kind || meta.Quality != quality || meta.URL != "" || len(meta.Headers) != 0 {
		t.Error("cache type or sanitized metadata incorrect")
	}
	s, err := openStream(cached, 0)
	if err != nil {
		cached.Close()
		t.Fatal("cached file cannot decode")
	}
	buf := make([]float32, 8192)
	n, err := s.Read(buf)
	s.Close()
	if n == 0 || (err != nil && err != io.EOF) {
		t.Error("cached file cannot play")
	}
	song, err := p.FindSong(nil, music.Track{ID: "sample", Source: "qishui-real-test"}, quality)
	if err != nil {
		t.Fatal("offline cache hit failed")
	}
	if song.Type != kind {
		t.Error("saved type differs")
	}
	file := filepath.Join(t.TempDir(), "saved."+kind)
	if song.SaveTo(file) != nil {
		t.Fatal("cached song save failed")
	}
	saved, err := os.ReadFile(file)
	if err != nil || !bytes.Equal(saved, b) {
		t.Fatal("cached save changes audio bytes")
	}
	var asked int
	source := streamer{st: st, asked: &asked}
	fresh := New(func(func()) {})
	online := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(b) }))
	defer online.Close()
	source.st.URL = online.URL
	direct, err := fresh.FindSong(source, music.Track{ID: "fresh", Source: "src"}, quality)
	if err != nil {
		t.Fatal("source download lookup failed")
	}
	target := filepath.Join(t.TempDir(), "downloaded."+kind)
	if direct.Type != kind || direct.SaveTo(target) != nil {
		t.Fatal("source save failed")
	}
	saved, err = os.ReadFile(target)
	if err != nil || !bytes.Equal(saved, b) {
		t.Error("source save changes audio bytes")
	}
	if requests.Load() != 1 || asked != 1 {
		t.Error("cache hit unexpectedly requested source")
	}
}
