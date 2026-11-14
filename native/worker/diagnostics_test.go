//go:build qishui_diagnostics

package main

import (
	"strings"
	"testing"
)

// The log line keeps one printable line and the end of a longer message, where
// the last failure is.
func TestSummarize(t *testing.T) {
	if got := summarize("a\nb\tc\r\nd\x00e\xe6\xb5\x8b"); got != "a b c  de" {
		t.Fatalf("unexpected summary %q", got)
	}
	long := strings.Repeat("x", 399) + "tail"
	if got := summarize(long); len(got) != 400 || !strings.HasSuffix(got, "tail") {
		t.Fatalf("long message did not keep its end: %d bytes", len(got))
	}
}
