import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Catalog } from '../helper/catalog.mjs'
import { session, profile } from './fixtures/plugin-sandbox.mjs'
const row = id => ({ id: String(id), content: 'Fixture', user: { nickname: 'Author' }, count_digged: 2, user_digged: false })
const rows = from => Array.from({ length: 20 }, (_, i) => row(from + i))
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

// Posting during a pending next page once lost the local insertion and skipped comment 41 on the following page.
test('serializes page snapshots with successful local comment insertions', async () => {
  const started = gate(), pageDone = gate(), state = {}, saved = { ...session, account: profile }
  let pages = 0, posts = 0
  const request = async (_, path) => {
    if (path.endsWith('/create')) { posts++; return { created_comment: '1000' } }
    if (++pages === 1) return { comments: rows(1), cursor: '20', has_more: true, count: 60 }
    if (pages === 2) { started.resolve(); await pageDone.promise; return { comments: rows(21), cursor: '40', has_more: true, count: 60 } }
    return { comments: rows(41), has_more: false, count: 61 }
  }
  const catalog = () => new Catalog(saved, { request, state })
  await catalog().comments({ trackId: '91' })
  const page = catalog().comments({ trackId: '91', offset: 20 })
  await started.promise
  const posting = catalog().postComment({ trackId: '91', text: 'Posted' })
  await Promise.resolve()
  assert.equal(posts, 0, 'write must wait for the older snapshot')
  pageDone.resolve()
  assert.equal((await page).comments[0].id, '21')
  assert.equal((await posting).id, '1000')
  assert.equal(state.comments.get('91').comments[0].id, '1000')
  const final = await catalog().comments({ trackId: '91', offset: 41 })
  assert.deepEqual(final.comments.map(c => c.id), rows(41).map(c => c.id))
  assert.equal(final.more, false)
  assert.equal(posts, 1)
  assert.equal(state.commentLocks.size, 0)
})

// Account cancellation while a page is loading must stop the queued write before it reaches the service.
test('cancels queued comment writes before dispatch and keeps other songs independent', async () => {
  const started = gate(), pageDone = gate(), controller = new AbortController(), state = {}
  let writes = 0
  const request = async (_, path, opts) => {
    if (path.endsWith('/create')) { writes++; return { created_comment: '1000' } }
    if (opts.query.group_id === '92') return { comments: [], count: 0 }
    started.resolve(); await pageDone.promise
    return { comments: rows(1), count: 20 }
  }
  const catalog = () => new Catalog({ ...session, account: profile }, { request, state, signal: controller.signal })
  const loading = catalog().comments({ trackId: '91' })
  await started.promise
  const posting = catalog().postComment({ trackId: '91', text: 'Do not dispatch' })
  const rejected = assert.rejects(posting, { kind: 'canceled' })
  assert.deepEqual((await catalog().comments({ trackId: '92' })).comments, [])
  controller.abort()
  pageDone.resolve()
  await loading
  await rejected
  assert.equal(writes, 0)
  assert.equal(state.commentLocks.size, 0)
})
