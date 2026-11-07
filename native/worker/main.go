// The helper never performs account/API requests or stores account state.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const maxFrame = 131072
const maxAudio = 128 * 1024 * 1024

type failure string

func (e failure) Error() string { return string(e) }

const (
	errUnavailable failure = "unavailable"
	errSetup       failure = "setup"
	errResponse    failure = "response"
)

func errorKind(err error) string {
	switch err {
	case errSetup:
		return "setup"
	case failure("session"):
		return "session"
	case failure("unsupported"):
		return "unsupported"
	case errResponse:
		return "response"
	}
	return "unavailable"
}

var digits16 = regexp.MustCompile(`^[0-9]{16}$`)
var digits15 = regexp.MustCompile(`^[0-9]{15}$`)
var trackID = regexp.MustCompile(`^[0-9]{1,32}$`)

type session struct {
	Version   int    `json:"version"`
	DeviceID  string `json:"deviceID"`
	InstallID string `json:"installID"`
}
type request struct {
	Op      string          `json:"op"`
	Method  string          `json:"method"`
	Session session         `json:"session"`
	Params  json.RawMessage `json:"params"`
}
type response struct {
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Reject duplicate JSON members before decoding security-sensitive header maps.
func validJSON(raw []byte) bool {
	if !utf8.Valid(raw) {
		return false
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var value func(int) bool
	value = func(depth int) bool {
		if depth > 64 {
			return false
		}
		t, e := d.Token()
		if e != nil {
			return false
		}
		delim, compound := t.(json.Delim)
		if !compound {
			return true
		}
		if delim == '{' {
			seen := map[string]bool{}
			for d.More() {
				key, e := d.Token()
				if e != nil {
					return false
				}
				k, ok := key.(string)
				if !ok || seen[k] {
					return false
				}
				seen[k] = true
				if !value(depth + 1) {
					return false
				}
			}
		} else if delim == '[' {
			for d.More() {
				if !value(depth + 1) {
					return false
				}
			}
		} else {
			return false
		}
		close, e := d.Token()
		return e == nil && (delim == '{' && close == json.Delim('}') || delim == '[' && close == json.Delim(']'))
	}
	if !value(0) {
		return false
	}
	_, e := d.Token()
	return e == io.EOF
}

type worker struct {
	root     string
	mu       sync.Mutex
	audio    *audioBridge
	download func(context.Context, string) ([]byte, error)
	decode   func(context.Context, []byte, string) ([]byte, error)
	convert  func(context.Context, []byte) ([]byte, error)
	sign     func(context.Context, signSpec) (map[string]string, error)
}

func newWorker(root string) *worker {
	w := &worker{root: root}
	w.download = downloadGranted
	w.decode = func(ctx context.Context, b []byte, a string) ([]byte, error) { return decodeResource(ctx, root, b, a) }
	w.convert = func(ctx context.Context, b []byte) ([]byte, error) { return convertAAC(ctx, root, b) }
	w.sign = func(ctx context.Context, s signSpec) (map[string]string, error) { return signRequest(ctx, root, s) }
	return w
}
func (w *worker) handle(ctx context.Context, raw []byte) (any, error) {
	if len(raw) > maxFrame || !validJSON(raw) {
		return nil, errResponse
	}
	var r request
	if json.Unmarshal(raw, &r) != nil || r.Op != "music" {
		return nil, errResponse
	}
	if r.Session.Version != 1 || !digits16.MatchString(r.Session.DeviceID) || !digits15.MatchString(r.Session.InstallID) {
		return nil, failure("session")
	}
	switch r.Method {
	case "sign":
		spec, e := parseSign(r.Params, r.Session.DeviceID)
		if e != nil {
			return nil, e
		}
		return w.sign(ctx, spec)
	case "stream":
		var p struct {
			ID      string          `json:"id"`
			Quality string          `json:"quality"`
			Grant   json.RawMessage `json:"grant"`
		}
		if json.Unmarshal(r.Params, &p) != nil || !trackID.MatchString(p.ID) {
			return nil, errUnavailable
		}
		stream, e := resolvePlayback(ctx, p.Grant, p.ID, p.Quality, w)
		if e != nil {
			return nil, e
		}
		if ctx.Err() != nil {
			return nil, errUnavailable
		}
		w.mu.Lock()
		if ctx.Err() != nil {
			w.mu.Unlock()
			return nil, errUnavailable
		}
		if w.audio == nil {
			w.audio, e = newAudioBridge()
		}
		audio := w.audio
		w.mu.Unlock()
		if e != nil || ctx.Err() != nil {
			return nil, errUnavailable
		}
		result, e := audio.add(stream)
		if ctx.Err() != nil {
			if result != nil {
				audio.discardURL(result.URL)
			}
			return nil, errUnavailable
		}
		return result, e
	default:
		return nil, failure("unsupported")
	}
}
func (w *worker) close() {
	w.mu.Lock()
	audio := w.audio
	w.mu.Unlock()
	if audio != nil {
		audio.close()
	}
}

type inputFrame struct {
	data    []byte
	invalid bool
}

// Continue after oversized lines without ever retaining an unbounded line. EOF
// cancels independently of the request loop, including while a child is active.
func readFrames(ctx context.Context, in io.Reader, frames chan<- inputFrame, stop context.CancelFunc) {
	defer stop()
	defer close(frames)
	r := bufio.NewReaderSize(in, 32768)
	for {
		var line []byte
		oversized := false
		for {
			part, e := r.ReadSlice('\n')
			if len(line)+len(part) > maxFrame+1 {
				oversized = true
				line = nil
			}
			if !oversized {
				line = append(line, part...)
			}
			if e == bufio.ErrBufferFull {
				continue
			}
			if e != nil {
				return
			}
			break
		}
		line = bytes.TrimSuffix(line, []byte{'\n'})
		line = bytes.TrimSuffix(line, []byte{'\r'})
		f := inputFrame{data: line, invalid: oversized || len(line) > maxFrame}
		select {
		case frames <- f:
		case <-ctx.Done():
			return
		default:
			return
		} // bounded pending requests
	}
}
func runIPC(parent context.Context, in io.Reader, out io.Writer, w *worker, idle time.Duration) {
	ctx, stop := context.WithCancel(parent)
	defer stop()
	defer w.close()
	frames := make(chan inputFrame, 16)
	go readFrames(ctx, in, frames, stop)
	timer := time.AfterFunc(idle, stop)
	defer timer.Stop()
	// Close sockets and pipes before waiting for bounded child teardown. Closing
	// stdout also interrupts a response write if the parent stopped reading it.
	go func() {
		<-ctx.Done()
		w.close()
		if c, ok := in.(io.Closer); ok {
			_ = c.Close()
		}
		if c, ok := out.(io.Closer); ok {
			_ = c.Close()
		}
	}()
	enc := json.NewEncoder(out)
	for {
		select {
		case <-ctx.Done():
			return
		case f, ok := <-frames:
			if !ok || ctx.Err() != nil {
				return
			}
			if !f.invalid {
				var p struct {
					Op string `json:"op"`
				}
				if json.Unmarshal(f.data, &p) == nil && p.Op == "music" {
					timer.Stop()
				}
			}
			reqctx, cancel := context.WithTimeout(ctx, 24*time.Second)
			var result any
			var e error
			if f.invalid {
				e = errResponse
			} else {
				result, e = w.handle(reqctx, f.data)
			}
			cancel()
			if ctx.Err() != nil {
				return
			}
			frame := response{OK: e == nil, Result: result}
			if e != nil {
				frame.Result = nil
				frame.Error = errorKind(e)
			}
			if enc.Encode(frame) != nil {
				return
			}
		}
	}
}
func main() {
	// No raw errors or panic values may leave this process.
	defer func() {
		if recover() != nil {
			os.Exit(1)
		}
	}()
	if len(os.Args) == 2 && os.Args[1] == "--decode" {
		if decodeMain(os.Stdin, os.Stdout) != nil {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) != 1 {
		os.Exit(1)
	}
	executable, e := os.Executable()
	if e != nil {
		os.Exit(1)
	}
	executable, e = filepath.EvalSymlinks(executable)
	if e != nil {
		os.Exit(1)
	}
	root := filepath.Dir(filepath.Dir(executable))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	runIPC(ctx, os.Stdin, os.Stdout, newWorker(root), 40*time.Second)
}
