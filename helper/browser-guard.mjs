// Adapted from mygo-cloudmusic/internal/qishui/browser_guard.mjs (AGPL-3.0).
// CDP inspects every redirect hop; Playwright route() misses later hops.
export async function installRequestGuard(context, page, { origin, glue, bdms, accountURL }) {
  const state = { signatureMissing: false, signedRequests: 0 }
  const cdp = await context.newCDPSession(page)
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  cdp.on('Fetch.requestPaused', event => {
    const { requestId, request, resourceType } = event
    const fail = () => cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
    const fulfill = (contentType, body) => cdp.send('Fetch.fulfillRequest', {
      requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: contentType }],
      body: Buffer.from(body).toString('base64'),
    })
    ;(async () => {
      const u = new URL(request.url)
      if (u.origin === origin && u.pathname === '/') {
        return fulfill('text/html', '<!doctype html><meta charset="utf-8"><script src="/sdk-glue.js"></script><script>_SdkGlueInit({self:{aid:386088,pageId:24554},bdms:{aid:386088,paths:["/passport"]}})</script>')
      }
      if (u.origin === origin && u.pathname === '/sdk-glue.js') return fulfill('text/javascript', glue)
      if (u.protocol === 'https:' &&
          ['lf-headquarters-speed.yhgfb-cn-static.com', 'lf-c-flwb.bytetos.com'].includes(u.hostname) &&
          u.pathname === '/obj/rc-client-security/web/stable/1.0.0.41/bdms.js') {
        return fulfill('text/javascript', bdms)
      }
      if (!accountURL(request.url) || resourceType !== 'XHR') return fail()
      if (u.pathname.startsWith('/passport/')) {
        if ((u.searchParams.get('a_bogus') || '').length !== 44) {
          state.signatureMissing = true
          return fail()
        }
        state.signedRequests++
      }
      return cdp.send('Fetch.continueRequest', { requestId })
    })().catch(() => fail().catch(() => {}))
  })
  return state
}
