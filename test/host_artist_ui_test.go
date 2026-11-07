package app

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"mygo-music/internal/music"
)

// Clicking an individual Qishui credit in Now Playing and then in an artist's
// song row must load that artist's page without starting a different song.
func TestQishuiArtistNameNavigation(t *testing.T) {
	a := newTestApp()
	without(a, "album", "followArtist")
	ch := posts(a)
	asked := make(chan string, 4)
	fake(a).artist = func(id string) (*music.ArtistPage, error) {
		asked <- id
		return &music.ArtistPage{
			Artist: music.Artist{ID: id, Name: "Fixture Artist " + id},
			Tracks: []music.Track{{ID: "91", Source: "fake", Name: "Hot Song", Duration: 180000,
				Artists: []music.Artist{{ID: "93", Name: "Fixture Artist C"}}}},
		}, nil
	}
	duet := music.Track{ID: "90", Source: "fake", Name: "Current Song", Duration: 180000,
		Artists: []music.Artist{{ID: "91", Name: "Fixture Artist A"}, {ID: "92", Name: "Fixture Artist B"}}}
	a.pl.Cue([]music.Track{duet})
	a.pl.SetLyrics(nil)
	a.nowPlaying = true
	tt := ui.NewTester(a.view, 1200, 800)
	tt.Frame()
	tt.Advance(time.Second)
	tt.Frame()
	if err := tt.Click("Fixture Artist B"); err != nil {
		t.Fatal(err)
	}
	if id := wait(t, asked, "Qishui artist from Now Playing"); id != "92" {
		t.Fatal("clicked the second credit but requested another artist")
	}
	until(t, ch, func() bool { return a.artists["92"] != nil && a.artists["92"].page != nil })
	tt.Frame()
	if a.nowPlaying || a.route != (route{page: pageArtist, src: "fake", id: "92"}) || a.artists["92"].page.Artist.ID != "92" {
		t.Fatal("Now Playing credit did not open its native artist page")
	}
	tt.Advance(time.Second)
	tt.Frame()
	r, ok := tt.Find("Fixture Artist C")
	if !ok {
		t.Fatal("artist credit missing from the loaded hot-song row")
	}
	tt.ClickAt(r.X+4, r.Y+r.H/2)
	if id := wait(t, asked, "Qishui artist from song row"); id != "93" {
		t.Fatal("song credit requested a different artist")
	}
	until(t, ch, func() bool { return a.artists["93"] != nil && a.artists["93"].page != nil })
	tt.Frame()
	if a.route.id != "93" || a.artists["93"].page.Artist.ID != "93" {
		t.Fatal("song credit did not load its artist page")
	}
	if current := a.pl.Current(); current == nil || current.ID != duet.ID {
		t.Fatal("clicking a credit started the row's song")
	}
	tt.Key(0, ui.KeyBack)
	tt.Frame()
	if a.route.id != "92" || len(asked) != 0 {
		t.Fatal("Back did not restore the previous artist page")
	}
}
