//go:build windows && amd64

package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	attributeSecurityCapabilities = 0x00020009
	attributeJobList              = 0x0002000d                                                                                                    // Windows 10+: atomic job membership at creation.
	appAccess                     = windows.FILE_GENERIC_READ | windows.FILE_GENERIC_WRITE | windows.FILE_GENERIC_EXECUTE | windows.DELETE | 0x40 // FILE_DELETE_CHILD
)

var (
	userenv       = windows.NewLazySystemDLL("userenv.dll")
	createProfile = userenv.NewProc("CreateAppContainerProfile")
	deleteProfile = userenv.NewProc("DeleteAppContainerProfile")
)

type securityCapabilities struct {
	AppContainerSid *windows.SID
	Capabilities    unsafe.Pointer
	CapabilityCount uint32
	Reserved        uint32
}

type config struct {
	root    string
	parent  uint32
	timeout time.Duration
	exe     string
	args    []string
}

// All diagnostics are fixed strings. Do not print OS errors, argv, paths or child stderr.
func main() {
	defer func() {
		if recover() != nil {
			_, _ = io.WriteString(os.Stderr, "windows-runner: internal failure\n")
			os.Exit(125)
		}
	}()
	code, err := run(os.Args[1:])
	if err != nil {
		_, _ = io.WriteString(os.Stderr, "windows-runner: "+err.Error()+"\n")
	}
	os.Exit(code)
}

func parse(args []string) (config, error) {
	var c config
	fs := flag.NewFlagSet("windows-runner", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var parent uint64
	var timeout int
	fs.StringVar(&c.root, "root", "", "")
	fs.Uint64Var(&parent, "parent", 0, "")
	fs.IntVar(&timeout, "timeout-ms", 0, "")
	// Require the explicit separator; flag otherwise also accepts a bare positional executable.
	separator := -1
	for i, arg := range args {
		if arg == "--" {
			separator = i
			break
		}
	}
	if separator < 0 || separator+1 >= len(args) || fs.Parse(args[:separator]) != nil || fs.NArg() != 0 || parent == 0 || parent > 0xffffffff || parent == uint64(os.Getpid()) || timeout < 1 || timeout > 22000 {
		return c, errors.New("invalid request")
	}
	c.root = filepath.Clean(c.root)
	c.exe = filepath.Clean(args[separator+1])
	c.args = args[separator+2:]
	c.parent, c.timeout = uint32(parent), time.Duration(timeout)*time.Millisecond
	if !localPath(c.root) || !localPath(c.exe) || !within(c.root, c.exe) || !strings.EqualFold(filepath.Ext(c.exe), ".exe") {
		return c, errors.New("invalid request")
	}
	home, _ := os.UserHomeDir()
	windir, err := windows.GetWindowsDirectory()
	if err != nil || within(c.root, home) || within(c.root, windir) || within(windir, c.root) {
		return c, errors.New("invalid request")
	}
	return c, nil
}

func localPath(p string) bool {
	if !filepath.IsAbs(p) || len(filepath.VolumeName(p)) != 2 || len(p) <= 3 || strings.ContainsAny(p[2:], ":\x00") {
		return false
	}
	for _, part := range strings.Split(p[3:], `\`) {
		if part == "" || strings.TrimRight(part, " .") != part {
			return false
		}
	}
	return true
}

func within(root, path string) bool {
	r, p := strings.ToLower(filepath.Clean(root)), strings.ToLower(filepath.Clean(path))
	return p == r || strings.HasPrefix(p, r+`\`)
}

func run(args []string) (code int, result error) {
	c, err := parse(args)
	if err != nil {
		return 125, err
	}
	deadline := time.Now().Add(c.timeout)
	parent, err := windows.OpenProcess(windows.SYNCHRONIZE, false, c.parent)
	if err != nil {
		return 125, errors.New("parent unavailable")
	}
	defer windows.CloseHandle(parent)
	if state, e := windows.WaitForSingleObject(parent, 0); e != nil || state != uint32(windows.WAIT_TIMEOUT) {
		return 125, errors.New("parent unavailable")
	}

	// Lock the root against rename/deletion, and reject reparse points in every ancestor.
	for p := c.root; len(p) > 3; p = filepath.Dir(p) {
		a, e := windows.GetFileAttributes(windows.StringToUTF16Ptr(p))
		if e != nil || a&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return 125, errors.New("invalid sandbox")
		}
	}
	rootHandle, err := openObject(c.root)
	if err != nil {
		return 125, errors.New("invalid sandbox")
	}
	defer windows.CloseHandle(rootHandle)
	var rootInfo windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(rootHandle, &rootInfo) != nil || rootInfo.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return 125, errors.New("invalid sandbox")
	}

	profileName, sid, err := newProfile()
	if err != nil {
		return 125, errors.New("isolation unavailable")
	}
	defer windows.FreeSid(sid)
	defer func() {
		if hr, _, _ := deleteProfile.Call(uintptr(unsafe.Pointer(profileName))); int32(hr) < 0 {
			code, result = 125, errors.New("cleanup failed")
		}
	}()

	cleanup, err := grantTree(c.root, sid)
	if cleanup != nil {
		defer func() {
			if cleanup() != nil {
				code, result = 125, errors.New("cleanup failed")
			}
		}()
	}
	if err != nil {
		return 125, errors.New("sandbox access failed")
	}
	// Keep the image stable between validation and CreateProcess.
	image, err := windows.CreateFile(windows.StringToUTF16Ptr(c.exe), windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return 125, errors.New("invalid executable")
	}
	defer windows.CloseHandle(image)
	var imageInfo windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(image, &imageInfo) != nil || imageInfo.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT) != 0 || imageInfo.NumberOfLinks != 1 {
		return 125, errors.New("invalid executable")
	}

	job, err := limitedJob()
	if err != nil {
		return 125, errors.New("isolation unavailable")
	}
	// Registered after ACL cleanup so jobs are always closed before restoring ACLs.
	defer func() {
		if job != 0 {
			windows.CloseHandle(job)
		}
	}()
	// Atomic guard membership closes the crash window between CreateProcess and
	// explicit assignment to the nested execution Job below. Neither job is inherited.
	guard, err := limitedJob()
	if err != nil {
		return 125, errors.New("isolation unavailable")
	}
	defer func() {
		if guard != 0 {
			windows.CloseHandle(guard)
		}
	}()

	// Duplicate exactly three handles. The job, parent, root and image are never inherited.
	handles, err := stdHandles()
	if err != nil {
		return 125, errors.New("stdio unavailable")
	}
	defer func() {
		for _, h := range handles {
			windows.CloseHandle(h)
		}
	}()
	attrs, err := windows.NewProcThreadAttributeList(3)
	if err != nil {
		return 125, errors.New("isolation unavailable")
	}
	defer attrs.Delete()
	caps := securityCapabilities{AppContainerSid: sid} // zero capabilities: no network access.
	if attrs.Update(attributeSecurityCapabilities, unsafe.Pointer(&caps), unsafe.Sizeof(caps)) != nil ||
		attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&handles[0]), uintptr(len(handles))*unsafe.Sizeof(handles[0])) != nil ||
		attrs.Update(attributeJobList, unsafe.Pointer(&guard), unsafe.Sizeof(guard)) != nil {
		return 125, errors.New("isolation unavailable")
	}
	env, err := environment(c.root)
	if err != nil {
		return 125, errors.New("isolation unavailable")
	}
	command := windows.ComposeCommandLine(append([]string{c.exe}, c.args...))
	command16, err := windows.UTF16FromString(command)
	if err != nil {
		return 125, errors.New("invalid request")
	}
	si := windows.StartupInfoEx{}
	si.Cb = uint32(unsafe.Sizeof(si))
	si.Flags = windows.STARTF_USESTDHANDLES
	si.StdInput, si.StdOutput, si.StdErr = handles[0], handles[1], handles[2]
	si.ProcThreadAttributeList = attrs.List()
	var pi windows.ProcessInformation
	flags := uint32(windows.CREATE_SUSPENDED | windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_NO_WINDOW)
	err = windows.CreateProcess(windows.StringToUTF16Ptr(c.exe), &command16[0], nil, nil, true, flags, &env[0], windows.StringToUTF16Ptr(c.root), &si.StartupInfo, &pi)
	runtime.KeepAlive(caps)
	if err != nil {
		return 125, errors.New("isolated launch failed")
	}
	defer windows.CloseHandle(pi.Process)
	defer windows.CloseHandle(pi.Thread)
	// Also handles failure before assignment: never leave a suspended child behind.
	defer func() {
		if job != 0 {
			windows.CloseHandle(job)
			job = 0
		}
		if guard != 0 {
			windows.CloseHandle(guard)
			guard = 0
		}
		windows.TerminateProcess(pi.Process, 125)
		windows.WaitForSingleObject(pi.Process, windows.INFINITE)
	}()
	if windows.AssignProcessToJobObject(job, pi.Process) != nil {
		return 125, errors.New("job assignment failed")
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return 124, errors.New("deadline exceeded")
	}
	if _, err = windows.ResumeThread(pi.Thread); err != nil {
		return 125, errors.New("isolated launch failed")
	}
	// EOF on stdin belongs to the child protocol. Cancellation uses a staging marker,
	// allowing normal profile/ACL cleanup before the caller's forced-kill fallback.
	for {
		if _, err := os.Lstat(filepath.Join(c.root, ".cancel")); err == nil {
			return 130, errors.New("cancelled")
		} else if !os.IsNotExist(err) {
			return 125, errors.New("cancellation check failed")
		}
		remaining = time.Until(deadline)
		if remaining <= 0 {
			return 124, errors.New("deadline exceeded")
		}
		if remaining > 50*time.Millisecond {
			remaining = 50 * time.Millisecond
		}
		state, err := windows.WaitForMultipleObjects([]windows.Handle{parent, pi.Process}, false, uint32((remaining+time.Millisecond-1)/time.Millisecond))
		if err != nil {
			return 125, errors.New("process wait failed")
		}
		switch state {
		case windows.WAIT_OBJECT_0:
			return 125, errors.New("parent exited")
		case windows.WAIT_OBJECT_0 + 1:
			var exit uint32
			if windows.GetExitCodeProcess(pi.Process, &exit) != nil {
				return 125, errors.New("process wait failed")
			}
			return int(exit), nil
		case uint32(windows.WAIT_TIMEOUT):
			continue
		default:
			return 125, errors.New("process wait failed")
		}
	}
}

func limitedJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
	limits.BasicLimitInformation.ActiveProcessLimit = 1
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func newProfile() (*uint16, *windows.SID, error) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, nil, err
	}
	name := windows.StringToUTF16Ptr("qishui.runner." + hex.EncodeToString(nonce[:]))
	if createProfile.Find() != nil || deleteProfile.Find() != nil {
		return nil, nil, errors.New("unavailable")
	}
	var sid *windows.SID
	hr, _, _ := createProfile.Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(name)), 0, 0, uintptr(unsafe.Pointer(&sid)))
	if int32(hr) < 0 || sid == nil {
		return nil, nil, errors.New("unavailable")
	}
	return name, sid, nil
}

func stdHandles() ([]windows.Handle, error) {
	null, err := windows.CreateFile(windows.StringToUTF16Ptr("NUL"), windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(null)
	out := make([]windows.Handle, 0, 3)
	for _, source := range []windows.Handle{windows.Handle(os.Stdin.Fd()), windows.Handle(os.Stdout.Fd()), null} {
		var h windows.Handle
		if err := windows.DuplicateHandle(windows.CurrentProcess(), source, windows.CurrentProcess(), &h, 0, true, windows.DUPLICATE_SAME_ACCESS); err != nil {
			for _, prior := range out {
				windows.CloseHandle(prior)
			}
			return nil, err
		}
		out = append(out, h)
	}
	return out, nil
}

func environment(root string) ([]uint16, error) {
	windir, err := windows.GetWindowsDirectory()
	if err != nil {
		return nil, err
	}
	system, err := windows.GetSystemDirectory()
	if err != nil {
		return nil, err
	}
	// Alphabetical, case-insensitive ordering as required for a Windows environment block.
	values := []string{"APPDATA=" + root, "LOCALAPPDATA=" + root, "PATH=" + system, "SystemRoot=" + windir, "TEMP=" + root, "TMP=" + root, "USERPROFILE=" + root}
	var block []uint16
	for _, value := range values {
		v, err := windows.UTF16FromString(value)
		if err != nil {
			return nil, err
		}
		block = append(block, v...)
	}
	return append(block, 0), nil
}

type savedSecurity struct {
	path string
	sd   *windows.SECURITY_DESCRIPTOR
}

func openObject(path string) (windows.Handle, error) {
	return windows.CreateFile(windows.StringToUTF16Ptr(path), windows.READ_CONTROL|windows.WRITE_DAC|windows.WRITE_OWNER|windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
}

// The caller owns this fresh private staging tree. Never follow junctions, symlinks or hardlinks.
func grantTree(root string, sid *windows.SID) (func() error, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	base, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + user.User.Sid.String() + ")(A;OICI;FA;;;SY)S:(ML;OICI;NW;;;ME)")
	if err != nil {
		return nil, err
	}
	baseACL, _, _ := base.DACL()
	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{AccessPermissions: appAccess, AccessMode: windows.GRANT_ACCESS, Inheritance: windows.SUB_CONTAINERS_AND_OBJECTS_INHERIT, Trustee: windows.TRUSTEE{TrusteeForm: windows.TRUSTEE_IS_SID, TrusteeType: windows.TRUSTEE_IS_UNKNOWN, TrusteeValue: windows.TrusteeValueFromSID(sid)}}}, baseACL)
	if err != nil {
		return nil, err
	}
	low, err := windows.SecurityDescriptorFromString("S:(ML;OICI;NW;;;LW)")
	if err != nil {
		return nil, err
	}
	lowACL, _, _ := low.SACL()
	var saved []savedSecurity
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		h, err := openObject(path)
		if err != nil {
			return err
		}
		defer windows.CloseHandle(h)
		var info windows.ByHandleFileInformation
		if err = windows.GetFileInformationByHandle(h, &info); err != nil {
			return err
		}
		if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 && info.NumberOfLinks != 1) {
			return errors.New("unsafe tree")
		}
		sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.LABEL_SECURITY_INFORMATION)
		if err != nil {
			return err
		}
		saved = append(saved, savedSecurity{path, sd})
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Bottom-up protection prevents root ACL propagation from overwriting saved child ACLs.
	modified := make(map[string]bool)
	known := make(map[string]bool, len(saved))
	for _, s := range saved {
		known[s.path] = true
	}
	cleanup := func() error {
		var cleanupErr error
		var additions []string
		// Validate the ENTIRE post-exit tree before any ACL propagation. A payload
		// could have created a junction; never let privileged cleanup follow it.
		if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			h, err := openObject(path)
			if err != nil {
				return err
			}
			defer windows.CloseHandle(h)
			var info windows.ByHandleFileInformation
			if windows.GetFileInformationByHandle(h, &info) != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 && info.NumberOfLinks != 1) {
				return errors.New("unsafe cleanup")
			}
			if !known[path] {
				additions = append(additions, path)
			}
			return nil
		}); err != nil {
			return err
		}
		// Protect new output objects bottom-up before restoring any parent ACL.
		for i := len(additions) - 1; i >= 0; i-- {
			h, err := openObject(additions[i])
			if err == nil {
				err = applySecurity(h, base)
				windows.CloseHandle(h)
			}
			if err != nil {
				cleanupErr = err
			}
		}
		for i := len(saved) - 1; i >= 0; i-- {
			s := saved[i]
			if !modified[s.path] {
				continue
			}
			h, err := openObject(s.path)
			if os.IsNotExist(err) {
				continue
			}
			if err == nil {
				var info windows.ByHandleFileInformation
				if windows.GetFileInformationByHandle(h, &info) != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 && info.NumberOfLinks != 1) {
					err = errors.New("unsafe cleanup")
				} else {
					err = applySecurity(h, s.sd)
				}
				windows.CloseHandle(h)
			}
			if err != nil {
				cleanupErr = err
			}
		}
		return cleanupErr
	}
	for i := len(saved) - 1; i >= 0; i-- {
		s := saved[i]
		h, err := openObject(s.path)
		if err != nil {
			return cleanup, err
		}
		modified[s.path] = true
		err = windows.SetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION|windows.LABEL_SECURITY_INFORMATION, nil, nil, acl, lowACL)
		windows.CloseHandle(h)
		if err != nil {
			return cleanup, err
		}
	}
	return cleanup, nil
}

func applySecurity(h windows.Handle, sd *windows.SECURITY_DESCRIPTOR) error {
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	sacl, _, err := sd.SACL()
	// Most staged objects have an implicit medium label. Restore that effective
	// label explicitly rather than leaving our temporary low label in place.
	if err == windows.ERROR_OBJECT_NOT_FOUND || (err == nil && sacl == nil) {
		medium, e := windows.SecurityDescriptorFromString("S:(ML;OICI;NW;;;ME)")
		if e != nil {
			return e
		}
		sacl, _, err = medium.SACL()
	}
	if err != nil {
		return err
	}
	control, _, err := sd.Control()
	if err != nil {
		return err
	}
	flags := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION | windows.LABEL_SECURITY_INFORMATION)
	if control&windows.SE_DACL_PROTECTED != 0 {
		flags |= windows.PROTECTED_DACL_SECURITY_INFORMATION
	} else {
		flags |= windows.UNPROTECTED_DACL_SECURITY_INFORMATION
	}
	return windows.SetSecurityInfo(h, windows.SE_FILE_OBJECT, flags, nil, nil, dacl, sacl)
}
