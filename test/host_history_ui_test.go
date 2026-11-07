package app

import (
	"testing"

	"github.com/egoist/mygo/ui"
	"mygo-music/internal/music"
)

func qishuiHistoryApp(t *testing.T, fixture qishuiSceneFixtures) (*app, []music.Playlist) {
	t.Helper()
	a := qishuiSceneApp(t, fixture)
	without(a, "createPlaylist", "savePlaylist", "renamePlaylist", "deletePlaylist", "addToPlaylist", "removeFromPlaylist")
	a.account.Name = "SVIP · 这是一个用于检查长昵称截断的合成账号名称"
	a.home = fixture.Pages["home"]
	a.route = route{page: pageHome, src: "fake"}
	lists := []music.Playlist{
		{ID: "fixture-liked", Name: "我喜欢的音乐", ImageURL: fixture.Pages["home"].Sections[0].Stations[0].ImageURL},
		{ID: "fixture-douyin", Name: "抖音收藏的音乐", ImageURL: fixture.Pages["home"].Sections[0].Stations[0].ImageURL, Description: "这个歌单暂时没有歌曲。"},
		{ID: "qishui:history", Name: "历史播放", ImageURL: "qishui-history-cover", Description: "汽水音乐账号的最近播放记录，最多展示 1000 首歌曲。", Tracks: sourced(fixture.Tracks...)},
	}
	a.saved = lists
	return a, lists
}

// Opening history and empty favorites from the native sidebar preserves identity, errors and navigation cache.
func TestQishuiHistorySidebarActions(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	a, lists := qishuiHistoryApp(t, fixture)
	ch := posts(a)
	asked := make(chan string, 8)
	fake(a).playlist = func(id string) (*music.Playlist, error) {
		asked <- id
		for _, list := range lists {
			if list.ID == id {
				return &list, nil
			}
		}
		return nil, music.ErrUnsupported
	}
	tt := ui.NewTester(a.view, 1200, 900)
	settled(tt)
	for _, list := range lists[1:] {
		if err := tt.Click(list.Name); err != nil {
			t.Fatal(err)
		}
		if id := wait(t, asked, "sidebar system list"); id != list.ID {
			t.Fatal("sidebar opened a different playlist")
		}
		runPost(t, ch)
		settled(tt)
		loaded := a.playlists[list.ID]
		if loaded == nil || a.plErr[list.ID] != "" || len(loaded.Tracks) != len(list.Tracks) || a.route.id != list.ID {
			t.Fatal("sidebar playlist did not load its actual tracks")
		}
		tt.Key(0, ui.KeyBack)
		tt.Frame()
		tt.Key(0, ui.KeyForward)
		tt.Frame()
		if a.route.id != list.ID || len(asked) != 0 {
			t.Fatal("forward did not retain cached system list")
		}
	}
	if err := tt.Click(a.account.Name); err != nil {
		t.Fatal(err)
	}
	if !a.accountOpen {
		t.Fatal("member prefix prevented opening the native account menu")
	}
}

// Actual host frames allow visual inspection of prefix truncation, empty favorites and the history cover in both themes.
func TestQishuiHistoryFrames(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	dir := framesDir(t)
	for _, dark := range []bool{false, true} {
		for _, i := range []int{1, 2} {
			a, lists := qishuiHistoryApp(t, fixture)
			list := lists[i]
			a.playlists[list.ID] = &list
			a.route = route{page: pagePlaylist, src: "fake", id: list.ID}
			tt := ui.NewTester(a.view, 1200, 900)
			tt.SetDark(dark)
			settled(tt)
			name := "empty"
			if i == 2 {
				name = "history"
			}
			theme := "light"
			if dark {
				theme = "dark"
			}
			saveFrame(t, dir, name+"-"+theme+".png", tt.Image())
		}
	}
}
