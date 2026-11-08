package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

var chapterSample = []byte{0, 12, 'C', 'h', 'a', 'p', 't', 'e', 'r', ' ', 't', 'e', 'x', 't'}

func withTextFixture(input []byte, prefix, textFirst bool, extraTable ...string) []byte {
	top := boxes(input, 0, len(input))
	mdat, movie := one(top, "mdat"), one(top, "moov")
	zero := be32(0)
	entry := make([]byte, 8)
	entry[7] = 1
	text := func(offset int) []byte {
		tables := mpbox("stbl",
			mpbox("stsd", zero, be32(1), mpbox("text", entry)),
			mpbox("stsz", zero, zero, be32(1), be32(len(chapterSample))),
			mpbox("stts", zero, be32(1), be32(1), be32(1024)),
			mpbox("stsc", zero, be32(1), be32(1), be32(1), be32(1)),
			mpbox("stco", zero, be32(1), be32(offset)))
		if len(extraTable) > 0 {
			tables = mpbox("stbl", tables[8:], mpbox(extraTable[0], zero, zero))
		}
		return mpbox("trak", mpbox("mdia", mpbox("hdlr", zero, zero, []byte("text")), mpbox("minf", tables)))
	}
	delta := len(text(0))
	audioDelta := delta
	if prefix {
		audioDelta += len(chapterSample)
	}
	var rewrite func(int, int) []byte
	rewrite = func(start, end int) []byte {
		var out []byte
		for _, b := range boxes(input, start, end) {
			body := bytes.Clone(input[b.body:b.end])
			switch b.typ {
			case "moov", "trak", "mdia", "minf", "stbl":
				body = rewrite(b.body, b.end)
			case "stco":
				for p := 8; p < len(body); p += 4 {
					binary.BigEndian.PutUint32(body[p:], uint32(u32(body, p)+audioDelta))
				}
			}
			out = append(out, mpbox(b.typ, body)...)
		}
		return out
	}
	offset := mdat.end + delta
	if prefix {
		offset = mdat.body + delta
	}
	original, extra := rewrite(movie.body, movie.end), text(offset)
	var out []byte
	for _, b := range top {
		switch b.typ {
		case "moov":
			if textFirst {
				out = append(out, mpbox("moov", extra, original)...)
			} else {
				out = append(out, mpbox("moov", original, extra)...)
			}
		case "mdat":
			if prefix {
				out = append(out, mpbox("mdat", chapterSample, input[b.body:b.end])...)
			} else {
				out = append(out, mpbox("mdat", input[b.body:b.end], chapterSample)...)
			}
		default:
			out = append(out, input[b.pos:b.end]...)
		}
	}
	return out
}

// The former one-trak decoder rejected songs carrying one plain chapter sample.
func TestCENCTextTrackPreservesAudioAndChapter(t *testing.T) {
	for _, prefix := range []bool{true, false} {
		for _, first := range []bool{true, false} {
			clear := fixtureM4A(t)
			input := withTextFixture(encryptM4AFixture(clear), prefix, first)
			before := bytes.Clone(input)
			decoded, e := decodeWithKey(input, fixtureKey)
			if e != nil || !nativeM4A(decoded) {
				t.Fatal("text-track AAC rejected")
			}
			if !bytes.Equal(input, before) {
				t.Fatal("input changed")
			}
			_, start, end := audioTrack(decoded, one(boxes(decoded, 0, len(decoded)), "moov"), one(boxes(decoded, 0, len(decoded)), "mdat"))
			plain := one(boxes(clear, 0, len(clear)), "mdat")
			if !bytes.Equal(decoded[start:end], clear[plain.body:plain.end]) {
				t.Fatal("AAC payload changed")
			}
			data := one(boxes(decoded, 0, len(decoded)), "mdat")
			chapter := decoded[end:data.end]
			if prefix {
				chapter = decoded[data.body:start]
			}
			if !bytes.Equal(chapter, chapterSample) {
				t.Fatal("chapter bytes were decrypted")
			}
			flac, e := decodeWithKey(withTextFixture(encryptedFixture("fLaC", 8, nil, false), prefix, first), fixtureKey)
			if e != nil || !bytes.Equal(flac, fixtureFLAC()) {
				t.Fatal("FLAC output includes text or changed frames")
			}
		}
	}
}

// Invalid auxiliary bounds must fail before decrypting any byte.
func TestCENCTextTrackRejectsInvalidRanges(t *testing.T) {
	for _, table := range []string{"senc", "saio", "saiz", "ctts"} {
		clear := withTextFixture(fixtureM4A(t), true, false, table)
		encrypted := withTextFixture(encryptM4AFixture(fixtureM4A(t)), true, false, table)
		if nativeM4A(clear) {
			t.Fatalf("text %s accepted by guard", table)
		}
		if _, e := decodeWithKey(encrypted, fixtureKey); e != errUnavailable {
			t.Fatalf("text %s accepted by decoder", table)
		}
	}
	base := withTextFixture(encryptM4AFixture(fixtureM4A(t)), true, false)
	for _, change := range []func([]byte){
		func(b []byte) { p := bytes.LastIndex(b, []byte("stco")); copy(b[p+12:], be32(0)) },
		func(b []byte) { p := bytes.LastIndex(b, []byte("stco")); copy(b[p+12:], be32(u32(b, p+12)+1)) },
		func(b []byte) { p := bytes.LastIndex(b, []byte("stsz")); copy(b[p+16:], be32(65537)) },
		func(b []byte) { p := bytes.LastIndex(b, []byte("hdlr")); copy(b[p+12:], "soun") },
	} {
		b := bytes.Clone(base)
		change(b)
		if _, e := decodeWithKey(b, fixtureKey); e != errUnavailable {
			t.Fatal("malformed text track accepted")
		}
		if nativeM4A(b) {
			t.Fatal("encrypted or malformed layout passed guard")
		}
	}
}
