package main

import (
	"github.com/egoist/mygo"
	"strings"
	"testing"
)

func TestLoginScriptsEmbedded(t *testing.T) {
	script, err := scripts(startRequest{Device: device{Schema: 1, Aid: 386088, Did: "1234567890123456", Iid: "123456789012345", ClientVersion: "3.7.0"}, ComputerName: "MyGo Music"})
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{"window.__mygoSignInData=", "window.__mygoVerify", "ucSecondVerifyReact", "React", "__mygoLoginState"} {
		if !strings.Contains(script, marker) {
			t.Fatalf("missing login component %s", marker)
		}
	}
	if len(script) > 524288 {
		t.Fatal("unbounded preload script")
	}
}

func TestLoginRequiresValidSessionCookie(t *testing.T) {
	for _, cookies := range [][]mygo.Cookie{nil, {{Name: "csrf", Value: "token"}}, {{Name: "sessionid", Value: "bad\r\nInjected: value"}}, {{Name: "sessionid", Value: ""}}} {
		if _, ok := signInCookies(cookies, nil, []string{"sessionid", "sessionid_ss"}); ok {
			t.Fatal("accepted invalid session")
		}
	}
	got, ok := signInCookies([]mygo.Cookie{{Name: "sessionid", Value: "synthetic-session"}}, nil, []string{"sessionid", "sessionid_ss"})
	if !ok || got != "sessionid=synthetic-session" {
		t.Fatal("rejected valid session")
	}
}
