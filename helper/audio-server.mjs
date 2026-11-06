// Private, bounded in-memory audio bridge for MyGO's HTTP-only player.
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { error } from './protocol.mjs'

export async function audioServer({ limit = 256 * 1024 * 1024, ttl = 15 * 60 * 1000, now = Date.now } = {}) {
  const entries = new Map()
  let bytes = 0
  let closed = false
  const discard = key => {
    const entry = entries.get(key)
    if (entry) { bytes -= entry.data.length; entries.delete(key) }
  }
  const prune = () => {
    for (const [key, entry] of entries) if (entry.expires <= now()) discard(key)
  }
  const server = http.createServer((req, res) => {
    prune()
    const host = `127.0.0.1:${server.address()?.port}`
    if (closed || req.headers.host !== host || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(403).end(); return
    }
    const entry = entries.get(req.url)
    if (!entry) { res.writeHead(404).end(); return }
    const { data, type } = entry
    const headers = { 'Content-Type': type === 'flac' ? 'audio/flac' : type === 'ogg' ? 'audio/ogg' : 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    let start = 0, end = data.length - 1, status = 200
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
      if (!range || (!range[1] && !range[2])) { res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end(); return }
      if (!range[1]) start = Math.max(0, data.length - Number(range[2]))
      else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])) }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= data.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end(); return
      }
      status = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`
    }
    headers['Content-Length'] = end - start + 1
    res.writeHead(status, headers)
    res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1))
  })
  server.requestTimeout = 10000
  server.headersTimeout = 10000
  server.maxConnections = 8
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    add(stream) {
      prune()
      if (closed || !Buffer.isBuffer(stream.data) || !stream.data.length || stream.data.length > limit || !['flac', 'mp3', 'ogg'].includes(stream.type)) throw error('unavailable')
      while (bytes + stream.data.length > limit || entries.size >= 5) discard(entries.keys().next().value)
      const key = '/' + randomBytes(24).toString('hex')
      entries.set(key, { data: stream.data, type: stream.type, expires: now() + ttl })
      bytes += stream.data.length
      const { data, ...metadata } = stream
      return { ...metadata, url: `http://127.0.0.1:${server.address().port}${key}`, size: data.length }
    },
    async close() {
      closed = true
      entries.clear()
      bytes = 0
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
