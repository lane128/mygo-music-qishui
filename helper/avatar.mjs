// Avatar responses can contain a complete URL or a CDN prefix plus an image ID.
// Keep complete HTTPS addresses intact, including any query bytes.
export function avatarURL(value, size = 100) {
  if (typeof value === 'string') {
    try { return new URL(value).protocol === 'https:' ? value : undefined } catch { return undefined }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.urls)) return undefined
  for (const raw of value.urls) {
    if (typeof raw !== 'string') continue
    try {
      const url = new URL(raw)
      if (url.protocol !== 'https:') continue
      const uri = typeof value.uri === 'string' ? value.uri : ''
      if (value.need_complete_url === true || !uri || url.pathname.includes(uri)) return raw
      url.pathname = url.pathname.replace(/\/$/, '') + '/' + uri.replace(/^\//, '')
      const template = typeof value.template_prefix === 'string' && value.template_prefix
        ? `${value.template_prefix}-crop-center:${size}:${size}.jpg` : `c5_${size}x${size}.jpg`
      if (!url.pathname.includes('~')) url.pathname += '~' + template
      return url.href
    } catch { /* Try the next avatar. */ }
  }
}
