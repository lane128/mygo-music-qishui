// Generate native UI test input from the actual standalone plugin and generated
// upstream JSON. No network, installed account storage or external process is used.
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sandbox, session } from '../test/fixtures/plugin-sandbox.mjs'
import { catalogService, discovery, modes, feed, track } from '../test/fixtures/catalog-service.mjs'

const output = process.argv[2]
if (!output || !path.isAbsolute(output)) throw Error('Provide a new empty absolute output directory.')
await mkdir(output, { recursive: true })
if ((await readdir(output)).length) throw Error('Fixture output directory must be empty.')
const discovered = (ids, options) => {
  const raw = discovery(ids, options)
  const cards = raw.inner_block || raw.blocks[0].inner_block
  for (const card of cards) card.resources[0].style.title = '示例电台 ' + card.inner_block_id
  return raw
}
const modeReply = () => {
  const reply = modes(9)
  // Keep one official scene and both preferences without covers to exercise
  // host defaults; the remaining URLs are synthetic remote image identities.
  for (const entry of reply.feed_mode_block[0].feed_mode.slice(1)) entry.url_info = 'https://example.invalid/mode-' + entry.entity.feed_scene_mode.scene_mode_id + '.jpg'
  return reply
}
const service = catalogService({
  modes: [modeReply(), modeReply(), modeReply()],
  discover: [discovered(Array.from({ length: 15 }, (_, i) => String(100 + i))), discovered(['42', '43', '44', '45'])],
  mix: [discovered(['46', '47'], { initial: false, more: false })],
  // More than two queued tracks keeps this click fixture above MyGO's
  // background refill threshold; continuation itself has separate regressions.
  feed: [feed(Array.from({ length: 4 }, (_, i) => track(String(91 + i), 180000)))],
})
const s = await sandbox([], session, { sign: true, request: service.request })
try {
  const home = await s.api.home()
  const landing = await s.api.browse({ page: 'listening-modes' })
  const more = landing.sections.at(-1).links[0].page
  const pages = { home, 'listening-modes': landing, [more]: await s.api.browse({ page: more }), 'scene-modes': await s.api.browse({ page: 'scene-modes' }) }
  const stations = await s.api.stations()
  const tracks = await s.api.stationNext({ id: 'recommendations' })
  const covers = {}
  const urls = new Set()
  for (const page of Object.values(pages)) for (const section of page.sections || []) {
    for (const item of [...(section.stations || []), ...(section.playlists || [])]) if (item.imageUrl) urls.add(item.imageUrl)
  }
  for (const station of stations) if (station.imageUrl) urls.add(station.imageUrl)
  // The Go UI fixture supplies in-memory test pixels for these URLs. No cover
  // files are copied, fetched or shipped; absent URLs retain the host fallback.
  for (const url of urls) covers[url] = ''
  await writeFile(path.join(output, 'fixture.json'), JSON.stringify({ pages, covers, stations, tracks }))
  console.log(path.join(output, 'fixture.json'))
} finally { await s.api.signOut() }
