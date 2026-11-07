// Copy into MyGO internal/plugin. Check the runtime and validation ZIPs with
// the actual installer on any OS; this never executes Windows programs.
package plugin

import (
	"debug/pe"
	"os"
	"path/filepath"
	"testing"
)

func TestQishuiWindowsPackageInstall(t *testing.T) {
	for _, kind := range []struct{ name, variable string }{{"runtime", "QISHUI_WINDOWS_PLUGIN_ZIP"}, {"validation", "QISHUI_WINDOWS_VALIDATION_ZIP"}} {
		t.Run(kind.name, func(t *testing.T) {
			archive := os.Getenv(kind.variable)
			if archive == "" {
				t.Skip(kind.variable + " is not set")
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
			images := []string{"bin/qishui-helper-windows-amd64.exe", "runtime/native/qishui-sign.exe", "runtime/native/bdms.node", "runtime/native/metasecml.dll", "runtime/native/ffmpeg.exe", "runtime/native/windows-runner.exe"}
			if kind.name == "validation" {
				images = append(images, "test/windows-runner.test.exe", "test/native-worker.test.exe")
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
			for _, name := range images {
				image, err := pe.Open(filepath.Join(installed, name))
				if err != nil {
					t.Fatal("invalid packaged Windows image", name, err)
				}
				machine := image.Machine
				image.Close()
				if machine != pe.IMAGE_FILE_MACHINE_AMD64 {
					t.Fatal("Windows package contains a different architecture", name)
				}
			}
			for _, name := range []string{"native/signer/include/NODE-LICENSE", "native/signer/signer.cpp", "native/worker/go.mod", "runtime/native/NATIVE-BUILD.json", "runtime/native/FFMPEG-LICENSE", "runtime/native/FFMPEG-README.txt", "runtime/native/FFMPEG-BUILD.json", "runtime/native/FFMPEG-SOURCE.tar.xz", "runtime/native/WINDOWS-CRT-SOURCE.tar.xz", "runtime/native/MINGW-LICENSE", "runtime/native/ZIG-LICENSE", "scripts/build-ffmpeg.mjs", "scripts/ffmpeg-config.mjs", "runtime/native/GO-LICENSE", "runtime/native/X-SYS-LICENSE", "LICENSE", "NOTICE.md", "src/plugin.mjs", "native/windows-runner/main_windows.go", "native/windows-runner/go.sum"} {
				if info, err := os.Stat(filepath.Join(installed, name)); err != nil || info.Size() == 0 {
					t.Fatal("missing dependency license or corresponding source", name)
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
			t.Log("Windows ZIP layout, x64 images, licenses, source and sandbox entry verified; no Windows program executed")
		})
	}
}
