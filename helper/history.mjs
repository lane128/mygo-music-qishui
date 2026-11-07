// A plugin-local read-only system list, never an upstream playlist or a write.
export const HISTORY_ID = 'qishui:history'
export const HISTORY_PATH = '/luna/pc/me/recently-played-media'
export const HISTORY_LIMIT = 1000
export function historyPlaylist() {
  return {
    id: HISTORY_ID,
    name: '历史播放',
    description: '汽水音乐账号的最近播放记录，最多展示 1000 首歌曲。',
    imageUrl: new URL('../assets/history.png', import.meta.url).href,
  }
}
