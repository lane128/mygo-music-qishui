package app

import (
	"testing"

	"github.com/egoist/mygo/ui"
	"mygo-music/internal/music"
)

// Home frames show the production discovery-only composition in both themes using public artwork.
func TestQishuiHomeFrames(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	if fixture.Pages["home"] == nil {
		t.Skip("fixture has no home")
	}
	dir := framesDir(t)
	for _, dark := range []bool{false, true} {
		a := qishuiSceneApp(t, fixture)
		a.home = fixture.Pages["home"]
		a.route = route{page: pageHome, src: "fake"}
		tt := ui.NewTester(a.view, 1200, 900)
		tt.SetDark(dark)
		settled(tt)
		theme := "light"
		if dark {
			theme = "dark"
		}
		saveFrame(t, dir, "home-"+theme+".png", tt.Image())
	}
}

// Home's discovery link opens the complete page and retains cached back/forward navigation.
func TestQishuiHomeDiscoveryNavigation(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	a := qishuiSceneApp(t, fixture)
	ch := posts(a)
	a.home = fixture.Pages["home"]
	a.route = route{page: pageHome, src: "fake"}
	asked := make(chan string, 8)
	fake(a).browse = func(page string) (*music.Browse, error) { asked <- page; return fixture.Pages[page], nil }
	tt := ui.NewTester(a.view, 1200, 900)
	settled(tt)
	if err := tt.Click("See All"); err != nil {
		t.Fatal(err)
	}
	page := a.home.Sections[0].MorePage
	if got := wait(t, asked, "home discovery destination"); got != page {
		t.Fatal("home opened the wrong page")
	}
	runPost(t, ch)
	settled(tt)
	tt.Key(0, ui.KeyBack)
	tt.Frame()
	if a.route != (route{page: pageHome, src: "fake"}) {
		t.Fatal("back lost the plugin home")
	}
	tt.Key(0, ui.KeyForward)
	tt.Frame()
	if a.route.id != page || len(asked) != 0 {
		t.Fatal("forward did not reuse its cached discovery page")
	}
}

// Clicking an exploration image starts its exact radio rather than a generic recommendation feed.
func TestQishuiHomeRadioAction(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	a := qishuiSceneApp(t, fixture)
	ch := posts(a)
	a.home = fixture.Pages["home"]
	a.route = route{page: pageHome, src: "fake"}
	asked := make(chan string, 8)
	fake(a).stationNext = func(id string) ([]music.Track, error) { asked <- id; return sourced(fixture.Tracks...), nil }
	tt := ui.NewTester(a.view, 1200, 900)
	settled(tt)
	station := a.home.Sections[0].Stations[0]
	if err := tt.Click(station.Name); err != nil {
		t.Fatal(err)
	}
	if id := wait(t, asked, "home radio click"); id != station.ID {
		t.Fatal("home started a different radio")
	}
	until(t, ch, func() bool { return a.pl.Radio() != "" })
	_, id, _ := radioParts(a.pl.Radio())
	if id != station.ID {
		t.Fatal("home radio lost its playback identity")
	}
}

// A discovered playlist opens its own list, and an empty sidebar playlist renders successfully with no songs.
func TestQishuiHomePlaylistActions(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	for _, sidebar := range []bool{false, true} {
		t.Run(map[bool]string{false: "discovery", true: "empty-sidebar"}[sidebar], func(t *testing.T) {
			a := qishuiSceneApp(t, fixture)
			ch := posts(a)
			playlist := music.Playlist{ID: "synthetic-playlist", Name: "Synthetic playlist", ImageURL: fixture.Pages["home"].Sections[0].Stations[0].ImageURL}
			home := *fixture.Pages["home"]
			if sidebar {
				a.mine = []music.Playlist{playlist}
			} else {
				home.Sections = []music.Section{{Playlists: []music.Playlist{playlist}}}
			}
			a.home = &home
			a.route = route{page: pageHome, src: "fake"}
			asked := make(chan string, 8)
			fake(a).playlist = func(id string) (*music.Playlist, error) {
				asked <- id
				result := playlist
				if !sidebar {
					result.Tracks = sourced(fixture.Tracks...)
				}
				return &result, nil
			}
			tt := ui.NewTester(a.view, 1200, 900)
			settled(tt)
			if err := tt.Click(playlist.Name); err != nil {
				t.Fatal(err)
			}
			if id := wait(t, asked, "playlist click"); id != playlist.ID {
				t.Fatal("playlist lost its ID")
			}
			runPost(t, ch)
			settled(tt)
			loaded := a.playlists[playlist.ID]
			if loaded == nil || a.plErr[playlist.ID] != "" || a.loadingPl[playlist.ID] {
				t.Fatal("playlist did not finish loading successfully")
			}
			if a.route != (route{page: pagePlaylist, src: "fake", id: playlist.ID}) {
				t.Fatal("playlist opened the wrong route")
			}
			if sidebar && len(loaded.Tracks) != 0 {
				t.Fatal("empty playlist contains fabricated songs")
			}
		})
	}
}
