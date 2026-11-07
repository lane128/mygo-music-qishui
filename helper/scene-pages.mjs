// MyGO owns card dimensions and typography. Keep the eight-mode preview flat;
// the common-mode section's morePage retains access to the complete catalog.
import { error } from './protocol.mjs'
import { discoverySection } from './exploration.mjs'

const station = mode => ({ id: mode.id, name: mode.name, imageUrl: mode.imageUrl })
export function scenePage(modes, page = 'listening-modes', discoveries = []) {
  if (!Array.isArray(modes)) throw error('response')
  if (page === 'scene-modes') {
    return { title: '全部听歌模式', subtitle: '点击模式持续播放', sections: modes.length ? [{ stations: modes.map(station) }] : [] }
  }
  if (page !== 'listening-modes') throw error('unsupported')
  return { title: '听歌模式', subtitle: '选择常用模式，或用图片发现更多音乐', sections: [
    ...(modes.length ? [{ title: '常用模式', stations: modes.slice(0, 8).map(station), ...(modes.length > 8 ? { morePage: 'scene-modes' } : {}) }] : []),
    ...(discoveries.length ? [discoverySection(discoveries)] : []),
  ] }
}
