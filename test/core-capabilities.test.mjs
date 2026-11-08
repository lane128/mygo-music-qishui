import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sandbox, session, profile, until } from './fixtures/plugin-sandbox.mjs'
import { catalogService, track, resource, stale } from './fixtures/catalog-service.mjs'
const saved = { ...session, account: profile }
const comment = id => ({ id, content: 'Fixture Comment', user: { nickname: 'Fixture Author' }, count_digged: 3, time_created: 1735689600, user_digged: true })
const own = { id: '94', title: 'Fixture Playlist', type: 2, owner: { id: profile.id }, count_tracks: 1 }
const liked = { ...own, id: '95', title: 'Unrelated name', type: 1 }

// The standalone plugin must sign user reactions and return the real comment ID without an extra profile/read request.
test('comments read, thumb toggles and posting integrate with account-scoped offset cache', async () => {
  const service = catalogService({
    '/luna/pc/comments': [{ comments: [{ ...comment('41'), user: { nickname: 'Fixture Author', thumb_avatar_url: {
      uri: 'listener', urls: ['https://images.example.test/aweme/100x100/listener.jpeg?from=fixture&size=100%2f100+small'], need_complete_url: true,
    } } }], count: '3', cursor: '20', has_more: true }, { comments: [comment('43')], count: '3', has_more: false }],
    '/luna/pc/comments/action': [call => { assert.equal(call.body.type, 3); return {} }, call => { assert.equal(call.body.type, 1); return {} }],
    '/luna/pc/comments/create': [call => { assert.equal(call.body.text, 'Test comment'); return { created_comment: '42' } }],
  })
  const s = await sandbox([], saved, { sign: true, request: service.request })
  try {
    const first = await s.api.comments({ trackId: '91' })
    assert.equal(first.comments[0].avatarUrl, 'https://images.example.test/aweme/100x100/listener.jpeg?from=fixture&size=100%2f100+small')
    assert.equal(first.comments[0].liked, true)
    assert.equal(first.comments[0].likes, 3)
    assert.equal(first.comments[0].time, 1735689600000)
    assert.equal(first.total, 3)
    await s.api.likeComment({ trackId: '91', commentId: '41', on: false })
    await s.api.likeComment({ trackId: '91', commentId: '41', on: true })
    const posted = await s.api.postComment({ trackId: '91', text: '  Test comment  ' })
    assert.equal(posted.id, '42')
    assert.equal(posted.author, profile.name)
    assert.equal(posted.time, undefined)
    const more = await s.api.comments({ trackId: '91', offset: 2 })
    assert.deepEqual(Array.from(more.comments, c => c.id), ['43'])
    assert.equal(more.more, false)
    assert.equal(service.calls.length, 5)
    assert.equal(s.spawned(), 5)
    assert.equal(s.closed(), 5)
  } finally { await s.api.signOut() }
})

// A timed-out comment write is ambiguous and must be sent only once, without any automatic re-read or retry.
test('posting transport failure is sanitized and never retries', async () => {
  let posts = 0
  const s = await sandbox([], saved, { sign: true, request: () => { posts++; throw Error('private write diagnostic') } })
  try {
    await assert.rejects(s.api.postComment({ trackId: '91', text: 'Test' }), e => !e.message.includes('private') && e.message.includes('是否发送成功'))
    assert.equal(posts, 1)
    assert.equal(s.timers.size, 0)
  } finally { await s.api.signOut() }
})

// Signed mutations preserve their endpoint and body; own fixed lists never acquire delete/rename actions.
test('library capabilities map flags and protected playlist operations through the real bundle', async () => {
  const library = { playlists: [own, liked], has_more: false }
  const service = catalogService({
    playlists: [library, library, library, library, call => { assert.equal(call.body.name, 'New'); return { playlist: { id: '96' } } }],
    '/luna/pc/me/collection/media': [call => { assert.equal(call.body.media[0].id, '91'); return {} }],
    '/luna/pc/me/playlist/update': [call => { assert.equal(call.body.name, 'Renamed'); return {} }],
    '/luna/pc/me/playlist/media/append': [call => { assert.equal(call.body.playlist_id, '94'); return {} }],
  })
  const s = await sandbox([], saved, { sign: true, request: service.request })
  try {
    const lists = await s.api.playlists()
    assert.equal(lists[0].mine, true)
    assert.equal(lists[0].fixed, undefined)
    assert.equal(lists[1].fixed, true)
    assert.equal(lists[2].id, 'qishui:history')
    assert.equal(lists[2].mine, true)
    assert.equal(lists[2].fixed, true)
    assert.equal(s.spawned(), 0, 'sidebar must not start helper')
    await s.api.like({ id: '91', on: true })
    await s.api.renamePlaylist({ id: '94', name: 'Renamed' })
    await s.api.addToPlaylist({ id: '94', trackIds: ['91'] })
    await assert.rejects(s.api.deletePlaylist({ id: '95' }), e => e.code === 'unsupported')
    const created = await s.api.createPlaylist({ name: '  New  ' })
    assert.equal(created.id, '96')
    assert.equal(created.name, 'New')
    assert.equal(created.mine, true)
    const count = service.calls.length
    for (const method of ['deletePlaylist', 'renamePlaylist', 'addToPlaylist', 'removeFromPlaylist', 'savePlaylist']) await assert.rejects(s.api[method]({ id: 'qishui:history', name: 'Invalid', trackIds: ['91'], on: true }))
    assert.equal(service.calls.length, count)
  } finally { await s.api.signOut() }
})

// Missing songs can be marked unliked only after every page of the true type-1 list is read.
test('liked and isLiked use the true complete liked playlist', async () => {
  const service = catalogService({
    playlists: [{ playlists: [liked] }, { playlists: [liked] }],
    playlist: [
      { playlist: liked, media_resources: [resource(track('91'))], has_more: true, next_cursor: 'tail' },
      { playlist: liked, media_resources: [resource(track('92'))], has_more: false },
      { playlist: liked, media_resources: [resource(track('91')), resource(track('92'))], has_more: false },
    ],
  })
  const s = await sandbox([], saved, { sign: true, request: service.request })
  try {
    const states = await s.api.isLiked({ ids: ['92', '93'] })
    assert.equal(states['92'], true)
    assert.equal(states['93'], false)
    assert.deepEqual(Array.from((await s.api.liked()).tracks, t => t.id), ['91', '92'])
  } finally { await s.api.signOut() }
})

// Signing out cancels the actual HTTP request and prevents its late comment from entering the next account's cache.
test('late comment response cannot repopulate a replacement account', async () => {
  let finish, signal
  const waiting = new Promise(resolve => { finish = resolve })
  const service = catalogService({ '/luna/pc/comments': [call => { signal = call.options.signal; return waiting }, { comments: [comment('52')], count: 1 }] })
  const s = await sandbox([], saved, { sign: true, request: service.request })
  const loading = s.api.comments({ trackId: '91' }), rejected = assert.rejects(loading, stale)
  await until(() => signal)
  await s.api.signOut()
  s.state.set('session', saved)
  finish({ comments: [comment('41')], count: 1 })
  await rejected
  assert.equal(signal.aborted, true)
  const next = await s.api.comments({ trackId: '91' })
  assert.equal(next.comments[0].id, '52')
  await s.api.signOut()
})
