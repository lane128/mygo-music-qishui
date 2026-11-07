// MyGO owns card dimensions and typography. Keep the eight-mode preview flat;
// the common-mode section's morePage retains access to the complete catalog.
import { error } from './protocol.mjs'
import { discoverySection } from './exploration.mjs'

// These matches select artwork fallbacks only; they are not UI categories.
const artworkGroups = [
  { id: 'focus', matches: /chill|放松|助眠|专注|图书馆|轻音乐|冥想|睡眠/i },
  { id: 'mood', matches: /快乐|开心|emo|失恋|治愈|躺平|浪漫|好运|佛系|伤感|情绪/i },
  { id: 'activity', matches: /健身|通勤|驾车|开车|游戏|洗澡|打扫|旅行|起床|夜晚|小酒馆|ktv|摸鱼|雨天|海边|跑步|运动|工作|学习/i },
  { id: 'styles', matches: /dj|电音|说唱|国风|摇滚|r[&＆]b|民谣|乡村|古典|爵士|流行|嘻哈|金属/i },
  { id: 'voices', matches: /粤语|欧美|英语|日语|韩语|k.?pop|女声|男声|儿歌|童声|华语/i },
]
export function sceneCategory(mode) {
  return (artworkGroups.find(group => group.matches.test(mode.name)) || { id: 'other' }).id
}
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
