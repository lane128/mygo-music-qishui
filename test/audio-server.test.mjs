import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { audioServer } from '../helper/audio-server.mjs'

// MyGO downloads and seeks through private URLs while the helper retains the audio.
test('serves full audio, HEAD and byte ranges without exposing another resource', async () => {
  const server = await audioServer()
  try {
    const stream = server.add({ data: Buffer.from('fLaCfixture-audio'), type: 'flac', quality: 'high' })
    assert.equal(stream.data, undefined)
    assert.equal(stream.size, 17)
    const full = await fetch(stream.url)
    assert.equal(full.headers.get('content-type'), 'audio/flac')
    assert.equal(await full.text(), 'fLaCfixture-audio')
    const head = await fetch(stream.url, { method: 'HEAD' })
    assert.equal(head.headers.get('content-length'), '17')
    assert.equal(await head.text(), '')
    const partial = await fetch(stream.url, { headers: { Range: 'bytes=4-10' } })
    assert.equal(partial.status, 206)
    assert.equal(partial.headers.get('content-range'), 'bytes 4-10/17')
    assert.equal(await partial.text(), 'fixture')
    assert.equal((await fetch(stream.url, { headers: { Range: 'bytes=100-' } })).status, 416)
    assert.equal((await fetch(stream.url + 'bad')).status, 404)
    assert.equal((await fetch(stream.url, { method: 'POST' })).status, 403)
    const status = await new Promise((resolve, reject) => {
      http.get(stream.url, { headers: { Host: 'evil.invalid' } }, response => {
        response.resume()
        resolve(response.statusCode)
      }).on('error', reject)
    })
    assert.equal(status, 403)
  } finally { await server.close() }
})

// Old audio is bounded in memory and disappears after expiry or sign-out cleanup.
test('evicts bounded buffers, expires grants, and closes the loopback listener', async () => {
  let now = 0
  const server = await audioServer({ limit: 10, ttl: 100, now: () => now })
  const first = server.add({ data: Buffer.from('123456'), type: 'mp3' })
  const second = server.add({ data: Buffer.from('abcdef'), type: 'mp3' })
  assert.equal((await fetch(first.url)).status, 404)
  const suffix = await fetch(second.url, { headers: { Range: 'bytes=-3' } })
  assert.equal(await suffix.text(), 'def')
  now = 101
  assert.equal((await fetch(second.url)).status, 404)
  await server.close()
  await assert.rejects(fetch(second.url))
})
