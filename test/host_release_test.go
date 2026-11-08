// Copy into MyGO's internal/plugin package. Opt in with QISHUI_CHECK_RELEASE=1
// and supply QISHUI_RELEASE_VERSION, QISHUI_PREVIOUS_VERSION and QISHUI_RELEASE_SHA256.
package plugin

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The anonymous public update path must select, verify and install the complete ZIP without touching user data.
func TestQishuiPublishedRelease(t *testing.T) {
	if os.Getenv("QISHUI_CHECK_RELEASE") != "1" {
		t.Skip("release verification is opt-in")
	}
	version, previous, expected := os.Getenv("QISHUI_RELEASE_VERSION"), os.Getenv("QISHUI_PREVIOUS_VERSION"), os.Getenv("QISHUI_RELEASE_SHA256")
	if version == "" || previous == "" || len(expected) != 64 {
		t.Fatal("release version, previous version and archive SHA-256 are required")
	}
	previousToken := githubToken
	githubToken = func() string { return "" }
	t.Cleanup(func() { githubToken = previousToken })
	release, err := Latest("lane128/mygo-music-qishui")
	if err != nil {
		t.Fatal(err)
	}
	asset := "plugin-" + runtime.GOOS + "-" + runtime.GOARCH + ".zip"
	if release.Version != "v"+version || !strings.HasSuffix(release.url, "/releases/download/v"+version+"/"+asset) {
		t.Fatal("MyGO did not select the expected complete public platform asset")
	}
	if !IsNewer(release.Version, "v"+previous) || IsNewer(release.Version, "v"+version) {
		t.Fatal("MyGO did not compare the release versions correctly")
	}
	dir := t.TempDir()
	pending, err := FetchRelease(release, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer pending.Discard()
	archive, err := os.Open(filepath.Join(pending.tmp, "archive.zip"))
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.New()
	_, copyErr := io.Copy(digest, archive)
	closeErr := archive.Close()
	if copyErr != nil || closeErr != nil || hex.EncodeToString(digest.Sum(nil)) != expected {
		t.Fatal("downloaded release archive failed SHA-256 validation")
	}
	if pending.Manifest.ID != "qishui-app-login" || pending.Manifest.Version != version {
		t.Fatal("downloaded manifest did not match the release")
	}
	if err := pending.Install(dir); err != nil {
		t.Fatal(err)
	}
	installed := filepath.Join(dir, "qishui-app-login")
	worker := filepath.Join("bin", "qishui-helper-"+runtime.GOOS+"-"+runtime.GOARCH)
	native := []string{"runtime/native/libMetaSecML.dylib", "runtime/native/audio-convert"}
	if runtime.GOOS == "windows" {
		worker += ".exe"
		native = []string{"runtime/native/metasecml.dll", "runtime/native/ffmpeg.exe", "runtime/native/windows-runner.exe", "runtime/native/FFMPEG-LICENSE", "runtime/native/GO-LICENSE", "runtime/native/X-SYS-LICENSE"}
	}
	signer := "runtime/native/qishui-sign"
	if runtime.GOOS == "windows" {
		signer += ".exe"
	}
	files := append([]string{worker, signer, "native/signer/include/NODE-LICENSE", "runtime/native/bdms.node", "LICENSE", "NOTICE.md", "src/plugin.mjs", "native/worker/go.mod"}, native...)
	for _, name := range files {
		info, err := os.Stat(filepath.Join(installed, name))
		if err != nil || info.Size() == 0 {
			t.Fatal("installed release is missing a required runtime file")
		}
		if name == worker && runtime.GOOS != "windows" && info.Mode().Perm()&0111 == 0 {
			t.Fatal("installed native worker is not executable")
		}
	}
	p, err := Load(installed, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	origin := p.Origin()
	if origin == nil || origin.Repo != release.Repo || origin.Version != "v"+version {
		t.Fatal("installed plugin is missing its repository update origin")
	}
	for _, capability := range []string{"home", "playlist", "artist", "album", "played", "search", "suggest", "lyrics", "stream", "stations", "stationNext", "browse", "comments", "likeComment", "postComment", "recent", "liked", "isLiked", "like", "savePlaylist", "createPlaylist", "renamePlaylist", "deletePlaylist", "addToPlaylist", "removeFromPlaylist"} {
		if !p.Can(capability) {
			t.Fatal("published plugin is missing its music capabilities")
		}
	}
	t.Log("public release discovery, version comparison, download hash, installation, runtime assets, capabilities and repository origin verified")
}
