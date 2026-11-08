package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func audioFixture(t *testing.T, name string) []byte {
	t.Helper()
	root := os.Getenv("QISHUI_NATIVE_ROOT")
	if root == "" {
		root = filepath.Join("..", "..")
	}
	b, e := os.ReadFile(filepath.Join(root, "test", "fixtures", name))
	if e != nil {
		t.Fatal("audio fixture unavailable:", name)
	}
	return b
}
func fixtureM4A(t *testing.T) []byte { return audioFixture(t, "aac-editlist.m4a") }
func TestM4ASharedCases(t *testing.T) {
	var cases []struct {
		Name  string
		Valid bool
		Hex   string
	}
	if json.Unmarshal(audioFixture(t, "m4a-layout.json"), &cases) != nil || len(cases) < 20 {
		t.Fatal("shared cases unavailable")
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			b, e := hex.DecodeString(c.Hex)
			if e != nil {
				t.Fatal(e)
			}
			before := bytes.Clone(b)
			if nativeM4A(b) != c.Valid {
				t.Fatal("M4A acceptance mismatch")
			}
			if !bytes.Equal(b, before) {
				t.Fatal("guard changed audio")
			}
		})
	}
	if !nativeM4A(fixtureM4A(t)) {
		t.Fatal("encoded edit-list fixture rejected")
	}
	for _, name := range []string{"aac-lc.m4a", "aac-he.m4a", "aac-hev2.m4a"} {
		if nativeM4A(audioFixture(t, name)) {
			t.Fatal("unsupported legacy fixture accepted")
		}
	}
}

// Add synthetic CENC protection around the real encoded AAC fixture. The decoder
// must neutralize protection in place and restore the exact AAC payload.
func encryptM4AFixture(clear []byte) []byte {
	top := boxes(clear, 0, len(clear))
	moov, mdat := one(top, "moov"), one(top, "mdat")
	movie := boxes(clear, moov.body, moov.end)
	trak := one(movie, "trak")
	mdia := one(boxes(clear, trak.body, trak.end), "mdia")
	minf := one(boxes(clear, mdia.body, mdia.end), "minf")
	stbl := one(boxes(clear, minf.body, minf.end), "stbl")
	stsz := one(boxes(clear, stbl.body, stbl.end), "stsz")
	count, fixed := u32(clear, stsz.body+8), u32(clear, stsz.body+4)
	encrypted := bytes.Clone(clear[mdat.body:mdat.end])
	senc := bytes.Join([][]byte{be32(0), be32(count)}, nil)
	offset := 0
	for i := 0; i < count; i++ {
		n := fixed
		if n == 0 {
			n = u32(clear, stsz.body+12+i*4)
		}
		iv := bytes.Clone(fixtureIV)
		iv[15] += byte(i)
		block, _ := aes.NewCipher(fixtureKey)
		cipher.NewCTR(block, iv).XORKeyStream(encrypted[offset:offset+n], encrypted[offset:offset+n])
		offset += n
		senc = append(senc, iv...)
	}
	sinf := mpbox("sinf", mpbox("frma", []byte("mp4a")), mpbox("schm", be32(0), []byte("cenc"), be32(0x10000)), mpbox("schi", mpbox("tenc", be32(0), []byte{0, 0, 1, 16}, make([]byte, 16))))
	delta := len(sinf) + len(mpbox("senc", senc))
	var rewrite func(int, int) []byte
	rewrite = func(start, end int) []byte {
		var out []byte
		for _, b := range boxes(clear, start, end) {
			body := bytes.Clone(clear[b.body:b.end])
			kind := b.typ
			switch kind {
			case "moov", "trak", "mdia", "minf", "stbl":
				body = rewrite(b.body, b.end)
				if kind == "stbl" {
					body = append(body, mpbox("senc", senc)...)
				}
			case "stsd":
				body = append(bytes.Clone(clear[b.body:b.body+8]), rewrite(b.body+8, b.end)...)
			case "mp4a":
				kind = "enca"
				body = append(body, sinf...)
			case "stco":
				for p := 8; p < len(body); p += 4 {
					copy(body[p:], be32(u32(body, p)+delta))
				}
			case "mdat":
				body = encrypted
			}
			out = append(out, mpbox(kind, body)...)
		}
		return out
	}
	return rewrite(0, len(clear))
}

// Both MDHD conventions must survive CENC decryption and byte-preserving playback.
func TestEncryptedAACRestoresDirectM4A(t *testing.T) {
	for _, convention := range []string{"excludes-priming", "includes-priming"} {
		t.Run(convention, func(t *testing.T) {
			clear := fixtureM4A(t)
			if convention == "includes-priming" {
				mdhd, elst := bytes.Index(clear, []byte("mdhd")), bytes.Index(clear, []byte("elst"))
				if mdhd < 0 || elst < 0 || clear[mdhd+4] != 0 || clear[elst+4] != 0 {
					t.Fatal("expected version-0 fixture headers")
				}
				binary.BigEndian.PutUint32(clear[mdhd+20:], uint32(u32(clear, mdhd+20)+u32(clear, elst+16)))
			}
			encrypted := encryptM4AFixture(clear)
			decoded, e := decodeWithKey(encrypted, fixtureKey)
			if e != nil || !nativeM4A(decoded) {
				t.Fatal("CENC decode did not restore verified M4A")
			}
			// CENC metadata is neutralized in place as free boxes; the decoder keeps offsets.
			before := one(boxes(clear, 0, len(clear)), "mdat")
			after := one(boxes(decoded, 0, len(decoded)), "mdat")
			if !bytes.Equal(clear[before.body:before.end], decoded[after.body:after.end]) {
				t.Fatal("decoded AAC payload changed")
			}
			w := &worker{download: func(context.Context, string) ([]byte, error) { return decoded, nil }}
			got, _, err := materialize(context.Background(), candidate{Codec: "aac", Quality: "higher"}, w)
			if err != nil || !bytes.Equal(got.Data, decoded) || got.Type != "m4a" {
				t.Fatal("passthrough changed decrypted container")
			}
		})
	}
}
