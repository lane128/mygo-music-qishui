import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { libraryWritePaths } from '../../helper/catalog-core.mjs'

export const paths = {
  playlists: '/luna/pc/me/playlist', playlist: '/luna/pc/playlist/detail', history: '/luna/pc/me/recently-played-media',
  artist: '/luna/pc/artists/92', search: '/luna/search/track', modes: '/luna/pc/feed/mode', feed: '/luna/pc/feed/song-tab',
  discover: '/luna/pc/discover', mix: '/luna/pc/discover/mix', radio: '/luna/pc/feed/radio/tracks', lyrics: '/luna/h5/seo_track',
}
const signed = new Set(['history', 'modes', 'feed', 'discover', 'mix', 'radio'].map(name => paths[name]))
const known = new Set(Object.values(paths))
export const track = (id, duration = 1000) => ({ id: String(id), name: 'Fixture Song', duration, artists: [{ id: '22', name: 'Artist' }], album: { id: '33', name: 'Album' } })
export const resource = raw => ({ type: 'track', entity: { track_wrapper: { track: raw } } })
export const feed = (tracks = [], extra = {}) => ({ items: tracks.map(resource), ...extra })
export const playlist = (id = '123', tracks = []) => ({ playlist: { id, title: 'Fixture Playlist', count_tracks: tracks.length }, media_resources: tracks.map(resource), has_more: false })
export const search = (tracks, cursor, more = false) => ({ result_groups: [{ data: tracks.map(raw => ({ entity: { track: raw } })), has_more: more, ...(cursor == null ? {} : { next_cursor: cursor }) }] })
export const modes = (count = 0) => ({ feed_mode_block: [{ title: '心情', feed_mode: Array.from({ length: count }, (_, id) => ({ type: 'scene_mode', text: `Fixture Mode ${id}`, entity: { feed_scene_mode: { scene_mode_id: id } } })) }] })
export const card = (id, type = 'radio') => ({ type: type === 'radio' ? 'discover_radio' : 'discover_playlist', inner_block_id: String(id), resources: [{ type, resource_id: String(id), style: { title: 'Fixture ' + type, cover_url_list: ['https://example.invalid/cover.jpg'] } }] })
export const discovery = (ids, { initial = true, more = true, cursor, sessionID, type = 'radio' } = {}) => ({
  ...(initial ? { blocks: [{ type: 'discover_playlist_mix', inner_block: ids.map(id => card(id, type)) }] } : { inner_block: ids.map(id => card(id, type)) }),
  has_more: more, ...(cursor == null ? {} : { next_cursor: cursor }), ...(sessionID == null ? {} : { session_id: sessionID }),
})

// Replace only the network boundary. Values are real remote JSON schemas, never mapped Catalog results.
export function catalogService(routes, { platform = 'mac' } = {}) {
  const calls = []
  const queues = new Map(Object.entries(routes).map(([name, replies]) => [paths[name] || name, [...replies]]))
  const request = async (url, options) => {
    const parsed = new URL(url)
    const artist = /^\/luna\/pc\/(?:artists\/\d{1,32}(?:\/(?:tracks|albums))?|albums\/\d{1,32}|search\/(?:artist|album|playlist)|sug)$/.test(parsed.pathname)
    if (!known.has(parsed.pathname) && !artist && !queues.has(parsed.pathname)) return undefined // Authentication uses the sandbox's independent reply queue.
    const call = { url, parsed, options, body: options.body == null ? undefined : JSON.parse(options.body) }
    calls.push(call)
    assert.equal(options.redirect, 'error')
    assert.equal(parsed.hostname, parsed.pathname === paths.lyrics ? 'beta-luna.douyin.com' : 'api.qishui.com')
    if (parsed.pathname === paths.lyrics || artist) assert.equal(options.headers.Cookie, undefined)
    else assert.ok(options.headers.Cookie?.startsWith('sessionid='))
    if (signed.has(parsed.pathname) || libraryWritePaths.includes(parsed.pathname) || parsed.pathname === '/luna/pc/comments' || (parsed.pathname === paths.playlists && (options.body != null || options.headers['x-helios'] != null))) {
      assert.equal(options.headers['x-helios'], 'fixture-helios')
      assert.equal(options.headers['x-medusa'], 'fixture-medusa')
      assert.equal(parsed.searchParams.get('device_platform'), platform)
      assert.equal(parsed.searchParams.get('version_name'), '3.7.0')
      assert.equal(options.method, options.body == null ? 'GET' : 'POST')
      assert.equal(options.headers['X-SS-STUB'], options.body == null ? undefined : createHash('md5').update(options.body).digest('hex').toUpperCase())
    } else {
      assert.equal(options.headers['x-helios'], undefined)
      assert.equal(options.headers['x-medusa'], undefined)
      if (artist) {
        assert.equal(options.method, 'GET')
        assert.equal(options.body, undefined)
        assert.equal(parsed.searchParams.get('device_platform'), platform)
        assert.equal(parsed.searchParams.get('version_name'), '3.7.0')
      }
    }
    const queue = queues.get(parsed.pathname)
    assert.ok(queue?.length, 'unexpected catalog request: ' + parsed.pathname)
    const next = queue.shift()
    const value = typeof next === 'function' ? await next(call) : next
    return value instanceof Response ? value : new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  }
  return { request, calls, for: name => calls.filter(call => call.parsed.pathname === paths[name]) }
}

export function assertSigner(call, name, saved) {
  assert.equal(call.op, 'music')
  assert.equal(call.method, 'sign')
  assert.equal(new URL(call.params.url).pathname, paths[name])
  assert.equal(call.params.did, saved.deviceID)
  assert.equal(call.session.deviceID, saved.deviceID)
  assert.equal(call.params.body, undefined)
}
export const stale = error => error.code === 'signIn' || error.kind === 'cancelled' || error.code === 'cancelled'
