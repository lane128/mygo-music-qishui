package main

import "encoding/binary"

// audioTrack accepts one sound track and an optional unencrypted QuickTime text
// sample at either edge of mdat. It validates the text tables before excluding
// those bytes from the audio range; offsets and auxiliary bytes stay unchanged.
func audioTrack(data []byte, movie, mdat mp4Box) (sound mp4Box, start, end int) {
	start, end = mdat.body, mdat.end
	var text mp4Box
	tracks := 0
	for _, track := range boxes(data, movie.body, movie.end) {
		rejectUnless(track.typ != "mvex")
		if track.typ != "trak" {
			continue
		}
		tracks++
		rejectUnless(tracks <= 2)
		media := one(boxes(data, track.body, track.end), "mdia")
		handler := one(boxes(data, media.body, media.end), "hdlr")
		enough(handler, handler.body, 12)
		switch string(data[handler.body+8 : handler.body+12]) {
		case "soun":
			rejectUnless(sound.end == 0)
			sound = track
		case "text":
			rejectUnless(text.end == 0)
			text = track
		default:
			rejectUnless(false)
		}
	}
	rejectUnless(sound.end != 0)
	if text.end == 0 {
		return
	}
	media := one(boxes(data, text.body, text.end), "mdia")
	minf := one(boxes(data, media.body, media.end), "minf")
	stbl := one(boxes(data, minf.body, minf.end), "stbl")
	tables := boxes(data, stbl.body, stbl.end)
	for _, box := range tables {
		rejectUnless(box.typ != "senc" && box.typ != "saio" && box.typ != "saiz" && box.typ != "ctts")
	}
	stsd := one(tables, "stsd")
	enough(stsd, stsd.body, 8)
	rejectUnless(u32(data, stsd.body) == 0 && u32(data, stsd.body+4) == 1)
	entries := boxes(data, stsd.body+8, stsd.end)
	entry := one(entries, "text")
	enough(entry, entry.body, 8)
	rejectUnless(len(entries) == 1 && binary.BigEndian.Uint16(data[entry.body+6:]) == 1)
	stsz := one(tables, "stsz")
	enough(stsz, stsz.body, 12)
	rejectUnless(u32(data, stsz.body) == 0 && u32(data, stsz.body+8) == 1)
	size := u32(data, stsz.body+4)
	if size == 0 {
		enough(stsz, stsz.body+12, 4)
		size = u32(data, stsz.body+12)
	}
	rejectUnless(size > 0 && size <= 65536)
	stsc := one(tables, "stsc")
	enough(stsc, stsc.body, 20)
	rejectUnless(u32(data, stsc.body) == 0 && u32(data, stsc.body+4) == 1 && u32(data, stsc.body+8) == 1 && u32(data, stsc.body+12) == 1 && u32(data, stsc.body+16) == 1)
	stts := one(tables, "stts")
	enough(stts, stts.body, 16)
	rejectUnless(u32(data, stts.body) == 0 && u32(data, stts.body+4) == 1 && u32(data, stts.body+8) == 1 && u32(data, stts.body+12) > 0)
	var offsets []mp4Box
	for _, box := range tables {
		if box.typ == "stco" || box.typ == "co64" {
			offsets = append(offsets, box)
		}
	}
	rejectUnless(len(offsets) == 1)
	chunk := offsets[0]
	width := 4
	if chunk.typ == "co64" {
		width = 8
	}
	enough(chunk, chunk.body, 8+width)
	rejectUnless(u32(data, chunk.body) == 0 && u32(data, chunk.body+4) == 1)
	offset := uint64(u32(data, chunk.body+8))
	if width == 8 {
		offset = binary.BigEndian.Uint64(data[chunk.body+8:])
	}
	rejectUnless(offset >= uint64(start) && offset <= uint64(end) && uint64(size) <= uint64(end)-offset)
	if offset == uint64(start) {
		start += size
	} else {
		rejectUnless(offset+uint64(size) == uint64(end))
		end -= size
	}
	rejectUnless(start < end)
	return
}
