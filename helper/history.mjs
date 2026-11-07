// A plugin-local system list, never an upstream playlist. Its contents come
// from account history; successful playback appends through the same API.
export const HISTORY_ID = 'qishui:history'
export const HISTORY_PATH = '/luna/pc/me/recently-played-media'
export const HISTORY_LIMIT = 1000
export function historyPlaylist(firstTrack) {
  return {
    id: HISTORY_ID,
    name: '历史播放',
    description: '汽水音乐账号的最近播放记录，最多展示 1000 首歌曲。',
    ...(firstTrack?.album?.imageUrl ? { imageUrl: firstTrack.album.imageUrl } : {}),
  }
}
