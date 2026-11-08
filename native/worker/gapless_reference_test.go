package main

import (
	"encoding/binary"
	"strconv"
	"strings"
)

// Only use explicit, internally consistent iTunes gapless metadata. Ordinary
// edit-list files and unfamiliar layouts keep FFmpeg's own timing behavior.
type gaplessAtom struct {
	kind string
	data []byte
}

func gaplessAtoms(data []byte) ([]gaplessAtom, bool) {
	var out []gaplessAtom
	for len(data) > 0 {
		if len(data) < 8 || len(out) >= 4096 {
			return nil, false
		}
		n := uint64(binary.BigEndian.Uint32(data))
		header := uint64(8)
		if n == 1 {
			if len(data) < 16 {
				return nil, false
			}
			n = binary.BigEndian.Uint64(data[8:])
			header = 16
		}
		if n == 0 {
			n = uint64(len(data))
		}
		if n < header || n > uint64(len(data)) {
			return nil, false
		}
		out = append(out, gaplessAtom{string(data[4:8]), data[header:n]})
		data = data[n:]
	}
	return out, true
}
func oneMP4(boxes []gaplessAtom, kind string) ([]byte, bool) {
	var found []byte
	count := 0
	for _, box := range boxes {
		if box.kind == kind {
			found = box.data
			count++
		}
	}
	return found, count == 1
}
func childMP4(data []byte, kind string) ([]byte, bool) {
	boxes, ok := gaplessAtoms(data)
	if !ok {
		return nil, false
	}
	return oneMP4(boxes, kind)
}
func hasMP4(boxes []gaplessAtom, kind string) bool {
	for _, box := range boxes {
		if box.kind == kind {
			return true
		}
	}
	return false
}

type gaplessTrim struct {
	priming, samples uint64
	timescale        uint32
}

func (g gaplessTrim) filter() string {
	return "atrim=start=" + strconv.FormatFloat(float64(g.priming)/float64(g.timescale), 'f', 9, 64) + ":duration=" + strconv.FormatFloat(float64(g.samples)/float64(g.timescale), 'f', 9, 64)
}
func gaplessArgs(args []string, trim *gaplessTrim) []string {
	var out []string
	for _, arg := range args {
		if arg == "-i" {
			out = append(out, "-copyts", "-flags2", "+skip_manual")
		}
		if arg == "-c:a" {
			out = append(out, "-af", trim.filter())
		}
		out = append(out, arg)
	}
	return out
}
func m4aGapless(data []byte) *gaplessTrim {
	top, ok := gaplessAtoms(data)
	if !ok || hasMP4(top, "moof") {
		return nil
	}
	moov, ok := oneMP4(top, "moov")
	if !ok {
		return nil
	}
	movie, ok := gaplessAtoms(moov)
	if !ok || hasMP4(movie, "mvex") {
		return nil
	}
	trak, ok := oneMP4(movie, "trak")
	if !ok {
		return nil
	}
	track, ok := gaplessAtoms(trak)
	if !ok || hasMP4(track, "edts") {
		return nil
	}
	mdia, ok := oneMP4(track, "mdia")
	if !ok {
		return nil
	}
	media, ok := gaplessAtoms(mdia)
	if !ok {
		return nil
	}
	handler, ok := oneMP4(media, "hdlr")
	if !ok || len(handler) < 12 || string(handler[8:12]) != "soun" {
		return nil
	}
	mdhd, ok := oneMP4(media, "mdhd")
	if !ok || len(mdhd) < 24 {
		return nil
	}
	var scale uint32
	var duration uint64
	switch mdhd[0] {
	case 0:
		scale = binary.BigEndian.Uint32(mdhd[12:])
		duration = uint64(binary.BigEndian.Uint32(mdhd[16:]))
	case 1:
		if len(mdhd) < 36 {
			return nil
		}
		scale = binary.BigEndian.Uint32(mdhd[20:])
		duration = binary.BigEndian.Uint64(mdhd[24:])
	default:
		return nil
	}
	if scale == 0 || duration == 0 || duration > 1<<53-1 {
		return nil
	}
	minf, ok := oneMP4(media, "minf")
	if !ok {
		return nil
	}
	stbl, ok := childMP4(minf, "stbl")
	if !ok {
		return nil
	}
	stsd, ok := childMP4(stbl, "stsd")
	if !ok || len(stsd) < 8 || binary.BigEndian.Uint32(stsd[4:]) != 1 {
		return nil
	}
	entries, ok := gaplessAtoms(stsd[8:])
	if !ok || len(entries) != 1 || entries[0].kind != "mp4a" {
		return nil
	}
	udta, ok := oneMP4(movie, "udta")
	if !ok {
		return nil
	}
	meta, ok := childMP4(udta, "meta")
	if !ok || len(meta) < 4 || binary.BigEndian.Uint32(meta) != 0 {
		return nil
	}
	ilst, ok := childMP4(meta[4:], "ilst")
	if !ok {
		return nil
	}
	tags, ok := gaplessAtoms(ilst)
	if !ok {
		return nil
	}
	var text string
	count := 0
	for _, tag := range tags {
		if tag.kind != "----" {
			continue
		}
		fields, valid := gaplessAtoms(tag.data)
		if !valid {
			return nil
		}
		name, valid := oneMP4(fields, "name")
		if !valid || len(name) < 4 {
			continue
		}
		if string(name[4:]) != "iTunSMPB" {
			continue
		}
		count++
		mean, valid := oneMP4(fields, "mean")
		if !valid || len(mean) < 4 || string(mean[4:]) != "com.apple.iTunes" {
			return nil
		}
		value, valid := oneMP4(fields, "data")
		if !valid || len(value) < 8 || binary.BigEndian.Uint32(value) != 1 || binary.BigEndian.Uint32(value[4:]) != 0 {
			return nil
		}
		text = string(value[8:])
	}
	if count != 1 || len(text) > 512 {
		return nil
	}
	fields := strings.Fields(text)
	if len(fields) < 4 || len(fields) > 16 || fields[0] != "00000000" {
		return nil
	}
	numbers := make([]uint64, len(fields))
	for i, field := range fields {
		width := 8
		if i == 3 {
			width = 16
		}
		if len(field) != width {
			return nil
		}
		n, e := strconv.ParseUint(field, 16, 64)
		if e != nil {
			return nil
		}
		numbers[i] = n
	}
	p, r, n := numbers[1], numbers[2], numbers[3]
	if n == 0 || n > duration || p > duration-n || r != duration-n-p {
		return nil
	}
	return &gaplessTrim{p, n, scale}
}
