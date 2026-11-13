// Loaded through a Go overlay into MyGO internal/plugin. Checks Windows ZIPs
// using the actual installer without executing any Windows program.
package plugin

import (
	"debug/pe"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestQishuiWindowsPackageInstall(t *testing.T) {
	for _, target := range []struct {
		arch, prefix string
		machine      uint16
	}{
		{"amd64", "QISHUI_WINDOWS", pe.IMAGE_FILE_MACHINE_AMD64},
		{"arm64", "QISHUI_WINDOWS_ARM64", pe.IMAGE_FILE_MACHINE_ARM64},
	} {
		for _, kind := range []struct{ name, suffix string }{{"runtime", "_PLUGIN_ZIP"}, {"validation", "_VALIDATION_ZIP"}} {
			t.Run(target.arch+"/"+kind.name, func(t *testing.T) {
				variable := target.prefix + kind.suffix
				archive := os.Getenv(variable)
				if archive == "" {
					t.Skip(variable + " is not set")
				}
				dir := t.TempDir()
				pending, err := Open(archive, dir)
				if err != nil {
					t.Fatal(err)
				}
				defer pending.Discard()
				if err := pending.Install(dir); err != nil {
					t.Fatal(err)
				}
				installed := filepath.Join(dir, "qishui-app-login")
				if files, err := filepath.Glob(filepath.Join(installed, "bin", "node*")); err != nil || len(files) != 0 {
					t.Fatal("ZIP must not include Node")
				}
				worker := "qishui-helper-windows-" + target.arch + ".exe"
				images := map[string]uint16{
					"bin/" + worker: target.machine,
					"bin/qishui-helper-login-windows-" + target.arch + ".exe": target.machine,
					"runtime/native/windows-runner.exe":                       target.machine,
					"runtime/native/qishui-sign.exe":                          pe.IMAGE_FILE_MACHINE_AMD64,
					"runtime/native/bdms.node":                                pe.IMAGE_FILE_MACHINE_AMD64,
					"runtime/native/metasecml.dll":                            pe.IMAGE_FILE_MACHINE_AMD64,
				}
				if kind.name == "validation" {
					images["test/windows-runner.test.exe"] = target.machine
					images["test/native-worker.test.exe"] = target.machine
					for _, name := range []string{"scripts/verify-windows.cmd", "scripts/verify-windows.mjs", "test/windows-integration.test.mjs", "test/fixtures/aac-lc.m4a", "test/fixtures/aac-he.m4a", "test/fixtures/aac-he.aac", "test/fixtures/aac-hev2.m4a", "test/fixtures/aac-hev2.aac", "test/fixtures/aac-lc.aac"} {
						if info, err := os.Stat(filepath.Join(installed, name)); err != nil || info.Size() == 0 {
							t.Fatal("validation ZIP lacks an independent verification input", name)
						}
					}
				} else {
					for _, name := range []string{"test", "native/windows-runner/tests", "scripts/verify-windows.cmd"} {
						if _, err := os.Stat(filepath.Join(installed, name)); !os.IsNotExist(err) {
							t.Fatal("runtime ZIP contains validation-only files", name)
						}
					}
				}
				if _, err := os.Stat(filepath.Join(installed, "assets")); !os.IsNotExist(err) {
					t.Fatal("ZIP contains replaced cover pictures")
				}
				for name, expected := range images {
					image, err := pe.Open(filepath.Join(installed, name))
					if err != nil {
						t.Fatal("invalid packaged Windows image", name, err)
					}
					machine := image.Machine
					image.Close()
					if machine != expected {
						t.Fatal("Windows component has the wrong architecture", name)
					}
				}
				data, err := os.ReadFile(filepath.Join(installed, "runtime/native/NATIVE-BUILD.json"))
				if err != nil {
					t.Fatal(err)
				}
				var build struct{ Platform, Arch, SignerArch string }
				if err := json.Unmarshal(data, &build); err != nil || build.Platform != "windows" || build.Arch != target.arch {
					t.Fatal("wrong native build target")
				}
				if target.arch == "arm64" && build.SignerArch != "amd64" {
					t.Fatal("ARM64 package requires a separate x64 signer")
				}
				for _, name := range []string{"native/signer/include/NODE-LICENSE", "native/signer/signer.cpp", "native/worker/go.mod", "native/login/main.go", "native/login/page/browser-verification.js", "runtime/native/NATIVE-BUILD.json", "runtime/native/GO-LICENSE", "runtime/native/X-SYS-LICENSE", "LICENSE", "NOTICE.md", "src/plugin.mjs", "helper/m4a.mjs", "native/windows-runner/main_windows.go", "native/windows-runner/go.sum"} {
					if info, err := os.Stat(filepath.Join(installed, name)); err != nil || info.Size() == 0 {
						t.Fatal("missing dependency license or corresponding source", name)
					}
				}
				for _, name := range []string{"runtime/native/ffmpeg.exe", "runtime/native/FFMPEG-LICENSE", "runtime/native/FFMPEG-README.txt", "runtime/native/FFMPEG-BUILD.json", "runtime/native/FFMPEG-SOURCE.tar.xz", "runtime/native/MINGW-LICENSE", "runtime/native/ZIG-LICENSE", "runtime/native/WINDOWS-CRT-SOURCE.tar.xz"} {
					if _, err := os.Stat(filepath.Join(installed, name)); !os.IsNotExist(err) {
						t.Fatal("ZIP must not contain bundled FFmpeg assets", name)
					}
				}
				if kind.name == "validation" {
					for _, name := range []string{"scripts/build-ffmpeg.mjs", "scripts/ffmpeg-config.mjs"} {
						if info, err := os.Stat(filepath.Join(installed, name)); err != nil || info.Size() == 0 {
							t.Fatal("validation ZIP lost offline FFmpeg reference tooling", name)
						}
					}
				}
				p, err := Load(installed, t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				defer p.Close()
				if account, err := p.Account(); err != nil || account != nil {
					t.Fatal("fresh Windows package has invalid or preloaded account state")
				}
				for _, capability := range []string{"home", "playlist", "artist", "played", "search", "lyrics", "stream", "stations", "stationNext", "browse"} {
					if !p.Can(capability) {
						t.Fatal("Windows package lost a plugin capability", capability)
					}
				}
				t.Log("Windows ZIP layout, per-component architectures, licenses, source and sandbox entry verified; no Windows program executed")
			})
		}
	}
}
