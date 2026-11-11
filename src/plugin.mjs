// Built into standalone index.js. MyGO performs authentication, catalogue
// requests and presentation; native helpers handle offline signing and audio.
import { Catalog, requestJSON, pcCatalogParams } from '../helper/catalog-core.mjs';
import { accountTier, memberName, COMMERCE_PATH } from '../helper/membership.mjs';
import { signedClient } from '../helper/client-profile.mjs';
import { scenePage } from '../helper/scene-pages.mjs';
import { discoverySection } from '../helper/exploration.mjs';
const SESSION_KEY = "session";
const t = host.t || ((text) => text);
let generation = 0;
let active = null;
const retainedAudio = [];
const musicHelpers = new Set();
const searchCursors = new Map();
const newCatalogState = () => ({ search: new Map(), comments: new Map(), commentLocks: new Map() });
let catalogState = newCatalogState();
const feedStates = new Map();
const discoveryPages = new Map();
const FEED_FIRST_USE_KEY = "feed-first-use";
let browseSequence = 0;
const catalogRequests = new Set();

async function closeMusic() {
  for (const controller of catalogRequests) controller.abort();
  catalogRequests.clear();
  retainedAudio.length = 0;
  searchCursors.clear();
  catalogState.search.clear();
  catalogState.comments.clear();
  catalogState.commentLocks.clear();
  catalogState.collections?.clear();
  catalogState.playlistOrder?.clear();
  // Old continuations retain only the discarded account's cache object.
  catalogState = newCatalogState();
  feedStates.clear();
  discoveryPages.clear();
  const helpers = Array.from(musicHelpers);
  musicHelpers.clear();
  await Promise.all(helpers.map(helper => helper.close()));
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deadline(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function startHelper() {
  let process;
  try {
    const executable = `bin/qishui-helper-${host.platform}-${host.arch}${host.platform === "windows" ? ".exe" : ""}`;
    process = host.spawn(executable, []);
  } catch {
    throw fail("setup", t("请允许插件启动程序，并安装适合当前系统的插件 ZIP。"));
  }
  let closed = false;
  let closing;
  let queue = Promise.resolve();
  return {
    request(spec, ms = 25000) {
      const response = queue.then(async () => {
      if (closed) throw new Error(t("登录已取消，请重试。"));
      process.write(JSON.stringify(spec) + "\n");
      const raw = await deadline(process.readLine(), ms, t("汽水请求超时，请重试。"))
        .catch(error => { closed = true; process.kill(); throw error; });
      let frame;
      try { frame = JSON.parse(raw); } catch { /* Do not expose worker output. */ }
      if (!frame || typeof frame !== "object") {
        closed = true;
        process.kill();
        throw new Error(t("汽水辅助进程已停止，请重试。"));
      }
      if (!frame.ok) {
        const messages = {
          setup: "插件组件无法启动，请重新安装完整的插件 ZIP。",
          signature: "汽水签名未生成，请检查插件组件版本。",
          rateLimit: "汽水请求过于频繁，请稍后重试。",
          verify: "汽水要求额外验证，请先在官方 App 完成验证后重试。",
          expired: "二维码已过期，请重新登录。",
          rejected: "汽水拒绝了本次请求，请稍后重试。",
          session: "未取得有效的汽水登录态，请重新登录。",
          network: "无法连接汽水音乐，请检查网络后重试。",
          response: spec.method === "playlist" ? (spec.params?.id === "qishui:history" ? "暂时无法读取播放历史，请稍后重试。" : "暂时无法读取歌单内容，请稍后重试。") : "汽水接口返回异常，请稍后重试。",
          unsupported: "暂不支持此操作，目前可以搜索歌曲、浏览歌单和推荐。",
          unavailable: "当前账号无法播放这首歌曲，或获准的音频格式暂不支持。",
          preview: "当前账号仅获准试听，请在汽水音乐官方 App 查看播放权限。",
        };
        throw fail(frame.error === "setup" ? "setup" : frame.error === "session" ? "signIn" : ["unavailable", "preview"].includes(frame.error) ? "unavailable" : frame.error === "unsupported" ? "unsupported" : "",
          t(messages[frame.error] || "汽水登录失败，请重试。"));
      }
      return frame;
      });
      queue = response.catch(() => {});
      return response;
    },
    get closed() { return closed; },
    close() {
      if (closing) return closing;
      if (closed) return Promise.resolve();
      closed = true;
      // Abort and account cleanup may close the same signer concurrently. Every
      // caller must await the original shutdown before a new session commits.
      closing = Promise.resolve().then(async () => {
        process.closeStdin();
        try {
          await deadline(process.wait(), 20000, "close");
        } catch {
          process.kill();
        }
      });
      return closing;
    },
  };
}

const AUTH_API = "https://api.qishui.com";
const AUTH_SESSIONS = new Set(["sessionid", "sessionid_ss", "sid_guard", "sid_tt"]);
const accountRequests = new Set();
let accountRefresh;

function authError(kind) {
  const messages = {
    cancelled: "登录已取消，请重试。",
    expired: "二维码已过期，请重新登录。",
    rateLimit: "汽水请求过于频繁，请稍后重试。",
    verify: "汽水要求额外验证，请先在官方 App 完成验证后重试。",
    rejected: "汽水拒绝了本次请求，请稍后重试。",
    session: "未取得有效的汽水登录态，请重新登录。",
    network: "无法连接汽水音乐，请检查网络后重试。",
    response: "汽水接口返回异常，请稍后重试。",
  };
  const error = fail(kind === "session" ? "signIn" : "", t(messages[kind] || messages.response));
  error.kind = kind;
  return error;
}

function authCurrent(ctx) {
  if (ctx.closed || ctx.attempt !== generation) throw authError("cancelled");
}

function authClose(ctx) {
  if (!ctx) return;
  ctx.closed = true;
  ctx.controller?.abort();
  ctx.wake?.();
  ctx.jar = [];
}

function authStopAccounts() {
  for (const ctx of accountRequests) authClose(ctx);
}

function authURL(raw) {
  if (typeof raw !== "string" || raw.length > 16384) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && !u.port &&
      (u.hostname === "qishui.com" || u.hostname.endsWith(".qishui.com"));
  } catch { return false; }
}

// These are anonymous client metadata, never authentication secrets. The QR
// challenge and session cookies come exclusively from the HTTPS service.
// MyGO 0.1.20 has no Web Crypto; do not use the fallback for secret generation.
function authBytes(n) {
  const bytes = new Uint8Array(n);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}
const authHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
function authIdentity() {
  const digits = n => Array.from(authBytes(n), (b, i) => String(i ? b % 10 : 1 + b % 9)).join("");
  const bytes = authBytes(16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const uuid = authHex(bytes);
  const portraitID = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}.login`;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const token = authBytes(88);
  let msToken = "", bits = 0, value = 0;
  for (const b of token) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 6) { bits -= 6; msToken += alphabet[(value >>> bits) & 63]; }
  }
  if (bits) msToken += alphabet[(value << (6 - bits)) & 63];
  return { deviceID: digits(16), installID: digits(15), portraitID, msToken: msToken + "==" };
}

function authParse(raw) {
  try {
    return JSON.parse(raw.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      token => /^-?\d{16,}$/.test(token) ? JSON.stringify(token) : token));
  } catch { throw authError("response"); }
}

function authPayload({ status, body }) {
  if (status === 401) throw authError("session");
  if (status === 429) throw authError("rateLimit");
  if (status === 403) throw authError("rejected");
  if (status !== 200) throw authError("network");
  const value = authParse(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw authError("response");
  for (const code of [value.error_code, value.status_code, value.status_info?.code, value.data?.error_code]) {
    if (code == null || Number(code) === 0) continue;
    throw authError(Number(code) === 7 ? "rateLimit" : Number(code) === 2046 ? "verify" : Number(code) === 2 ? "expired" : "rejected");
  }
  return value;
}

function authProfile(payload, commerce) {
  const p = payload.my_info || payload.user;
  if (!p || !/^\d+$/.test(String(p.id || ""))) throw authError("response");
  const nickname = [p.nickname, p.public_name].find(v => typeof v === "string" && v.trim()) || "汽水音乐用户";
  const tier = accountTier(p, commerce);
  const image = (value, suffix = "") => {
    const https = raw => { try { return typeof raw === "string" && new URL(raw).protocol === "https:" ? raw : undefined; } catch { return undefined; } };
    if (typeof value === "string") return https(value);
    if (!value || typeof value !== "object") return undefined;
    if (value.uri && value.template_prefix) return https(`https://p3-luna.douyinpic.com/img/${value.uri}~${value.template_prefix}-resize:%7Bsize%7D:%7Bsize%7D.png`);
    for (const raw of Array.isArray(value.urls) ? value.urls : []) {
      try {
        const u = new URL(raw);
        if (u.protocol !== "https:") continue;
        if (value.uri && !u.pathname.includes(value.uri)) u.pathname = u.pathname.replace(/\/$/, "") + "/" + value.uri.replace(/^\//, "");
        if (!u.pathname.includes("~")) u.pathname += suffix;
        return u.href;
      } catch { /* Try another avatar. */ }
    }
  };
  return {
    id: String(p.id), name: memberName(nickname, tier), page: 'my-library',
    imageUrl: image(p.avatar_url) || image(p.larger_avatar_url) || image(p.medium_avatar_url, "~c5_{size}x{size}.jpg") || image(p.thumb_avatar_url, "~c5_{size}x{size}.jpg") || image(p.url_avatar, "~c5_{size}x{size}.jpg"),
  };
}

function authApplies(cookie, url) {
  return (cookie.hostOnly ? url.hostname === cookie.domain : url.hostname === cookie.domain || url.hostname.endsWith("." + cookie.domain)) &&
    (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : cookie.path + "/")) &&
    (!cookie.expires || cookie.expires > Date.now() / 1000);
}

function authCookies(jar, raw, requireSession = false) {
  const u = new URL(raw);
  const valid = jar.filter(c => authApplies(c, u)).sort((a, b) => b.path.length - a.path.length);
  if (requireSession && !valid.some(c => AUTH_SESSIONS.has(c.name) && c.value)) throw authError("session");
  const header = valid.map(c => `${c.name}=${c.value}`).join("; ");
  if (header.length > 65536) throw authError("session");
  return header;
}

function authIngest(jar, lines, raw) {
  const u = new URL(raw);
  if (lines.length > 128) throw authError("response");
  for (const line of lines) {
    if (line.length > 8192) throw authError("response");
    const parts = line.split(";"), pair = parts.shift(), eq = pair.indexOf("=");
    if (eq <= 0) throw authError("response");
    const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || !/^[\x21-\x3A\x3C-\x7E]*$/.test(value)) throw authError("response");
    let domain = u.hostname, hostOnly = true, path = u.pathname.slice(0, u.pathname.lastIndexOf("/")) || "/", expires = 0, age = null, secure = false;
    for (const attr of parts) {
      const e = attr.indexOf("="), k = (e < 0 ? attr : attr.slice(0, e)).trim().toLowerCase(), v = (e < 0 ? "" : attr.slice(e + 1)).trim();
      if (k === "domain") { domain = v.toLowerCase().replace(/^\./, ""); hostOnly = false; }
      if (k === "path" && v.startsWith("/")) path = v;
      if (k === "secure") secure = true;
      if (k === "expires") { const ms = Date.parse(v); if (Number.isFinite(ms)) expires = ms / 1000; }
      if (k === "max-age" && /^-?\d+$/.test(v)) age = Number(v);
    }
    if ((domain !== "qishui.com" && !domain.endsWith(".qishui.com")) || (u.hostname !== domain && !u.hostname.endsWith("." + domain))) continue;
    if (name.startsWith("__Host-") && (!hostOnly || path !== "/" || !secure)) continue;
    if (name.startsWith("__Secure-") && !secure) continue;
    if (age !== null) expires = age <= 0 ? 1 : Date.now() / 1000 + age;
    if (!Number.isFinite(expires)) throw authError("response");
    const old = jar.findIndex(c => c.name === name && c.domain === domain && c.path === path);
    if (old >= 0) jar.splice(old, 1);
    if (value && (!expires || expires > Date.now() / 1000)) jar.push({ name, value, domain, hostOnly, path, expires });
    if (jar.length > 128) throw authError("response");
  }
}

function authStored(saved) {
  if (!saved || saved.version !== 1 || !/^\d{16}$/.test(saved.deviceID) || !/^\d{15}$/.test(saved.installID) || !Array.isArray(saved.cookies) || saved.cookies.length > 128) throw authError("session");
  const jar = saved.cookies.map(c => {
    if (!c || typeof c.name !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(c.name) || typeof c.value !== "string" || !/^[\x21-\x3A\x3C-\x7E]+$/.test(c.value)) throw authError("session");
    const legacy = c.domain == null && c.path == null && c.hostOnly == null;
    const domain = legacy ? "api.qishui.com" : typeof c.domain === "string" ? c.domain.replace(/^\./, "").toLowerCase() : "";
    const path = legacy ? "/" : c.path;
    const hostOnly = legacy ? true : c.hostOnly == null ? typeof c.domain === "string" && !c.domain.startsWith(".") : c.hostOnly;
    const expires = c.expires == null || c.expires === -1 ? 0 : c.expires;
    if ((domain !== "qishui.com" && !domain.endsWith(".qishui.com")) || typeof path !== "string" || !path.startsWith("/") || /[\x00-\x20\x7f]/.test(path) || typeof hostOnly !== "boolean" || !Number.isFinite(expires) || expires < 0) throw authError("session");
    return { name: c.name, value: c.value, domain, hostOnly, path, expires };
  });
  authCookies(jar, AUTH_API + "/", true);
  return jar;
}

async function authBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0, body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) throw authError("response");
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    try { await reader.cancel(); } catch { /* Cancellation must not expose upstream data. */ }
    reader.releaseLock();
  }
}

async function authRequest(ctx, raw, { method = "GET", headers = {}, body, timeoutMS = 20000 } = {}, redirects = false) {
  for (let hop = 0; hop < 6; hop++) {
    authCurrent(ctx);
    if (!authURL(raw)) throw authError("response");
    const controller = new AbortController();
    ctx.controller = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMS);
    let response;
    try {
      const cookie = authCookies(ctx.jar, raw);
      response = await fetch(raw, { method, headers: { "User-Agent": "LunaPC/3.0.0(290101097)", ...headers, ...(cookie ? { Cookie: cookie } : {}) }, body, redirect: "manual", signal: controller.signal });
      authCurrent(ctx);
      authIngest(ctx.jar, response.headers.getSetCookie(), raw);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!redirects) throw authError("response");
        const location = response.headers.get("location");
        if (!location) throw authError("response");
        const next = new URL(location, raw).href;
        if (!authURL(next)) throw authError("response");
        raw = next; method = "GET"; headers = {}; body = undefined;
        continue;
      }
      const text = await authBody(response);
      authCurrent(ctx);
      return { status: response.status, body: text };
    } catch (error) {
      authCurrent(ctx);
      throw error.kind ? error : authError("network");
    } finally {
      clearTimeout(timer);
      if (ctx.controller === controller) ctx.controller = null;
      try { await response?.body?.cancel(); } catch { /* Reader may already be closed. */ }
    }
  }
  throw authError("response");
}

async function authAccount(ctx, identity) {
  const payload = authPayload(await authRequest(ctx, AUTH_API + "/luna/pc/me?aid=386088"));
  // Verify the identity before requesting optional entitlement metadata.
  authProfile(payload);
  let commerce;
  try {
    const query = pcCatalogParams(identity);
    query.set('version_name', '3.7.0');
    query.set('version_code', '30070000');
    for (const [key, value] of Object.entries(signedClient(host.platform))) query.set(key, value);
    query.sort();
    const body = JSON.stringify({ includes: ['membership'] });
    commerce = authPayload(await authRequest(ctx, AUTH_API + COMMERCE_PATH + '?' + query, {
      method: 'POST', body, timeoutMS: 5000,
      headers: { 'User-Agent': 'LunaPC/3.7.0(452316191)', Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'X-SS-STUB': host.crypto.md5(body).toUpperCase() },
    }));
  } catch (error) {
    // Ordinary metadata failures preserve login; explicit session expiry does not.
    authCurrent(ctx);
    if (error.kind === 'session') throw error;
  }
  authCurrent(ctx);
  // Even an unsuccessful optional response can revoke the API session cookie.
  authCookies(ctx.jar, AUTH_API + '/', true);
  return authProfile(payload, commerce);
}

async function authPassport(ctx, path, form, extra = {}) {
  const id = ctx.identity, trace = authHex(authBytes(4));
  const query = new URLSearchParams({
    aid: "386088", passport_jssdk_version: "2.4.13", passport_jssdk_type: "normal", is_from_ttaccountsdk: "1", language: "zh", account_sdk_source: "web",
    p_js_v: "2.4.13", p_js_t: "pro", p_zt: "3.3.5", p_ver: "1.0.29", request_host: "app%3A%2F%2Fresources", p_bd: "1.0.0.41", is_new_login: "1",
    is_from_iesaccountsaas: "1", device_platform: "PC", version_code: "3.5.2", account_sdk_source_info: "00", biz_trace_id: trace,
    device_id: id.deviceID, did: id.deviceID, install_id: id.installID, iid: id.installID, msToken: id.msToken, ...extra,
  });
  query.sort();
  const headers = { Accept: "application/json, text/javascript", "x-tt-passport-verify-portrait": id.portraitID, "x-tt-passport-trace-id": trace };
  let body;
  if (form) {
    const params = new URLSearchParams(form); params.sort(); body = params.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers["x-ss-stub"] = host.crypto.md5(body).toUpperCase();
  }
  return authPayload(await authRequest(ctx, AUTH_API + path + "?" + query, { method: form ? "POST" : "GET", headers, body }));
}

async function authWait(ctx) {
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); ctx.wake = null; resolve(); };
    const timer = setTimeout(done, 3500);
    ctx.wake = done;
  });
  authCurrent(ctx);
}

export async function signIn() {
  const ctx = { attempt: ++generation, jar: [], identity: authIdentity(), closed: false };
  authClose(active);
  authStopAccounts();
  active = ctx;
  try {
    await closeMusic();
    authCurrent(ctx);
    const qr = (await authPassport(ctx, "/passport/web/get_qrcode/", null, { next: AUTH_API, need_logo: "false", need_short_url: "false", is_new_login: "1" })).data;
    if (!qr || typeof qr.token !== "string" || !qr.token || qr.token.length > 8192 || !authURL(qr.qrcode_index_url)) throw authError("response");
    authCurrent(ctx);
    // Keep the exact server-provided QR URL; never substitute another scanner URL.
    host.signInPrompt({ qr: qr.qrcode_index_url, text: t("请使用汽水音乐 App 扫码，并在手机上确认登录。") });
    const until = Date.now() + 210000;
    while (Date.now() < until) {
      await authWait(ctx);
      if (Date.now() >= until) break;
      const data = (await authPassport(ctx, "/passport/web/check_qrconnect/", {
        token: qr.token, next: AUTH_API, need_logo: "false", need_short_url: "false", is_frontier: String(qr.is_frontier === true), is_new_login: "1",
      })).data;
      const status = String(data?.status).trim().toLowerCase();
      if (["new", "1"].includes(status)) continue;
      if (["scanned", "2"].includes(status)) {
        host.signInPrompt({ qr: qr.qrcode_index_url, text: t("已扫码，请在手机上确认登录。") });
        continue;
      }
      if (["expired", "expire", "timeout"].includes(status)) throw authError("expired");
      if (["cancelled", "canceled", "rejected", "denied"].includes(status)) throw authError("rejected");
      if (!["confirmed", "success", "3"].includes(status)) throw authError("response");
      let hasSession = false;
      try { authCookies(ctx.jar, AUTH_API + "/", true); hasSession = true; } catch { /* The completion redirect can set the session. */ }
      if (!hasSession && data.redirect_url) {
        const response = await authRequest(ctx, data.redirect_url, {}, true);
        if (response.status !== 200) throw authError("network");
      }
      authCookies(ctx.jar, AUTH_API + "/", true);
      const account = await authAccount(ctx, ctx.identity);
      authCurrent(ctx);
      // Store only cookies usable by the existing API/music worker. Cookies from
      // login-only hosts or paths must not become credentials for API requests.
      const cookies = ctx.jar.filter(c => authApplies(c, new URL(AUTH_API + "/"))).map(c => ({ ...c }));
      const session = { version: 1, deviceID: ctx.identity.deviceID, installID: ctx.identity.installID, cookies, account };
      authStored(session);
      ctx.attempt = ++generation;
      authStopAccounts();
      await closeMusic();
      authCurrent(ctx);
      // Restores started while cleanup awaited still belong to the old session.
      // Invalidate them immediately before the synchronous new-session commit.
      ctx.attempt = ++generation;
      authStopAccounts();
      host.storage.set(SESSION_KEY, session);
      return account;
    }
    throw authError("expired");
  } finally {
    authClose(ctx);
    if (active === ctx) active = null;
  }
}

export async function account() {
  if (accountRefresh?.attempt === generation) return accountRefresh.promise;
  const refresh = { attempt: generation, promise: restoreAccount() };
  accountRefresh = refresh;
  try {
    return await refresh.promise;
  } finally {
    if (accountRefresh === refresh) accountRefresh = undefined;
  }
}

async function restoreAccount() {
  const saved = host.storage.get(SESSION_KEY);
  if (!saved) return null;
  const ctx = { attempt: generation, jar: [], closed: false };
  accountRequests.add(ctx);
  try {
    ctx.jar = authStored(saved);
    const profile = await authAccount(ctx, saved);
    authCurrent(ctx);
    // Persist verified rotations and keep postComment's author consistent.
    const cookies = ctx.jar.filter(c => authApplies(c, new URL(AUTH_API + '/'))).map(c => ({ ...c }));
    host.storage.set(SESSION_KEY, { ...saved, cookies, account: profile });
    return profile;
  } catch (error) {
    if (ctx.attempt !== generation) return null;
    if (error.kind === "session") {
      ++generation;
      // Expire old-account work, but keep an independent QR attempt current.
      // Its cookie jar belongs to the new login, never to the saved session.
      if (active && !active.closed) active.attempt = generation;
      host.storage.remove(SESSION_KEY);
      authStopAccounts();
      await closeMusic();
      return null;
    }
    throw error;
  } finally {
    accountRequests.delete(ctx);
    authClose(ctx);
  }
}

export async function signOut() {
  ++generation;
  host.storage.remove(SESSION_KEY);
  authClose(active);
  active = null;
  authStopAccounts();
  await closeMusic();
}

async function nativeMusic(method, params = {}, persistent = false, signal) {
  const saved = host.storage.get(SESSION_KEY);
  if (!saved) throw fail("signIn", t("请先登录汽水音乐。"));
  const attempt = generation;
  if (method === 'stream' && (typeof params.id !== 'string' || !/^\d{1,32}$/.test(params.id))) throw fail('unavailable', t('当前账号无法播放这首歌曲，或获准的音频格式暂不支持。'));
  // MyGO can prefetch while another track resolves. Independent helpers keep
  // each request within the host deadline, without waiting behind another song.
  if (signal?.aborted) throw fail('', t('汽水请求已取消，请重试。'));
  const helper = startHelper();
  musicHelpers.add(helper);
  const controller = new AbortController();
  catalogRequests.add(controller);
  const abort = () => { controller.abort(); helper.close().catch(() => {}); };
  const timer = setTimeout(abort, 24000);
  signal?.addEventListener('abort', abort, { once: true });
  const identity = { version: saved.version, deviceID: saved.deviceID, installID: saved.installID };
  const signing = spec => {
    const headers = Object.fromEntries(Object.entries(spec.headers).map(([name, value]) => [name.toLowerCase(), value]));
    return { ...spec, headers, headerLines: Object.entries(headers).flatMap(([name, value]) => [name, value]).join('\r\n') };
  };
  const current = () => {
    if (attempt !== generation) throw fail('signIn', t('账号已切换，请重试。'));
    if (controller.signal.aborted) throw fail('', t('汽水请求已取消，请重试。'));
  };
  let retained = false;
  try {
    if (method === 'stream') {
      const session = { ...saved, cookies: authStored(saved) };
      const grant = await requestJSON(session, '/luna/pc/track_v2', {
        body: { track_id: params.id, media_type: 'track', queue_type: 'favorite_track_playlist', scene_name: 'library' },
        signed: true, signal: controller.signal,
      }, {
        platform: host.platform, md5: text => host.crypto.md5(text),
        fetch: (url, options) => { current(); return fetch(url, options); },
        sign: async ({ signal: _signal, ...spec }) => {
          current();
          const frame = await helper.request({ op: 'music', method: 'sign', params: signing(spec), session: identity });
          current();
          return frame.result;
        },
      });
      current();
      params = { ...params, grant };
    } else if (method === 'sign') params = signing(params);
    current();
    const reply = await helper.request({ op: "music", method, params, session: identity });
    current();
    if (signal?.aborted) throw fail('', t('汽水请求已取消，请重试。'));
    if (persistent) {
      retained = true;
      retainedAudio.push(helper);
      // Retain recent URLs for downloads and seeks, bounding buffered audio.
      // Pending resolutions are never evicted by this completed-helper list.
      while (retainedAudio.length > 4) {
        const oldest = retainedAudio.shift();
        oldest.close().catch(() => {}).finally(() => musicHelpers.delete(oldest));
      }
    }
    return reply;
  } catch (error) {
    current();
    if (error.kind) throw authError(error.kind);
    throw error;
  } finally {
    clearTimeout(timer);
    catalogRequests.delete(controller);
    signal?.removeEventListener('abort', abort);
    if (!retained) {
      try { await helper.close(); } finally { musicHelpers.delete(helper); }
    }
  }
}

async function music(method, params = {}, persistent = false) {
  if (method === 'stream') return nativeMusic(method, params, persistent);
  const saved = host.storage.get(SESSION_KEY);
  if (!saved) throw fail('signIn', t('请先登录汽水音乐。'));
  const attempt = generation;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 24000);
  catalogRequests.add(controller);
  const current = () => {
    if (attempt !== generation) throw fail('signIn', t('账号已切换，请重试。'));
    if (controller.signal.aborted) throw authError('network');
  };
  const request = async (url, options) => {
    current();
    return fetch(url, options);
  };
  try {
    // Normalize legacy cookies and their scope before transmitting credentials.
    const session = { ...saved, cookies: authStored(saved) };
    const catalog = new Catalog(session, {
      state: catalogState,
      signal: controller.signal,
      uuid: () => authIdentity().portraitID.slice(0, -6),
      publicFetch: request,
      request: (session, path, options) => requestJSON(session, path, options, {
        fetch: request,
        platform: host.platform,
        md5: text => host.crypto.md5(text),
        sign: async ({ signal, ...spec }) => {
          current();
          const reply = await nativeMusic('sign', spec, false, signal);
          current();
          return reply.result;
        },
      }),
    });
    let result;
    switch (method) {
      case 'home': result = await catalog.home(); break;
      case 'playlists': result = await catalog.playlists(); break;
      case 'profile': result = await catalog.profile(); break;
      case 'playlist': result = await catalog.playlist(params.id); break;
      case 'artist': result = await catalog.artist(params.id); break;
      case 'album': result = await catalog.album(params.id); break;
      case 'suggest': result = await catalog.suggest(params.query); break;
      case 'recent': result = await catalog.recent(); break;
      case 'liked': result = await catalog.liked(params.offset); break;
      case 'isLiked': result = await catalog.isLiked(params.ids); break;
      case 'like': await catalog.like(params.id, params.on); break;
      case 'savePlaylist': await catalog.savePlaylist(params.id, params.on); break;
      case 'followArtist': await catalog.followArtist(params.id, params.on); break;
      case 'saveAlbum': await catalog.saveAlbum(params.id, params.on); break;
      case 'savedAlbums': result = await catalog.savedAlbums(params.offset); break;
      case 'movePlaylistTrack': await catalog.movePlaylistTrack(params.id, params.from, params.to); break;
      case 'createPlaylist': result = await catalog.createPlaylist(params.name); break;
      case 'renamePlaylist': await catalog.renamePlaylist(params.id, params.name); break;
      case 'deletePlaylist': await catalog.deletePlaylist(params.id); break;
      case 'addToPlaylist': await catalog.addToPlaylist(params.id, params.trackIds); break;
      case 'removeFromPlaylist': await catalog.removeFromPlaylist(params.id, params.trackIds); break;
      case 'comments': result = await catalog.comments(params); break;
      case 'likeComment': await catalog.likeComment(params); break;
      case 'postComment': result = await catalog.postComment(params); break;
      case 'played': await catalog.played(params.id); break;
      case 'search': return await catalog.search(params).then(reply => { current(); return reply; });
      case 'modes': result = await catalog.listeningModes(); break;
      case 'modePage': {
        if (!['scene-modes', 'listening-modes'].includes(params.page)) throw fail('unsupported', t('不支持此汽水页面。'));
        if (params.page === 'scene-modes') { result = scenePage(await catalog.listeningModes(), params.page); break; }
        const [modes, page] = await Promise.all([catalog.listeningModes(), catalog.discoveryPage()]);
        current();
        return { result: scenePage(modes, params.page, page.items), discovery: page.state, more: page.more };
      }
      case 'discover': {
        if (params.state == null) throw authError('response');
        const page = await catalog.discoveryPage(params.state);
        current();
        return { result: { title: '探索更多新模式', sections: [discoverySection(page.items)] }, discovery: page.state, more: page.more };
      }
      case 'radio': { const reply = await catalog.radioBatch(params); current(); return reply; }
      case 'feed': result = await catalog.recommendationBatch(params); break;
      case 'lyrics': result = await catalog.lyrics(params.id); break;
      default: throw fail('unsupported', t('暂不支持此操作。'));
    }
    current();
    return { result };
  } catch (error) {
    if (attempt !== generation) throw fail('signIn', t('账号已切换，请重试。'));
    if (error.code !== undefined) throw error;
    if (error.kind === 'unsupported') throw fail('unsupported', t('暂不支持此操作，目前可以搜索歌曲、浏览歌单和推荐。'));
    if (error.kind === 'response' && method === 'artist') throw fail('', t('暂时无法读取完整歌手主页，请稍后重试。'));
    if (error.kind === 'response' && method === 'album') throw fail('', t('暂时无法读取专辑内容，请稍后重试。'));
    if (error.kind === 'network' && method === 'postComment') throw fail('', t('未能确认评论是否发送成功，请先查看评论列表再决定是否重发。'));
    if (error.kind === 'response' && method === 'postComment') throw fail('', t('评论内容或返回结果异常。评论不能为空且最多 280 字；请先查看评论列表再决定是否重发。'));
    if (error.kind === 'response' && method === 'playlist') throw fail('', t(params.id === 'qishui:history' ? '暂时无法读取播放历史，请稍后重试。' : '暂时无法读取歌单内容，请稍后重试。'));
    throw authError(error.kind === 'canceled' ? 'network' : error.kind);
  } finally {
    clearTimeout(timer);
    catalogRequests.delete(controller);
    controller.abort();
  }
}

export async function home() { return (await music("home")).result; }
export async function playlists() { return (await music("playlists")).result; }
export async function playlist({ id }) { return (await music("playlist", { id })).result; }
export async function artist({ id }) { return (await music("artist", { id })).result; }
export async function album({ id }) { return (await music('album', { id })).result; }
export async function suggest({ query }) { return (await music('suggest', { query })).result; }
export async function recent() { return (await music('recent')).result; }
export async function liked({ offset = 0 } = {}) { return (await music('liked', { offset })).result; }
export async function isLiked({ ids }) { return (await music('isLiked', { ids })).result; }
export async function like({ id, on }) { await music('like', { id, on }); }
export async function savePlaylist({ id, on }) { await music('savePlaylist', { id, on }); }
export async function followArtist({ id, on }) { await music('followArtist', { id, on }); }
export async function saveAlbum({ id, on }) { await music('saveAlbum', { id, on }); }
export async function savedAlbums({ offset = 0 } = {}) { return (await music('savedAlbums', { offset })).result; }
export async function movePlaylistTrack({ id, from, to }) { await music('movePlaylistTrack', { id, from, to }); }
export async function createPlaylist({ name }) { return (await music('createPlaylist', { name })).result; }
export async function renamePlaylist({ id, name }) { await music('renamePlaylist', { id, name }); }
export async function deletePlaylist({ id }) { await music('deletePlaylist', { id }); }
export async function addToPlaylist({ id, trackIds }) { await music('addToPlaylist', { id, trackIds }); }
export async function removeFromPlaylist({ id, trackIds }) { await music('removeFromPlaylist', { id, trackIds }); }
export async function comments({ trackId, offset = 0 }) { return (await music('comments', { trackId, offset })).result; }
export async function likeComment({ trackId, commentId, on }) { await music('likeComment', { trackId, commentId, on }); }
export async function postComment({ trackId, text }) { return (await music('postComment', { trackId, text })).result; }
// MyGO calls this after starting audio, including cache hits. Resolving a
// stream or prefetching it must never append a play to account history.
export async function played({ id }) { await music("played", { id }); }
const recommendationStation = () => ({ id: "recommendations", name: "播放推荐", description: "按当前账号持续推荐歌曲" });
const modeStation = mode => ({ id: mode.id, name: mode.name, description: mode.group, imageUrl: mode.imageUrl });

async function nextFeed(id) {
  if (typeof id !== "string" || !id || id.length > 512) throw fail("unsupported", t("不支持此听歌模式。"));
  const saved = host.storage.get(SESSION_KEY);
  if (!saved) throw fail("signIn", t("请先登录汽水音乐。"));
  let state = feedStates.get(id);
  if (!state) {
    if (feedStates.size >= 64) {
      for (const [key, previous] of feedStates) {
        if (!previous.pending) { feedStates.delete(key); break; }
      }
      if (feedStates.size >= 64) throw new Error(t("汽水请求过于频繁，请稍后重试。"));
    }
    state = { count: 0, played: [], pending: null, cursor: undefined, done: false };
    feedStates.set(id, state);
  }
  // Coalesce only the same station. Different modes never share a request queue
  // or wait behind another mode's network deadline.
  if (state.pending) return state.pending;
  if (state.done) return [];
  const params = { id, count: ++state.count, played: state.played };
  if (id.startsWith("radio:") && state.cursor !== undefined) params.cursor = state.cursor;
  if (id === "recommendations") {
    let firstUse = host.storage.get(FEED_FIRST_USE_KEY);
    if (!firstUse || firstUse.deviceID !== saved.deviceID || !Number.isSafeInteger(firstUse.time) || firstUse.time <= 0) {
      firstUse = { deviceID: saved.deviceID, time: Math.floor(Date.now() / 1000) };
      host.storage.set(FEED_FIRST_USE_KEY, firstUse);
      params.firstDeviceRequest = true;
    }
    params.firstUseTime = firstUse.time;
  }
  const attempt = generation;
  state.pending = (async () => {
    const reply = await music(id.startsWith("radio:") ? "radio" : "feed", params);
    if (attempt !== generation) throw fail("signIn", t("账号已切换，请重试。"));
    const tracks = reply.result;
    if (!Array.isArray(tracks)) throw new Error(t("汽水接口返回异常，请稍后重试。"));
    if (id.startsWith("radio:")) {
      if (reply.cursor !== undefined) state.cursor = reply.cursor;
      // A filtered video-only batch can be empty while the radio has more.
      // MyGO retries empty batches at most three times; preserve its cursor.
      state.done = reply.more === false;
    }
    const pending = new Map(state.played.map(track => [track.id, track]));
    for (const track of tracks) {
      pending.delete(track.id);
      pending.set(track.id, { id: track.id, duration: Math.floor(track.duration || 0) });
    }
    state.played = Array.from(pending.values()).slice(-30);
    return tracks;
  })().finally(() => { state.pending = null; });
  return state.pending;
}

export async function stations() {
  const modes = (await music("modes")).result;
  return [recommendationStation(), ...modes.filter(mode => mode.id === "preference:familiar" || mode.id === "preference:fresh").map(modeStation)];
}
export async function stationNext({ id }) { return nextFeed(id); }

function discoveryResult(reply) {
  const result = reply.result;
  if (reply.more && reply.discovery) {
    while (discoveryPages.size >= 100) discoveryPages.delete(discoveryPages.keys().next().value);
    const page = `listening-modes:more:${++browseSequence}`;
    discoveryPages.set(page, { state: reply.discovery, result: null, pending: null });
    // MyGO renders Links after the content and owns their card appearance.
    // A separate trailing section keeps this manual pagination out of the header.
    result.sections.push({ links: [{ title: t("换一批"), subtitle: t("查看另一批探索内容"), page }] });
  }
  return result;
}
export async function browse({ page }) {
  if (page === 'my-library') return (await music('profile')).result;
  if (page === "listening-modes" || page === "scene-modes") {
    const attempt = generation;
    const reply = await music("modePage", { page });
    if (attempt !== generation) throw fail("signIn", t("账号已切换，请重试。"));
    return discoveryResult(reply);
  }
  if (typeof page === "string" && /^listening-modes:more:[1-9]\d{0,14}$/.test(page)) {
    const saved = discoveryPages.get(page);
    if (!saved) throw fail("unsupported", t("此探索页面已过期，请重新打开听歌模式。"));
    if (saved.result) return saved.result;
    if (!saved.pending) {
      const attempt = generation;
      saved.pending = music("discover", { state: saved.state }).then(reply => {
        if (attempt !== generation) throw fail("signIn", t("账号已切换，请重试。"));
        saved.result = discoveryResult(reply);
        return saved.result;
      }).finally(() => { saved.pending = null; });
    }
    return saved.pending;
  }
  if (typeof page === "string" && /^recommendations(?::\d{1,15})?$/.test(page)) {
    const tracks = await nextFeed("recommendations");
    return { title: "推荐预览", subtitle: "在侧栏选择推荐，可持续听歌", sections: [
      { title: "更多推荐歌曲", tracks, morePage: `recommendations:${++browseSequence}` },
    ] };
  }
  throw fail("unsupported", t("不支持此汽水页面。"));
}
export async function lyrics({ id }) { return (await music("lyrics", { id })).result; }
export async function search({ query, kind = "tracks", offset = 0 }) {
  const attempt = generation;
  const key = JSON.stringify([query, kind, offset]);
  const cursor = offset === 0 ? undefined : searchCursors.get(key);
  const reply = await music("search", { query, kind, offset, cursor });
  if (attempt === generation && reply.result.more && reply.cursor) {
    if (searchCursors.size >= 100) searchCursors.clear();
    searchCursors.set(JSON.stringify([query, kind, reply.nextOffset]), reply.cursor);
  }
  return reply.result;
}
export async function stream({ id, quality = "high" }) {
  // Keep the helper alive while MyGO downloads its private loopback URL.
  return (await music("stream", { id, quality }, true)).result;
}
