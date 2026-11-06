import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { test } from 'node:test'
import { sceneCover } from '../helper/scene-art.mjs'

const root = new URL('../assets/scene-covers/', import.meta.url)
const { covers } = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'))

// Bundled art must resolve relative to the installed helper and support future scenes without external image fetches.
test('resolves local common-mode and future-scene covers without changing station identity', async () => {
  for (const mode of [{ id: 'preference:familiar', name: '熟悉' }, { id: 'preference:fresh', name: '新鲜' }, { id: 'scene:999999', name: '未来场景' }]) {
    const id = mode.id
    const image = new URL(sceneCover(mode))
    assert.equal(image.protocol, 'file:')
    assert.ok(image.href.startsWith(root.href))
    assert.equal((await readFile(image)).subarray(1, 4).toString(), 'PNG')
    assert.equal(mode.id, id)
  }
  assert.equal(sceneCover({ id: 'scene:999999', name: '通勤未来模式' }), new URL(covers['category:activity'], root).href)
})

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}
function pixels(png) {
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), depth = png[24], type = png[25]
  assert.equal(width, 320)
  assert.equal(height, 320)
  assert.equal(depth, 8)
  assert.ok(type === 2 || type === 6)
  assert.equal(png[28], 0, 'PNG must not be interlaced')
  const compressed = []
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset)
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + size))
    offset += size + 12
  }
  const channels = type === 6 ? 4 : 3, stride = width * channels
  const raw = inflateSync(Buffer.concat(compressed))
  assert.equal(raw.length, (stride + 1) * height)
  const output = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    assert.ok(filter <= 4)
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, a = x >= channels ? output[at - channels] : 0, b = y ? output[at - stride] : 0, c = y && x >= channels ? output[at - stride - channels] : 0
      const predict = filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : 0
      output[at] = (raw[y * (stride + 1) + x + 1] + predict) & 255
    }
  }
  return { output, channels }
}

// White transparent provider icons disappeared in light mode; every shipped cover must have a colored, opaque background.
test('every registered scene asset exists and has an opaque colored background', async () => {
  const names = [...new Set(Object.values(covers))]
  assert.ok(names.length > 0)
  for (const name of names) {
    assert.match(name, /^[a-f0-9]{20}\.png$/)
    const { output, channels } = pixels(await readFile(new URL(name, root)))
    if (channels === 4) for (let at = 3; at < output.length; at += 4) assert.equal(output[at], 255, 'scene image must not retain transparent pixels')
    assert.ok(output[0] + output[1] + output[2] < 650, 'background must contrast with white symbols')
  }
})
