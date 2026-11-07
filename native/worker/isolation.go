package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

func regular(path string) (string, error) {
	p, e := filepath.EvalSymlinks(path)
	if e != nil {
		return "", errSetup
	}
	info, e := os.Stat(p)
	if e != nil || !info.Mode().IsRegular() {
		return "", errSetup
	}
	return p, nil
}
func canonical(path string) (string, error) {
	p, e := filepath.EvalSymlinks(path)
	if e != nil {
		return "", errSetup
	}
	return filepath.Abs(p)
}
func within(root, p string) bool {
	return p == root || strings.HasPrefix(p, root+string(filepath.Separator))
}
func quotePolicy(s string) string { b, _ := json.Marshal(s); return string(b) }

// Matches helper/native.mjs: canonical home denial with only needed files and
// ancestor metadata exceptions. No directory listing exception is granted.
func sandboxPolicy(root string, readable []string, home string) (string, error) {
	var e error
	root, e = canonical(root)
	if e != nil {
		return "", errSetup
	}
	home, e = canonical(home)
	if e != nil {
		return "", errSetup
	}
	allowed := map[string]bool{}
	ancestors := map[string]bool{}
	for _, file := range readable {
		file, e = canonical(file)
		if e != nil {
			return "", errSetup
		}
		allowed[file] = true
		for p := filepath.Dir(file); p != filepath.Dir(p); p = filepath.Dir(p) {
			if within(home, p) {
				ancestors[p] = true
				allowed[p] = true
			}
		}
	}
	// Sorted output makes the policy reviewable and deterministic.
	keys := sortedKeys(allowed)
	var exceptions strings.Builder
	for _, file := range keys {
		exceptions.WriteString(" (require-not (literal " + quotePolicy(file) + "))")
	}
	policy := "(version 1)\n(allow default)\n(deny network*)\n(deny file-read* (require-all (subpath " + quotePolicy(home) + ")" + exceptions.String() + "))\n"
	for _, dir := range sortedKeys(ancestors) {
		policy += "(deny file-read-data (literal " + quotePolicy(dir) + "))\n"
	}
	// The signer redirects untrusted SDK diagnostics to /dev/null before loading
	// it. Permit that sink while keeping all other writes outside scratch denied.
	policy += "(deny file-read* (subpath \"/Library/Keychains\"))\n(deny file-write* (require-all (require-not (subpath " + quotePolicy(root) + ")) (require-not (literal \"/dev/null\"))))\n"
	return policy, nil
}
func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

type boundedOutput struct {
	buf      bytes.Buffer
	limit    int
	overflow bool
	stop     func()
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.buf.Len() {
		b.overflow = true
		b.stop()
		return 0, errUnavailable
	}
	return b.buf.Write(p)
}

// All child stderr is discarded. The launcher, child argv and underlying OS
// errors never form a diagnostic returned over IPC.
func runIsolated(ctx context.Context, command string, args []string, input []byte, limit int, scratch string, windows bool) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 22*time.Second)
	defer cancel()
	if ctx.Err() != nil {
		return nil, errUnavailable
	}
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir = scratch
	if windows {
		systemRoot := os.Getenv("SystemRoot")
		if systemRoot == "" {
			systemRoot = `C:\Windows`
		}
		cmd.Env = []string{"SystemRoot=" + systemRoot, "TEMP=" + scratch, "TMP=" + scratch}
	} else {
		cmd.Env = []string{"PATH=/usr/bin:/bin", "TMPDIR=" + scratch, "LANG=en_US.UTF-8"}
	}
	cmd.Stdin = bytes.NewReader(input)
	cmd.Stderr = io.Discard
	cmd.WaitDelay = 2500 * time.Millisecond
	var mu sync.Mutex
	var forced *time.Timer
	if windows {
		cmd.Cancel = func() error {
			if e := os.WriteFile(filepath.Join(scratch, ".cancel"), nil, 0600); e != nil {
				return cmd.Process.Kill()
			}
			mu.Lock()
			forced = time.AfterFunc(2*time.Second, func() { _ = cmd.Process.Kill() })
			mu.Unlock()
			return nil
		}
	}
	output := &boundedOutput{limit: limit, stop: cancel}
	cmd.Stdout = output
	if e := cmd.Start(); e != nil {
		return nil, errSetup
	}
	e := cmd.Wait()
	mu.Lock()
	if forced != nil {
		forced.Stop()
	}
	mu.Unlock()
	if ctx.Err() != nil || output.overflow {
		return nil, errUnavailable
	}
	if e != nil {
		if windows && cmd.ProcessState != nil && cmd.ProcessState.ExitCode() == 125 {
			return nil, errSetup
		}
		return nil, errUnavailable
	}
	return output.buf.Bytes(), nil
}
func copyPrivate(source, destination string) error {
	source, e := regular(source)
	if e != nil {
		return errSetup
	}
	in, e := os.Open(source)
	if e != nil {
		return errSetup
	}
	defer in.Close()
	out, e := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
	if e != nil {
		return errSetup
	}
	_, e = io.Copy(out, in)
	closeErr := out.Close()
	if e != nil || closeErr != nil {
		return errSetup
	}
	return nil
}
func cleanupScratch(path string) error {
	for attempt := 0; attempt < 6; attempt++ {
		if os.RemoveAll(path) == nil {
			return nil
		}
		if runtime.GOOS != "windows" {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	return errUnavailable
}

func isolatedNative(ctx context.Context, plugin, operation string, input []byte, limit int) (result []byte, resultErr error) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" || runtime.GOOS == "darwin" && runtime.GOARCH != "arm64" || runtime.GOOS == "windows" && runtime.GOARCH != "amd64" {
		return nil, errSetup
	}
	if ctx.Err() != nil {
		return nil, errUnavailable
	}
	scratch, e := os.MkdirTemp("", "qishui-native-")
	if e != nil {
		return nil, errSetup
	}
	cleanupPath := scratch
	defer func() {
		if cleanupScratch(cleanupPath) != nil {
			result = nil
			resultErr = errUnavailable
		}
	}()
	scratch, e = canonical(scratch)
	if e != nil {
		return nil, errSetup
	}
	windows := runtime.GOOS == "windows"
	ext := ""
	if windows {
		ext = ".exe"
	}
	native := filepath.Join(plugin, "runtime", "native")
	var executable string
	var args, readable, files []string
	switch operation {
	case "sign":
		executable, e = regular(filepath.Join(native, "qishui-sign"+ext))
		if windows {
			files = []string{"bdms.node", "metasecml.dll"}
		} else {
			files = []string{"bdms.node", "libMetaSecML.dylib"}
		}
	case "decode":
		program := "qishui-helper-" + runtime.GOOS + "-" + runtime.GOARCH + ext
		executable, e = regular(filepath.Join(plugin, "bin", program))
		args = []string{"--decode"}
	case "convert":
		program := "audio-convert"
		if windows {
			program = "ffmpeg.exe"
		}
		executable, e = regular(filepath.Join(native, program))
	default:
		return nil, errSetup
	}
	if e != nil {
		return nil, errSetup
	}
	readable = append(readable, executable)
	for _, name := range files {
		file, e := regular(filepath.Join(native, name))
		if e != nil {
			return nil, errSetup
		}
		readable = append(readable, file)
	}
	if windows {
		staged := filepath.Join(scratch, "worker.exe")
		if e = copyPrivate(executable, staged); e != nil {
			return nil, e
		}
		executable = staged
		for _, name := range files {
			if e = copyPrivate(filepath.Join(native, name), filepath.Join(scratch, name)); e != nil {
				return nil, e
			}
		}
	}
	var outputPath string
	if operation == "convert" {
		inputPath := filepath.Join(scratch, "input.m4a")
		outputPath = filepath.Join(scratch, "output.flac")
		if len(input) == 0 || len(input) > maxAudio {
			return nil, errUnavailable
		}
		if e = os.WriteFile(inputPath, input, 0600); e != nil {
			return nil, errUnavailable
		}
		readable = append(readable, inputPath)
		input = nil
		limit = 4096
		args = []string{inputPath, outputPath}
		if windows {
			args = aacConversionArgs(inputPath, outputPath)
		}
	}
	command := "/usr/bin/sandbox-exec"
	if windows {
		command, e = regular(filepath.Join(native, "windows-runner.exe"))
		if e != nil {
			return nil, errSetup
		}
		args = append([]string{"--root", scratch, "--parent", strconv.Itoa(os.Getpid()), "--timeout-ms", "22000", "--", executable}, args...)
	} else {
		home, e := os.UserHomeDir()
		if e != nil {
			return nil, errSetup
		}
		policy, e := sandboxPolicy(scratch, readable, home)
		if e != nil {
			return nil, errSetup
		}
		args = append([]string{"-p", policy, executable}, args...)
	}
	result, e = runIsolated(ctx, command, args, input, limit, scratch, windows)
	if e != nil {
		return nil, e
	}
	if operation == "convert" {
		// Treat converter output as untrusted too: it cannot point the parent at
		// an account file through a symlink created inside private scratch.
		root, e := os.OpenRoot(scratch)
		if e != nil {
			return nil, errUnavailable
		}
		defer root.Close()
		file, e := root.Open(filepath.Base(outputPath))
		if e != nil {
			return nil, errUnavailable
		}
		defer file.Close()
		info, e := file.Stat()
		if e != nil || !info.Mode().IsRegular() || info.Size() <= 42 || info.Size() > maxAudio {
			return nil, errUnavailable
		}
		result, e = io.ReadAll(io.LimitReader(file, maxAudio+1))
		if e != nil || len(result) > maxAudio || !nativeFLAC(result) {
			return nil, errUnavailable
		}
	}
	if ctx.Err() != nil {
		return nil, errUnavailable
	}
	return result, nil
}
func aacConversionArgs(input, output string) []string {
	return []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-err_detect", "explode", "-y", "-protocol_whitelist", "file,pipe", "-i", input, "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", "-compression_level", "5", "-threads", "1", "-fs", strconv.Itoa(maxAudio), "-f", "flac", output}
}
func convertAAC(ctx context.Context, root string, data []byte) ([]byte, error) {
	return isolatedNative(ctx, root, "convert", data, 4096)
}
