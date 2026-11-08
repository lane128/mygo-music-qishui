package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math/bits"
	"testing"
)

var fixtureKey = []byte{0x2b, 0x7e, 0x15, 0x16, 0x28, 0xae, 0xd2, 0xa6, 0xab, 0xf7, 0x15, 0x88, 0x09, 0xcf, 0x4f, 0x3c}
var fixtureIV = []byte{0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff}

func fixtureFLAC() []byte {
	data, _ := base64.StdEncoding.DecodeString("ZkxhQ4AAACIAgACAAAAAAAAAC7gA8AAAAIAAAAAAAAAAAAAAAAAAAAAA//hqCAB/XQLgAOQA6ADsAPAA9AD4APwAAAAEAAgADAAQABQAGAAcAOAA5ADoAOwA8AD0APgA/AAAAAQACAAMABAAFAAYABwA4ADkAOgA7ADwAPQA+AD8AAAABAAIAAwAEAAUABgAHADgAOQA6ADsAPAA9AD4APwAAAAEAAgADAAQABQAGAAcAOAA5ADoAOwA8AD0APgA/AAAAAQACAAMABAAFAAYABwA4ADkAOgA7ADwAPQA+AD8AAAABAAIAAwAEAAUABgAHADgAOQA6ADsAPAA9AD4APwAAAAEAAgADAAQABQAGAAcAOAA5ADoAOwA8AD0APgA/AAAAAQACAAMABAAFAAYABwADqU=")
	return data
}
func fixtureAuth() string {
	plain := []byte("0" + hex.EncodeToString(fixtureKey))
	inner := make([]byte, len(plain))
	for i, b := range plain {
		prev := byte(0xfa)
		if i == 1 {
			prev = 0x55
		} else if i > 1 {
			prev = inner[i-2]
		}
		inner[i] = byte(int(b)+bits.OnesCount(uint(i))+21) ^ prev
	}
	return base64.StdEncoding.EncodeToString(append([]byte{48 ^ inner[0] ^ inner[1]}, inner...))
}
func be32(n int) []byte { b := make([]byte, 4); binary.BigEndian.PutUint32(b, uint32(n)); return b }
func be16(n int) []byte { b := make([]byte, 2); binary.BigEndian.PutUint16(b, uint16(n)); return b }
func mpbox(typ string, parts ...[]byte) []byte {
	body := bytes.Join(parts, nil)
	return bytes.Join([][]byte{be32(len(body) + 8), []byte(typ), body}, nil)
}

type subSample struct{ clear, encrypted int }

func encryptedFixture(format string, ivSize int, subs []subSample, subFlag bool) []byte {
	flac := fixtureFLAC()
	plain := bytes.Clone(flac[42:])
	iv := make([]byte, 16)
	copy(iv, fixtureIV[:ivSize])
	block, _ := aes.NewCipher(fixtureKey)
	ctr := cipher.NewCTR(block, iv)
	if !subFlag || len(subs) == 0 {
		ctr.XORKeyStream(plain, plain)
	} else {
		offset := 0
		for _, s := range subs {
			offset += s.clear
			ctr.XORKeyStream(plain[offset:offset+s.encrypted], plain[offset:offset+s.encrypted])
			offset += s.encrypted
		}
	}
	zero := be32(0)
	ftyp := mpbox("ftyp", []byte("isom"), zero, []byte("isom"))
	sinf := mpbox("sinf", mpbox("frma", []byte(format)), mpbox("schm", zero, []byte("cenc"), be32(0x10000)), mpbox("schi", mpbox("tenc", zero, []byte{0, 0, 1, byte(ivSize)}, make([]byte, 16))))
	var config []byte
	if format == "fLaC" {
		config = mpbox("dfLa", zero, flac[4:42])
	}
	stsd := mpbox("stsd", zero, be32(1), mpbox("enca", make([]byte, 28), config, sinf))
	flags := zero
	sencData := bytes.Clone(fixtureIV[:ivSize])
	if subFlag {
		flags = be32(2)
		sencData = append(sencData, be16(len(subs))...)
		for _, s := range subs {
			sencData = append(sencData, be16(s.clear)...)
			sencData = append(sencData, be32(s.encrypted)...)
		}
	}
	handler := mpbox("hdlr", be32(0), be32(0), []byte("soun"))
	movie := func(offset int) []byte {
		return mpbox("moov", mpbox("trak", mpbox("mdia", handler, mpbox("minf", mpbox("stbl", stsd, mpbox("stsz", zero, zero, be32(1), be32(len(plain))), mpbox("stco", zero, be32(1), be32(offset)), mpbox("stsc", zero, be32(1), be32(1), be32(1), be32(1)), mpbox("senc", flags, be32(1), sencData))))))
	}
	return bytes.Join([][]byte{ftyp, movie(len(ftyp) + len(movie(0)) + 8), mpbox("mdat", plain)}, nil)
}
func TestAuthorizedCENCFixture(t *testing.T) {
	key, e := resourceKey(fixtureAuth())
	if e != nil || !bytes.Equal(key, fixtureKey) {
		t.Fatal("matching auth did not restore fixture key")
	}
	for _, iv := range []int{8, 16} {
		for _, mode := range []string{"whole", "zero-subs", "subs"} {
			n := len(fixtureFLAC()) - 42
			var subs []subSample
			if mode == "subs" {
				subs = []subSample{{3, 5}, {2, n - 10}}
			}
			data := encryptedFixture("fLaC", iv, subs, mode != "whole")
			before := bytes.Clone(data)
			got, e := decodeWithKey(data, key)
			if e != nil || !bytes.Equal(got, fixtureFLAC()) {
				t.Fatal("fixture decryption failed")
			}
			if !bytes.Equal(data, before) {
				t.Fatal("decoder mutated its input")
			}
		}
	}
	data := encryptedFixture("mp4a", 16, nil, false)
	out, e := decodeWithKey(data, key)
	if e != nil || bytes.Contains(out, []byte("enca")) || bytes.Contains(out, []byte("senc")) {
		t.Fatal("AAC encryption markers remain")
	}
	pos := bytes.Index(out, []byte("mdat")) + 4
	if !bytes.Equal(out[pos:], fixtureFLAC()[42:]) {
		t.Fatal("AAC clear sample mismatch")
	}
}
func TestMalformedCENCTables(t *testing.T) {
	base := encryptedFixture("fLaC", 16, nil, false)
	cases := []struct {
		name   string
		change func([]byte) []byte
	}{
		{"truncated", func(b []byte) []byte { return b[:len(b)-1] }},
		{"fragmented", func(b []byte) []byte { return append(b, mpbox("moof")...) }},
		{"chunk-offset", func(b []byte) []byte { p := bytes.Index(b, []byte("stco")); copy(b[p+12:], be32(1)); return b }},
		{"sample-limit", func(b []byte) []byte { p := bytes.Index(b, []byte("stsz")); copy(b[p+12:], be32(1000001)); return b }},
		{"sample-layout", func(b []byte) []byte { p := bytes.Index(b, []byte("stsz")); copy(b[p+16:], be32(1)); return b }},
		{"description", func(b []byte) []byte { p := bytes.Index(b, []byte("stsd")); copy(b[p+8:], be32(2)); return b }},
		{"scheme", func(b []byte) []byte { p := bytes.Index(b, []byte("schm")); copy(b[p+8:], "cbcs"); return b }},
		{"senc-flags", func(b []byte) []byte { p := bytes.Index(b, []byte("senc")); copy(b[p+4:], be32(1)); return b }},
		{"senc-count", func(b []byte) []byte { p := bytes.Index(b, []byte("senc")); copy(b[p+8:], be32(2)); return b }},
		{"iv-size", func(b []byte) []byte { p := bytes.Index(b, []byte("tenc")); b[p+11] = 7; return b }},
		{"chunk-map", func(b []byte) []byte { p := bytes.Index(b, []byte("stsc")); copy(b[p+12:], be32(2)); return b }},
		{"box-extended", func(b []byte) []byte { copy(b[:4], be32(1)); binary.BigEndian.PutUint64(b[8:16], ^uint64(0)); return b }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, e := decodeWithKey(c.change(bytes.Clone(base)), fixtureKey)
			if e != errUnavailable {
				t.Fatal("malformed container was accepted")
			}
		})
	}
	n := len(fixtureFLAC()) - 42
	for _, amount := range []int{n - 1, n + 1} {
		b := encryptedFixture("fLaC", 16, []subSample{{0, n}}, true)
		p := bytes.Index(b, []byte("senc"))
		copy(b[p+32:], be32(amount))
		if _, e := decodeWithKey(b, fixtureKey); e != errUnavailable {
			t.Fatal("invalid subsample coverage accepted")
		}
	}
	for _, auth := range []string{"", "a", "!!!!", base64.StdEncoding.EncodeToString([]byte{0, 1, 2, 3})} {
		if _, e := resourceKey(auth); e != errUnavailable {
			t.Fatal("invalid authorization accepted")
		}
	}
}
func TestDecodePrivateProtocol(t *testing.T) {
	input, _ := json.Marshal(map[string]string{"audio": base64.StdEncoding.EncodeToString(encryptedFixture("fLaC", 16, nil, false)), "auth": fixtureAuth()})
	var out bytes.Buffer
	if decodeMain(bytes.NewReader(input), &out) != nil || !bytes.Equal(out.Bytes(), fixtureFLAC()) {
		t.Fatal("private decode protocol failed")
	}
	for _, raw := range []string{`{}`, `{"audio":"!!!!","auth":"invalid"}`, `{"audio":7}`, `{} trailing`} {
		if decodeMain(bytes.NewBufferString(raw), &out) != errUnavailable {
			t.Fatal("invalid private protocol accepted")
		}
	}
}
