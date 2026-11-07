import { error } from './protocol.mjs'
import { discoverySection } from './exploration.mjs'

const PREVIEW_SIZE = 15

export function homePage(discoveries) {
  if (!Array.isArray(discoveries)) throw error('response')
  return {
    title: '汽水音乐',
    subtitle: '听点新鲜的，也遇见喜欢的。',
    // Keep the section even for an empty result, so MyGO does not fall back to
    // its personal-library Home. See All still reaches the full discovery page.
    sections: [{
      ...discoverySection(discoveries.slice(0, PREVIEW_SIZE)),
      morePage: 'listening-modes',
    }],
  }
}
