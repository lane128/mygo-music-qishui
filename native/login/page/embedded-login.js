// The plugin-owned isolated embedded page owns this login from QR through official MFA.
// It cannot invoke application Go services; the host reads a bounded state.
(() => {
  if (location.origin !== 'https://api.qishui.com') return;
  const ORIGIN = location.origin;
  const GLUE = 'https://lf-headquarters-speed.yhgfb-cn-static.com/obj/rc-client-security/web/glue/1.0.0.36/sdk-glue.js';
  const config = window.__mygoSignInData;
  const device = config?.device;
  const state = window.__mygoLoginState = { status: 'pending', message: '正在初始化汽水登录…', qr: '', cookies: [] };
  let statusNode, qrSection, qrImage, verificationMs = 0;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fail = (message, code = 'page') => Object.assign(new Error(message), { code });
  function status(text) { state.message = text; if (statusNode) statusNode.textContent = text; }
  function checked(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('汽水接口未返回有效数据。');
    const nested = value.data && typeof value.data === 'object' ? value.data : {};
    const codes = [value.error_code, value.status_code, nested.error_code].filter(x => x !== undefined && x !== null && x !== '');
    const bad = codes.find(x => !Number.isFinite(Number(x)) || Number(x) !== 0);
    if (bad !== undefined || (value.message && value.message !== 'success')) {
      const code = /^\d{1,9}$/.test(String(bad)) ? String(bad) : 'unknown';
      throw fail('汽水接口返回错误（' + code + '），本次登录尚未完成。', code);
    }
    return value;
  }
  async function loadScript(url) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => reject(fail('官方登录组件加载超时，请检查网络后重试。')), 20000);
      script.charset = 'utf-8';
      script.src = url;
      script.onload = () => { clearTimeout(timer); resolve(); };
      script.onerror = () => { clearTimeout(timer); reject(fail('官方登录组件加载失败，请检查网络后重试。')); };
      document.head.appendChild(script);
    });
  }
  async function request(endpoint, body, flow = {}, json = false) {
    const url = new URL(endpoint, ORIGIN);
    if (url.origin !== ORIGIN) throw fail('登录请求来源无效。');
    const headers = { Accept: 'application/json, text/javascript' };
    if (url.pathname.startsWith('/passport/')) {
      for (const [key, value] of Object.entries({ p_zt: window.$SECURE_VERSION || '0', p_bd: window._sdkGlueVersionMap?.bdmsVersion || '0', request_host: encodeURIComponent(ORIGIN), account_sdk_source_info: window.__mygoSourceInfo })) url.searchParams.set(key, value);
      const csrf = /(?:^|; )passport_csrf_token=([^;]+)/.exec(document.cookie) || /(?:^|; )passport_csrf_token_default=([^;]+)/.exec(document.cookie);
      if (csrf) headers['x-tt-passport-csrf-token'] = csrf[1];
      headers['x-tt-passport-verify-portrait'] = flow.portrait;
      headers['x-tt-passport-trace-id'] = flow.trace;
    }
    if (body !== undefined) headers['Content-Type'] = json ? 'application/json' : 'application/x-www-form-urlencoded';
    let response;
    try { response = await fetch(url.href, { method: body === undefined ? 'GET' : 'POST', headers, body, credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw fail('无法连接汽水登录接口，请检查网络后重试。', 'network'); }
    if (!response.ok) throw fail('汽水登录接口暂时不可用（HTTP ' + response.status + '）。', 'network');
    const text = await response.text();
    if (text.length > 1048576) throw fail('汽水登录接口返回的数据过大。');
    try { return JSON.parse(text); } catch { throw fail('汽水登录接口未返回有效数据。'); }
  }
  function challengeFor(value) {
    const nested = value?.data && typeof value.data === 'object' ? value.data : {};
    const error = [nested, value].find(item => Number(item?.error_code) === 2046 && typeof item.url === 'string');
    if (error) return { kind: 'modern', decision: error, body: error.biz_params };
    const raw = nested.verify_center_decision_conf || nested.verify_center_secondary_decision_conf || value?.verify_center_decision_conf || value?.verify_center_secondary_decision_conf;
    if (typeof raw !== 'string' || raw.length > 131072) return null;
    let decision; try { decision = JSON.parse(raw); } catch { return null; }
    if (!decision || ![10000, 20000].includes(Number(decision.code))) return null;
    const sms = nested.sms_code_key || value.sms_code_key;
    return { kind: 'legacy', decision, ...(Number(nested.error_code || value.error_code) === 2046 && typeof sms === 'string' ? { body: { sms_code_key: sms } } : {}) };
  }
  async function verifiedRequest(endpoint, body, flow) {
    state.stage = endpoint.startsWith('/passport/web/get_qrcode/') ? 'create' : 'poll';
    const value = await request(endpoint, body, flow);
    const challenge = challengeFor(value);
    if (!challenge) {
      if (Number(value?.data?.error_code || value?.error_code) === 2046) state.reason = 'missingChallenge';
      return checked(value);
    }
    state.status = 'verifying'; qrSection.hidden = true;
    status('请在当前登录窗口完成官方安全验证，完成前请勿关闭。');
    const verificationBegan = Date.now();
    window.__mygoVerify({ ...challenge, device, portrait: flow.portrait });
    const deadline = Date.now() + 185000;
    while (Date.now() < deadline) {
      const verification = window.__mygoVerificationState;
      if (verification.status === 'success') {
        verificationMs += Date.now() - verificationBegan;
        const url = new URL(endpoint, ORIGIN); url.searchParams.set('isResend', 'true');
        if (verification.fp) { url.searchParams.set('fp', verification.fp); url.searchParams.set('verifyFp', verification.fp); }
        let nextBody = body;
        if (challenge.body && typeof challenge.body === 'object' && !Array.isArray(challenge.body)) {
          const fields = body === undefined ? url.searchParams : new URLSearchParams(body);
          for (const [key, item] of Object.entries(challenge.body)) fields.set(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
          if (body !== undefined) nextBody = fields.toString();
        }
        const resumed = await request(url.pathname + url.search, nextBody, flow);
        if (challengeFor(resumed)) { state.reason = 'repeat'; throw fail('验证后平台仍要求额外验证，本次登录未完成，请稍后重新登录。', '2046'); }
        state.status = 'pending'; qrSection.hidden = false;
        status('安全验证已完成，正在等待汽水确认登录…');
        return checked(resumed);
      }
      if (verification.status !== 'pending') state.reason = verification.reason || verification.status;
      if (verification.entry?.host && /^[a-z0-9.-]{1,253}$/.test(verification.entry.host)) state.verificationHost = verification.entry.host;
      if (verification.status === 'unsupported') throw fail('官方验证入口暂不受支持（域名：' + (verification.entry?.host || '无法解析') + '；原因：' + (verification.entry?.reason || 'unknown') + '）。', '2046');
      if (verification.status === 'cancelled') throw fail('安全验证已关闭，登录尚未完成，请重新登录。', 'cancelled');
      if (verification.status === 'loadFailed') throw fail('官方验证界面未能加载，请检查网络后重试。', '2046');
      if (verification.status === 'timeout') throw fail('安全验证已超时，请重新登录。', 'timeout');
      await sleep(200);
    }
    throw fail('安全验证已超时，请重新登录。', 'timeout');
  }
  function buildPage() {
    document.title = '汽水音乐 · 插件登录';
    const style = document.createElement('style');
    style.textContent = `:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;background:light-dark(#fff,#181818);color:light-dark(#171717,#eee)}main{box-sizing:border-box;width:100%;max-width:460px;margin:auto;padding:32px 24px;text-align:center}h1{font-size:22px;margin:0 0 12px}p{font-size:14px;line-height:1.6}#qr-section{margin:22px 0}#login-qr{display:block;max-width:100%;width:264px;height:264px;object-fit:contain;margin:0 auto;background:white;border-radius:12px}#login-qr:not([src]){visibility:hidden}.hint{font-size:12px;opacity:.7}[hidden]{display:none!important}`;
    document.head.appendChild(style);
    const main = document.createElement('main');
    const title = document.createElement('h1'); title.textContent = '登录汽水音乐';
    statusNode = document.createElement('p'); statusNode.id = 'login-status'; statusNode.textContent = state.message;
    qrSection = document.createElement('section'); qrSection.id = 'qr-section';
    qrImage = document.createElement('img'); qrImage.id = 'login-qr'; qrImage.alt = '请用汽水音乐 App 扫码'; qrSection.appendChild(qrImage);
    const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = '全部验证在插件的登录窗口中完成。登录完成前请保留此窗口；成功后会自动关闭。';
    main.append(title, statusNode, qrSection, hint); document.body.replaceChildren(main);
    window.__mygoSetQRCode = (url, png) => { if (url !== state.qr || typeof png !== 'string' || !png.startsWith('data:image/png;base64,')) return false; qrImage.src = png; return true; };
  }
  async function login() {
    buildPage();
    state.stage = 'sdk';
    if (!device || typeof device.did !== 'string' || typeof device.iid !== 'string' || typeof config.computerName !== 'string' || !config.computerName) throw fail('插件设备信息不完整，请重新登录。');
    await loadScript(GLUE);
    window._SdkGlueInit({ self: { aid: 386088, pageId: 24554 }, bdms: { aid: 386088, paths: ['/passport'] } });
    const sdkDeadline = Date.now() + 15000;
    while (!(typeof window.bdms?.init === 'function' && !window._SdkGlueLoadingMap?.bdms)) {
      if (Date.now() > sdkDeadline) throw fail('官方登录 SDK 未完成初始化。'); await sleep(50);
    }
    window.__mygoSourceInfo = await window.__mygoCollectBrowserInfo();
    const options = { aid: 386088, service: 'api.qishui.com', host: ORIGIN, unionHost: '', union: false, needFid: false };
    const checkedDevice = await request('/ttwid/check/', JSON.stringify({ ...options, fid: '', migrate_priority: 0 }), {}, true);
    if (!Number.isFinite(Number(checkedDevice.status_code))) throw fail('汽水设备初始化返回了无效数据。');
    if (Number(checkedDevice.status_code) > 1001) {
      const registered = await request('/ttwid/register/', JSON.stringify({ ...options, migrate_info: checkedDevice.migrate_info, fid: '' }), {}, true);
      if (Number(registered.status_code) !== 0) throw fail('汽水登录设备初始化失败。');
    }
    const trace = [...crypto.getRandomValues(new Uint8Array(4))].map(x => x.toString(16).padStart(2, '0')).join('');
    const flow = { trace, portrait: crypto.randomUUID() + '.login' };
    document.cookie = 'biz_trace_id=' + trace + ';path=/;domain=qishui.com;Secure;SameSite=Lax';
    const params = new URLSearchParams({ passport_jssdk_version: '2.4.13', passport_jssdk_type: 'normal', is_from_ttaccountsdk: '1', aid: '386088', p_js_v: '2.4.13', p_js_t: 'pro', p_ver: '1.0.29', account_sdk_source: 'web', language: 'zh', biz_trace_id: trace, device_id: device.did, install_id: device.iid, did: device.did, iid: device.iid, device_platform: 'PC', version_code: device.clientVersion });
    status('正在获取二维码…');
    const created = await verifiedRequest('/passport/web/get_qrcode/?' + params + '&next=https%3A%2F%2Fapi.qishui.com&need_logo=false&need_short_url=false&is_new_login=1', undefined, flow);
    const data = created.data || {};
    if (typeof data.token !== 'string' || !data.token || typeof data.qrcode_index_url !== 'string') throw fail('汽水未返回有效二维码。');
    let original; try { original = new URL(data.qrcode_index_url); } catch { throw fail('汽水二维码地址无效。'); }
    if (original.protocol !== 'https:' || original.hostname !== 'bff-pc.qishui.com' || original.username || original.password || original.searchParams.getAll('token').length !== 1 || original.searchParams.get('token') !== data.token) throw fail('二维码来源或会话不符合预期。', 'qr');
    state.qr = original.href;
    status('请用汽水音乐 App「搜索 → 扫一扫」扫码，并在手机上确认登录此电脑（' + config.computerName + '）。');
    const body = new URLSearchParams({ need_logo: 'false', need_short_url: 'false', is_frontier: 'true', token: data.token, is_new_login: '1', next: ORIGIN }).toString();
    let deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const paused = verificationMs;
      const result = await verifiedRequest('/passport/web/check_qrconnect/?' + params + '&is_new_login=1', body, flow);
      deadline += verificationMs - paused;
      const next = result.data || {}, current = String(next.status || '');
      if (current === '3' || current === 'confirmed' || current === 'success') {
        if (typeof next.session_cookie === 'string') state.cookies = next.session_cookie.split(';').map(piece => /^\s*(sessionid|sessionid_ss)=(.*)$/.exec(piece)).filter(Boolean).map(match => ({ name: match[1], value: match[2] }));
        state.status = 'complete'; status('手机确认完成，正在连接 MyGo 账号…'); return;
      }
      if (current === 'scanned' || current === '2') status('已扫码，请在手机确认；如需二次验证，请在当前窗口继续。');
      else if (current !== 'new' && current !== '1') throw fail('二维码已失效或登录被取消，请重新登录。', 'expired');
    }
    throw fail('二维码已超时，请重新登录。', 'timeout');
  }
  function start() { login().catch(error => { state.status = 'error'; state.code = typeof error.code === 'string' ? error.code : 'page'; state.qr = ''; state.cookies = []; if (qrSection) qrSection.hidden = true; status(error.code ? error.message : '内嵌登录未能完成，请检查网络后重试。'); }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
