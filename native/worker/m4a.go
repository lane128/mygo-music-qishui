package main

import "encoding/binary"

// AAC-LC passthrough accepts only the plain ASC and SBR-absent extensions verified
// in real grants. Unknown configurations never reach the host as playable M4A.
func aacLCConfig(asc []byte) (rate, channels int, ok bool) {
	if len(asc) < 2 || len(asc) > 8 {
		return
	}
	at := 0
	read := func(n int) int {
		if n > len(asc)*8-at {
			return -1
		}
		v := 0
		for i := 0; i < n; i++ {
			v = v*2 + int((asc[at/8]>>uint(7-at%8))&1)
			at++
		}
		return v
	}
	if read(5) != 2 {
		return
	}
	index, ch := read(4), read(4)
	rates := [...]int{96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350}
	if index < 0 || index >= len(rates) || (ch != 1 && ch != 2) || read(3) != 0 {
		return
	}
	if len(asc)*8-at > 7 {
		if read(11) != 0x2b7 || read(5) != 5 || read(1) != 0 {
			return
		}
		if len(asc)*8-at > 7 && (read(11) != 0x548 || read(1) != 0) {
			return
		}
	}
	if len(asc)*8-at > 7 || read(len(asc)*8-at) != 0 {
		return
	}
	return rates[index], ch, true
}

func descriptors(data []byte, start, end int) []mp4Box {
	rejectUnless(start >= 0 && start <= end && end <= len(data))
	var out []mp4Box
	for p := start; p < end; {
		tag := data[p]
		p++
		n, done := 0, false
		for i := 0; i < 4; i++ {
			rejectUnless(p < end)
			v := data[p]
			p++
			n = n*128 + int(v&127)
			if v&128 == 0 {
				done = true
				break
			}
		}
		rejectUnless(done && n <= end-p)
		out = append(out, mp4Box{typ: string([]byte{tag}), body: p, end: p + n})
		p += n
	}
	return out
}

// nativeM4A validates a non-fragmented edit-list layout with one sound track
// and an optional bounded plain text track. It never transcodes or changes audio.
func nativeM4A(data []byte) (valid bool) {
	defer func() {
		if recover() != nil {
			valid = false
		}
	}()
	rejectUnless(len(data) >= 32 && len(data) <= maxAudio)
	top := boxes(data, 0, len(data))
	movie, mdat, ftyp := one(top, "moov"), one(top, "mdat"), one(top, "ftyp")
	rejectUnless(ftyp.end-ftyp.body >= 8)
	for _, b := range top {
		rejectUnless(b.typ != "moof")
	}
	moov := boxes(data, movie.body, movie.end)
	for _, b := range moov {
		rejectUnless(b.typ != "mvex")
	}
	trak, audioStart, audioEnd := audioTrack(data, movie, mdat)
	track := boxes(data, trak.body, trak.end)
	mdia := one(track, "mdia")
	media := boxes(data, mdia.body, mdia.end)
	hdlr := one(media, "hdlr")
	enough(hdlr, hdlr.body, 12)
	rejectUnless(string(data[hdlr.body+8:hdlr.body+12]) == "soun")
	mdhd := one(media, "mdhd")
	enough(mdhd, mdhd.body, 24)
	var scale int
	var duration uint64
	switch data[mdhd.body] {
	case 0:
		scale = u32(data, mdhd.body+12)
		duration = uint64(u32(data, mdhd.body+16))
	case 1:
		enough(mdhd, mdhd.body, 36)
		scale = u32(data, mdhd.body+20)
		duration = binary.BigEndian.Uint64(data[mdhd.body+24:])
	default:
		return false
	}
	edts := one(track, "edts")
	elst := one(boxes(data, edts.body, edts.end), "elst")
	enough(elst, elst.body, 8)
	rejectUnless((u32(data, elst.body) == 0 || u32(data, elst.body) == 0x1000000) && u32(data, elst.body+4) == 1)
	var segment uint64
	var prime int64
	var rateAt int
	if data[elst.body] == 1 {
		enough(elst, elst.body+8, 20)
		segment = binary.BigEndian.Uint64(data[elst.body+8:])
		prime = int64(binary.BigEndian.Uint64(data[elst.body+16:]))
		rateAt = elst.body + 24
	} else {
		enough(elst, elst.body+8, 12)
		segment = uint64(u32(data, elst.body+8))
		prime = int64(int32(u32(data, elst.body+12)))
		rateAt = elst.body + 16
	}
	rejectUnless(segment > 0 && segment <= 1<<53-1 && prime >= 0 && prime <= 1<<53-1 && u32(data, rateAt) == 0x10000)
	minf := one(media, "minf")
	stbl := one(boxes(data, minf.body, minf.end), "stbl")
	tables := boxes(data, stbl.body, stbl.end)
	for _, b := range tables {
		rejectUnless(b.typ != "senc" && b.typ != "saio" && b.typ != "saiz")
	}
	stsd := one(tables, "stsd")
	enough(stsd, stsd.body, 8)
	rejectUnless(u32(data, stsd.body) == 0 && u32(data, stsd.body+4) == 1)
	entries := boxes(data, stsd.body+8, stsd.end)
	entry := one(entries, "mp4a")
	enough(entry, entry.body, 28)
	rejectUnless(len(entries) == 1 && binary.BigEndian.Uint16(data[entry.body+8:]) == 0)
	children := boxes(data, entry.body+28, entry.end)
	for _, b := range children {
		rejectUnless(b.typ != "sinf")
	}
	esds := one(children, "esds")
	enough(esds, esds.body, 4)
	rejectUnless(u32(data, esds.body) == 0)
	es := one(descriptors(data, esds.body+4, esds.end), "\x03")
	enough(es, es.body, 3)
	p, flags := es.body+3, data[es.body+2]
	if flags&128 != 0 {
		p += 2
	}
	if flags&64 != 0 {
		enough(es, p, 1)
		p += 1 + int(data[p])
	}
	if flags&32 != 0 {
		p += 2
	}
	enough(es, p, 0)
	decoder := one(descriptors(data, p, es.end), "\x04")
	enough(decoder, decoder.body, 13)
	rejectUnless(data[decoder.body] == 0x40 && data[decoder.body+1]>>2 == 5)
	config := one(descriptors(data, decoder.body+13, decoder.end), "\x05")
	rate, channels, ok := aacLCConfig(data[config.body:config.end])
	rejectUnless(ok && scale == rate && u32(data, entry.body+24) == rate*65536 && int(binary.BigEndian.Uint16(data[entry.body+16:])) == channels)
	stsz := one(tables, "stsz")
	enough(stsz, stsz.body, 12)
	fixed, count := u32(data, stsz.body+4), u32(data, stsz.body+8)
	rejectUnless(count > 0 && count <= 1000000)
	if fixed == 0 {
		enough(stsz, stsz.body+12, count*4)
	}
	total := uint64(0)
	for i := 0; i < count; i++ {
		n := fixed
		if n == 0 {
			n = u32(data, stsz.body+12+i*4)
		}
		rejectUnless(n > 0)
		total += uint64(n)
	}
	rejectUnless(total == uint64(audioEnd-audioStart))
	var offsets []mp4Box
	for _, b := range tables {
		if b.typ == "stco" || b.typ == "co64" {
			offsets = append(offsets, b)
		}
		rejectUnless(b.typ != "ctts")
	}
	rejectUnless(len(offsets) == 1)
	chunks := offsets[0]
	width := 4
	if chunks.typ == "co64" {
		width = 8
	}
	enough(chunks, chunks.body, 8)
	chunkCount := u32(data, chunks.body+4)
	rejectUnless(u32(data, chunks.body) == 0 && chunkCount > 0 && chunkCount <= count)
	enough(chunks, chunks.body+8, chunkCount*width)
	stsc := one(tables, "stsc")
	enough(stsc, stsc.body, 8)
	mappings := u32(data, stsc.body+4)
	rejectUnless(u32(data, stsc.body) == 0 && mappings > 0 && mappings <= chunkCount)
	enough(stsc, stsc.body+8, mappings*12)
	type mapping struct{ first, samples int }
	maps := make([]mapping, mappings)
	for i := range maps {
		p := stsc.body + 8 + i*12
		first, n := u32(data, p), u32(data, p+4)
		rejectUnless((i != 0 || first == 1) && (i == 0 || first > maps[i-1].first) && first <= chunkCount && n > 0 && n <= count && u32(data, p+8) == 1)
		maps[i] = mapping{first, n}
	}
	sample, offset, run := 0, audioStart, 0
	for i := 1; i <= chunkCount; i++ {
		if run+1 < mappings && maps[run+1].first == i {
			run++
		}
		p := chunks.body + 8 + (i-1)*width
		declared := uint64(u32(data, p))
		if width == 8 {
			declared = binary.BigEndian.Uint64(data[p:])
		}
		rejectUnless(declared == uint64(offset) && sample+maps[run].samples <= count)
		for j := 0; j < maps[run].samples; j++ {
			n := fixed
			if n == 0 {
				n = u32(data, stsz.body+12+sample*4)
			}
			offset += n
			sample++
		}
	}
	rejectUnless(sample == count && offset == audioEnd)
	stts := one(tables, "stts")
	enough(stts, stts.body, 8)
	runs := u32(data, stts.body+4)
	rejectUnless(runs > 0 && runs <= count)
	enough(stts, stts.body+8, runs*8)
	packets, ticks := uint64(0), uint64(0)
	for i := 0; i < runs; i++ {
		n, delta := u32(data, stts.body+8+i*8), u32(data, stts.body+12+i*8)
		rejectUnless(n > 0 && delta > 0 && delta <= 1024)
		packets += uint64(n)
		ticks += uint64(n) * uint64(delta)
	}
	// Real grants use MDHD durations both including and excluding edit-list priming.
	// The host derives playback length from STTS minus priming in either layout.
	return packets == uint64(count) && duration > 0 && uint64(prime) < ticks &&
		(duration == ticks || duration == ticks-uint64(prime))
}
