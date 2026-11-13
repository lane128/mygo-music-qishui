// Loaded through a Go overlay into MyGO internal/plugin. Installs Intel ZIPs
// and checks their images without executing any Intel native program.
package plugin

import (
	"debug/macho"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestQishuiDarwinAMD64PackageInstall(t *testing.T) {
	for _, kind := range []struct{ name, variable string }{{"runtime", "QISHUI_DARWIN_AMD64_PLUGIN_ZIP"}, {"validation", "QISHUI_DARWIN_AMD64_VALIDATION_ZIP"}} {
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
			images := []string{"bin/qishui-helper-login-darwin-amd64", "bin/qishui-helper-darwin-amd64", "runtime/native/qishui-sign", "runtime/native/bdms.node", "runtime/native/libMetaSecML.dylib"}
			if kind.name == "validation" {
				images = append(images, "test/native-worker.test")
				for _, name := range []string{"test/fixtures/aac-lc.m4a", "test/fixtures/aac-he.m4a", "test/fixtures/aac-hev2.m4a"} {
					if info, err := os.Stat(filepath.Join(installed, name)); err != nil || info.Size() == 0 {
						t.Fatal("missing validation fixture", name)
					}
				}
			} else if _, err := os.Stat(filepath.Join(installed, "test")); !os.IsNotExist(err) {
				t.Fatal("runtime ZIP contains validation files")
			}
			for _, name := range images {
				file := filepath.Join(installed, name)
				if fat, err := macho.OpenFat(file); err == nil {
					found := false
					for _, image := range fat.Arches {
						if image.Cpu == macho.CpuAmd64 {
							found = true
						}
					}
					fat.Close()
					if !found {
						t.Fatal("universal image lacks Intel slice", name)
					}
				} else {
					image, err := macho.Open(file)
					if err != nil {
						t.Fatal("invalid Mach-O image", name, err)
					}
					cpu := image.Cpu
					image.Close()
					if cpu != macho.CpuAmd64 {
						t.Fatal("Intel ZIP contains a different architecture", name)
					}
				}
			}
			for _, name := range []string{"LICENSE", "NOTICE.md", "src/plugin.mjs", "helper/m4a.mjs", "native/signer/signer.cpp", "native/signer/include/NODE-LICENSE", "native/worker/go.mod", "runtime/native/GO-LICENSE", "runtime/native/NATIVE-BUILD.json", "runtime/native/SOURCES.json"} {
				if info, err := os.Stat(filepath.Join(installed, name)); err != nil || info.Size() == 0 {
					t.Fatal("missing license, source or provenance", name)
				}
			}
			for _, name := range []string{"runtime/native/ffmpeg", "runtime/native/FFMPEG-LICENSE", "runtime/native/FFMPEG-README.txt", "runtime/native/FFMPEG-BUILD.json", "runtime/native/FFMPEG-SOURCE.tar.xz"} {
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
			data, err := os.ReadFile(filepath.Join(installed, "runtime/native/NATIVE-BUILD.json"))
			if err != nil {
				t.Fatal(err)
			}
			var build struct{ Platform, Arch string }
			if err := json.Unmarshal(data, &build); err != nil || build.Platform != "darwin" || build.Arch != "amd64" {
				t.Fatal("wrong native build target")
			}
			p, err := Load(installed, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			if account, err := p.Account(); err != nil || account != nil {
				t.Fatal("fresh Intel package has invalid or preloaded account state")
			}
			for _, capability := range []string{"home", "playlist", "artist", "played", "search", "lyrics", "stream", "stations", "stationNext", "browse"} {
				if !p.Can(capability) {
					t.Fatal("Intel package lost capability", capability)
				}
			}
			t.Log("Intel ZIP installed; Mach-O images, source and JS entry checked; no Intel native execution")
		})
	}
}
