// Synthetic upstream grant schema for sandbox tests; no real media or account.
export function grant(id) {
  return { track: { id: String(id), duration: 180000 }, track_player: { video_model: {
    video_duration: 180, video_list: [{ main_url: 'https://fixture.douyinvod.com/audio.mp3',
      video_meta: { codec_type: 'mp3', quality: 'exhigh', bitrate: 256000, size: 4 } }],
  } } }
}
