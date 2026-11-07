// Copy this file into MyGO Music's internal/plugin directory and run it there
// with QISHUI_PLUGIN_DIR pointing to this plugin. It uses the actual moejs host.
package plugin

import (
	"context"
	"crypto/md5"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"mygo-music/internal/music"
)

type qishuiAuthTransport func(*http.Request) (*http.Response, error)

func (f qishuiAuthTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Replace only remote HTTP services, retaining actual host fetch, headers, streams and Catalog mapping.
func qishuiAuthFixture(t *testing.T) *atomic.Int32 {
	t.Helper()
	original := http.DefaultTransport
	count := new(atomic.Int32)
	var discoveries, radios atomic.Int32
	var lastPlayed atomic.Value
	track := func(id string) map[string]any {
		return map[string]any{"id": id, "name": "Fixture Song", "duration": 180000,
			"artists": []any{map[string]any{"id": "92", "name": "Artist"}}, "album": map[string]any{"id": "93", "name": "Album", "cover_url": "https://p3-luna.douyinpic.com/img/history-first.jpg"}}
	}
	resource := func(id string) map[string]any {
		return map[string]any{"type": "track", "entity": map[string]any{"track_wrapper": map[string]any{"track": track(id)}}}
	}
	card := func(id string) map[string]any {
		return map[string]any{"type": "discover_radio", "inner_block_id": id, "resources": []any{map[string]any{
			"type": "radio", "resource_id": id, "style": map[string]any{"title": "Picture Radio " + id, "cover_url_list": []string{"https://example.invalid/cover.jpg"}},
		}}}
	}
	http.DefaultTransport = qishuiAuthTransport(func(r *http.Request) (*http.Response, error) {
		public := (r.URL.Host == "beta-luna.douyin.com" && r.URL.Path == "/luna/h5/seo_track") || (r.URL.Host == "api.qishui.com" && r.URL.Path == "/luna/pc/artists/92")
		if r.URL.Scheme != "https" || (!public && r.URL.Host != "api.qishui.com") {
			return nil, fmt.Errorf("unexpected fixture endpoint")
		}
		count.Add(1)
		if public {
			if r.Header.Get("Cookie") != "" || r.Header.Get("X-Helios") != "" || r.Header.Get("X-Medusa") != "" {
				return nil, fmt.Errorf("account credentials reached public metadata")
			}
		} else if strings.HasPrefix(r.URL.Path, "/luna/") && r.Header.Get("Cookie") != strings.Join([]string{"sessionid", "test-session-value"}, "=") {
			return nil, fmt.Errorf("missing fixture session")
		}
		signed := false
		switch r.URL.Path {
		case "/luna/pc/me/recently-played-media", "/luna/pc/feed/mode", "/luna/pc/discover", "/luna/pc/discover/mix", "/luna/pc/feed/radio/tracks", "/luna/pc/feed/song-tab", "/luna/pc/track_v2":
			signed = true
		}
		var payload struct {
			Cursor       string   `json:"cursor"`
			RadioID      string   `json:"radio_id"`
			Count        int      `json:"count"`
			Exposure     []string `json:"exposure_radio_list"`
			BlockType    string   `json:"block_type"`
			SubChannel   int      `json:"sub_channel_id"`
			FirstRequest bool     `json:"first_request"`
			NewDiscovery bool     `json:"pc_new_discover_request"`
			FirstFeed    bool     `json:"is_first_request"`
			FirstDevice  bool     `json:"is_did_first_request"`
			FirstUseTime int64    `json:"did_first_use_time"`
			FeedCounts   struct {
				Count int `json:"mix_session_count"`
			} `json:"feed_counts"`
			Preference struct {
				SceneID *int `json:"scene_mode_id"`
			} `json:"feed_preference"`
			Media []struct {
				ID   string `json:"id"`
				Type string `json:"type"`
			} `json:"media"`
			Played []struct {
				ID           string `json:"media_id"`
				Type         string `json:"type"`
				Duration     int    `json:"duration"`
				PlayedMillis int    `json:"played_mills"`
			} `json:"played_media"`
		}
		if signed {
			platform := "mac"
			if runtime.GOOS == "windows" {
				platform = "windows"
			}
			if r.Header.Get("X-Helios") != "fixture-helios" || r.Header.Get("X-Medusa") != "fixture-medusa" || r.URL.Query().Get("device_platform") != platform {
				return nil, fmt.Errorf("missing fixture signature")
			}
			if r.URL.Path == "/luna/pc/me/recently-played-media" && r.Header.Get("X-Luna-Is-Local-User") != "1" {
				return nil, fmt.Errorf("history request lacks logged-in header")
			}
			if r.URL.Path == "/luna/pc/me/recently-played-media" && r.Method == "GET" {
				if r.Header.Get("X-SS-Stub") != "" {
					return nil, fmt.Errorf("invalid signed history GET")
				}
			} else {
				raw, err := io.ReadAll(r.Body)
				if err != nil || r.Method != "POST" || r.Header.Get("X-SS-Stub") != fmt.Sprintf("%X", md5.Sum(raw)) || json.Unmarshal(raw, &payload) != nil {
					return nil, fmt.Errorf("invalid signed catalog body")
				}
			}
		} else if r.Header.Get("X-Helios") != "" || r.Header.Get("X-Medusa") != "" {
			return nil, fmt.Errorf("unsigned endpoint received catalog signatures")
		}
		body := ""
		headers := make(http.Header)
		headers.Set("Content-Type", "application/json")
		var result any
		switch r.URL.Path {
		case "/passport/web/get_qrcode/":
			if r.Header.Get("Cookie") != "" {
				return nil, fmt.Errorf("new QR reused credentials")
			}
			body = `{"error_code":0,"data":{"token":"challenge-for-test","qrcode_index_url":"https://bff-pc.qishui.com/test","is_frontier":false}}`
		case "/passport/web/check_qrconnect/":
			if r.Method != "POST" || r.Header.Get("X-SS-Stub") == "" || r.Header.Get("Cookie") != "" {
				return nil, fmt.Errorf("invalid fixture poll")
			}
			body = `{"error_code":0,"data":{"status":"confirmed"}}`
			headers.Add("Set-Cookie", strings.Join([]string{"sessionid", "test-session-value"}, "=")+"; Path=/; Secure; HttpOnly")
		case "/luna/pc/me":
			body = `{"my_info":{"id":7123456789012345678,"nickname":"Test Account","is_vip":true,"vip_stage":"svip"}}`
		case "/luna/pc/track_v2":
			body = `{"track":{"id":"91","duration":180000},"track_player":{"video_model":{"video_duration":180,"video_list":[]}}}`
		case "/luna/pc/me/playlist":
			body = `{"playlists":[{"id":"94","title":"Fixture Playlist","count_tracks":1}]}`
		case "/luna/pc/playlist/detail":
			id := r.URL.Query().Get("playlist_id")
			if id == "empty-fixture" {
				body = `{"playlist":{"id":"empty-fixture","title":"Empty fixture"},"next_cursor":"0"}`
			} else if id == "94" {
				result = map[string]any{"playlist": map[string]any{"id": id, "title": "Fixture Playlist", "count_tracks": 1}, "media_resources": []any{resource("91")}, "has_more": false}
			} else {
				return nil, fmt.Errorf("unexpected playlist identity")
			}
		case "/luna/pc/me/recently-played-media":
			if r.Method == "POST" {
				if len(payload.Media) != 1 || payload.Media[0].Type != "track" || (payload.Media[0].ID != "91" && payload.Media[0].ID != "92") || r.URL.Query().Has("count") {
					return nil, fmt.Errorf("invalid start-only history append")
				}
				lastPlayed.Store(payload.Media[0].ID)
				result = map[string]any{"status_code": 0}
			} else {
				if r.URL.Query().Get("cursor") != "" || r.URL.Query().Get("count") != "1000" {
					return nil, fmt.Errorf("invalid history pagination")
				}
				id := "91"
				if played := lastPlayed.Load(); played != nil {
					id = played.(string)
				}
				result = map[string]any{"media": []any{resource(id)}, "has_more": false}
			}
		case "/luna/pc/artists/92":
			if r.Method != "GET" || !r.URL.Query().Has("locate_item_id") || r.URL.Query().Has("user_id") {
				return nil, fmt.Errorf("invalid artist detail query")
			}
			result = map[string]any{"artist_info": map[string]any{"id": "92", "name": "Fixture Artist", "url_avatar": map[string]any{"urls": []string{"https://p3-luna.douyinpic.com/img/artist.jpg"}}}, "hot_tracks": []any{track("91")}}
		case "/luna/search/track":
			if r.URL.Query().Get("q") != "Fixture" || r.URL.Query().Get("device_platform") != "android" {
				return nil, fmt.Errorf("invalid search parameters")
			}
			result = map[string]any{"result_groups": []any{map[string]any{"data": []any{map[string]any{"entity": map[string]any{"track": track("91")}}}, "has_more": false}}}
		case "/luna/pc/feed/mode":
			entries := make([]any, 9)
			for i := range entries {
				entry := map[string]any{"type": "scene_mode", "text": fmt.Sprintf("Relax %d", i), "entity": map[string]any{"feed_scene_mode": map[string]any{"scene_mode_id": i}}}
				if i != 1 {
					entry["url_info"] = fmt.Sprintf("https://p3-luna.douyinpic.com/img/mode-%d.jpg", i)
				}
				entries[i] = entry
			}
			result = map[string]any{"feed_mode_block": []any{map[string]any{"title": "心情", "feed_mode": entries}}}
		case "/luna/pc/discover":
			if !payload.FirstRequest || !payload.NewDiscovery {
				return nil, fmt.Errorf("invalid initial discovery request")
			}
			n := 1
			if discoveries.Add(1) == 1 {
				n = 15
			} // Home previews 15; subsequent full pages keep one discovery card.
			cards := make([]any, n)
			for i := range cards {
				cards[i] = card(fmt.Sprint(42 + i))
			}
			result = map[string]any{"blocks": []any{map[string]any{"type": "discover_playlist_mix", "inner_block": cards}}, "has_more": true}
		case "/luna/pc/discover/mix":
			if len(payload.Exposure) != 1 || payload.Exposure[0] != "42" || payload.BlockType != "discover_playlist_mix" || payload.SubChannel != -2 {
				return nil, fmt.Errorf("lost discovery exposures")
			}
			result = map[string]any{"inner_block": []any{card("43")}, "has_more": false}
		case "/luna/pc/feed/radio/tracks":
			n := radios.Add(1)
			if payload.RadioID != "42" || payload.Count != 6 || (n == 1 && payload.Cursor != "") || (n > 1 && payload.Cursor != "opaque-radio") || n > 2 {
				return nil, fmt.Errorf("lost radio cursor or terminal state")
			}
			result = map[string]any{"items": []any{resource(fmt.Sprint(100 + n))}, "next_cursor": "opaque-radio", "has_more": n < 2}
		case "/luna/pc/feed/song-tab":
			n := payload.FeedCounts.Count
			if n < 1 || payload.Preference.SceneID == nil || (*payload.Preference.SceneID != 0 && *payload.Preference.SceneID != 9223372036854775807) || payload.FirstDevice || payload.FirstUseTime != 0 || payload.FirstFeed != (n == 1) {
				return nil, fmt.Errorf("invalid scene feed lifecycle")
			}
			if n == 1 && len(payload.Played) != 0 {
				return nil, fmt.Errorf("new scene inherited feedback")
			}
			if n > 1 && (len(payload.Played) != 1 || payload.Played[0].ID != "91" || payload.Played[0].Type != "track" || payload.Played[0].Duration != 180 || payload.Played[0].PlayedMillis != -1) {
				return nil, fmt.Errorf("lost continuation feedback")
			}
			result = map[string]any{"items": []any{resource(fmt.Sprint(90 + n))}}
		case "/luna/h5/seo_track":
			if !public || r.URL.Query().Get("track_id") != "91" {
				return nil, fmt.Errorf("invalid public lyrics request")
			}
			result = map[string]any{"seo_track": map[string]any{"track": track("91")}, "lyric": map[string]any{"content": "[1000,2000]Fixture"}}
		default:
			return nil, fmt.Errorf("unexpected fixture request")
		}
		if result != nil {
			raw, err := json.Marshal(result)
			if err != nil {
				return nil, err
			}
			body = string(raw)
		}
		return &http.Response{StatusCode: 200, Header: headers, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = original })
	return count
}

// Actual sandbox authentication and grant HTTP must drive native music IPC without forwarding the saved account.
func TestQishuiPluginRuntime(t *testing.T) {
	root := os.Getenv("QISHUI_PLUGIN_DIR")
	if root == "" {
		t.Skip("QISHUI_PLUGIN_DIR is not set")
	}
	qishuiAuthFixture(t)
	dir := t.TempDir()
	for _, name := range []string{"plugin.json", "index.js"} {
		b, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	// Replace only native effects. The real sandbox signs and fetches the grant.
	fixture := `package main
import("bufio";"encoding/json";"net/url";"os";"regexp";"strings")
func main(){
 scanner:=bufio.NewScanner(os.Stdin); scanner.Buffer(make([]byte,4096),131072)
 enc:=json.NewEncoder(os.Stdout)
 for scanner.Scan(){
  var spec struct{Op,Method string; Session map[string]json.RawMessage; Params struct{URL,DID,ID,Quality,HeaderLines string; Headers map[string]string; Grant struct{Track struct{ID string}}}}
  if json.Unmarshal(scanner.Bytes(),&spec)!=nil || spec.Op!="music" || len(spec.Session)!=3 {os.Exit(1)}
  var version int; var did,iid string
  json.Unmarshal(spec.Session["version"],&version);json.Unmarshal(spec.Session["deviceID"],&did);json.Unmarshal(spec.Session["installID"],&iid)
  if version!=1 || !regexp.MustCompile("^[0-9]{16}$").MatchString(did) || !regexp.MustCompile("^[0-9]{15}$").MatchString(iid){os.Exit(1)}
  var result any
  if spec.Method=="sign"{
   u,e:=url.Parse(spec.Params.URL)
   if e!=nil || u.Scheme!="https" || u.Host!="api.qishui.com" || spec.Params.DID!=did || u.Query().Get("device_id")!=did || spec.Params.Headers["cookie"]!=strings.Join([]string{"sessionid","test-session-value"},"=") || spec.Params.HeaderLines=="" {os.Exit(1)}
   result=map[string]string{"x-helios":"fixture-helios","x-medusa":"fixture-medusa"}
  }else if spec.Method=="stream"{
   if spec.Params.ID!="91" || spec.Params.Quality!="high" || spec.Params.Grant.Track.ID!="91" {os.Exit(1)}
   result=map[string]string{"url":"http://127.0.0.1:12345/fixture","type":"flac","quality":"high"}
  }else{os.Exit(1)}
  if enc.Encode(map[string]any{"ok":true,"result":result})!=nil{os.Exit(1)}
 }
}`
	fixtureSource := filepath.Join(t.TempDir(), "fixture.go")
	if err := os.WriteFile(fixtureSource, []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	data := t.TempDir()
	p, err := Load(dir, data)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	if err := p.Grant(true); err != nil {
		t.Fatal(err)
	}
	if a, err := p.Account(); err != nil || a != nil {
		t.Fatalf("initial account: %v, %v", a, err)
	}
	// The fixture is a standalone native executable in the production layout.
	if err := os.Mkdir(filepath.Join(dir, "bin"), 0700); err != nil {
		t.Fatal(err)
	}
	executable := "qishui-helper-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	build := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-o", filepath.Join(dir, "bin", executable), fixtureSource)
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("native fixture build failed: %v, %s", err, out)
	}
	var prompt music.SignInPrompt
	p.OnSignInPrompt(func(value music.SignInPrompt) { prompt = value })
	a, err := p.SignIn()
	if err != nil || a == nil || a.ID != "7123456789012345678" || a.Name != "SVIP · Test Account" {
		t.Fatalf("sign in: %v, %v", a, err)
	}
	if prompt.QR != "https://bff-pc.qishui.com/test" {
		t.Fatal("original QR did not reach the host")
	}
	if p.Info().Playback != music.PlaybackStream || !p.Can("home") || !p.Can("playlist") || !p.Can("stream") {
		t.Fatal("music capabilities were not discovered")
	}
	home, err := p.Home()
	if err != nil || len(home.Sections) != 1 || len(home.Sections[0].Stations) != 15 || len(home.Sections[0].Playlists) != 0 {
		t.Fatalf("home mapping failed: %v", err)
	}
	if home.Sections[0].MorePage != "listening-modes" || home.Sections[0].Stations[0].ID != "radio:42" {
		t.Fatal("home exploration lost its station or destination")
	}
	lists, err := p.Playlists()
	if err != nil || len(lists) != 2 || lists[0].ID != "94" || lists[1].ID != "qishui:history" {
		t.Fatalf("playlist list mapping failed: %v", err)
	}
	pl, err := p.Playlist("94")
	if err != nil || len(pl.Tracks) != 1 || pl.Tracks[0].Duration != 180000 {
		t.Fatalf("playlist tracks mapping failed: %v", err)
	}
	empty, err := p.Playlist("empty-fixture")
	if err != nil || empty.ID != "empty-fixture" || len(empty.Tracks) != 0 || empty.Name != "Empty fixture" {
		t.Fatalf("empty playlist mapping failed: %v", err)
	}
	history, err := p.Playlist("qishui:history")
	if err != nil || history.ID != "qishui:history" || len(history.Tracks) != 1 || history.Tracks[0].Source != "qishui-app-login" || history.ImageURL != history.Tracks[0].Album.ImageURL {
		t.Fatalf("history playlist mapping failed: %v", err)
	}
	// The real host callback must record cached playback without stream(), then
	// a fresh history read must expose the server's updated first song.
	if !p.Can("played") {
		t.Fatal("successful playback reporting was not discovered")
	}
	for _, id := range []string{"92", "91", "92"} {
		p.Played(music.Track{ID: id})
		updated, err := p.Playlist("qishui:history")
		if err != nil || len(updated.Tracks) != 1 || updated.Tracks[0].ID != id {
			t.Fatalf("history did not update after the played callback: %v", err)
		}
	}
	found, err := p.Search("Fixture", music.SearchTracks, 0)
	if err != nil || len(found.Tracks) != 1 || found.Tracks[0].Source != "qishui-app-login" {
		t.Fatalf("search mapping failed: %v", err)
	}
	if !p.Can("artist") {
		t.Fatal("native artist navigation capability was not discovered")
	}
	ar, err := p.Artist(found.Tracks[0].Artists[0].ID)
	if err != nil || ar.Artist.ID != "92" || ar.Artist.Name != "Fixture Artist" || ar.Artist.ImageURL == "" || len(ar.Tracks) != 1 || ar.Tracks[0].Source != "qishui-app-login" {
		t.Fatalf("artist page mapping failed: %v", err)
	}
	if !p.Can("stations") || !p.Can("stationNext") || !p.Can("browse") {
		t.Fatal("continuous listening capabilities were not discovered")
	}
	modes, err := p.Stations()
	if err != nil || len(modes) != 3 || modes[2].ID != "preference:fresh" {
		t.Fatalf("common station mapping failed: %v", err)
	}
	flat, err := p.Browse("listening-modes")
	if err != nil || len(flat.Sections) != 3 || len(flat.Sections[1].Stations) != 1 || flat.Sections[1].MorePage != "" || len(flat.Sections[2].Links) != 1 {
		t.Fatalf("flat discovery landing failed: %v", err)
	}
	all, err := p.Browse(flat.Sections[0].MorePage)
	if err != nil || len(all.Sections) != 1 || len(all.Sections[0].Stations) != 11 || all.Sections[0].Stations[0].ID != "preference:familiar" || all.Sections[0].Stations[2].ID != "scene:0" {
		t.Fatalf("all-mode navigation lost its playable station: %v", err)
	}
	if all.Sections[0].Stations[2].ImageURL != "https://p3-luna.douyinpic.com/img/mode-0.jpg" || all.Sections[0].Stations[3].ImageURL != "" || lists[1].ImageURL != "" {
		t.Fatal("official cover URL or host missing-cover fallback was replaced")
	}
	nextPage, err := p.Browse(flat.Sections[2].Links[0].Page)
	if err != nil || nextPage.Sections[0].Stations[0].ID != "radio:43" || nextPage.Sections[0].MorePage != "" {
		t.Fatalf("native discovery continuation failed: %v", err)
	}
	for i, id := range []string{"101", "102"} {
		next, err := p.StationNext("radio:42")
		if err != nil || len(next) != 1 || next[0].ID != id || next[0].Source != "qishui-app-login" {
			t.Fatalf("discovery radio batch %d failed: %v", i, err)
		}
	}
	if next, err := p.StationNext("radio:42"); err != nil || len(next) != 0 {
		t.Fatalf("ended discovery radio restarted: %v", err)
	}
	for _, n := range p.Info().Navigation {
		if n.Page != "" {
			if _, err := p.Browse(n.Page); err != nil {
				t.Fatalf("manifest navigation did not reach a usable browse page: %v", err)
			}
		}
	}
	for i, id := range []string{"91", "92"} {
		next, err := p.StationNext("scene:0")
		if err != nil || len(next) != 1 || next[0].ID != id || next[0].Source != "qishui-app-login" {
			t.Fatalf("station batch %d lost lifecycle or source: %v", i, err)
		}
	}
	if next, err := p.StationNext("scene:9223372036854775807"); err != nil || len(next) != 1 || next[0].ID != "91" {
		t.Fatalf("int64 scene request was rounded or rejected in the sandbox: %v", err)
	}
	words, err := p.Lyrics("91")
	if err != nil || words.LRC != "[00:01.00]Fixture" {
		t.Fatalf("lyrics mapping failed: %v", err)
	}
	stream, err := p.Stream("91", "high")
	if err != nil || stream.Type != "flac" || stream.Quality != "high" {
		t.Fatalf("stream mapping failed: %v", err)
	}
	p.Close()
	again, err := Load(dir, data)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(again.Close)
	if a, err := again.Account(); err != nil || a == nil || a.ID != "7123456789012345678" {
		t.Fatalf("restored account: %v, %v", a, err)
	}
	if err := again.SignOut(); err != nil {
		t.Fatal(err)
	}
	if a, err := again.Account(); err != nil || a != nil {
		t.Fatalf("signed-out account: %v, %v", a, err)
	}
}

// Login, restoration and sign-out must work without Node, browser assets or process permission.
func TestQishuiPluginNetworkOnlyLogin(t *testing.T) {
	root := os.Getenv("QISHUI_PLUGIN_DIR")
	if root == "" {
		t.Skip("QISHUI_PLUGIN_DIR is not set")
	}
	calls := qishuiAuthFixture(t)
	dir, data := t.TempDir(), t.TempDir()
	for _, name := range []string{"plugin.json", "index.js"} {
		b, e := os.ReadFile(filepath.Join(root, name))
		if e != nil {
			t.Fatal(e)
		}
		if name == "plugin.json" {
			var manifest map[string]any
			if json.Unmarshal(b, &manifest) != nil {
				t.Fatal("invalid manifest")
			}
			permissions := manifest["permissions"].(map[string]any)
			delete(permissions, "process")
			b, _ = json.Marshal(manifest)
		}
		if e := os.WriteFile(filepath.Join(dir, name), b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	p, e := Load(dir, data)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(p.Close)
	if a, e := p.Account(); e != nil || a != nil {
		t.Fatal("initial account must be empty")
	}
	a, e := p.SignIn()
	if e != nil || a == nil || a.ID != "7123456789012345678" {
		t.Fatal("network-only sandbox login failed")
	}
	p.Close()
	again, e := Load(dir, data)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(again.Close)
	if b, e := again.Account(); e != nil || b == nil || b.ID != a.ID {
		t.Fatal("sandbox session restore failed")
	}
	isolated, e := Load(dir, t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer isolated.Close()
	if b, e := isolated.Account(); e != nil || b != nil {
		t.Fatal("session leaked into another data directory")
	}
	// No helper/bin files or program permission exist: these paths must use host fetch.
	if lists, e := again.Playlists(); e != nil || len(lists) != 2 || lists[0].ID != "94" {
		t.Fatalf("network-only library failed: %v", e)
	}
	if list, e := again.Playlist("94"); e != nil || len(list.Tracks) != 1 || list.Tracks[0].ID != "91" {
		t.Fatalf("network-only playlist failed: %v", e)
	}
	if list, e := again.Playlist("empty-fixture"); e != nil || len(list.Tracks) != 0 {
		t.Fatalf("network-only empty playlist failed: %v", e)
	}
	if result, e := again.Search("Fixture", music.SearchTracks, 0); e != nil || len(result.Tracks) != 1 || result.Tracks[0].ID != "91" {
		t.Fatalf("network-only search failed: %v", e)
	}
	if words, e := again.Lyrics("91"); e != nil || words.LRC != "[00:01.00]Fixture" {
		t.Fatalf("network-only lyrics failed: %v", e)
	}
	if artist, e := again.Artist("92"); e != nil || artist.Artist.ID != "92" || len(artist.Tracks) != 1 {
		t.Fatalf("network-only artist failed: %v", e)
	}
	if _, e := again.Home(); e == nil {
		t.Fatal("native signing unexpectedly worked without a process permission")
	}
	if e := again.SignOut(); e != nil {
		t.Fatal(e)
	}
	if b, e := again.Account(); e != nil || b != nil {
		t.Fatal("sandbox sign-out retained credentials")
	}
	if calls.Load() != 10 {
		t.Fatal("unexpected authentication or unsigned catalog requests")
	}
}

// MyGO's ZIP installer must preserve the bundled executable and dependencies without user configuration.
func TestQishuiPluginZipInstall(t *testing.T) {
	archive := os.Getenv("QISHUI_PLUGIN_ZIP")
	if archive == "" {
		t.Skip("QISHUI_PLUGIN_ZIP is not set")
	}
	dir := t.TempDir()
	pending, err := Open(archive, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer pending.Discard()
	if err := pending.Install(dir); err != nil {
		t.Fatal(err)
	}
	installed := filepath.Join(dir, "qishui-app-login")
	executable := "qishui-helper-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, filepath.Join(installed, "bin", executable))
	cmd.Dir = installed
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + os.Getenv("HOME")}
	if runtime.GOOS == "windows" {
		cmd.Env = []string{"PATH=", "SystemRoot=" + os.Getenv("SystemRoot"), "TEMP=" + os.Getenv("TEMP"), "TMP=" + os.Getenv("TMP")}
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal("native stdin unavailable")
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal("native stdout unavailable")
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatal("installed native worker did not start")
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})
	request := map[string]any{"op": "music", "method": "sign", "session": map[string]any{"version": 1, "deviceID": "1234567890123456", "installID": "123456789012345"}, "params": map[string]any{"url": "https://api.qishui.com/luna/pc/track_v2?aid=386088&app_name=luna_pc&device_id=1234567890123456&fp=1234567890123456", "did": "1234567890123456", "headers": map[string]string{"accept": "application/json"}}}
	if err := json.NewEncoder(stdin).Encode(request); err != nil {
		t.Fatal("native request failed")
	}
	var frame struct {
		OK     bool
		Result map[string]string
	}
	if json.NewDecoder(stdout).Decode(&frame) != nil || !frame.OK || len(frame.Result) != 2 || frame.Result["x-helios"] == "" || frame.Result["x-medusa"] == "" {
		t.Fatal("installed native signing failed; output withheld")
	}
	_ = stdin.Close()
	if cmd.Wait() != nil {
		t.Fatal("installed native worker failed to stop")
	}
	for _, name := range []string{"assets", "test", "scripts/verify-windows.cmd"} {
		if _, err := os.Stat(filepath.Join(installed, name)); !os.IsNotExist(err) {
			t.Fatal("runtime ZIP contains artwork or validation-only files", name)
		}
	}
	p, err := Load(installed, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if a, err := p.Account(); err != nil || a != nil {
		t.Fatalf("initial installed account: %v, %v", a, err)
	}
}

// A real QR must reach MyGO using sandbox fetch; cancellation must save nothing and need no program grant.
func TestQishuiPluginLiveCancel(t *testing.T) {
	if os.Getenv("QISHUI_HOST_PREFLIGHT") != "1" {
		t.Skip("QISHUI_HOST_PREFLIGHT is not set")
	}
	p, err := Load(os.Getenv("QISHUI_PLUGIN_DIR"), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	if p.granted {
		t.Fatal("live login must start without process permission")
	}
	shown := make(chan bool, 1)
	p.OnSignInPrompt(func(value music.SignInPrompt) { shown <- value.QR != "" })
	done := make(chan error, 1)
	go func() { _, err := p.SignIn(); done <- err }()
	select {
	case ok := <-shown:
		if !ok {
			t.Fatal("no QR was shown")
		}
	case err := <-done:
		t.Fatalf("login ended before showing a QR: %v", err)
	case <-time.After(60 * time.Second):
		t.Fatal("QR request timed out")
	}
	if err := p.SignOut(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled login returned success")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled login did not finish")
	}
	if account, err := p.Account(); err != nil || account != nil {
		t.Fatal("cancelled login saved credentials")
	}
}
