package main

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestM4AGaplessFixtures(t *testing.T) {
	for _, c := range []struct{ name, filter string }{
		{"aac-he.m4a", "atrim=start=0.095782313:duration=1.000000000"},
		{"aac-hev2.m4a", "atrim=start=0.095782313:duration=1.000000000"},
		{"aac-fullscale.m4a", "atrim=start=0.047891156:duration=1.000000000"},
		{"aac-transient.m4a", "atrim=start=0.047891156:duration=1.000000000"},
	} {
		base := os.Getenv("QISHUI_NATIVE_ROOT")
		if base == "" {
			base = filepath.Join("..", "..")
		}
		data, e := os.ReadFile(filepath.Join(base, "test", "fixtures", c.name))
		if e != nil {
			t.Fatal(e)
		}
		trim := m4aGapless(data)
		if trim == nil || trim.filter() != c.filter {
			t.Fatalf("gapless metadata mismatch: %s", c.name)
		}
		args := strings.Join(gaplessArgs(aacConversionArgs("in", "out"), trim), " ")
		if !strings.Contains(args, "-copyts -flags2 +skip_manual -i in") || !strings.Contains(args, "-af "+c.filter) {
			t.Fatal("gapless decoding must preserve original timestamps and manual priming")
		}
	}
}
func gaplessBox(kind string, data ...[]byte) []byte {
	b := append([]byte{}, bytes.Join(data, nil)...)
	out := make([]byte, 8+len(b))
	binary.BigEndian.PutUint32(out, uint32(len(out)))
	copy(out[4:], kind)
	copy(out[8:], b)
	return out
}
func gaplessTestFile(edit, duplicate bool, scale uint32, duration uint64, version byte) []byte {
	mdhd := make([]byte, 24)
	if version == 1 {
		mdhd = make([]byte, 36)
		binary.BigEndian.PutUint32(mdhd[20:], scale)
		binary.BigEndian.PutUint64(mdhd[24:], duration)
	} else {
		binary.BigEndian.PutUint32(mdhd[12:], scale)
		binary.BigEndian.PutUint32(mdhd[16:], uint32(duration))
	}
	mdhd[0] = version
	hdlr := make([]byte, 12)
	copy(hdlr[8:], "soun")
	stsd := make([]byte, 8)
	binary.BigEndian.PutUint32(stsd[4:], 1)
	media := gaplessBox("mdia", gaplessBox("mdhd", mdhd), gaplessBox("hdlr", hdlr), gaplessBox("minf", gaplessBox("stbl", gaplessBox("stsd", stsd, gaplessBox("mp4a")))))
	if edit {
		media = append(media, gaplessBox("edts", gaplessBox("elst", make([]byte, 8)))...)
	}
	text := " 00000000 00000840 0000059E 0000000000005622 00000000"
	value := make([]byte, 8)
	binary.BigEndian.PutUint32(value, 1)
	tag := gaplessBox("----", gaplessBox("mean", make([]byte, 4), []byte("com.apple.iTunes")), gaplessBox("name", make([]byte, 4), []byte("iTunSMPB")), gaplessBox("data", value, []byte(text)))
	tags := tag
	if duplicate {
		tags = append(append([]byte{}, tag...), tag...)
	}
	return gaplessBox("moov", gaplessBox("trak", media), gaplessBox("udta", gaplessBox("meta", make([]byte, 4), gaplessBox("ilst", tags))))
}
func TestM4AGaplessRejectsAmbiguousOrInconsistentTiming(t *testing.T) {
	valid := gaplessTestFile(false, false, 22050, 25600, 0)
	if m4aGapless(valid) == nil {
		t.Fatal("control metadata rejected")
	}
	if m4aGapless(gaplessTestFile(false, false, 22050, 25600, 1)) == nil {
		t.Fatal("64-bit media header rejected")
	}
	for _, data := range [][]byte{
		gaplessTestFile(true, false, 22050, 25600, 0), gaplessTestFile(false, true, 22050, 25600, 0),
		gaplessTestFile(false, false, 0, 25600, 0), gaplessTestFile(false, false, 22050, 25601, 0),
		gaplessTestFile(false, false, 22050, 1<<63, 1), gaplessTestFile(false, false, 22050, 25600, 2),
		append(append([]byte{}, valid...), gaplessBox("moof")...), append(append([]byte{}, valid...), valid...),
		bytes.Replace(valid, []byte("iTunSMPB"), []byte("otherTag"), 1), bytes.Replace(valid, []byte("mp4a"), []byte("alac"), 1),
		bytes.Replace(valid, []byte("0000059E"), []byte("00000XYZ"), 1), valid[:len(valid)-1],
		{0, 0, 0, 1, 'm', 'o', 'o', 'v', 255, 255, 255, 255, 255, 255, 255, 255},
	} {
		if m4aGapless(data) != nil {
			t.Fatal("unsafe metadata enabled trimming")
		}
	}
}
