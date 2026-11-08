import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sandbox, session, profile, profileReply, json, until } from './fixtures/plugin-sandbox.mjs'

// The account menu opens the current account's library without starting a native helper.
test('restored account exposes its own profile with owned and saved playlists', async () => {
  const s = await sandbox([], session, { allowSpawn: false, replies: [profileReply()], request: (url, opts) => {
    if (new URL(url).pathname !== '/luna/pc/me/playlist') return
    assert.equal(opts.method, 'GET')
    return json({ playlists: [
      { id: '11', title: 'Owned', owner: { id: profile.id }, type: 2 },
      { id: '12', title: 'Saved', owner: { id: '999' }, state: { is_collected: true } },
    ], has_more: false })
  } })
  const account = await s.api.account()
  assert.equal(account.page, 'my-library')
  const page = await s.api.browse({ page: account.page })
  assert.equal(page.title, profile.name)
  assert.equal(page.sections[0].playlists[0].id, '11')
  assert.equal(page.sections[1].playlists[0].id, '12')
  assert.equal(s.spawned(), 0)
  await s.api.signOut()
  await assert.rejects(s.api.browse({ page: 'my-library' }), err => err.code === 'signIn')
})

// A library response arriving after sign-out must not display the previous account's lists.
test('late profile result is discarded after sign-out', async () => {
  let release, started = false
  const s = await sandbox([], { ...session, account: profile }, { allowSpawn: false, request: () => {
    started = true
    return new Promise(resolve => { release = () => resolve(json({ playlists: [], has_more: false })) })
  } })
  const pending = s.api.browse({ page: 'my-library' })
  await until(() => started)
  await s.api.signOut()
  release()
  await assert.rejects(pending, err => err.code === 'signIn')
})
