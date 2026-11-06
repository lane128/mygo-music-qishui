// MyGO supports file:// cover images. Resolve bundled opaque artwork relative
// to the installed plugin, so white provider icons remain visible in both themes.
import { existsSync, readFileSync } from 'node:fs'
import { sceneCategory } from './scene-pages.mjs'

const root = new URL('../assets/scene-covers/', import.meta.url)
let covers = {}
try {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'))
  if (manifest.version === 1 && manifest.covers && typeof manifest.covers === 'object' && !Array.isArray(manifest.covers)) covers = manifest.covers
} catch { /* Older/source-only layouts can still use the provider's image. */ }

export function sceneCover(mode) {
  const name = covers[mode.id] || covers['category:' + sceneCategory(mode)]
  if (typeof name === 'string' && /^[a-f0-9]{20}\.png$/.test(name)) {
    const url = new URL(name, root)
    if (existsSync(url)) return url.href
  }
  return mode.imageUrl
}
