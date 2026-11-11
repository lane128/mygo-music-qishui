import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readComments, likeComment, postComment } from '../helper/comments.mjs'

const account = { name: 'Fixture listener', imageUrl: 'https://images.example.test/listener.jpg' }
const row = (id, extra = {}) => ({ id, content: 'Fixture comment ' + id, user: { nickname: 'Fixture author' }, ...extra })
const read = (request, options = {}) => readComments(request, { trackId: '123', state: new Map(), ...options })
const post = (request, options = {}) => postComment(request, { trackId: '123', text: 'Fixture text', account, ...options })

test('requests signed official comment GET and maps artist, listener, and optional metadata', async () => {
  const page = await read(async (path, options) => {
    assert.equal(path, '/luna/pc/comments')
    assert.deepEqual(options, { signed: true, query: { group_id: '123', group_type: 0, cursor: '', count: 20, image_strategy: 2 } })
    return { count: '42', comments: [
      row('7123456789012345678', { count_digged: '3', time_created: 1710000000, user_digged: true,
        user_artist_info: { artist_brief: { name: 'Fixture artist', url_avatar: 'https://images.example.test/artist.jpg' } } }),
      row(2, { user: { nickname: 'Fixture listener', thumb_avatar_url: { urls: ['http://images.example.test/unsafe', 'https://images.example.test/avatar'], uri: 'listener' } }, count_digged: 0, user_digged: false, time_created: 0 }),
      row('3', { user: { nickname: 'Unsafe avatar', url_avatar: 'javascript:fixture' } }),
      row('4', { user: {}, user_artist_info: { artist_brief: { name: '' } } }),
    ] }
  })
  assert.deepEqual(page, { comments: [
    { id: '7123456789012345678', author: 'Fixture artist', avatarUrl: 'https://images.example.test/artist.jpg', text: 'Fixture comment 7123456789012345678', likes: 3, time: 1710000000000, liked: true },
    { id: '2', author: 'Fixture listener', avatarUrl: 'https://images.example.test/avatar/listener~c5_%7Bsize%7Dx%7Bsize%7D.jpg', text: 'Fixture comment 2', likes: 0, time: 0, liked: false },
    { id: '3', author: 'Unsafe avatar', text: 'Fixture comment 3' },
    { id: '4', author: '汽水音乐用户', text: 'Fixture comment 4' },
  ], total: 42, more: false })
})

test('uses the avatar belonging to the selected artist author', async () => {
  const page = await read(async () => ({ comments: [row('1', {
    user: { nickname: 'Listener', url_avatar: 'https://images.example.test/listener.jpg' },
    user_artist_info: { artist_brief: { name: 'Artist', thumb_avatar_url: { urls: ['https://images.example.test/img/'], uri: 'artist', template_prefix: 'avatar' } } },
  })] }))
  assert.equal(page.comments[0].avatarUrl, 'https://images.example.test/img/artist~avatar-crop-center:%7Bsize%7D:%7Bsize%7D.jpg')
})

test('preserves complete comment avatar paths and query bytes from image_strategy=2', async () => {
  const complete = 'https://images.example.test/aweme/100x100/listener.jpeg?from=fixture&size=100%2f100+small&size=original'
  const values = [
    { uri: 'listener', urls: [complete], need_complete_url: true },
    { uri: 'opaque-image-id', urls: [complete], need_complete_url: true, template_prefix: 'avatar' },
    { urls: [complete] },
    { uri: 'listener', urls: [complete] },
    { uri: 'listener', urls: [complete], template_prefix: 'avatar' },
    complete,
  ]
  const page = await read(async () => ({ comments: values.map((value, index) => row(String(index + 1), {
    user: { nickname: 'Listener', thumb_avatar_url: value },
  })) }))
  for (const comment of page.comments) assert.equal(comment.avatarUrl, complete)
})

test('skips invalid avatar candidates and keeps the returned CDN for prefix images', async () => {
  const page = await read(async () => ({ comments: [
    row('1', { user: { thumb_avatar_url: { urls: ['invalid', 'http://images.example.test/no', 'https://other.example.test/img/'], uri: 'listener', template_prefix: 'avatar' } } }),
    row('2', { user: { thumb_avatar_url: { urls: ['javascript:fixture', 'https://other.example.test/listener.jpeg?from=fixture'], uri: 'listener', need_complete_url: true } } }),
    row('3', { user: { thumb_avatar_url: { urls: ['http://images.example.test/no'], uri: 'listener', template_prefix: 'avatar' } } }),
  ] }))
  assert.equal(page.comments[0].avatarUrl, 'https://other.example.test/img/listener~avatar-crop-center:%7Bsize%7D:%7Bsize%7D.jpg')
  assert.equal(page.comments[1].avatarUrl, 'https://other.example.test/listener.jpeg?from=fixture')
  assert.equal(page.comments[2].avatarUrl, undefined)
})

test('does not borrow a listener avatar when the selected artist has no usable image', async () => {
  const page = await read(async () => ({ comments: [row('1', {
    user: { nickname: 'Listener', url_avatar: 'https://images.example.test/listener.jpg' },
    user_artist_info: { artist_brief: { name: 'Artist', thumb_avatar_url: { uri: 'artist', template_prefix: 'avatar' } } },
  })] }))
  assert.equal(page.comments[0].author, 'Artist')
  assert.equal(page.comments[0].avatarUrl, undefined)
})

test('offset counts unique displayed comments and advances past duplicate and empty more pages', async () => {
  const state = new Map(), calls = []
  const pages = new Map([
    ['', { comments: [row('1'), row('1'), row('2')], count: 6, cursor: 'opaque+/a', has_more: true }],
    ['opaque+/a', { comments: [row('2')], cursor: 'b', has_more: true }],
    ['b', { comments: [], cursor: 'c', has_more: true }],
    ['c', { comments: [row('2'), row('3'), row('4')], cursor: 'ignored-terminal', has_more: false }],
  ])
  const request = async (_, { query }) => { calls.push(query.cursor); return pages.get(query.cursor) }
  assert.deepEqual((await read(request, { state })).comments.map(c => c.id), ['1', '2'])
  const page = await read(request, { state, offset: 2 })
  assert.deepEqual(page.comments.map(c => c.id), ['3', '4'])
  assert.equal(page.total, 6)
  assert.equal(page.more, false)
  assert.deepEqual(calls, ['', 'opaque+/a', 'b', 'c'])
  page.comments[0].text = 'Caller mutation'
  assert.equal((await read(request, { state, offset: 2 })).comments[0].text, 'Fixture comment 3')
  assert.deepEqual((await read(request, { state, offset: 4 })).comments, [])
  assert.equal(calls.length, 4, 'cached offsets do not repeat requests')
})

test('reconstructs a unique offset after cache loss and refreshes offset zero', async () => {
  const state = new Map(), calls = []
  const request = async (_, { query }) => {
    calls.push(query.cursor)
    return query.cursor === '' ? { comments: [row('1'), row('2')], cursor: 'next', has_more: true }
      : { comments: [row('2'), row('3')], has_more: false }
  }
  assert.deepEqual((await read(request, { state, offset: 2 })).comments.map(c => c.id), ['3'])
  assert.deepEqual(calls, ['', 'next'])
  assert.deepEqual((await read(request, { state })).comments.map(c => c.id), ['1', '2'])
  assert.deepEqual(calls, ['', 'next', ''])
})

test('has_more absent means false even when the response has a cursor', async () => {
  assert.deepEqual(await read(async () => ({ comments: [], cursor: 'not-an-invitation' })), { comments: [], total: 0, more: false })
  assert.deepEqual(await read(async () => ({})), { comments: [], total: 0, more: false })
})

test('rejects repeated, missing, and cyclic cursors without corrupting a cached page', async () => {
  for (const cursor of [undefined, '', '\n', 'x'.repeat(8193)]) {
    await assert.rejects(read(async () => ({ comments: [row('1')], has_more: true, cursor })), { kind: 'response' })
  }
  const state = new Map()
  const initial = await read(async () => ({ comments: [row('1')], has_more: true, cursor: 'a' }), { state })
  let calls = 0
  await assert.rejects(read(async () => ({ comments: [], has_more: true, cursor: ++calls === 1 ? 'b' : 'a' }), { state, offset: 1 }), { kind: 'response' })
  assert.equal(calls, 2)
  const retry = await read(async (_, { query }) => {
    assert.equal(query.cursor, 'a')
    return { comments: [row('2')], has_more: false }
  }, { state, offset: initial.comments.length })
  assert.deepEqual(retry.comments.map(c => c.id), ['2'])
})

test('bounds empty pagination with an explicit error and bounds track cache by eviction', async () => {
  let calls = 0
  await assert.rejects(read(async () => ({ comments: [], has_more: true, cursor: 'page-' + ++calls })), { kind: 'response' })
  assert.equal(calls, 128)
  const state = new Map()
  for (let track = 1; track <= 9; track++) await read(async () => ({ comments: [row('1')] }), { state, trackId: String(track) })
  assert.equal(state.size, 8)
  assert.equal(state.has('1'), false)
  assert.equal(state.has('9'), true)
})

test('caps a long sequence of nonempty pages instead of presenting a truncated ending', async () => {
  const state = new Map()
  let calls = 0
  const request = async () => ({ comments: [row(String(++calls))], has_more: true, cursor: 'page-' + calls })
  for (let offset = 0; offset < 128; offset++) {
    const page = await read(request, { state, offset })
    assert.equal(page.more, true)
    assert.equal(page.comments[0].id, String(offset + 1))
  }
  await assert.rejects(read(request, { state, offset: 128 }), { kind: 'response' })
  assert.equal(calls, 128)
})

test('rejects malformed response fields, imprecise IDs and oversized pages', async () => {
  for (const response of [null, [], { comments: {} }, { comments: [row('bad')] }, { comments: [row(Number.MAX_SAFE_INTEGER + 1)] },
    { comments: [row('1', { content: null })] }, { comments: [row('1', { count_digged: -1 })] },
    { comments: [row('1', { time_created: Number.MAX_SAFE_INTEGER })] }, { comments: [row('1', { user_digged: 1 })] },
    { comments: [], count: 'invalid' }, { comments: [], has_more: 'true' }, { comments: Array.from({ length: 21 }, () => row('1')) },
  ]) await assert.rejects(read(async () => response), { kind: 'response' })
})

test('validates input IDs, offsets and booleans before sending requests', async () => {
  const request = async () => assert.fail('invalid input reached request')
  for (const trackId of [123, '', 'x', '1'.repeat(33), '12\n']) {
    await assert.rejects(read(request, { trackId }), { kind: 'response' })
    await assert.rejects(post(request, { trackId }), { kind: 'response' })
    await assert.rejects(likeComment(request, { trackId, commentId: '1', on: true }), { kind: 'response' })
  }
  for (const offset of [-1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(read(request, { offset }), { kind: 'response' })
  await assert.rejects(read(request, { state: {} }), { kind: 'response' })
  for (const commentId of ['', 1, 'x', '1'.repeat(33)]) await assert.rejects(likeComment(request, { trackId: '1', commentId, on: true }), { kind: 'response' })
  for (const on of [0, 1, 'true', null, undefined]) await assert.rejects(likeComment(request, { trackId: '1', commentId: '2', on }), { kind: 'response' })
})

test('sends official like and undo bodies with strict action types', async () => {
  for (const on of [true, false]) {
    let calls = 0
    await likeComment(async (path, options) => {
      calls++
      assert.equal(path, '/luna/pc/comments/action')
      assert.deepEqual(options, { signed: true, body: { comment_id: '2', reply_id: '', group_id: '123', type: on ? 1 : 3, scene_name: 'comment_detail' } })
      return {}
    }, { trackId: '123', commentId: '2', on })
    assert.equal(calls, 1)
  }
})

test('posts the official normalized body once and returns only known created fields', async () => {
  let calls = 0
  const result = await post(async (path, options) => {
    calls++
    assert.equal(path, '/luna/pc/comments/create')
    assert.deepEqual(options, { signed: true, body: { group_id: '123', group_type: 0, comment_type: 0, text: 'First\nSecond', hashtags: [], reply_id: '', reply_to_reply_id: '', reply_to_user_id: '', text_extra: [] } })
    return { created_comment: '7123456789012345678' }
  }, { text: '  First\n\n\nSecond  ' })
  assert.deepEqual(result, { id: '7123456789012345678', author: account.name, avatarUrl: account.imageUrl, text: 'First\nSecond' })
  assert.equal(calls, 1)
})

test('requires a real returned ID and never retries an ambiguous write', async () => {
  for (const response of [{}, { created_comment: '' }, { created_comment: 0 }, { created_comment: '0' }, { created_comment: '000' }, { created_comment: {} }, { created_comment: { id: '123' } }, { created_comment: 'invalid' }, { created_comment: Number.MAX_SAFE_INTEGER + 1 }]) {
    let calls = 0
    await assert.rejects(post(async () => { calls++; return response }), { kind: 'response' })
    assert.equal(calls, 1)
  }
})

test('validates author and text before posting, with no profile request after success', async () => {
  for (const account of [undefined, null, {}, { name: '' }, { name: ' ' }, { name: 'A', imageUrl: 'http://images.example.test/unsafe' }, { name: 'A', imageUrl: { urls: ['https://images.example.test/a'] } }]) {
    await assert.rejects(post(async () => assert.fail('invalid account reached request'), { account }), { kind: 'session' })
  }
  for (const text of ['', '  \n ', null, 'a'.repeat(281), 'a\u0000b']) await assert.rejects(post(async () => assert.fail('invalid text reached request'), { text }), { kind: 'response' })
  const mutable = { name: 'Known author' }
  const created = await post(async () => { mutable.name = ''; return { created_comment: 123 } }, { account: mutable })
  assert.deepEqual(created, { id: '123', author: 'Known author', text: 'Fixture text' })
})

test('counts emoji, combining marks, ZWJ families, and regional flags as graphemes with Intl', async () => {
  for (const cluster of ['😀', 'é', '👨‍👩‍👧‍👦', '🇨🇳']) {
    const text = cluster.repeat(280)
    assert.equal((await post(async () => ({ created_comment: '1' }), { text })).text, text)
    await assert.rejects(post(async () => assert.fail('281 graphemes reached request'), { text: cluster.repeat(281) }), { kind: 'response' })
  }
})

test('works without Intl or Segmenter using a conservative codepoint upper bound', async () => {
  const original = globalThis.Intl
  try {
    for (const replacement of [undefined, {}]) {
      globalThis.Intl = replacement
      for (const text of ['a'.repeat(280), '😀'.repeat(280), 'é', '👨‍👩‍👧‍👦', '🇨🇳']) {
        assert.equal((await post(async () => ({ created_comment: '1' }), { text })).text, text)
      }
      for (const text of ['a'.repeat(281), '😀'.repeat(281), 'é'.repeat(141), '👨‍👩‍👧‍👦'.repeat(41), '🇨🇳'.repeat(141)]) {
        await assert.rejects(post(async () => assert.fail('fallback over-bound text reached request'), { text }), { kind: 'response' })
      }
    }
  } finally { globalThis.Intl = original }
})

test('returns only fixed protocol errors without raw request messages or retries', async () => {
  for (const operation of [request => read(request), request => post(request), request => likeComment(request, { trackId: '123', commentId: '1', on: true })]) {
    for (const kind of ['session', 'rateLimit', 'rejected', 'network', 'untrusted-kind']) {
      let calls = 0
      await assert.rejects(operation(async () => { calls++; throw Object.assign(new Error('untrusted upstream details'), { kind }) }), err => {
        assert.equal(err.kind, kind === 'untrusted-kind' ? 'network' : kind)
        assert.equal(err.message, err.kind)
        return true
      })
      assert.equal(calls, 1)
    }
  }
})
