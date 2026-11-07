import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Catalog } from '../helper/catalog.mjs'
import { homePage } from '../helper/home-page.mjs'

const discoveries = Array.from({ length: 20 }, (_, i) => ({ type: i === 1 ? 'playlist' : 'radio', item: { id: i === 1 ? '7123456789012345678' : `radio:${i}`, name: `探索 ${i}`, imageUrl: `https://example.invalid/radio-${i}.jpg` } }))

// Home bounds the discovery preview at 15 while preserving playlist and radio actions and artwork.
test('home previews fifteen discovery resources and links to the full exploration page', () => {
  const home = homePage(discoveries)
  assert.equal(home.sections.length, 1)
  const discovery = home.sections[0]
  assert.equal(discovery.morePage, 'listening-modes')
  assert.deepEqual(discovery.playlists, [discoveries[1].item])
  assert.deepEqual(discovery.stations, discoveries.slice(0, 15).filter(d => d.type === 'radio').map(d => d.item))
  assert.equal(home.sections.some(s => s.links || s.stations?.some(s => s.id === 'recommendations')), false)
  assert.equal(discoveries.length, 20)
})

// An empty discovery response must retain its section and navigation so MyGO never substitutes personal-library shelves.
test('empty and short discovery keep the home destination without fabricated cards', () => {
  const empty = homePage([])
  assert.equal(empty.sections.length, 1)
  assert.equal(empty.sections[0].morePage, 'listening-modes')
  assert.equal(empty.sections[0].playlists, undefined)
  assert.equal(empty.sections[0].stations, undefined)
  assert.deepEqual(homePage(discoveries.slice(0, 1)).sections[0].stations, [discoveries[0].item])
  assert.throws(() => homePage(null), { kind: 'response' })
})

// The production catalog must use signed discovery alone, without a personal-library request or playback grant.
test('catalog home composes actual discovery responses without loading personal playlists', async () => {
  const session = { version: 1, deviceID: '1234567890123456', installID: '123456789012345', cookies: [{ name: 'sessionid', value: 'fixture' }] }
  const catalog = new Catalog(session, { request: async (_, path, options) => {
    assert.equal(path, '/luna/pc/discover')
    assert.equal(options.signed, true)
    assert.deepEqual(options.body, { first_request: true, pc_new_discover_request: true })
    return { blocks: [{ type: 'discover_playlist_mix', inner_block: discoveries.map((d, i) => ({ type: d.type === 'playlist' ? 'discover_playlist' : 'discover_radio', inner_block_id: String(i), resources: [{ type: d.type, resource_id: d.item.id.replace(/^radio:/, ''), style: { title: d.item.name, cover_url_list: [d.item.imageUrl] } }] })) }] }
  } })
  assert.deepEqual((await catalog.home()).sections, homePage(discoveries).sections)
})
