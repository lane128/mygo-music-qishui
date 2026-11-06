import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scenePage, SCENES_PER_PAGE } from '../helper/scene-pages.mjs'

const mode = (id, name) => ({ id: 'scene:' + id, name, group: '场景音乐', imageUrl: `https://example.invalid/${id}.png` })
const common = [{ id: 'preference:familiar', name: '熟悉模式', group: '常用模式' }, { id: 'preference:fresh', name: '新鲜模式', group: '常用模式' }]

// A category landing must keep common modes playable without dumping every server scene into large cards.
test('category links retain direct common modes and reach the correct scene IDs', () => {
  const modes = [...common, mode(0, 'Chill 放松'), mode(1, '快乐时光'), mode(2, '通勤必听'), mode(3, '电音'), mode(4, '粤语'), mode(5, '未来新模式')]
  const landing = scenePage(modes)
  assert.deepEqual(landing.sections[0].stations.map(station => station.id), common.map(station => station.id))
  const links = landing.sections.flatMap(section => section.links || [])
  assert.equal(links.length, 6)
  assert.ok(landing.sections.every(section => !section.stations || section.stations.length <= 2))
  const reached = links.flatMap(link => {
    const page = scenePage(modes, link.page)
    assert.equal(page.sections[0].stations[0].imageUrl, link.imageUrl)
    return page.sections[0].stations.map(station => station.id)
  })
  assert.deepEqual(new Set(reached), new Set(modes.slice(2).map(station => station.id)))
})

// Following every page link must expose all scene identities once without rounding, omission, or unbounded card lists.
test('paginates large categories with complete forward and backward routes', () => {
  const scenes = Array.from({ length: 29 }, (_, i) => mode(i, `通勤 ${i}`))
  scenes[0].id = 'scene:9223372036854775807'
  const modes = [...common, ...scenes]
  const start = scenePage(modes).sections.flatMap(section => section.links || [])[0].page
  const visited = new Set()
  const reached = []
  const pending = [start]
  while (pending.length) {
    const route = pending.shift()
    if (visited.has(route)) continue
    visited.add(route)
    const page = scenePage(modes, route)
    const stations = page.sections.flatMap(section => section.stations || [])
    assert.ok(stations.length > 0 && stations.length <= SCENES_PER_PAGE)
    reached.push(...stations.map(station => station.id))
    pending.push(...page.sections.flatMap(section => section.links || []).map(link => link.page))
  }
  assert.equal(visited.size, 3)
  assert.equal(reached.length, scenes.length)
  assert.deepEqual(new Set(reached), new Set(scenes.map(station => station.id)))
})

// Empty categories do not create dead cards, and malformed or out-of-range routes fail explicitly.
test('does not expose dead categories or accept unsupported pagination routes', () => {
  const modes = [...common, mode(0, '专注模式')]
  const landing = scenePage(modes)
  assert.equal(landing.sections[1].links.length, 1)
  for (const page of ['listening-modes:focus:0', 'listening-modes:focus:01', 'listening-modes:focus:2', 'listening-modes:focus:1?x=y', 'listening-modes:activity:1', 'listening-modes:unknown:1']) assert.throws(() => scenePage(modes, page), { kind: 'unsupported' })
  assert.deepEqual(scenePage([]).sections, [])
})
