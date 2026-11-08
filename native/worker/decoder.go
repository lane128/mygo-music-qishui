// CENC/Spade semantics ported from helper/resource.cjs. Spade interpretation
// follows sodahub-org/libresoda (AGPL-3.0-or-later), commit
// 5edd2ff3b825f0a16b1e281204822ee06842df9c, src/soda/crypto.rs.
// This decoder only handles the resource and matching auth in an existing grant.
package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"math/bits"
	"regexp"
	"strconv"
)

var authPattern = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`)
var keyPattern = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)

func resourceKey(auth string) ([]byte, error) {
	if len(auth) > 4096 || !authPattern.MatchString(auth) {
		return nil, errUnavailable
	}
	// Node's base64 decoder also accepts unpadded input.
	raw, e := base64.RawStdEncoding.DecodeString(string(bytes.TrimRight([]byte(auth), "=")))
	if e != nil || len(raw) < 4 {
		return nil, errUnavailable
	}
	padding := int(raw[0]^raw[1]^raw[2]) - 48
	if padding < 0 || padding+2 >= len(raw) {
		return nil, errUnavailable
	}
	inner := raw[1 : len(raw)-padding]
	plain := make([]byte, len(inner))
	for i, b := range inner {
		previous := byte(0xfa)
		if i == 1 {
			previous = 0x55
		} else if i > 1 {
			previous = inner[i-2]
		}
		value := int(b^previous) - bits.OnesCount(uint(i)) - 21
		for value < 0 {
			value += 255
		}
		plain[i] = byte(value)
	}
	if len(plain) < 2 || !(plain[0] >= '0' && plain[0] <= '9' || plain[0] >= 'a' && plain[0] <= 'z') {
		return nil, errUnavailable
	}
	skip, e := strconv.ParseUint(string(plain[:1]), 36, 8)
	if e != nil || int(skip) >= len(plain)-1 {
		return nil, errUnavailable
	}
	encoded := plain[1 : len(plain)-int(skip)]
	if !keyPattern.Match(encoded) {
		return nil, errUnavailable
	}
	key, e := hex.DecodeString(string(encoded))
	if e != nil {
		return nil, errUnavailable
	}
	return key, nil
}

type mp4Box struct {
	typ            string
	pos, body, end int
}

func rejectUnless(ok bool) {
	if !ok {
		panic(errUnavailable)
	}
}
func boxes(data []byte, begin, end int) []mp4Box {
	rejectUnless(begin >= 0 && end <= len(data) && begin <= end)
	out := make([]mp4Box, 0, 8)
	for p := begin; p < end; {
		rejectUnless(end-p >= 8)
		size := uint64(binary.BigEndian.Uint32(data[p : p+4]))
		header := 8
		if size == 1 {
			rejectUnless(end-p >= 16)
			size = binary.BigEndian.Uint64(data[p+8 : p+16])
			header = 16
		} else if size == 0 {
			size = uint64(end - p)
		}
		rejectUnless(size >= uint64(header) && size <= uint64(end-p) && len(out) < 1000000)
		out = append(out, mp4Box{typ: string(data[p+4 : p+8]), pos: p, body: p + header, end: p + int(size)})
		p += int(size)
	}
	return out
}
func one(list []mp4Box, typ string) mp4Box {
	var found mp4Box
	n := 0
	for _, b := range list {
		if b.typ == typ {
			found = b
			n++
		}
	}
	rejectUnless(n == 1)
	return found
}
func enough(b mp4Box, p, n int)  { rejectUnless(p >= b.body && n >= 0 && p <= b.end && n <= b.end-p) }
func u32(data []byte, p int) int { return int(binary.BigEndian.Uint32(data[p : p+4])) }
func decodeWithKey(input, key []byte) (result []byte, err error) {
	defer func() {
		if recover() != nil {
			result = nil
			err = errUnavailable
		}
	}()
	rejectUnless(len(key) == 16 && len(input) <= maxAudio)
	output := bytes.Clone(input)
	top := boxes(output, 0, len(output))
	for _, b := range top {
		rejectUnless(b.typ != "moof")
	}
	mdat := one(top, "mdat")
	parent, audioStart, audioEnd := audioTrack(output, one(top, "moov"), mdat)
	for _, typ := range []string{"mdia", "minf", "stbl"} {
		parent = one(boxes(output, parent.body, parent.end), typ)
	}
	tables := boxes(output, parent.body, parent.end)
	stsz := one(tables, "stsz")
	enough(stsz, stsz.body, 12)
	fixed, count := u32(output, stsz.body+4), u32(output, stsz.body+8)
	rejectUnless(count > 0 && count <= 1000000)
	if fixed == 0 {
		enough(stsz, stsz.body+12, count*4)
	}
	sizes := make([]int, count)
	total := uint64(0)
	for i := range sizes {
		sizes[i] = fixed
		if fixed == 0 {
			sizes[i] = u32(output, stsz.body+12+i*4)
		}
		rejectUnless(sizes[i] > 0)
		total += uint64(sizes[i])
	}
	rejectUnless(total == uint64(audioEnd-audioStart))
	var offsetBoxes []mp4Box
	for _, b := range tables {
		if b.typ == "stco" || b.typ == "co64" {
			offsetBoxes = append(offsetBoxes, b)
		}
	}
	rejectUnless(len(offsetBoxes) == 1)
	stco := offsetBoxes[0]
	enough(stco, stco.body, 8)
	chunks := u32(output, stco.body+4)
	stride := 4
	if stco.typ == "co64" {
		stride = 8
	}
	rejectUnless(chunks > 0 && chunks <= count)
	enough(stco, stco.body+8, chunks*stride)
	stsc := one(tables, "stsc")
	enough(stsc, stsc.body, 8)
	runsCount := u32(output, stsc.body+4)
	rejectUnless(runsCount > 0 && runsCount <= chunks)
	enough(stsc, stsc.body+8, runsCount*12)
	type chunkRun struct{ first, count, entry int }
	runs := make([]chunkRun, runsCount)
	for i := range runs {
		p := stsc.body + 8 + i*12
		runs[i] = chunkRun{u32(output, p), u32(output, p+4), u32(output, p+8)}
		r := runs[i]
		rejectUnless(r.count > 0 && r.entry == 1 && r.first <= chunks && (i == 0 && r.first == 1 || i > 0 && r.first > runs[i-1].first))
	}
	sample, expected, run := 0, audioStart, 0
	for i := 0; i < chunks; i++ {
		for run+1 < len(runs) && runs[run+1].first <= i+1 {
			run++
		}
		p := stco.body + 8 + i*stride
		offset := uint64(u32(output, p))
		if stride == 8 {
			offset = binary.BigEndian.Uint64(output[p : p+8])
		}
		rejectUnless(offset == uint64(expected) && runs[run].count <= count-sample)
		for n := 0; n < runs[run].count; n++ {
			expected += sizes[sample]
			sample++
		}
	}
	rejectUnless(sample == count && expected == audioEnd)
	stsd := one(tables, "stsd")
	enough(stsd, stsd.body, 8)
	rejectUnless(u32(output, stsd.body+4) == 1)
	entry := one(boxes(output, stsd.body+8, stsd.end), "enca")
	enough(entry, entry.body, 28)
	rejectUnless(binary.BigEndian.Uint16(output[entry.body+8:entry.body+10]) == 0)
	entryBoxes := boxes(output, entry.body+28, entry.end)
	sinf := one(entryBoxes, "sinf")
	protection := boxes(output, sinf.body, sinf.end)
	frma := one(protection, "frma")
	enough(frma, frma.body, 4)
	format := string(output[frma.body : frma.body+4])
	rejectUnless(format == "mp4a" || format == "fLaC")
	var metadata []byte
	if format == "fLaC" {
		config := one(entryBoxes, "dfLa")
		enough(config, config.body, 8)
		rejectUnless(u32(output, config.body) == 0)
		metadata = output[config.body+4 : config.end]
		p, blocks, last := 0, 0, false
		for p < len(metadata) {
			rejectUnless(!last && len(metadata)-p >= 4)
			typ := metadata[p] & 0x7f
			size := int(metadata[p+1])<<16 | int(metadata[p+2])<<8 | int(metadata[p+3])
			rejectUnless((blocks != 0 || typ == 0 && size == 34) && (blocks == 0 || typ != 0) && typ != 127)
			last = metadata[p]&0x80 != 0
			p += 4 + size
			rejectUnless(p <= len(metadata))
			blocks++
		}
		rejectUnless(blocks > 0 && last)
	}
	schm := one(protection, "schm")
	enough(schm, schm.body, 8)
	rejectUnless(string(output[schm.body+4:schm.body+8]) == "cenc")
	schi := one(protection, "schi")
	tenc := one(boxes(output, schi.body, schi.end), "tenc")
	enough(tenc, tenc.body, 24)
	ivSize := int(output[tenc.body+7])
	rejectUnless(output[tenc.body] == 0 && output[tenc.body+6] == 1 && (ivSize == 8 || ivSize == 16))
	senc := one(tables, "senc")
	enough(senc, senc.body, 8)
	flags := u32(output, senc.body) & 0xffffff
	rejectUnless(output[senc.body] == 0 && flags & ^2 == 0 && u32(output, senc.body+4) == count)
	p, offset := senc.body+8, audioStart
	block, e := aes.NewCipher(key)
	rejectUnless(e == nil)
	for _, size := range sizes {
		enough(senc, p, ivSize)
		iv := make([]byte, 16)
		copy(iv, output[p:p+ivSize])
		p += ivSize
		ctr := cipher.NewCTR(block, iv)
		end := offset + size
		if flags&2 != 0 {
			enough(senc, p, 2)
			subs := int(binary.BigEndian.Uint16(output[p : p+2]))
			p += 2
			enough(senc, p, subs*6)
			if subs == 0 {
				ctr.XORKeyStream(output[offset:end], output[offset:end])
				offset = end
			}
			for i := 0; i < subs; i++ {
				clear, encrypted := int(binary.BigEndian.Uint16(output[p:p+2])), u32(output, p+2)
				p += 6
				rejectUnless(clear <= end-offset && encrypted <= end-offset-clear)
				offset += clear
				ctr.XORKeyStream(output[offset:offset+encrypted], output[offset:offset+encrypted])
				offset += encrypted
			}
			rejectUnless(offset == end)
		} else {
			ctr.XORKeyStream(output[offset:end], output[offset:end])
		}
		offset = end
	}
	rejectUnless(p == senc.end && offset == audioEnd)
	if format == "fLaC" {
		rejectUnless(4+len(metadata)+audioEnd-audioStart <= maxAudio)
		result = make([]byte, 0, 4+len(metadata)+audioEnd-audioStart)
		result = append(result, []byte("fLaC")...)
		result = append(result, metadata...)
		result = append(result, output[audioStart:audioEnd]...)
		return result, nil
	}
	copy(output[entry.pos+4:], "mp4a")
	copy(output[sinf.pos+4:], "free")
	for _, b := range tables {
		if b.typ == "senc" || b.typ == "saio" || b.typ == "saiz" {
			copy(output[b.pos+4:], "free")
		}
	}
	return output, nil
}

const maxDecodeInput = 180 * 1024 * 1024

func decodeMain(in io.Reader, out io.Writer) error {
	raw, e := io.ReadAll(io.LimitReader(in, maxDecodeInput+1))
	if e != nil || len(raw) > maxDecodeInput {
		return errUnavailable
	}
	var req struct {
		Audio string `json:"audio"`
		Auth  string `json:"auth"`
	}
	if json.Unmarshal(raw, &req) != nil || len(req.Audio) > base64.StdEncoding.EncodedLen(maxAudio) {
		return errUnavailable
	}
	data, e := base64.StdEncoding.Strict().DecodeString(req.Audio)
	if e != nil || len(data) > maxAudio {
		return errUnavailable
	}
	key, e := resourceKey(req.Auth)
	if e != nil {
		return errUnavailable
	}
	result, e := decodeWithKey(data, key)
	if e != nil {
		return errUnavailable
	}
	_, e = out.Write(result)
	if e != nil {
		return errUnavailable
	}
	return nil
}
func decodeResource(ctx context.Context, root string, data []byte, auth string) ([]byte, error) {
	if len(data) == 0 || len(data) > maxAudio || len(auth) > 4096 {
		return nil, errUnavailable
	}
	raw, e := json.Marshal(struct {
		Audio string `json:"audio"`
		Auth  string `json:"auth"`
	}{base64.StdEncoding.EncodeToString(data), auth})
	if e != nil {
		return nil, errUnavailable
	}
	return isolatedNative(ctx, root, "decode", raw, maxAudio)
}
