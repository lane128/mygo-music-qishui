// Copy alongside host_integration_test.go into MyGo's internal/plugin package.
package plugin

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A 2046 fallback uses the real process boundary and validates its returned session.
func TestQishuiBrowserLogin(t *testing.T) {
	for _, tc := range []struct{ name, frame, wantError string }{
		{"validated session", `{"type":"complete","cookie":"sessionid=test-session-value"}`, ""},
		{"cancelled", `{"type":"error","code":"closed"}`, "登录已取消"},
		{"missing session", `{"type":"complete","cookie":"other=value"}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			qishuiAuthFixture(t)
			base := http.DefaultTransport
			http.DefaultTransport = qishuiAuthTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/passport/web/check_qrconnect/" {
					return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"data":{"error_code":2046}}`)), Request: r}, nil
				}
				return base.RoundTrip(r)
			})
			dir := t.TempDir()
			for _, name := range []string{"plugin.json", "index.js"} {
				data, e := os.ReadFile(filepath.Join(os.Getenv("QISHUI_PLUGIN_DIR"), name))
				if e != nil {
					t.Fatal(e)
				}
				if e = os.WriteFile(filepath.Join(dir, name), data, 0600); e != nil {
					t.Fatal(e)
				}
			}
			if e := os.Mkdir(filepath.Join(dir, "bin"), 0700); e != nil {
				t.Fatal(e)
			}
			// The real host starts a child process and consumes its JSON line.
			script := "#!/bin/sh\nread request\n/usr/bin/printf '%s\\n' '" + tc.frame + "'\n"
			if e := os.WriteFile(filepath.Join(dir, "bin/qishui-helper-login-darwin-"+runtime.GOARCH), []byte(script), 0700); e != nil {
				t.Fatal(e)
			}
			p, e := Load(dir, t.TempDir())
			if e != nil {
				t.Fatal(e)
			}
			defer p.Close()
			if e = p.Grant(true); e != nil {
				t.Fatal(e)
			}
			account, e := p.SignIn()
			if runtime.GOOS != "darwin" {
				if e == nil || !strings.Contains(e.Error(), "额外验证") {
					t.Fatalf("unsupported platform lost its verification error: %v", e)
				}
				return
			}
			if tc.name == "validated session" {
				if e != nil || account == nil || account.ID != "7123456789012345678" {
					t.Fatalf("profile validation failed: %v", e)
				}
			} else {
				if e == nil || (tc.wantError != "" && !strings.Contains(e.Error(), tc.wantError)) {
					t.Fatalf("unexpected login outcome: %v", e)
				}
				if stored, e := p.Account(); e != nil || stored != nil {
					t.Fatal("failed login saved an account")
				}
			}
		})
	}
}
