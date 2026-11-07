package app

import (
	"encoding/json"
	"image"
	"image/color"
	"image/draw"
	_ "image/jpeg"
	_ "image/png"
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
		// Offline checks use test pixels. Optional public-image checks read
		// temporary downloads, never images from an installed plugin package.
		var img image.Image = &image.Uniform{C: color.RGBA{R: 52, G: 103, B: 137, A: 255}}
		bounds := image.Rect(0, 0, 320, 320)
		if name != "" {
			if filepath.Base(name) != name {
				t.Fatal("fixture image must be in its temporary directory")
			}
			file, err := os.Open(filepath.Join(filepath.Dir(os.Getenv("QISHUI_SCENE_FIXTURE")), name))
			if err != nil {
				t.Fatal(err)
			}
			img, _, err = image.Decode(file)
			file.Close()
			if err != nil {
				t.Fatal(err)
			}
			bounds = img.Bounds()
		}
		bitmap := image.NewRGBA(bounds)
		draw.Draw(bitmap, bitmap.Bounds(), img, bounds.Min, draw.Src)
		giveCover(a, url, bitmap)
	}
	return a
}

// Native frames show remote-cover fixtures, missing-cover defaults and the stock radio without touching installed application data.
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
			if view.id == "listening-modes" {
				tt.Scroll(800, 400, 0, 100000)
				settled(tt)
				saveFrame(t, dir, view.file+"-bottom-"+theme+".png", tt.Image())
			}
		}
	}
}

// A mode without a provider cover remains playable with the host default in either theme.
func TestQishuiMissingCoverModeAction(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	for _, dark := range []bool{false, true} {
		a := qishuiSceneApp(t, fixture)
		ch := posts(a)
		page := fixture.Pages["scene-modes"]
		station := page.Sections[0].Stations[2]
		if station.ImageURL != "" {
			t.Fatal("fixture must include a scene without a cover")
		}
		a.browses = map[string]*browseData{"scene-modes": {page: page}}
		a.route = route{page: pageBrowse, src: "fake", id: "scene-modes"}
		asked := make(chan string, 8)
		fake(a).stationNext = func(id string) ([]music.Track, error) {
			asked <- id
			return sourced(fixture.Tracks...), nil
		}
		tt := ui.NewTester(a.view, 1200, 900)
		tt.SetDark(dark)
		settled(tt)
		if err := tt.Click(station.Name); err != nil {
			t.Fatal(err)
		}
		if id := wait(t, asked, "mode without a cover"); id != station.ID {
			t.Fatal("missing cover changed the requested station")
		}
		until(t, ch, func() bool { return a.pl.Radio() != "" })
		_, id, _ := radioParts(a.pl.Radio())
		if id != station.ID {
			t.Fatal("missing cover changed the active radio")
		}
	}
}

// Clicking the bottom exploration link loads the next batch, retains back/forward caching and preserves the discovered radio ID.
func TestQishui105DiscoveryNavigation(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	a := qishuiSceneApp(t, fixture)
	ch := posts(a)
	root := *fixture.Pages["listening-modes"]
	root.Sections = root.Sections[1:]
	a.browses = map[string]*browseData{}
	a.route = route{page: pageBrowse, src: "fake", id: "listening-modes"}
	asked := make(chan string, 8)
	fake(a).browse = func(page string) (*music.Browse, error) {
		asked <- page
		if page == "listening-modes" {
			return &root, nil
		}
		return fixture.Pages[page], nil
	}
	// Loading through the host also initializes freshness metadata in MyGO 0.1.20.
	a.loadBrowse(a.library, "listening-modes", false)
	if page := wait(t, asked, "initial discovery page"); page != "listening-modes" {
		t.Fatal("initial discovery opened a different page")
	}
	runPost(t, ch)
	tt := ui.NewTester(a.view, 1200, 900)
	settled(tt)
	tt.Scroll(800, 400, 0, 100000)
	settled(tt)
	if len(asked) != 0 {
		t.Fatal("scrolling must not fetch without clicking the manual continuation")
	}
	if err := tt.Click(root.Sections[len(root.Sections)-1].Links[0].Title); err != nil {
		t.Fatal(err)
	}
	nextPage := root.Sections[len(root.Sections)-1].Links[0].Page
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
