import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lyricsOf } from '../helper/lyrics.mjs'

// Removing word tags used to discard official timing and leave the host to estimate it.
test('word timing stays relative to its line, with exact milliseconds and pauses', () => {
  const result = lyricsOf('[1234,2500]<0,150,0>你<500,800,0>好\n[4000,1000]普通行\n[00:06.12][00:08.45]重复行')
  assert.deepEqual(result.lines, [
    { start: 1234, end: 3734, text: '你好', words: [{ start: 1234, end: 1384, text: '你' }, { start: 1734, end: 2534, text: '好' }] },
    { start: 4000, end: 5000, text: '普通行' }, { start: 6120, text: '重复行' }, { start: 8450, text: '重复行' },
  ])
})

// Bad word timing must preserve readable line text without sending invalid times to MyGO.
test('malformed or out-of-line word timing falls back to line text', () => {
  for (const body of ['<0,101,0>越界', '<-1,10,0>负数', '<10,10,0>后<0,10,0>前', '<0,0,0>零', '前缀<0,10,0>字', '<0,9007199254740993,0>过大']) {
    const result = lyricsOf('[0,100]' + body + '\n[1000,100]<0,100,0>正常')
    assert.equal(result.lines[0].words, undefined)
    assert.ok(result.lines[0].text)
    assert.deepEqual(result.lines[1].words, [{ start: 1000, end: 1050, text: '正' }, { start: 1050, end: 1100, text: '常' }])
  }
})

// A timing group may cover multiple Unicode characters; host JSON times must remain integers.
test('splits official timing groups into Unicode characters with integer boundaries', () => {
  const result = lyricsOf('[1000,1000]<0,100,0>你😀好')
  assert.deepEqual(result.lines[0].words, [
    { start: 1000, end: 1033, text: '你' }, { start: 1033, end: 1067, text: '😀' }, { start: 1067, end: 1100, text: '好' },
  ])
})

// The official translation is aligned by source line, even when its timestamp differs.
test('keeps Chinese translations aligned by line and suppresses duplicate text', () => {
  const result = lyricsOf('[1000,500]hello\n\n[2000,500]<0,500,0>world\n[00:03.00]相同', '[00:00.00]你好\n[00:10.00]世界\n[00:30.00]相同')
  assert.equal(result.lines[0].translation, '你好')
  assert.equal(result.lines[1].translation, '世界')
  assert.equal(result.lines[2].translation, undefined)
  assert.deepEqual(lyricsOf('[00:01.00]hello', '[00:20.00]你好').lines, [{ start: 1000, text: 'hello', translation: '你好' }])
  assert.deepEqual(lyricsOf('[00:01:25][00:02.50]hello', '[00:20.00][00:30.00]你好').lines, [
    { start: 1250, text: 'hello', translation: '你好' }, { start: 2500, text: 'hello', translation: '你好' },
  ])
})

// Ordinary lyrics and legitimate no-lyric tracks retain the existing fallback contract.
test('ordinary LRC and empty lyrics need no synthetic word timing', () => {
  for (const [raw, lrc] of [['[00:01:25]hello', '[00:01:25]hello'], ['[00:01.25]hello', '[00:01.25]hello'], ['[1000,800]你好', '[00:01.00]你好'], ['', ''], ['unrecognized', '']]) {
    assert.deepEqual(lyricsOf(raw), { lrc })
  }
})
