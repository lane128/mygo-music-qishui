import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Catalog } from '../helper/catalog.mjs'
import { sandbox, session } from './fixtures/plugin-sandbox.mjs'
import { catalogService, discovery } from './fixtures/catalog-service.mjs'

// Local pictures previously overrode fresh provider URLs, including future scenes.
const mode = (id, url) => ({ type: 'scene_mode', text: '官方模式', url_info: url, entity: { feed_scene_mode: typeof id === 'number' ? { scene_mode_id: id } : { sub_queue_type: id } } })
const reply = () => ({ feed_mode_block: [{ title: '官方分组', feed_mode: [
  mode(0, 'https://p3-luna.douyinpic.com/img/current.jpg?revision=2'),
  mode(999999, 'https://p3-luna.douyinpic.com/img/new-scene.jpg'),
  mode('fresh', 'https://p3-luna.douyinpic.com/img/fresh.jpg'),
  mode('familiar', undefined),
  mode(42, 'file:///outside/private.png'),
] }] })
const check = modes => {
  assert.equal(modes.find(mode => mode.id === 'scene:0').imageUrl, 'https://p3-luna.douyinpic.com/img/current.jpg?revision=2')
  assert.equal(modes.find(mode => mode.id === 'scene:999999').imageUrl, 'https://p3-luna.douyinpic.com/img/new-scene.jpg')
  assert.equal(modes.find(mode => mode.id === 'preference:fresh').imageUrl, 'https://p3-luna.douyinpic.com/img/fresh.jpg')
  assert.equal(modes.find(mode => mode.id === 'preference:familiar').imageUrl, undefined)
  assert.equal(modes.find(mode => mode.id === 'scene:42').imageUrl, undefined)
}

test('Node catalogue preserves current official cover URLs and leaves missing or unsafe covers to the host', async () => {
  const catalog = new Catalog(session, { request: async () => reply() })
  check(await catalog.listeningModes())
})

test('standalone sandbox preserves official covers across stations and browse without fetching image bytes', async () => {
  const service = catalogService({ modes: [reply(), reply(), reply()], discover: [discovery([], { more: false })] })
  const s = await sandbox([], session, { sign: true, request: service.request })
  try {
    const stations = await s.api.stations()
    assert.equal(stations.find(mode => mode.id === 'preference:fresh').imageUrl, 'https://p3-luna.douyinpic.com/img/fresh.jpg')
    assert.equal(stations.find(mode => mode.id === 'preference:familiar').imageUrl, undefined)
    check((await s.api.browse({ page: 'scene-modes' })).sections[0].stations)
    check((await s.api.browse({ page: 'listening-modes' })).sections[0].stations)
    assert.ok(service.calls.every(call => call.parsed.hostname === 'api.qishui.com'))
  } finally { await s.api.signOut() }
})
