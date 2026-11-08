//go:build windows && (amd64 || arm64)

package runner_test

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// A copy of this very test image is the sandbox payload: no Node, FFmpeg or other runtime.
func TestMain(m *testing.M) {
	if len(os.Args) > 2 && os.Args[1] == "--runner-helper" {
		os.Exit(helper(os.Args[2:]))
	}
	os.Exit(m.Run())
}

func helper(args []string) int {
	switch args[0] {
	case "idle":
		fmt.Println(os.Getpid())
		for {
			time.Sleep(time.Second)
		}
	case "echo":
		body, err := io.ReadAll(os.Stdin)
		if err != nil {
			return 10
		}
		time.Sleep(150 * time.Millisecond) // stdin EOF must not kill this response.
		_, err = os.Stdout.Write(body)
		if err != nil {
			return 11
		}
		return 0
	case "isolation":
		if len(args) != 5 {
			return 12
		}
		root, fixture, address, self := args[1], args[2], args[3], args[4]
		var app, size uint32
		// TOKEN_INFORMATION_CLASS::TokenIsAppContainer = 29.
		if windows.GetTokenInformation(windows.GetCurrentProcessToken(), 29, (*byte)(unsafe.Pointer(&app)), 4, &size) != nil || app != 1 {
			return 13
		}
		for _, name := range []string{"TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"} {
			if os.Getenv(name) != root {
				return 14
			}
		}
		if os.Getenv("NODE_OPTIONS") != "" || os.Getenv("QISHUI_RUNNER_ENV_SECRET") != "" {
			return 15
		}
		if b, err := os.ReadFile(filepath.Join(root, "input")); err != nil || string(b) != "staged" {
			return 16
		}
		if err := os.Mkdir(filepath.Join(root, "output"), 0700); err != nil {
			return 17
		}
		if err := os.WriteFile(filepath.Join(root, "output", "result"), []byte("isolated"), 0600); err != nil {
			return 18
		}
		if _, err := os.ReadFile(fixture); !os.IsPermission(err) {
			return 19
		}
		if err := os.WriteFile(fixture, []byte("bad"), 0600); !os.IsPermission(err) {
			return 20
		}
		if err := os.WriteFile(filepath.Join(filepath.Dir(fixture), "outside-write"), []byte("bad"), 0600); !os.IsPermission(err) {
			return 21
		}
		if conn, err := net.DialTimeout("tcp4", address, time.Second); err == nil {
			conn.Close()
			return 22
		}
		// A second executable must be denied by the single-process Job limit.
		if err := exec.Command(self, "--runner-helper", "echo").Run(); err == nil {
			return 23
		}
		var containerInfo [512]byte
		// TOKEN_INFORMATION_CLASS::TokenAppContainerSid = 31, TOKEN_APPCONTAINER_INFORMATION.
		if windows.GetTokenInformation(windows.GetCurrentProcessToken(), 31, &containerInfo[0], uint32(len(containerInfo)), &size) != nil {
			return 24
		}
		sid := *(**windows.SID)(unsafe.Pointer(&containerInfo[0]))
		if sid == nil {
			return 25
		}
		fmt.Print("isolated\n", sid.String())
		return 0
	}
	return 24
}

func launcher(t *testing.T) string {
	t.Helper()
	if os.Getenv("QISHUI_TEST_WINDOWS") != "1" {
		t.Skip("set QISHUI_TEST_WINDOWS=1 on Windows amd64/arm64 to run real AppContainer tests")
	}
	path := os.Getenv("QISHUI_WINDOWS_RUNNER")
	if path == "" {
		var err error
		path, err = exec.LookPath("windows-runner.exe")
		if err != nil {
			t.Fatal("set QISHUI_WINDOWS_RUNNER to the built launcher")
		}
	}
	path, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func stage(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	image := filepath.Join(root, "helper.exe")
	if err := os.WriteFile(image, body, 0700); err != nil {
		t.Fatal(err)
	}
	return root, image
}

func command(runner, root, image string, parent, timeout int, args ...string) *exec.Cmd {
	request := []string{"--root", root, "--parent", strconv.Itoa(parent), "--timeout-ms", strconv.Itoa(timeout), "--", image}
	request = append(request, args...)
	cmd := exec.Command(runner, request...)
	cmd.Stdin = strings.NewReader("")
	return cmd
}

func TestIsolation(t *testing.T) {
	runner := launcher(t)
	root, image := stage(t)
	if err := os.WriteFile(filepath.Join(root, "input"), []byte("staged"), 0600); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	fixture := filepath.Join(outside, "private")
	if err := os.WriteFile(fixture, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	// Windows file modes alone do not establish a private fixture DACL.
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + user.User.Sid.String() + ")(A;OICI;FA;;;SY)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{outside, fixture} {
		if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
			t.Fatal(err)
		}
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	// Positive control: this is a real reachable TCP listener outside the sandbox.
	conn, err := net.DialTimeout("tcp4", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	cmd := command(runner, root, image, os.Getpid(), 15000, "--runner-helper", "isolation", root, fixture, listener.Addr().String(), image)
	cmd.Env = append(os.Environ(), "NODE_OPTIONS=--must-not-inherit", "QISHUI_RUNNER_ENV_SECRET=must-not-inherit")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	body, err := cmd.Output()
	if err != nil {
		t.Fatalf("sandbox helper failed: %v; fixed launcher diagnostic: %s", err, stderr.String())
	}
	parts := strings.Split(string(body), "\n")
	if len(parts) != 2 || parts[0] != "isolated" || !strings.HasPrefix(parts[1], "S-1-15-2-") {
		t.Fatal("unexpected sandbox response")
	}
	profileSID := parts[1]
	if b, err := os.ReadFile(fixture); err != nil || string(b) != "private" {
		t.Fatal("outside fixture changed")
	}
	if b, err := os.ReadFile(filepath.Join(root, "output", "result")); err != nil || string(b) != "isolated" {
		t.Fatal("sandbox output unavailable")
	}
	// Normal cleanup must revoke the per-run SID on original and newly created objects.
	for _, path := range []string{root, image, filepath.Join(root, "output"), filepath.Join(root, "output", "result")} {
		sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil || strings.Contains(sd.String(), profileSID) {
			t.Fatal("AppContainer ACL remained after normal cleanup")
		}
	}
}

func TestEOFIsNormalInputCompletion(t *testing.T) {
	runner := launcher(t)
	root, image := stage(t)
	cmd := command(runner, root, image, os.Getpid(), 15000, "--runner-helper", "echo")
	cmd.Stdin = strings.NewReader("completed after EOF")
	body, err := cmd.Output()
	if err != nil || string(body) != "completed after EOF" {
		t.Fatalf("EOF response failed: %v", err)
	}
}

func TestJobLifetime(t *testing.T) {
	runner := launcher(t)
	for _, mode := range []string{"timeout", "parent-exit", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			root, image := stage(t)
			parentPID, timeout := os.Getpid(), 22000
			if mode == "timeout" {
				timeout = 8000 // Leave profile creation and antivirus scanning time to start the helper.
			}
			if mode == "parent-exit" {
				self, _ := os.Executable()
				parent := exec.Command(self, "--runner-helper", "idle")
				if err := parent.Start(); err != nil {
					t.Fatal(err)
				}
				defer func() { _ = parent.Process.Kill(); _ = parent.Wait() }()
				parentPID = parent.Process.Pid
				// The actual kill occurs once the sandbox has reported its PID below.
			}
			cmd := command(runner, root, image, parentPID, timeout, "--runner-helper", "idle")
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer cmd.Process.Kill()
			scanner := bufio.NewScanner(stdout)
			if !scanner.Scan() {
				_ = cmd.Wait()
				t.Fatalf("helper did not start: %s", stderr.String())
			}
			pid, err := strconv.Atoi(scanner.Text())
			if err != nil {
				t.Fatal("invalid helper PID")
			}
			child, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
			if err != nil {
				t.Fatal(err)
			}
			defer windows.CloseHandle(child)
			switch mode {
			case "parent-exit":
				parent, err := os.FindProcess(parentPID)
				if err != nil || parent.Kill() != nil {
					t.Fatal("could not end monitored parent")
				}
			case "cancel":
				if err := os.WriteFile(filepath.Join(root, ".cancel"), nil, 0600); err != nil {
					t.Fatal(err)
				}
			}
			err = cmd.Wait()
			if err == nil {
				t.Fatal("expected launcher failure/cancellation")
			}
			expected := map[string]int{"timeout": 124, "parent-exit": 125, "cancel": 130}[mode]
			if cmd.ProcessState.ExitCode() != expected {
				t.Fatalf("unexpected launcher status %d: %s", cmd.ProcessState.ExitCode(), stderr.String())
			}
			if state, err := windows.WaitForSingleObject(child, 3000); err != nil || state != windows.WAIT_OBJECT_0 {
				t.Fatal("sandbox process survived job close")
			}
		})
	}
}

func TestRejectsHardlinkedImage(t *testing.T) {
	runner := launcher(t)
	root, image := stage(t)
	if err := os.Link(image, filepath.Join(root, "alias.exe")); err != nil {
		t.Fatal(err)
	}
	cmd := command(runner, root, image, os.Getpid(), 15000, "--runner-helper", "echo")
	if err := cmd.Run(); err == nil || cmd.ProcessState.ExitCode() != 125 {
		t.Fatal("hardlinked staging file was accepted")
	}
}

func TestInvalidRequestsFailClosed(t *testing.T) {
	runner := launcher(t)
	root, image := stage(t)
	for name, args := range map[string][]string{
		"missing":       nil,
		"file-root":     {"--root", image, "--parent", strconv.Itoa(os.Getpid()), "--timeout-ms", "1000", "--", image},
		"missing-root":  {"--root", filepath.Join(root, "absent"), "--parent", strconv.Itoa(os.Getpid()), "--timeout-ms", "1000", "--", filepath.Join(root, "absent", "helper.exe")},
		"relative-root": {"--root", "relative", "--parent", strconv.Itoa(os.Getpid()), "--timeout-ms", "1000", "--", image},
		"outside-exe":   {"--root", root, "--parent", strconv.Itoa(os.Getpid()), "--timeout-ms", "1000", "--", filepath.Join(filepath.Dir(root), "helper.exe")},
		"missing-exe":   {"--root", root, "--parent", strconv.Itoa(os.Getpid()), "--timeout-ms", "1000", "--", filepath.Join(root, "absent.exe")},
		"bad-timeout":   {"--root", root, "--parent", strconv.Itoa(os.Getpid()), "--timeout-ms", "22001", "--", image},
	} {
		t.Run(name, func(t *testing.T) {
			cmd := exec.Command(runner, args...)
			cmd.Stdin = strings.NewReader("")
			body, err := cmd.CombinedOutput()
			if err == nil || cmd.ProcessState.ExitCode() != 125 {
				t.Fatal("invalid request did not fail closed")
			}
			if strings.Contains(string(body), root) || strings.Contains(string(body), image) {
				t.Fatal("launcher leaked request paths")
			}
		})
	}
}
