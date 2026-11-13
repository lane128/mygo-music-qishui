// Adapted from MyGo Music v0.1.22 sign-in code and this project's patches.
// GNU AGPL v3; see LICENSE.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"rsc.io/qr"
)

type signInPageState struct {
	VerificationHost string `json:"verificationHost"`
	Status           string `json:"status"`
	Message          string `json:"message"`
	Code             string `json:"code"`
	Stage            string `json:"stage"`
	Reason           string `json:"reason"`
	QR               string `json:"qr"`
	Cookies          []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"cookies"`
}

var signInCookieName = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

// Scripted pages never receive a trusted Go bridge. Only this bounded state
// is read by the host, and the plugin still validates the account with its API.
func scriptedSignInState(win *mygo.Window, o signInOptions, session *mygo.Session, lastQR *string, applied, completed *bool) error {
	address, err := url.Parse(win.Page().URL())
	if err != nil || address.Scheme+"://"+address.Host != o.ScriptOrigin {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	originJSON, _ := json.Marshal(o.ScriptOrigin)
	value, err := win.Page().EvalContext(ctx, "location.origin==="+string(originJSON)+"?JSON.stringify(window.__mygoLoginState||null):null")
	if err != nil {
		return nil
	} // A navigation may still be loading; the window timeout remains active.
	text, ok := value.(string)
	if !ok || text == "null" {
		return nil
	}
	if len(text) > 32768 {
		return &signInError{Code: "page", Message: T("The sign-in page returned invalid data")}
	}
	var state signInPageState
	if json.Unmarshal([]byte(text), &state) != nil {
		return &signInError{Code: "page", Message: T("The sign-in page returned invalid data")}
	}
	if state.Status == "error" {
		messages := map[string]string{
			"closed":    "登录窗口已关闭，登录尚未完成。",
			"cancelled": "安全验证已取消，登录尚未完成。",
			"timeout":   "本次登录已超时，请重新登录。",
			"expired":   "二维码已过期或登录被取消，请重新登录。",
			"network":   "无法连接汽水登录接口，请检查网络后重试。",
			"qr":        "二维码来源或会话不符合预期，登录已停止。",
			"2046":      "汽水要求的安全验证未能完成，请重新登录。",
			"2156":      "汽水暂时未能完成登录，请稍后重试。",
		}
		code := state.Code
		message, known := messages[code]
		if !known {
			code = "page"
			message = "登录页面未能完成，请检查网络后重试。"
		}
		// Never forward page-controlled text, URLs or credentials into diagnostics.
		stage, reason := "", ""
		for _, allowed := range []string{"create", "poll", "sdk"} {
			if state.Stage == allowed {
				stage = allowed
			}
		}
		for _, allowed := range []string{"unsupported", "loadFailed", "repeat", "cancelled", "timeout", "missingChallenge", "scriptTimeout", "scriptDownload", "missingRuntime", "missingAPI", "sdkException"} {
			if state.Reason == allowed {
				reason = allowed
			}
		}
		hostname := ""
		if regexp.MustCompile(`^[a-z0-9.-]{1,253}$`).MatchString(state.VerificationHost) {
			hostname = state.VerificationHost
		}
		return &signInError{Code: code, Message: message, Stage: stage, Reason: reason, VerificationHost: hostname}
	}
	if state.QR != "" && state.QR != *lastQR {
		u, err := url.Parse(state.QR)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || len(state.QR) > 8192 {
			return &signInError{Code: "page", Message: T("The sign-in page returned an invalid QR code")}
		}
		code, err := qr.Encode(state.QR, qr.M)
		if err != nil {
			return &signInError{Code: "page", Message: T("The sign-in QR code could not be generated")}
		}
		code.Scale = 5
		args, _ := json.Marshal([]string{state.QR, "data:image/png;base64," + base64.StdEncoding.EncodeToString(code.PNG())})
		if delivered, err := win.Page().EvalContext(ctx, "location.origin==="+string(originJSON)+"&&window.__mygoSetQRCode?.(..."+string(args)+")"); err == nil && delivered == true {
			*lastQR = state.QR
		}
	}
	*completed = state.Status == "complete"
	if *completed && len(state.Cookies) > 0 && !*applied {
		if len(state.Cookies) > 8 {
			return errors.New("invalid sign-in cookie count")
		}
		allowed := map[string]bool{}
		for _, name := range append(append([]string{}, o.Until...), o.UntilAny...) {
			allowed[name] = true
		}
		cookieOrigin, _ := url.Parse(o.CookiesOf)
		for _, c := range state.Cookies {
			if !allowed[c.Name] || !signInCookieName.MatchString(c.Name) || c.Value == "" || len(c.Value) > 16384 || strings.ContainsAny(c.Value, ";\r\n\x00") {
				return &signInError{Code: "page", Message: T("The sign-in page returned invalid credentials")}
			}
			if err := session.Cookies.Set(mygo.Cookie{Name: c.Name, Value: c.Value, Domain: cookieOrigin.Hostname(), Path: "/", Secure: true, HTTPOnly: true}); err != nil {
				return &signInError{Code: "page", Message: T("The sign-in session could not be saved")}
			}
		}
		*applied = true
	}
	return nil
}

func signInCookies(cookies []mygo.Cookie, all, any []string) (string, bool) {
	header, ok := cookieHeader(cookies, all)
	if !ok {
		return "", false
	}
	if len(any) == 0 {
		return header, true
	}
	for _, pair := range strings.Split(header, "; ") {
		for _, name := range any {
			if strings.HasPrefix(pair, name+"=") {
				return header, true
			}
		}
	}
	return "", false
}

// Keep verification popups in MyGo and the same ephemeral session. Remote
// pages remain untrusted and cannot call application-wide Go services.
func embeddedSignInPopups(win *mygo.Window, session *mygo.Session) func() {
	handler := func(req mygo.WindowOpenRequest) *mygo.WindowOptions {
		u, err := url.Parse(req.URL)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
			return nil
		}
		return &mygo.WindowOptions{Title: T("Sign-in verification"), Width: 480, Height: 680, Parent: win, Page: mygo.PageOptions{Session: session, Untrusted: true}}
	}
	win.Page().SetWindowOpenHandler(handler)
	off := mygo.App.OnWindowCreated(func(child *mygo.Window) {
		if child.Parent() == win {
			child.Page().SetWindowOpenHandler(handler)
		}
	})
	return func() {
		off()
		for _, child := range mygo.Windows() {
			if child.Parent() == win {
				child.Close()
			}
		}
	}
}
