package app

import (
	"encoding/json"
	"image"
	"image/draw"
	_ "image/jpeg"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo/ui"
	"mygo-music/internal/music"
)

type qishuiSceneFixtures struct {
	Pages    map[string]*music.Browse `json:"pages"`
	Covers   map[string]string        `json:"covers"`
	Stations []music.Station          `json:"stations"`
	Tracks   []music.Track            `json:"tracks"`
}

func loadQishuiSceneFixtures(t *testing.T) qishuiSceneFixtures {
	t.Helper()
	name := os.Getenv("QISHUI_SCENE_FIXTURE")
	if name == "" {
		t.Skip("QISHUI_SCENE_FIXTURE is not set")
	}
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	var f qishuiSceneFixtures
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}
func qishuiSceneApp(t *testing.T, fixture qishuiSceneFixtures) *app {
	t.Helper()
	a := newTestApp()
	without(a, "isLiked")
	a.account = &music.Account{ID: "synthetic-preview"}
	fake(a).info.Name = "汽水音乐"
	fake(a).info.Navigation = []music.NavItem{{Title: "首页", Builtin: "home"}, {Title: "推荐", Builtin: "stations", Icon: "star"}, {Title: "听歌模式", Page: "listening-modes", Icon: "radio"}}
	a.stations, a.stationsOnce = fixture.Stations, true
	for url, name := range fixture.Covers {
		f, err := os.Open(filepath.Join(filepath.Dir(os.Getenv("QISHUI_SCENE_FIXTURE")), name))
		if err != nil {
			t.Fatal(err)
		}
		img, _, err := image.Decode(f)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		bitmap := image.NewRGBA(img.Bounds())
		draw.Draw(bitmap, bitmap.Bounds(), img, img.Bounds().Min, draw.Src)
		giveCover(a, url, bitmap)
	}
	return a
}

// Native frames must show actual discovery photographs and the integrated stock radio, without modifying installed application data.
func TestQishui105NativeFrames(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	dir := framesDir(t)
	for _, view := range []struct{ id, file string }{{"listening-modes", "modes"}, {"listening-modes:more:1", "exploration"}, {"scene-modes", "all-modes"}, {"recommendations", "recommendations"}} {
		for _, dark := range []bool{false, true} {
			a := qishuiSceneApp(t, fixture)
			if view.id == "recommendations" {
				a.route = route{page: pageStations, src: "fake"}
				a.pl.Cue(sourced(fixture.Tracks...))
				a.pl.AttachRadio(radioName("fake", &a.stations[0]), func(func([]music.Track)) {})
			} else {
				a.browses = map[string]*browseData{view.id: {page: fixture.Pages[view.id]}}
				a.route = route{page: pageBrowse, src: "fake", id: view.id}
			}
			tt := ui.NewTester(a.view, 1200, 900)
			tt.SetDark(dark)
			settled(tt)
			theme := "light"
			if dark {
				theme = "dark"
			}
			saveFrame(t, dir, view.file+"-"+theme+".png", tt.Image())
		}
	}
}

// Native more-page navigation retains back/forward caching and dispatches the exact discovered radio ID when a photo is clicked.
func TestQishui105DiscoveryNavigation(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	a := qishuiSceneApp(t, fixture)
	ch := posts(a)
	root := *fixture.Pages["listening-modes"]
	root.Sections = root.Sections[1:]
	a.browses = map[string]*browseData{"listening-modes": {page: &root}}
	a.route = route{page: pageBrowse, src: "fake", id: "listening-modes"}
	asked := make(chan string, 8)
	fake(a).browse = func(page string) (*music.Browse, error) { asked <- page; return fixture.Pages[page], nil }
	tt := ui.NewTester(a.view, 1200, 900)
	settled(tt)
	if err := tt.Click("See All"); err != nil {
		t.Fatal(err)
	}
	nextPage := root.Sections[0].MorePage
	if page := wait(t, asked, "discovery continuation"); page != nextPage {
		t.Fatal("continuation lost its plugin route")
	}
	runPost(t, ch)
	settled(tt)
	tt.Key(0, ui.KeyBack)
	tt.Frame()
	if a.route.id != "listening-modes" {
		t.Fatal("back lost discovery root")
	}
	tt.Key(0, ui.KeyForward)
	tt.Frame()
	if a.route.id != nextPage || len(asked) != 0 {
		t.Fatal("forward did not use native page cache")
	}
	station := fixture.Pages[nextPage].Sections[0].Stations[0]
	fake(a).stationNext = func(id string) ([]music.Track, error) { asked <- id; return sourced(fixture.Tracks...), nil }
	if err := tt.Click(station.Name); err != nil {
		t.Fatal(err)
	}
	if id := wait(t, asked, "picture radio playback"); id != station.ID {
		t.Fatal("picture radio lost its identity")
	}
	until(t, ch, func() bool { return a.pl.Radio() != "" })
	_, id, _ := radioParts(a.pl.Radio())
	if id != station.ID {
		t.Fatal("picture card started a different radio")
	}
}

// The native recommendation player starts the recommendation feed and switching a common mode selects that exact feed.
func TestQishui105RecommendationControls(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	a := qishuiSceneApp(t, fixture)
	ch := posts(a)
	a.route = route{page: pageStations, src: "fake"}
	asked := make(chan string, 8)
	fake(a).stationNext = func(id string) ([]music.Track, error) { asked <- id; return sourced(fixture.Tracks...), nil }
	tt := ui.NewTester(a.view, 1200, 900)
	settled(tt)
	if err := tt.Click("Start Listening"); err != nil {
		t.Fatal(err)
	}
	if id := wait(t, asked, "recommendation start"); id != fixture.Stations[0].ID {
		t.Fatal("recommendation started the wrong station")
	}
	until(t, ch, func() bool { return a.pl.Radio() != "" })
	settled(tt)
	if err := tt.Click(fixture.Stations[2].Name); err != nil {
		t.Fatal(err)
	}
	if id := wait(t, asked, "common mode switch"); id != fixture.Stations[2].ID {
		t.Fatal("common mode did not switch its feed")
	}
	until(t, ch, func() bool { _, id, _ := radioParts(a.pl.Radio()); return id == fixture.Stations[2].ID })
}
