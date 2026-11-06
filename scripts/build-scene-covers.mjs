// Optional artwork rebuild: node scripts/build-scene-covers.mjs PUBLIC_MODE_JSON NEW_OUTPUT_DIR
// The input is an anonymous feed/mode response, never account/session storage.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { image } from '../helper/catalog.mjs'
import { modesOf } from '../helper/discovery.mjs'
import { sceneCategory } from '../helper/scene-pages.mjs'
import { parseJSON } from '../helper/protocol.mjs'

if (!process.argv[2] || !process.argv[3]) throw new Error('Provide public mode JSON and a new output directory.')
const modes = modesOf(parseJSON(await readFile(path.resolve(process.argv[2]), 'utf8')), raw => image(raw, '~c5_300x300.jpg'))
if (modes.length > 200) throw new Error('Unexpected scene count.')
const output = path.resolve(process.argv[3])
await mkdir(path.dirname(output), { recursive: true })
await mkdir(output) // Refuse to overwrite existing artwork.
const scratch = await mkdtemp(path.join(tmpdir(), 'qishui-scene-art-'))
const palettes = {
  focus: ['0F766E', '164E63'], mood: ['BE425F', '7E2649'], activity: ['315EAD', '243B77'],
  styles: ['7945B4', '44246B'], voices: ['AC6A28', '6A3D1B'], other: ['466C78', '283E4D'],
}
const covers = {}
const jobs = []
try {
  for (const mode of modes) {
    const category = sceneCategory(mode)
    const name = createHash('sha256').update(mode.id).digest('hex').slice(0, 20) + '.png'
    const job = { output: path.join(output, name), colors: palettes[category] }
    if (mode.id === 'preference:familiar' || mode.id === 'preference:fresh') {
      job.kind = mode.id.slice(11)
      job.colors = job.kind === 'familiar' ? ['BD596A', '853E60'] : ['147D91', '24588D']
    } else if (mode.imageUrl) {
      const url = new URL(mode.imageUrl)
      if (url.protocol !== 'https:' || !/(^|\.)douyinpic\.com$/.test(url.hostname) || url.port || url.username || url.password) throw new Error('Unexpected scene image origin.')
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) })
      if (!response.ok) throw new Error('Could not retrieve a scene icon.')
      const chunks = []; let bytes = 0
      for await (const chunk of response.body) {
        bytes += chunk.length
        if (bytes > 4194304) throw new Error('Scene icon exceeded the size limit.')
        chunks.push(chunk)
      }
      job.input = path.join(scratch, name)
      await writeFile(job.input, Buffer.concat(chunks), { flag: 'wx' })
    }
    covers[mode.id] = name
    if (!mode.id.startsWith('preference:') && !covers['category:' + category]) covers['category:' + category] = name
    jobs.push(job)
  }
  const jobsFile = path.join(scratch, 'jobs.json')
  await writeFile(jobsFile, JSON.stringify(jobs), { flag: 'wx' })
  const result = spawnSync('/usr/bin/swift', [fileURLToPath(new URL('./render-scene-covers.swift', import.meta.url)), jobsFile], { stdio: 'inherit', timeout: 60000 })
  if (result.error || result.status !== 0) throw new Error('Scene artwork rendering failed.')
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ version: 1, covers }, null, 2) + '\n', { flag: 'wx' })
  console.log(`Generated ${jobs.length} opaque scene covers.`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
