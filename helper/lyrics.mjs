// Preserve the official line-relative word timing; ordinary LRC remains a fallback.
const DAY = 86400000
const stripTiming = text => text.replace(/<[^>]*>/g, '')
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= DAY

export function normalizeLyrics(raw) {
  return raw.split('\n').flatMap(line => {
    line = line.trim()
    const match = /^\[(\d+),(\d+)\](.*)$/.exec(line)
    if (!match) {
      const stamps = [...line.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)]
      if (!stamps.length || stamps[0].index !== 0 || stamps.some(stamp => !time(Math.round(Number(stamp[1]) * 60000 + Number(stamp[2]) * 1000 + (stamp[3] ? Number('0.' + stamp[3]) * 1000 : 0))))) return []
      return [line]
    }
    const ms = Number(match[1])
    if (!time(ms)) return []
    return [`[${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(Math.floor(ms % 1000 / 10)).padStart(2, '0')}]${stripTiming(match[3])}`]
  }).join('\n')
}

function wordsOf(body, start, end) {
  const words = []
  let covered = 0, previous = start
  for (const match of body.matchAll(/<(\d+),(\d+),(\d+)>([^<]*)/g)) {
    if (match.index !== covered) return undefined
    const offset = Number(match[1]), duration = Number(match[2])
    const at = start + offset, until = at + duration
    if (!time(offset) || !time(duration) || !time(at) || !time(until) || duration === 0 || at < previous || until > end || !match[4]) return undefined
    // The official renderer splits a timing group evenly by Unicode code point.
    const characters = [...match[4]]
    if (duration < characters.length) return undefined
    for (let i = 0; i < characters.length; i++) words.push({
      start: Math.round(at + duration * i / characters.length),
      end: Math.round(at + duration * (i + 1) / characters.length),
      text: characters[i],
    })
    previous = at
    covered += match[0].length
  }
  return covered === body.length && words.length ? words : undefined
}

export function lyricsOf(raw, chineseTranslation) {
  const lrc = normalizeLyrics(raw)
  const lines = []
  // Official LyricsView aligns translations.cn by nonempty source-line index.
  const translated = typeof chineseTranslation === 'string' ? chineseTranslation.split('\n') : []
  let wordTiming = false, hasTranslation = false
  for (const [index, line] of raw.split('\n').map(line => line.trim()).filter(Boolean).entries()) {
    const translatedText = /^(?:\[[^\]]+\])+(.*)$/.exec(translated[index] ?? '')?.[1]?.trim()
    const translationOf = text => {
      if (!translatedText || translatedText === text.trim()) return {}
      hasTranslation = true
      return { translation: translatedText }
    }
    const match = /^\[(\d+),(\d+)\](.*)$/.exec(line)
    if (match) {
      const start = Number(match[1]), duration = Number(match[2]), end = start + duration
      const text = stripTiming(match[3])
      if (!time(start) || !time(duration) || !time(end) || !text.trim()) continue
      const words = wordsOf(match[3], start, end)
      if (words) wordTiming = true
      lines.push({ start, ...(duration > 0 ? { end } : {}), text, ...translationOf(text), ...(words ? { words } : {}) })
      continue
    }
    const stamps = [...line.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)]
    if (!stamps.length || stamps[0].index !== 0) continue
    const last = stamps.at(-1), text = line.slice(last.index + last[0].length)
    if (!text.trim()) continue
    for (const stamp of stamps) {
      const start = Number(stamp[1]) * 60000 + Number(stamp[2]) * 1000 + (stamp[3] ? Number('0.' + stamp[3]) * 1000 : 0)
      if (time(Math.round(start))) lines.push({ start: Math.round(start), text, ...translationOf(text) })
    }
  }
  return { lrc, ...(wordTiming || hasTranslation ? { lines: lines.sort((a, b) => a.start - b.start) } : {}) }
}
