// Copy into MyGO's internal/app package with the Qishui plugin fixtures.
package app

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"mygo-music/internal/music"
)

// Opening song comments, liking and unliking one, then posting preserves the playing song and uses each real source action.
func TestQishuiCommentsReadLikeAndPost(t *testing.T) {
	a := newTestApp()
	without(a, "like", "isLiked")
	a.account = &music.Account{ID: "fixture-account", Name: "Fixture Listener"}
	ch := posts(a)
	type action struct {
		kind, track, id, text string
		on                    bool
	}
	asked := make(chan action, 8)
	fake(a).comments = func(id string, offset int) (*music.CommentPage, error) {
		asked <- action{kind: "read", track: id}
		if offset != 0 {
			t.Error("terminal comments triggered an extra page")
		}
		return &music.CommentPage{Total: 1, Comments: []music.Comment{{ID: "41", Author: "Fixture Author", Text: "Fixture comment", Likes: 3}}}, nil
	}
	fake(a).likeComment = func(track, id string, on bool) error {
		asked <- action{kind: "like", track: track, id: id, on: on}
		return nil
	}
	fake(a).postComment = func(track, text string) (*music.Comment, error) {
		asked <- action{kind: "post", track: track, text: text}
		return &music.Comment{ID: "42", Author: "Fixture Listener", Text: text}, nil
	}
	a.pl.Cue([]music.Track{{ID: "91", Source: "fake", Name: "Fixture Song", Duration: 180000}})
	a.pl.SetLyrics(nil)
	a.nowPlaying, a.npPane = true, paneComments
	tt := ui.NewTester(a.view, 1200, 800)
	tt.Frame()
	if call := wait(t, asked, "Qishui comments"); call.kind != "read" || call.track != "91" {
		t.Fatal("comments did not load for the playing song")
	}
	until(t, ch, func() bool { return a.comments.loaded && !a.comments.loading })
	tt.Advance(time.Second)
	tt.Frame()
	if err := tt.Click("Like"); err != nil {
		t.Fatal(err)
	}
	if call := wait(t, asked, "Qishui comment like"); call != (action{kind: "like", track: "91", id: "41", on: true}) {
		t.Fatal("comment thumb did not call the correct like action")
	}
	runPost(t, ch)
	tt.Frame()
	if err := tt.Click("Unlike"); err != nil {
		t.Fatal(err)
	}
	if call := wait(t, asked, "Qishui comment unlike"); call.on || call.id != "41" {
		t.Fatal("second thumb did not unlike the same comment")
	}
	runPost(t, ch)
	tt.Frame()
	if err := tt.Click("Write a comment…"); err != nil {
		t.Fatal(err)
	}
	tt.Type("  Test comment  ")
	tt.Key(0, ui.KeyEnter)
	if call := wait(t, asked, "Qishui comment post"); call.kind != "post" || call.track != "91" || call.text != "Test comment" {
		t.Fatal("posting did not submit the current song and trimmed draft")
	}
	until(t, ch, func() bool { return !a.comments.posting })
	if len(a.comments.list) != 2 || a.comments.list[0].ID != "42" || a.comments.draft != "" || a.comments.list[1].Liked || a.comments.list[1].Likes != 3 {
		t.Fatal("accepted comment or final thumb state was not reflected")
	}
	if current := a.pl.Current(); current == nil || current.ID != "91" {
		t.Fatal("comment actions changed the playing song")
	}
}
