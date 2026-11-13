// Independent plugin-owned native login window. Assisted-by: Cindy (https://cindy.app)
package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"log"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

//go:embed page/*.js page/vendor/react-18.3.1/*.js
var pageScripts embed.FS

const origin = "https://api.qishui.com"

// The API error page can select GB18030 in WebKit and corrupt UTF-8 SDKs.
// Keep the official API origin with an explicit UTF-8 bootstrap document.
const bootstrapHTML = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"mygo-qishui-bootstrap\" content=\"1\"></head><body></body></html>"

type device struct {
	Schema                  int
	Aid                     int
	Did, Iid, ClientVersion string
}
type startRequest struct {
	Type         string
	Device       device
	ComputerName string
	TimeoutMs    int
}
type signInOptions struct {
	CookiesOf, ScriptOrigin string
	Until, UntilAny         []string
}
type signInError struct{ Code, Message, Stage, Reason, VerificationHost string }

func (e *signInError) Error() string     { return e.Message }
func problem(code, message string) error { return &signInError{Code: code, Message: message} }

// Production has no QA controls; tagged verification builds install these hooks.
var beforePage func(string) string
var observePage func(*mygo.Window)

func main() {
	log.SetOutput(os.Stderr)
	input := bufio.NewScanner(os.Stdin)
	input.Buffer(make([]byte, 4096), 262144)
	initial := make(chan []byte, 1)
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		if input.Scan() {
			initial <- append([]byte(nil), input.Bytes()...)
		}
		for input.Scan() {
		}
	}()
	var req startRequest
	select {
	case raw := <-initial:
		if json.Unmarshal(raw, &req) != nil {
			emitError(problem("setup", "登录组件收到无效请求，请重新安装插件。"))
			return
		}
	case <-closed:
		return
	case <-time.After(30 * time.Second):
		return
	}
	id := regexp.MustCompile("^[1-9][0-9]{8,24}$")
	if req.Type != "start" || req.Device.Schema != 1 || req.Device.Aid != 386088 || !id.MatchString(req.Device.Did) || !id.MatchString(req.Device.Iid) || req.Device.ClientVersion == "" || len(req.Device.ClientVersion) > 32 || req.ComputerName == "" || len([]rune(req.ComputerName)) > 255 || strings.ContainsAny(req.ComputerName, "\r\n\x00") {
		emitError(problem("setup", "登录设备信息不完整，请重新登录。"))
		return
	}
	if req.TimeoutMs < 1000 || req.TimeoutMs > 240000 {
		req.TimeoutMs = 240000
	}
	script, err := scripts(req)
	if err != nil {
		emitError(err)
		return
	}
	if beforePage != nil {
		script = beforePage(script)
	}
	mygo.App.SetName("MyGo 汽水登录")
	mygo.App.OnWindowAllClosed(func() {})
	mygo.App.WhenReady(func() {
		go func() {
			type outcome struct {
				cookie string
				err    error
			}
			done := make(chan outcome, 1)
			go func() {
				cookie, err := login(script, time.Duration(req.TimeoutMs)*time.Millisecond, closed)
				done <- outcome{cookie, err}
			}()
			deadline := time.NewTimer(time.Duration(req.TimeoutMs)*time.Millisecond + time.Second)
			defer deadline.Stop()
			var result outcome
			// Independent of page evaluation and native Cookie callbacks.
			select {
			case result = <-done:
			case <-closed:
				result.err = problem("closed", "登录已取消，请重新登录。")
			case <-deadline.C:
				result.err = problem("timeout", "本次登录已超时，请重新登录。")
			}
			if result.err != nil {
				emitError(result.err)
			} else {
				emit(map[string]any{"type": "complete", "cookie": result.cookie})
			}
			for _, window := range mygo.Windows() {
				window.Close()
			}
			mygo.App.Quit()
		}()
	})
	if err := mygo.App.Run(); err != nil {
		emitError(problem("setup", "无法启动汽水登录窗口，请检查系统网页组件。"))
	}
}

// stdout is exclusively the parent's private JSON-lines channel.
func emit(value any) { json.NewEncoder(os.Stdout).Encode(value) }
func emitError(err error) {
	if e, ok := err.(*signInError); ok {
		emit(map[string]any{"type": "error", "code": e.Code, "message": e.Message, "stage": e.Stage, "reason": e.Reason, "verificationHost": e.VerificationHost})
		return
	}
	emit(map[string]any{"type": "error", "code": "page", "message": "登录组件未能完成，请重新登录。"})
}

func scripts(req startRequest) (string, error) {
	data, _ := json.Marshal(map[string]any{"device": map[string]any{"schema": req.Device.Schema, "aid": req.Device.Aid, "did": req.Device.Did, "iid": req.Device.Iid, "clientVersion": req.Device.ClientVersion}, "computerName": req.ComputerName})
	var result strings.Builder
	result.WriteString("if(location.origin==='" + origin + "'){window.__mygoSignInData=" + string(data) + ";\n")
	for _, name := range []string{"vendor/react-18.3.1/react.production.min.js", "vendor/react-18.3.1/react-dom.production.min.js", "browser-info.js", "browser-verification.js", "embedded-login.js"} {
		b, e := pageScripts.ReadFile("page/" + name)
		if e != nil || len(b)+result.Len() > 524288 {
			return "", problem("setup", "登录脚本无效，请重新安装插件。")
		}
		result.Write(b)
		result.WriteString("\n;\n")
	}
	result.WriteString("\n}")
	return result.String(), nil
}

func login(script string, timeout time.Duration, cancelled <-chan struct{}) (string, error) {
	var available bool
	mygo.RunOnMain(func() { available = mygo.WebViewAvailable() })
	if !available {
		return "", problem("setup", "系统无法显示汽水验证窗口。")
	}
	session := mygo.NewEphemeralSession()
	win := mygo.NewWindow(mygo.WindowOptions{Title: "登录汽水音乐", Width: 480, Height: 680, MinWidth: 360, MinHeight: 480, Page: mygo.PageOptions{Session: session, PreloadScript: script, Untrusted: true}})
	// MyGo starts helpers with a hidden console (STARTF_USESHOWWINDOW with
	// SW_HIDE). Windows applies that setting to the process's first ShowWindow
	// call, which creating the window already made, so show it once more: the
	// second call honors SW_SHOW. Without this, Windows opens no visible window.
	win.Show()

	defer embeddedSignInPopups(win, session)()
	defer win.Close()
	closed := make(chan struct{})
	win.OnClosed(func() { close(closed) })
	failed := make(chan struct{}, 1)
	win.Page().OnDidFailLoad(func(_ *mygo.LoadError) {
		select {
		case failed <- struct{}{}:
		default:
		}
	})
	win.Page().LoadHTML(bootstrapHTML, origin+"/")
	if observePage != nil {
		go observePage(win)
	}
	options := signInOptions{CookiesOf: origin + "/", ScriptOrigin: origin, UntilAny: []string{"sessionid", "sessionid_ss"}}
	lastQR, applied, completed := "", false, false
	tick := time.NewTicker(400 * time.Millisecond)
	defer tick.Stop()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		select {
		case <-cancelled:
			return "", problem("closed", "登录已取消，请重新登录。")
		case <-closed:
			return "", problem("closed", "登录窗口已关闭，登录尚未完成。")
		case <-failed:
			return "", problem("load", "登录页面未能加载，请检查网络后重试。")
		case <-deadline.C:
			return "", problem("timeout", "本次登录已超时，请重新登录。")
		case <-tick.C:
			if err := scriptedSignInState(win, options, session, &lastQR, &applied, &completed); err != nil {
				return "", err
			}
			if !completed {
				continue
			}
			cookies, err := session.Cookies.List(mygo.CookieFilter{URL: origin + "/"})
			if err != nil {
				continue
			}
			if header, ok := signInCookies(cookies, nil, options.UntilAny); ok {
				if len(header) > 65536 {
					return "", problem("page", "登录凭据无效，请重新登录。")
				}
				return header, nil
			}
		}
	}
}

func cookieHeader(cookies []mygo.Cookie, until []string) (string, bool) {
	have := map[string]bool{}
	values := []string{}
	for _, c := range cookies {
		if c.Value != "" && signInCookieName.MatchString(c.Name) && !strings.ContainsAny(c.Value, ";\r\n\x00") {
			have[c.Name] = true
			values = append(values, c.Name+"="+c.Value)
		}
	}
	for _, name := range until {
		if !have[name] {
			return "", false
		}
	}
	return strings.Join(values, "; "), true
}

func T(text string) string {
	translations := map[string]string{
		"The sign-in page returned invalid data":        "登录页面返回的数据无效。",
		"The sign-in page returned an invalid QR code":  "登录页面返回的二维码无效。",
		"The sign-in QR code could not be generated":    "无法生成登录二维码。",
		"The sign-in page returned invalid credentials": "登录页面返回的凭据无效。",
		"The sign-in session could not be saved":        "无法保存本次登录会话。",
		"Sign-in verification":                          "汽水音乐安全验证",
	}
	if value, ok := translations[text]; ok {
		return value
	}
	return text
}
