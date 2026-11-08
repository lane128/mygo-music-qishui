// Music operations use private JSON-line pipe messages. Login runs in MyGO's sandbox.
import readline from 'node:readline'
import { error } from './protocol.mjs'
import { validateSession, libraryWritePaths } from './catalog-core.mjs'
import { signRequest } from './native.mjs'
import { audioServer } from './audio-server.mjs'

const send = frame => process.stdout.write(JSON.stringify(frame) + '\n')
const controller = new AbortController()
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let ended = false
let music = false
let audio
const stop = () => {
  if (ended) return
  ended = true
  controller.abort()
  lines.close()
  process.stdin.destroy()
  audio?.close().catch(() => {})
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
lines.on('close', stop)
const idle = setTimeout(stop, 40000)
try {
  for await (const line of lines) {
    if (ended) break
    try {
      if (line.length > 131072) throw error('response')
      const spec = JSON.parse(line)
      if (spec.op !== 'music') throw error('response')
      music = true
      clearTimeout(idle)
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(24000)])
      validateSession(spec.session)
      const params = spec.params || {}
      let result
      switch (spec.method) {
        case 'sign': {
          const url = new URL(params.url)
          const paths = ['/luna/pc/me/recently-played-media', '/luna/pc/feed/mode', '/luna/pc/feed/song-tab', '/luna/pc/discover', '/luna/pc/discover/mix', '/luna/pc/feed/radio/tracks', '/luna/pc/track_v2', '/luna/pc/comments', '/luna/pc/me/playlist', ...libraryWritePaths]
          if (url.origin !== 'https://api.qishui.com' || url.username || url['pass' + 'word'] || url.hash || !paths.includes(url.pathname) || params.did !== spec.session.deviceID || url.searchParams.get('device_id') !== params.did) throw error('response')
          if (!params.headers || Object.keys(params.headers).length > 64 || Object.entries(params.headers).some(([key, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value))) throw error('response')
          result = await signRequest({ url: url.href, headers: params.headers, did: params.did, signal })
          break
        }
        case 'stream': {
          const { resolvePlayback } = await import('./playback.mjs')
          const stream = await resolvePlayback(spec.session, params, { signal })
          if (ended) break
          audio ||= await audioServer()
          result = audio.add(stream)
          break
        }
        default: throw error('unsupported')
      }
      if (!ended) send({ ok: true, result })
    } catch (err) {
      if (!ended) send({ ok: false, error: ['setup', 'rateLimit', 'verify', 'expired', 'rejected', 'session', 'network', 'response', 'unsupported', 'unavailable', 'preview'].includes(err.kind) ? err.kind : 'response' })
      if (!music) break
    }
  }
} finally {
  clearTimeout(idle)
  stop()
}
