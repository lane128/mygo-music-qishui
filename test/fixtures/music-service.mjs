// Test-only replacement of remote services; production worker code is unchanged.
import assert from 'node:assert/strict'
import https from 'node:https'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

const id = '7123456789012345678'
const track = { id, name: 'Fixture Song', duration: 180000, artists: [{ id: '22', name: 'Artist' }], album: { id: '33', name: 'Album' } }
const playlist = { id: '123', title: 'Fixture Playlist', count_tracks: 1 }
const json = value => new Response(JSON.stringify(value))
globalThis.fetch = async (url, options) => {
  const parsed = new URL(url)
  assert.equal(options.redirect, 'error')
  if (parsed.hostname === 'beta-luna.douyin.com') {
    assert.equal(options.headers.Cookie, undefined)
    return json({ seo_track: { track }, lyric: { content: '[1000,2000]<0,1000,0>歌词' } })
  }
  assert.equal(parsed.hostname, 'api.qishui.com')
  assert.equal(options.headers.Cookie, ['sessionid', 'fixture-session'].join('='))
  if (parsed.pathname === '/luna/pc/me') return json({ my_info: { id: '123', nickname: 'Fixture account', is_vip: true, vip_stage: 'svip' } })
  if (parsed.pathname === '/luna/pc/me/playlist') return json({ playlists: Array.from({ length: 7 }, (_, i) => ({ ...playlist, id: String(123 + i), title: `Fixture Playlist ${i}`, count_tracks: i === 1 ? 0 : i === 6 ? 'not-a-count' : 1, ...(i === 0 ? { count_tracks: 0, resource_cnt: { track_cnt: 1 } } : {}), ...(i === 2 ? { resource_cnt: { track_cnt: 2 } } : {}) })) })
  if (parsed.pathname === '/luna/pc/me/recently-played-media') {
    assert.equal(options.method, 'GET')
    assert.equal(options.body, undefined)
    assert.equal(options.headers['X-SS-STUB'], undefined)
    assert.ok(options.headers['x-helios'])
    assert.ok(options.headers['x-medusa'])
    assert.equal(parsed.searchParams.get('count'), '1000')
    assert.equal(parsed.searchParams.get('cursor'), '')
    assert.equal(parsed.searchParams.get('media_type'), '')
    assert.equal(parsed.searchParams.get('scene'), '')
    return json({ media: [{ entity: { track } }, { entity: { track_wrapper: { track: { ...track, id: '2' } } } }, { entity: { video: { video_id: '3' } } }], has_more: false })
  }
  if (parsed.pathname === '/luna/pc/playlist/detail') {
    const playlistID = parsed.searchParams.get('playlist_id')
    if (playlistID === '124') return json({ has_more: false, next_cursor: 0 })
    if (playlistID === '125') return json({ playlist: { ...playlist, id: '125', count_tracks: '1' }, media_resources: [{ entity: { track } }], has_more: false, next_cursor: 0 })
    if (playlistID === 'empty-omitted' || playlistID === 'empty-null' || playlistID === 'empty-string-zero') return json({
      playlist: { id: playlistID, title: 'Empty fixture', count_tracks: playlistID === 'empty-string-zero' ? '0' : 0, desc: 'Empty description', cover_url: 'https://example.invalid/empty.jpg' },
      next_cursor: 0,
      ...(playlistID === 'empty-null' ? { media_resources: null } : {}),
      has_more: false,
    })
    return json({ playlist, media_resources: [{ type: 'track', entity: { track_wrapper: { track } } }], has_more: false })
  }
  if (parsed.pathname === '/luna/search/track') return json({ result_groups: [{ data: [{ entity: { track } }], has_more: false }] })
  if (parsed.pathname === '/luna/pc/feed/mode') {
    assert.ok(options.headers['x-helios'])
    assert.ok(options.headers['x-medusa'])
    assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), {})
    return json({ feed_mode_block: [{ title: '心情', feed_mode: [{ type: 'scene_mode', text: 'Fixture Mode', entity: { feed_scene_mode: { scene_mode_id: 0 } } }] }] })
  }
  if (parsed.pathname === '/luna/pc/discover' || parsed.pathname === '/luna/pc/discover/mix') {
    assert.ok(options.headers['x-helios'])
    assert.ok(options.headers['x-medusa'])
    const initial = parsed.pathname === '/luna/pc/discover'
    const body = JSON.parse(options.body)
    assert.deepEqual(body, initial ? { first_request: true, pc_new_discover_request: true } : { block_type: 'discover_playlist_mix', sub_channel_id: -2, exposure_radio_list: ['42'] })
    const card = { type: 'discover_radio', inner_block_id: initial ? '42' : '43', resources: [{ type: 'radio', resource_id: initial ? '42' : '43', style: { title: 'Fixture Radio', desc: 'Fixture Description', cover_url_list: ['https://example.invalid/radio.jpg'] } }] }
    return json(initial ? { blocks: [{ type: 'discover_playlist_mix', inner_block: [card] }] } : { inner_block: [card], has_more: false })
  }
  if (parsed.pathname === '/luna/pc/feed/radio/tracks') {
    assert.ok(options.headers['x-helios'])
    assert.ok(options.headers['x-medusa'])
    const body = JSON.parse(options.body)
    assert.equal(body.radio_id, '42')
    assert.equal(body.count, 6)
    assert.equal(body.cursor, 'opaque-radio')
    return json({ items: [{ type: 'track', entity: { track_wrapper: { track } } }], has_more: false })
  }
  if (parsed.pathname === '/luna/pc/feed/song-tab') {
    assert.ok(options.headers['x-helios'])
    assert.ok(options.headers['x-medusa'])
    const body = JSON.parse(options.body)
    assert.equal(body.feed_preference.scene_mode_id, 0)
    assert.equal(body.is_did_first_request, false)
    assert.equal(body.did_first_use_time, undefined)
    assert.equal(body.feed_counts.mix_session_count, 2)
    assert.equal(body.played_media[0].played_mills, -1)
    assert.equal(body.played_media[0].duration, 180)
    return json({ items: [{ type: 'track', entity: { track_wrapper: { track } } }] })
  }
  if (parsed.pathname === '/luna/pc/track_v2') {
    assert.ok(options.headers['x-helios'])
    assert.ok(options.headers['x-medusa'])
    assert.equal(parsed.searchParams.get('aid'), '386088')
    assert.equal(parsed.searchParams.get('device_id'), '1234567890123456')
    assert.equal(JSON.parse(options.body).track_id, id)
    return json({ track, track_player: { video_model: { video_duration: 180, video_list: [{ main_url: 'https://fixture.douyinvod.com/audio', video_meta: { codec_type: 'mp3', quality: 'highest', bitrate: 128000, size: 417 } }] } } })
  }
  throw new Error('unexpected fixture request')
}
https.get = (url, options, callback) => {
  const request = new EventEmitter()
  request.destroy = () => {}
  queueMicrotask(() => {
    try {
      assert.equal(url, 'https://fixture.douyinvod.com/audio')
      assert.deepEqual(Object.keys(options.headers).sort(), ['Accept-Encoding', 'User-Agent'])
      const response = Readable.from([Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)])])
      response.statusCode = 200
      response.headers = { 'content-length': '417' }
      response.socket = { authorized: true }
      callback(response)
    } catch (err) { request.emit('error', err) }
  })
  return request
}
