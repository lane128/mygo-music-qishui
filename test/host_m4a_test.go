package player

import (
	"math"
	"os"
	"path/filepath"
	"testing"
)

// Legacy capability diagnostic: these iTunes/HE fixtures are outside the passthrough guard.
func TestQishuiM4AEditListDecode(t *testing.T) {
	root := os.Getenv("QISHUI_AUDIO_FIXTURES")
	if root == "" {
		t.Skip("set QISHUI_AUDIO_FIXTURES to the plugin's test/fixtures")
	}
	b, err := os.ReadFile(filepath.Join(root, "aac-editlist.m4a"))
	if err != nil {
		t.Fatal(err)
	}
	got := decodeAll(t, b)
	if len(got) != 44100*2 {
		t.Fatalf("edit-list frame count=%d, want 44100", len(got)/2)
	}
	peak := float64(0)
	for _, value := range got {
		x := float64(value)
		if math.IsNaN(x) || math.IsInf(x, 0) || math.Abs(x) > 1 {
			t.Fatal("invalid PCM or peak overflow")
		}
		peak = math.Max(peak, math.Abs(x))
	}
	if peak < 0.9 {
		t.Fatal("full-scale fixture failed to exercise peaks")
	}
	seekLands(t, b, got, 0.05, 0, 1, 1023, 1024, 22050, 44099, 0)
}

// Compare auxiliary-track variants against the same encoded full-scale sound track.
func TestQishuiM4ATextTrackDecode(t *testing.T) {
	root := os.Getenv("QISHUI_TEXT_AUDIO_FIXTURES")
	if root == "" {
		t.Skip("set QISHUI_TEXT_AUDIO_FIXTURES to generated auxiliary-track fixtures")
	}
	original, err := os.ReadFile(filepath.Join(root, "original.m4a"))
	if err != nil {
		t.Fatal(err)
	}
	want := decodeAll(t, original)
	if len(want) != 44100*2 {
		t.Fatal("unexpected baseline frame count")
	}
	for _, name := range []string{"prefix", "suffix", "text-first", "co64"} {
		t.Run(name, func(t *testing.T) {
			b, err := os.ReadFile(filepath.Join(root, name+".m4a"))
			if err != nil {
				t.Fatal(err)
			}
			got := decodeAll(t, b)
			if len(got) != len(want) {
				t.Fatalf("frames=%d, want %d", len(got)/2, len(want)/2)
			}
			peak := float64(0)
			for i, sample := range got {
				x := float64(sample)
				if math.IsNaN(x) || math.IsInf(x, 0) || math.Abs(x) > 1 || sample != want[i] {
					t.Fatal("auxiliary track changed PCM or full-scale bounds")
				}
				peak = math.Max(peak, math.Abs(x))
			}
			if peak < 0.9 {
				t.Fatal("fixture did not exercise full-scale peaks")
			}
			seekLands(t, b, got, 0.05, 0, 1, 1023, 1024, 22050, 44099, 0)
			t.Logf("frames=%d peak=%.6f PCM identical to sound-only fixture", len(got)/2, peak)
		})
	}
}

func TestQishuiM4AHostDecode(t *testing.T) {
	root := os.Getenv("QISHUI_AUDIO_FIXTURES")
	if root == "" {
		t.Skip("set QISHUI_AUDIO_FIXTURES to the plugin's test/fixtures")
	}
	for _, tc := range []struct {
		name           string
		rate, min, max int
	}{
		// These fixtures carry iTunSMPB: 0.1s for LC, 1s for the others.
		{"aac-lc.m4a", 48000, 4800, 4800},
		{"aac-he.m4a", 44100, 44100, 44100},
		{"aac-hev2.m4a", 44100, 44100, 44100},
		{"aac-fullscale.m4a", 44100, 44100, 44100},
		{"aac-transient.m4a", 44100, 44100, 44100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, err := os.ReadFile(filepath.Join(root, tc.name))
			if err != nil {
				t.Fatal(err)
			}
			s, err := openStream(downloaded(b), 0)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if s.SampleRate() != tc.rate {
				t.Fatalf("sample rate %d, want %d", s.SampleRate(), tc.rate)
			}
			got := decodeAll(t, b)
			frames := len(got) / 2
			if frames < tc.min || frames > tc.max {
				t.Fatalf("decoded %d frames, want %d..%d", frames, tc.min, tc.max)
			}
			peak := float64(0)
			for _, sample := range got {
				v := float64(sample)
				if math.IsNaN(v) || math.IsInf(v, 0) {
					t.Fatal("nonfinite PCM")
				}
				peak = math.Max(peak, math.Abs(v))
			}
			if peak == 0 {
				t.Fatal("silent PCM")
			}
			t.Logf("frames=%d peak=%.6f", frames, peak)
			seekLands(t, b, got, 0.05, 0, 1, int64(frames/2))
		})
	}
}
