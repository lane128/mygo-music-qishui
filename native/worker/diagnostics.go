//go:build qishui_diagnostics

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// summarize turns untrusted child stderr into one log line: printable ASCII
// only, and the end of the text, where the last error is.
func summarize(stderr string) string {
	text := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if r < 32 || r > 126 {
			return -1
		}
		return r
	}, stderr)
	if len(text) > 400 {
		text = text[len(text)-400:]
	}
	return text
}

// noteIsolation writes where an isolated child stopped, for the local test
// packages built with this tag. The released worker has no such build tag and
// compiles the empty form in diagnostics_off.go. On Windows the launcher gives
// the child its own NUL as stderr, so this records the launcher's fixed lines
// and the child's exit code, not the signer's own diagnostics; run the signer
// directly, outside the launcher, to see those.
func noteIsolation(operation string, code int, stderr string) {
	if runtime.GOOS != "windows" {
		return
	}
	text := summarize(stderr)
	path := filepath.Join(os.TempDir(), "qishui-diagnostics.log")
	if info, e := os.Stat(path); e == nil && info.Size() > 256*1024 {
		_ = os.Remove(path)
	}
	f, e := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if e != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s build=test op=%s exit=%d stderr=%q\n", time.Now().UTC().Format(time.RFC3339), operation, code, text)
}
