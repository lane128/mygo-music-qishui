// Copy into MyGO's internal/app package alongside the other Qishui UI tests.
package app

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"mygo-music/internal/music"
)

// A singer's album tab opens the selected album, whose play button queues its songs in order.
func TestQishuiArtistAlbumsAndAlbumPlay(t *testing.T) {
	a := newTestApp()
	without(a, "isLiked", "like", "saveAlbum", "followArtist")
	ch := posts(a)
	asked := make(chan string, 4)
	ar := music.Artist{ID: "92", Name: "Fixture Singer"}
	record := music.Album{ID: "63", Name: "Fixture Record", Artists: []music.Artist{ar}, Released: "2025-10-01"}
	fake(a).artist = func(id string) (*music.ArtistPage, error) {
		return &music.ArtistPage{Artist: ar, Tracks: []music.Track{{ID: "91", Source: "fake", Name: "Singer Song", Duration: 180000}}, Albums: []music.Album{record}}, nil
	}
	fake(a).album = func(id string) (*music.AlbumPage, error) {
		asked <- id
		return &music.AlbumPage{Album: record, Tracks: []music.Track{
			{ID: "94", Source: "fake", Name: "Record Opening", Duration: 180000, Album: record, Artists: []music.Artist{ar}},
			{ID: "95", Source: "fake", Name: "Record Ending", Duration: 180000, Album: record, Artists: []music.Artist{ar}},
		}}, nil
	}
	a.openArtist("fake", "92")
	tt := ui.NewTester(a.view, 1200, 800)
	tt.Frame()
	until(t, ch, func() bool { return a.artists["92"] != nil && a.artists["92"].page != nil })
	tt.Advance(time.Second)
	tt.Frame()
	if err := tt.Click("Albums"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("Fixture Record"); err != nil {
		t.Fatal(err)
	}
	if id := wait(t, asked, "Qishui album from artist grid"); id != "63" {
		t.Fatal("album tab requested another record")
	}
	until(t, ch, func() bool { return a.albums["63"] != nil && a.albums["63"].album != nil })
	tt.Advance(time.Second)
	tt.Frame()
	if a.route.page != pageAlbum || a.route.id != "63" || a.pl.Current() != nil {
		t.Fatal("opening an album changed playback or failed to navigate")
	}
	if err := tt.Click("Play"); err != nil {
		t.Fatal(err)
	}
	if current := a.pl.Current(); current == nil || current.ID != "94" || len(a.pl.Queue()) != 2 || a.pl.Queue()[1].ID != "95" {
		t.Fatal("album play did not queue its songs in official order")
	}
}
