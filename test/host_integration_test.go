// Copy this file into MyGO Music's internal/plugin directory and run it there
// with QISHUI_PLUGIN_DIR pointing to this plugin. It uses the actual moejs host.
package plugin

import (
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
const account = {id: '7123456789012345678', name: 'Test Account'};
for await (const line of readline.createInterface({input: process.stdin})) {
  const spec = JSON.parse(line);
  let frame;
  if (spec.op === 'start') frame = {ok: true, qr: 'https://bff-pc.qishui.com/test', expiresIn: 60000};
  else if (spec.op === 'check') frame = {ok: true, status: 'confirmed', account, session: {version: 1, cookies: [{name: 'sessionid', value: 'test'}]}};
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
	if err != nil || a == nil || a.ID != "7123456789012345678" {
		t.Fatalf("sign in: %v, %v", a, err)
	}
	if prompt.QR != "https://bff-pc.qishui.com/test" {
		t.Fatal("original QR did not reach the host")
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
	cmd := exec.Command(filepath.Join(installed, "bin", executable), "-e", `require('playwright-core'); require('fs').readFileSync('runtime/security/bdms.js'); require('fs').readFileSync('runtime/security/sdk-glue.js')`)
	cmd.Dir = installed
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("installed runtime failed: %v, %s", err, out)
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
