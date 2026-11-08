import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sandbox, session, profile, qrReply, confirmedReply, profileReply } from './fixtures/plugin-sandbox.mjs'
import { catalogService, modes } from './fixtures/catalog-service.mjs'

// Installation paths must never become manufactured file:// cover URLs.
test('Windows drive and UNC plugin paths need no local image files', async () => {
  for (const directory of ['C:\\Users\\测试 #100%\\MyGo Music\\plugins\\qishui', 'D:\\Music\\', '\\\\server\\share\\汽水 #1']) {
    const s = await sandbox([], session, { platform: 'windows', arch: 'amd64', dir: directory, allowSpawn: false,
      request: () => new Response('{"playlists":[]}') })
    const history = (await s.api.playlists())[0]
    assert.equal(history.imageUrl, undefined)
    await s.api.signOut()
  }
})

// Windows must keep the same browser-free authentication and isolated storage.
test('Windows completes, restores and clears QR login without process permission', async () => {
  const options = { platform: 'windows', arch: 'amd64', dir: 'C:\\Users\\测试\\MyGo Music\\plugins\\qishui', allowSpawn: false }
  const s = await sandbox([], undefined, { ...options, replies: [qrReply(), confirmedReply(), profileReply()] })
  assert.equal((await s.api.signIn()).id, profile.id)
  assert.equal(s.spawned(), 0)
  const restored = await sandbox([], s.state.get('session'), { ...options, replies: [profileReply()] })
  assert.equal((await restored.api.account()).id, profile.id)
  await restored.api.signOut(); await s.api.signOut()
  assert.equal(restored.state.has('session'), false)
  assert.equal(restored.spawned(), 0)
})

// The actual bundle must select the Windows signer executable and sign exactly
// the same Windows request that the host subsequently sends.
for (const arch of ['amd64', 'arm64']) test(`Windows signed catalogue uses Windows metadata and the bundled ${arch} helper`, async () => {
  const service = catalogService({ modes: [modes(1)] }, { platform: 'windows' })
  const s = await sandbox([], session, { platform: 'windows', arch, dir: 'C:\\MyGo #1\\plugin', sign: true, request: service.request })
  const stations = await s.api.stations()
  assert.ok(stations.length)
  assert.equal(s.spawned(), 1)
  const request = service.for('modes')[0]
  assert.equal(request.parsed.searchParams.get('device_type'), 'Windows')
  assert.equal(request.parsed.searchParams.get('os_version'), 'Windows 10')
  assert.equal(s.calls[0].params.url, request.url)
  assert.equal(s.calls[0].params.did, session.deviceID)
  assert.equal(s.calls[0].params.headers['x-ss-stub'], request.options.headers['X-SS-STUB'])
  await s.api.signOut()
})
