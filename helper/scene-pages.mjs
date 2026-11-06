// Compose discovery pages from MyGO's existing Link and Station card types.
// The host owns card sizing; category navigation keeps the scene list compact.
import { error } from './protocol.mjs'

export const SCENES_PER_PAGE = 12
const categories = [
  { id: 'focus', title: '放松与专注', matches: /chill|放松|助眠|专注|图书馆|轻音乐|冥想|睡眠/i },
  { id: 'mood', title: '心情与陪伴', matches: /快乐|开心|emo|失恋|治愈|躺平|浪漫|好运|佛系|伤感|情绪/i },
  { id: 'activity', title: '生活与出行', matches: /健身|通勤|驾车|开车|游戏|洗澡|打扫|旅行|起床|夜晚|小酒馆|ktv|摸鱼|雨天|海边|跑步|运动|工作|学习/i },
  { id: 'styles', title: '音乐风格', matches: /dj|电音|说唱|国风|摇滚|r[&＆]b|民谣|乡村|古典|爵士|流行|嘻哈|金属/i },
  { id: 'voices', title: '语言与人声', matches: /粤语|欧美|英语|日语|韩语|k.?pop|女声|男声|儿歌|童声|华语/i },
  { id: 'other', title: '更多场景', matches: /./s },
]
export function sceneCategory(mode) {
  return (categories.find(category => category.matches.test(mode.name)) || categories.at(-1)).id
}
const station = mode => ({ id: mode.id, name: mode.name, imageUrl: mode.imageUrl })
const pageID = (category, page = 1) => `listening-modes:${category}:${page}`

export function scenePage(modes, page = 'listening-modes') {
  if (!Array.isArray(modes)) throw error('response')
  const common = []
  const groups = new Map(categories.map(category => [category.id, []]))
  for (const mode of modes) {
    if (mode.id === 'preference:familiar' || mode.id === 'preference:fresh') common.push(mode)
    else {
      groups.get(sceneCategory(mode)).push(mode)
    }
  }
  if (page === 'listening-modes') {
    const links = categories.flatMap(category => {
      const scenes = groups.get(category.id)
      return scenes.length ? [{ title: category.title, subtitle: `${scenes.length} 个模式`, imageUrl: scenes.find(mode => mode.imageUrl)?.imageUrl, page: pageID(category.id) }] : []
    })
    return { title: '听歌模式', subtitle: '先选心情或场景，再开始持续听歌', sections: [
      ...(common.length ? [{ title: '常用模式', stations: common.map(station) }] : []),
      ...(links.length ? [{ title: '按分类发现', links }] : []),
    ] }
  }
  const match = /^listening-modes:(focus|mood|activity|styles|voices|other):([1-9]\d{0,5})$/.exec(page)
  if (!match) throw error('unsupported')
  const category = categories.find(category => category.id === match[1])
  const scenes = groups.get(category.id)
  const current = Number(match[2])
  const total = Math.max(1, Math.ceil(scenes.length / SCENES_PER_PAGE))
  if (!scenes.length || current > total) throw error('unsupported')
  const links = []
  if (current > 1) links.push({ title: '上一页', page: pageID(category.id, current - 1), imageUrl: scenes[(current - 2) * SCENES_PER_PAGE].imageUrl })
  if (current < total) links.push({ title: '下一页', page: pageID(category.id, current + 1), imageUrl: scenes[current * SCENES_PER_PAGE].imageUrl })
  return { title: category.title, subtitle: `${scenes.length} 个模式 · 第 ${current} / ${total} 页 · 点击卡片持续播放`, sections: [
    { stations: scenes.slice((current - 1) * SCENES_PER_PAGE, current * SCENES_PER_PAGE).map(station) },
    ...(links.length ? [{ links }] : []),
  ] }
}
