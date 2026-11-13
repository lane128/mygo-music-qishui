// Runs inside MyGo's isolated login page. Challenge contents stay in the
// temporary WebView; only bounded completion state is read by the host.
(() => {
  const ORIGIN = 'https://api.qishui.com';
  const CAPTCHA = 'https://lf-rc1.yhgfb-cn-static.com/obj/rc-client-security/secsdk-captcha/2.28.11/captcha.js';
  const SCRIPT_HOSTS = new Set(['lf-rc1.yhgfb-cn-static.com', 'lf-headquarters-speed.yhgfb-cn-static.com',
    'lf-cdn-tos.bytescm.com', 'lf3-cdn-tos.bytescm.com', 'lf6-cdn-tos.bytescm.com', 'lf-luna.qishui.com',
    // Passport 2046 decisions can serve the official component from this host.
    'auth.zijieapi.com']);
  function rejectedEntry(reason, host = '') {
    return Object.assign(new Error('unsupported'), { verificationEntry: { reason, host } });
  }
  function scriptURL(value) {
    if (typeof value !== 'string') throw rejectedEntry('url');
    if (value.length > 8192) throw rejectedEntry('length');
    let url;
    try { url = new URL(value); } catch { throw rejectedEntry('url'); }
    // Only the public hostname and a fixed reason leave the browser. Never
    // include URL paths, query strings, fragments, userinfo or challenge data.
    const host = /^[a-z0-9.-]{1,253}$/.test(url.hostname) ? url.hostname : '';
    if (url.protocol !== 'https:') throw rejectedEntry('scheme', host);
    if (url.username || url.password) throw rejectedEntry('credentials', host);
    if (url.port) throw rejectedEntry('port', host);
    if (!SCRIPT_HOSTS.has(url.hostname)) throw rejectedEntry('host', host);
    return url;
  }
  async function loadScript(value) {
    const url = scriptURL(value);
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => { script.remove(); reject(new Error('scriptTimeout')); }, 20000);
      script.charset = 'utf-8';
      script.crossOrigin = 'anonymous';
      script.src = url.href;
      script.onload = () => { clearTimeout(timer); resolve(); };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('scriptDownload')); };
      document.head.appendChild(script);
    });
  }
  let active = false;
  window.__mygoVerificationState = { status: 'idle' };
  window.__mygoVerify = async config => {
    if (active || location.origin !== ORIGIN) return;
    active = true;
    window.__mygoVerificationState = { status: 'pending' };
    let settled = false;
    const timer = setTimeout(() => finish('timeout'), 180000);
    function finish(status, fp, entry, reason) {
      if (settled) return;
      settled = true; clearTimeout(timer); active = false;
      window.__mygoVerificationState = { status, ...(typeof fp === 'string' && fp.length <= 512 ? { fp } : {}), ...(entry ? { entry } : {}), ...(reason ? { reason } : {}) };
    }
    let phase = 'sdkException';
    let entry;
    try {
      document.title = '汽水音乐安全验证 · MyGo';
      const { device, portrait, decision, kind } = config;
      const commonOptions = { aid: 386088, did: device.did, iid: device.iid };
      const generalParams = { device_id: device.did, install_id: device.iid, did: device.did, iid: device.iid,
        device_platform: 'PC', version_code: device.clientVersion };
      if (kind === 'modern') {
        const url = scriptURL(decision.url);
        entry = {host: url.hostname};
        url.searchParams.set('aid', '386088');
        url.searchParams.set('verify_reason', decision.event_params?.verify_reason || '');
        url.searchParams.set('verify_scene', decision.event_params?.verify_scene || '');
        // The official UMD externalizes React and uses its legacy DOM APIs.
        // Both runtimes are pinned local plugin assets, injected by the helper.
        phase = 'missingRuntime';
        const react = window.React, reactDOM = window.ReactDOM;
        if (typeof react?.createElement !== 'function' || typeof reactDOM?.render !== 'function' ||
            typeof reactDOM?.unmountComponentAtNode !== 'function') throw new Error('loadFailed');
        window.ucSecondVerifyReact = react;
        window.ucSecondVerifyReactDom = reactDOM;
        window.$$account_verify_portrait_id = portrait;
        phase = 'scriptDownload';
        await loadScript(url.href);
        if (settled) return;
        phase = 'missingAPI';
        if (typeof window.ucWebSecondVerify !== 'function') throw new Error('loadFailed');
        phase = 'sdkException';
        window.ucWebSecondVerify({ ...decision, aid: 386088, did: device.did, iid: device.iid, generalParams,
          newSecondVerifyWebOptions: { host: ORIGIN, verifyAppName: '汽水音乐' },
          verify_portrait_id: portrait, monitorTime: { startTime: Date.now(), scriptLoadStartTime: 0, scriptLoadEndTime: Date.now(), renderStartTime: Date.now() },
          fun: 'verify', uc_account_verify_version: '1.0.29',
          verifyFinishCallback: result => finish(result?.status === true ? 'success' : 'cancelled') });
      } else if (kind === 'legacy') {
        entry = {host: new URL(CAPTCHA).hostname};
        phase = 'scriptDownload';
        await loadScript(CAPTCHA);
        if (settled) return;
        phase = 'missingAPI';
        const sdk = window.verifySDK;
        if (typeof sdk?.initVerifyOptions !== 'function' || typeof sdk.autoRender !== 'function') throw new Error('loadFailed');
        phase = 'sdkException';
        sdk.initVerifyOptions({ commonOptions,
          captchaOptions: { sideSlide: 'disabled', lang: 'zh', showMode: 'mask', region: 'cn', app_name: '' },
          secondVerifyWebOptions: { host: ORIGIN, verifyAppName: '汽水音乐' } });
        sdk.autoRender({ verify_data: decision,
          captchaOptions: { successCb: () => {
            const fp = typeof sdk.getCaptchaWebId === 'function' ? sdk.getCaptchaWebId() : '';
            finish('success', fp);
          }, closeCb: () => finish('cancelled') },
          secondVerifyWebOptions: { scene: '4', callBack: () => finish('success'), closeCallBack: () => finish('cancelled') } });
      } else finish('unsupported');
    } catch (error) {
      const reason = ['scriptTimeout', 'scriptDownload'].includes(error.message) ? error.message : phase;
      finish(error.verificationEntry ? 'unsupported' : 'loadFailed', undefined, error.verificationEntry || entry, reason);
    }
  };
})();
