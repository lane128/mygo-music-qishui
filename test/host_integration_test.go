// Copy this file into MyGO Music's internal/plugin directory and run it there
// with QISHUI_PLUGIN_DIR pointing to this plugin. It uses the actual moejs host.
package plugin

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"mygo-music/internal/music"
)

// The actual MyGO runtime must load the plugin, exchange JSON with Node, and persist and clear an account.
func TestQishuiPluginRuntime(t *testing.T) {
	root := os.Getenv("QISHUI_PLUGIN_DIR")
	if root == "" {
		t.Skip("QISHUI_PLUGIN_DIR is not set")
	}
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
	if err := os.Mkdir(filepath.Join(dir, "helper"), 0700); err != nil {
		t.Fatal(err)
	}
	// This fixture replaces only the upstream service; MyGO executes the real
	// index.js and starts a real Node process through its permission-gated host.
	fixture := `import readline from 'node:readline';
const account = {id: '7123456789012345678', name: 'SVIP · Test Account'};
for await (const line of readline.createInterface({input: process.stdin})) {
  const spec = JSON.parse(line);
  let frame;
  if (spec.op === 'start') frame = {ok: true, qr: 'https://bff-pc.qishui.com/test', expiresIn: 60000};
  else if (spec.op === 'check') frame = {ok: true, status: 'confirmed', account, session: {version: 1, deviceID:'1234567890123456', installID:'123456789012345', cookies: [{name: 'sessionid', value: 'test'}]}};
  else if (spec.op === 'music') {
    const track = {id: '91', name: 'Fixture Song', duration: 180000, artists: [{id:'92',name:'Artist'}], album:{id:'93',name:'Album'}};
    const playlist = {id:'94',name:'Fixture Playlist',tracks:[track]};
    let result, extra = {};
    if (spec.method === 'home') result = {title:'汽水音乐',sections:[{stations:Array.from({length:15},(_,i)=>({id:'radio:'+String(42+i),name:'Picture Radio '+i,imageUrl:'https://example.invalid/cover.jpg'})),morePage:'listening-modes'}]};
    else if (spec.method === 'playlists') result = [playlist, {id:'qishui:history',name:'历史播放'}];
    else if (spec.method === 'playlist') result = spec.params.id === 'empty-fixture' ? {id:'empty-fixture',name:'Empty fixture',trackCount:0,tracks:[]} : spec.params.id === 'qishui:history' ? {id:'qishui:history',name:'历史播放',tracks:[track]} : playlist;
    else if (spec.method === 'search') result = {tracks:[track],more:false};
    else if (spec.method === 'modes') result = [{id:'preference:familiar',name:'Familiar'},{id:'preference:fresh',name:'Fresh'},{id:'scene:0',name:'Relax'}];
    else if (spec.method === 'modePage') {
      result = spec.params.page === 'listening-modes'
        ? {sections:[{stations:[{id:'preference:fresh',name:'Fresh'}],morePage:'scene-modes'},{stations:[{id:'radio:42',name:'Picture Radio',imageUrl:'https://example.invalid/cover.jpg'}]}]}
        : {sections:[{stations:[{id:'scene:0',name:'Relax'}]}]};
      if (spec.params.page === 'listening-modes') extra = {discovery:{exposure:['42']},more:true};
    }
    else if (spec.method === 'discover') {
      if (spec.params.state.exposure[0] !== '42') throw new Error('lost discovery exposures');
      result = {sections:[{stations:[{id:'radio:43',name:'Next Picture Radio'}]}]};
      extra = {more:false};
    }
    else if (spec.method === 'radio') {
      if (spec.params.count > 1 && spec.params.cursor !== 'opaque-radio') throw new Error('lost radio cursor');
      result = [{...track,id:String(100 + spec.params.count)}];
      extra = {cursor:'opaque-radio',more:spec.params.count < 2};
    }
    else if (spec.method === 'feed') {
      if (spec.params.count > 1 && (spec.params.played[0]?.id !== '91' || spec.params.played[0]?.duration !== 180000)) throw new Error('lost continuation feedback');
      result = [{...track,id:String(90 + spec.params.count)}];
    }
    else if (spec.method === 'lyrics') result = {lrc:'[00:01.00]Fixture'};
    else if (spec.method === 'stream') result = {url:'http://127.0.0.1:12345/fixture',type:'flac',quality:'high'};
    frame = {ok:true,result,...extra};
  }
  else frame = {ok: true, account: spec.session.account};
  process.stdout.write(JSON.stringify(frame) + '\n');
}`
	if err := os.WriteFile(filepath.Join(dir, "helper", "worker.mjs"), []byte(fixture), 0600); err != nil {
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
	// The fixture has the same relative bundled executable layout as the ZIP.
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "bin"), 0700); err != nil {
		t.Fatal(err)
	}
	executable := "node-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	if err := os.Symlink(node, filepath.Join(dir, "bin", executable)); err != nil {
		t.Fatal(err)
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
	if err != nil || history.ID != "qishui:history" || len(history.Tracks) != 1 || history.Tracks[0].Source != "qishui-app-login" {
		t.Fatalf("history playlist mapping failed: %v", err)
	}
	found, err := p.Search("Fixture", music.SearchTracks, 0)
	if err != nil || len(found.Tracks) != 1 || found.Tracks[0].Source != "qishui-app-login" {
		t.Fatalf("search mapping failed: %v", err)
	}
	if !p.Can("stations") || !p.Can("stationNext") || !p.Can("browse") {
		t.Fatal("continuous listening capabilities were not discovered")
	}
	modes, err := p.Stations()
	if err != nil || len(modes) != 3 || modes[2].ID != "preference:fresh" {
		t.Fatalf("common station mapping failed: %v", err)
	}
	flat, err := p.Browse("listening-modes")
	if err != nil || len(flat.Sections) != 2 || len(flat.Sections[1].Stations) != 1 || len(flat.Sections[1].Links) != 0 {
		t.Fatalf("flat discovery landing failed: %v", err)
	}
	all, err := p.Browse(flat.Sections[0].MorePage)
	if err != nil || len(all.Sections) != 1 || all.Sections[0].Stations[0].ID != "scene:0" {
		t.Fatalf("all-mode navigation lost its playable station: %v", err)
	}
	nextPage, err := p.Browse(flat.Sections[1].MorePage)
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

// The real helper must map missing SDK assets to the host's setup error rather than hanging or exposing output.
func TestQishuiPluginMissingAssets(t *testing.T) {
	root := os.Getenv("QISHUI_PLUGIN_DIR")
	if root == "" {
		t.Skip("QISHUI_PLUGIN_DIR is not set")
	}
	p, err := Load(root, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	if err := p.Grant(true); err != nil {
		t.Fatal(err)
	}
	t.Setenv("QISHUI_SECURITY_DIR", filepath.Join(t.TempDir(), "missing"))
	if _, err := p.SignIn(); !errors.Is(err, music.ErrSetup) {
		t.Fatalf("expected setup failure: %v", err)
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
	executable := "node-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	cmd := exec.Command(filepath.Join(installed, "bin", executable), "-e", `require('playwright-core'); require('fs').readFileSync('runtime/security/bdms.js'); require('fs').readFileSync('runtime/security/sdk-glue.js'); import('./helper/native.mjs').then(async ({signRequest}) => { const headers = await signRequest({url:'https://api.qishui.com/luna/pc/track_v2?aid=386088&app_name=luna_pc&fp=1234567890123456',headers:{accept:'application/json'},did:'1234567890123456'}); if (!headers['x-helios'] || !headers['x-medusa']) throw new Error('missing signature'); }).catch(()=>process.exitCode=1)`)
	cmd.Dir = installed
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("installed runtime failed: %v, %s", err, out)
	}
	manifest, err := os.ReadFile(filepath.Join(installed, "assets", "scene-covers", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var art struct {
		Covers map[string]string `json:"covers"`
	}
	if err := json.Unmarshal(manifest, &art); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"preference:familiar", "category:other"} {
		if art.Covers[id] == "" {
			t.Fatal("missing installed scene artwork")
		}
		image, err := music.Fetch(music.FileURL(filepath.Join(installed, "assets", "scene-covers", art.Covers[id])))
		if err != nil || len(image) < 8 || string(image[1:4]) != "PNG" {
			t.Fatalf("MyGO could not fetch the installed scene cover: %v", err)
		}
	}
	historyCover, err := music.Fetch(music.FileURL(filepath.Join(installed, "assets", "history.png")))
	if err != nil || len(historyCover) < 8 || string(historyCover[1:4]) != "PNG" {
		t.Fatalf("MyGO could not fetch the installed history cover: %v", err)
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

// A real SDK-generated QR must reach MyGO, and signing out must cancel the helper without storing credentials.
func TestQishuiPluginLiveCancel(t *testing.T) {
	if os.Getenv("QISHUI_HOST_PREFLIGHT") != "1" {
		t.Skip("QISHUI_HOST_PREFLIGHT is not set")
	}
	p, err := Load(os.Getenv("QISHUI_PLUGIN_DIR"), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	if err := p.Grant(true); err != nil {
		t.Fatal(err)
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
