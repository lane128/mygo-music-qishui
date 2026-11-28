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

test('listening-mode pages replace a verified icon, not missing or photographic covers, and keep station identity', async () => {
  const key = 'a'.repeat(32) + '.png', uri = `tos-cn-i-b829550vbb/${key}`
  const info = { uri, template_prefix: 'tplv-b829550vbb', urls: ['https://p3-luna.douyinpic.com/img/'] }
  const remote = reply(); remote.feed_mode_block[0].feed_mode[0].url_info = info
  const service = catalogService({ modes: [remote, remote], discover: [discovery([], { more: false })] })
  const file = `file:///cache/${key}.png`
  const covers = { ok: true, result: { [key]: file } }
  const s = await sandbox([[covers], [covers]], session, { sign: true, request: service.request })
  try {
    for (const page of ['scene-modes', 'listening-modes']) {
      const { stations } = (await s.api.browse({page})).sections[0]
      assert.equal(stations.find(x=>x.id==='scene:0').imageUrl,file)
      assert.equal(stations.find(x=>x.id==='scene:999999').imageUrl,'https://p3-luna.douyinpic.com/img/new-scene.jpg')
      assert.equal(stations.find(x=>x.id==='preference:familiar').imageUrl,undefined)
    }
    assert.deepEqual(s.calls.filter(x=>x.method==='sceneIcons').map(x=>x.params.keys),[[key],[key]])
  } finally { await s.api.signOut() }
})

test('an optional icon lookup that outlives the page deadline still returns the mode page', async () => {
  const key = 'b'.repeat(32) + '.png'
  const info = { uri: `tos-cn-i-b829550vbb/${key}`, template_prefix: 'tplv-b829550vbb', urls: ['https://p3-luna.douyinpic.com/img/'] }
  const remote = reply(); remote.feed_mode_block[0].feed_mode[0].url_info = info
  let answered
  const discovered = new Promise(resolve => { answered = resolve })
  const service = catalogService({ modes: [remote], discover: [() => { answered(); return discovery([], { more: false }) }] })
  let expire
  // Required data is complete; only the optional artwork is still pending when the page deadline expires.
  const icons = async () => {
    await discovered
    await new Promise(resolve => setTimeout(resolve, 0))
    expire?.()
    return JSON.stringify({ ok: false, error: 'network' })
  }
  const timer = (callback, ms) => { if (ms === 24000 && !expire) { expire = callback; return 0 } const id = setTimeout(callback, ms); return id }
  const s = await sandbox([[icons]], session, { sign: true, request: service.request, timer })
  try {
    const { stations } = (await s.api.browse({ page: 'listening-modes' })).sections[0]
    const icon = `https://p3-luna.douyinpic.com/img/${info.uri}~tplv-b829550vbb-resize:%7Bsize%7D:%7Bsize%7D.png`
    assert.equal(stations.find(x => x.id === 'scene:0').imageUrl, icon)
    assert.equal(s.calls.filter(x => x.method === 'sceneIcons').length, 1)
  } finally { await s.api.signOut() }
})

test('a stalled icon helper cannot hold the mode page open', async () => {
  const key = 'd'.repeat(32) + '.png'
  const info = { uri: `tos-cn-i-b829550vbb/${key}`, template_prefix: 'tplv-b829550vbb', urls: ['https://p3-luna.douyinpic.com/img/'] }
  const remote = reply(); remote.feed_mode_block[0].feed_mode[0].url_info = info
  const service = catalogService({ modes: [remote], discover: [discovery([], { more: false })] })
  const held = []
  let release
  const icons = () => new Promise(resolve => { release = resolve })
  const timer = (callback, ms) => {
    if (ms === 5000) { setImmediate(callback); return 0 } // optional artwork budget
    if (ms === 25000) { held.push(callback); return 0 } // helper read deadline
    if (ms === 24000) return 0 // page deadline is not part of this case
    return setTimeout(callback, ms)
  }
  const s = await sandbox([[icons]], session, { sign: true, request: service.request, timer })
  let slow
  try {
    const page = await Promise.race([
      s.api.browse({ page: 'listening-modes' }),
      new Promise((_, reject) => { slow = setTimeout(() => reject(new Error('page waited for the stalled icon helper')), 1000) }),
    ])
    const icon = `https://p3-luna.douyinpic.com/img/${info.uri}~tplv-b829550vbb-resize:%7Bsize%7D:%7Bsize%7D.png`
    assert.equal(page.sections[0].stations.find(x => x.id === 'scene:0').imageUrl, icon)
    assert.equal(s.calls.filter(x => x.method === 'sceneIcons').length, 1)
  } finally {
    clearTimeout(slow)
    release?.(JSON.stringify({ ok: false, error: 'network' }))
    for (const callback of held) callback()
    await s.api.signOut()
  }
})

test('a failed discovery request fails the page without waiting for the mode catalogue', async () => {
  const remote = reply()
  let settle
  const modes = () => new Promise(resolve => { settle = () => resolve(remote) })
  const service = catalogService({ modes: [modes], discover: [() => new Response('', { status: 503 })] })
  const s = await sandbox([], session, { sign: true, request: service.request })
  let slow
  try {
    const outcome = await Promise.race([
      s.api.browse({ page: 'listening-modes' }).then(() => 'ok', error => error.message),
      new Promise(resolve => { slow = setTimeout(() => resolve('waited for the mode catalogue'), 1000) }),
    ])
    assert.notEqual(outcome, 'ok')
    assert.notEqual(outcome, 'waited for the mode catalogue')
  } finally {
    clearTimeout(slow)
    settle?.()
    await s.api.signOut()
  }
})

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
