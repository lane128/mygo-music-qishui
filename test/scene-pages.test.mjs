import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scenePage } from '../helper/scene-pages.mjs'

const mode = (id, name) => ({ id: 'scene:' + id, name, group: '场景音乐', imageUrl: `https://example.invalid/${id}.png` })
const common = [{ id: 'preference:familiar', name: '熟悉模式' }, { id: 'preference:fresh', name: '新鲜模式' }]

// Root discovery stays directly playable; its native more link keeps every original mode reachable without categories.
test('flattens common modes and retains all original scenes through a native section link', () => {
  const modes = [...common, ...Array.from({ length: 45 }, (_, i) => mode(i, `模式 ${i}`))]
  modes.at(-1).id = 'scene:9223372036854775807'
  const landing = scenePage(modes)
  assert.deepEqual(landing.sections[0].stations.map(s => s.id), modes.slice(0, 8).map(s => s.id))
  assert.ok(landing.sections.every(section => !section.links))
  const all = scenePage(modes, landing.sections[0].morePage)
  assert.deepEqual(all.sections[0].stations.map(s => s.id), modes.map(s => s.id))
  assert.equal(all.sections[0].stations.at(-1).imageUrl, modes.at(-1).imageUrl)
})

// The eight-mode preview must not expose a redundant full-list route when every mode already fits.
test('keeps a short common-mode catalog complete without a redundant more link', () => {
  for (const count of [1, 2, 7, 8]) {
    const modes = [...common, ...Array.from({ length: 6 }, (_, i) => mode(i, `Mode ${i}`))].slice(0, count)
    const section = scenePage(modes).sections[0]
    assert.deepEqual(section.stations.map(s => s.id), modes.map(s => s.id))
    assert.equal(section.morePage, undefined)
  }
})

// Radio and playlist discovery cards retain their native playback semantics and official image URLs.
test('shows exploration pictures without category or operation cards', () => {
  const radio = { id: 'radio:42', name: '音乐电台', imageUrl: 'https://example.invalid/photo.jpg', description: '电台介绍' }
  const playlist = { id: '73', name: '推荐歌单', imageUrl: 'https://example.invalid/list.jpg' }
  const landing = scenePage(common, 'listening-modes', [{ type: 'radio', item: radio }, { type: 'playlist', item: playlist }])
  assert.equal(landing.sections[0].morePage, undefined)
  assert.deepEqual(landing.sections[1].stations, [radio])
  assert.deepEqual(landing.sections[1].playlists, [playlist])
  assert.ok(landing.sections.every(section => !section.links))
})

// Removed category routes must not silently route to a wrong station or expose dead navigation.
test('handles empty mode catalogs and rejects obsolete category routes', () => {
  assert.deepEqual(scenePage([]).sections, [])
  assert.deepEqual(scenePage([], 'scene-modes').sections, [])
  for (const page of ['listening-modes:focus:1', 'scene-modes:2', 'unknown']) assert.throws(() => scenePage(common, page), { kind: 'unsupported' })
})
