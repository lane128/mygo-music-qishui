// Download verified signer SDK inputs into a new directory. Never executes downloads.
import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'
import { WINDOWS_DOWNLOADS, WINDOWS_FILES, checkDigest, checkWindowsPE } from './runtime-assets.mjs'

const MAX_ARCHIVE = 256 * 1024 * 1024
export function extractSelected(data, distribution) {
  checkDigest(data, distribution.sha256, distribution.url)
  const wanted = distribution.files, result = new Map()
  function save(name, bytes) {
    const target = wanted[name]
    if (!target) return
    if (result.has(target) || bytes.length > 128 * 1024 * 1024) throw new Error('Invalid selected archive member')
    checkDigest(bytes, WINDOWS_FILES[target], target)
    if (/\.(?:exe|dll|node)$/.test(target)) checkWindowsPE(bytes, target)
    result.set(target, bytes)
  }
  if (distribution.type === 'zip') {
    const files = unzipSync(data, { filter: entry => {
      if (!Object.hasOwn(wanted, entry.name)) return false
      if (entry.originalSize > 128 * 1024 * 1024) throw new Error('Oversized runtime archive member')
      return true
    } })
    for (const [name, bytes] of Object.entries(files)) save(name, Buffer.from(bytes))
  } else if (distribution.type === 'tgz') {
    const tar = gunzipSync(data, { maxOutputLength: 512 * 1024 * 1024 })
    for (let at = 0; at + 512 <= tar.length;) {
      const header = tar.subarray(at, at + 512)
      if (header.every(byte => byte === 0)) break
      const field = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0]
      const sizeText = field(124, 12).trim()
      if (!/^[0-7]+$/.test(sizeText)) throw new Error('Invalid runtime TAR size')
      const size = Number.parseInt(sizeText, 8), end = at + 512 + size
      if (!Number.isSafeInteger(size) || end > tar.length) throw new Error('Truncated runtime TAR')
      const prefix = field(345, 155), name = (prefix ? prefix + '/' : '') + field(0, 100)
      if (Object.hasOwn(wanted, name)) {
        if (![0, 48].includes(header[156])) throw new Error('Runtime member is not a regular file')
        save(name, tar.subarray(at + 512, end))
      }
      at = at + 512 + Math.ceil(size / 512) * 512
    }
  } else throw new Error('Unsupported runtime archive')
  if (result.size !== Object.keys(wanted).length) throw new Error('Missing required runtime archive member')
  return result
}

export async function prepareWindows(output, { fetcher = fetch } = {}) {
  if (!output || !path.isAbsolute(output)) throw new Error('Provide a new empty absolute output directory')
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw new Error('Runtime output directory must be empty')
  for (const distribution of WINDOWS_DOWNLOADS) {
    const response = await fetcher(distribution.url, { redirect: 'error', signal: AbortSignal.timeout(120000) })
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_ARCHIVE) throw new Error('Runtime download failed')
    const chunks = []; let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > MAX_ARCHIVE) { await response.body.cancel().catch(() => {}); throw new Error('Runtime download is oversized') }
      chunks.push(chunk)
    }
    const files = extractSelected(Buffer.concat(chunks), distribution)
    for (const [name, bytes] of files) await writeFile(path.join(output, name), bytes, { flag: 'wx' })
  }
  await writeFile(path.join(output, 'SOURCES.json'), JSON.stringify(WINDOWS_DOWNLOADS, null, 2) + '\n', { flag: 'wx' })
  return output
}

const entry = process.argv[1] && await realpath(process.argv[1]).catch(() => null)
if (entry && import.meta.url === pathToFileURL(entry).href) {
  console.log(await prepareWindows(process.argv[2]))
}
