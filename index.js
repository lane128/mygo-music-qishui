// MyGO runs this file in its JavaScript sandbox. Node and Chrome are used only
// by the helper; credentials pass over stdin/stdout, never command arguments.
const SESSION_KEY = "session";
const t = host.t || ((text) => text);
let generation = 0;
let active = null;
const retainedAudio = [];
const musicHelpers = new Set();
const searchCursors = new Map();
const feedStates = new Map();
const FEED_FIRST_USE_KEY = "feed-first-use";
let browseSequence = 0;

async function closeMusic() {
  retainedAudio.length = 0;
  searchCursors.clear();
  feedStates.clear();
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
    const executable = `bin/node-${host.platform}-${host.arch}${host.platform === "windows" ? ".exe" : ""}`;
    process = host.spawn(executable, ["helper/worker.mjs"]);
  } catch {
    throw fail("setup", t("请允许插件启动程序，并安装适合当前系统的插件 ZIP。"));
  }
  let closed = false;
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
          browserMissing: "未找到 Chrome 浏览器，请安装 Google Chrome 后重新登录。",
          signature: "汽水签名未生成，请检查插件组件版本。",
          rateLimit: "汽水请求过于频繁，请稍后重试。",
          verify: "汽水要求额外验证，请先在官方 App 完成验证后重试。",
          expired: "二维码已过期，请重新登录。",
          rejected: "汽水拒绝了本次请求，请稍后重试。",
          session: "未取得有效的汽水登录态，请重新登录。",
          network: "无法连接汽水音乐，请检查网络后重试。",
          response: "汽水接口返回异常，请稍后重试。",
          unsupported: "暂不支持此操作，目前可以搜索歌曲、浏览歌单和推荐。",
          unavailable: "当前账号无法播放这首歌曲，或获准的音频格式暂不支持。",
          preview: "当前账号仅获准试听，请在汽水音乐官方 App 查看播放权限。",
        };
        throw fail(["setup", "browserMissing"].includes(frame.error) ? "setup" : frame.error === "session" ? "signIn" : ["unavailable", "preview"].includes(frame.error) ? "unavailable" : frame.error === "unsupported" ? "unsupported" : "",
          t(messages[frame.error] || "汽水登录失败，请重试。"));
      }
      return frame;
      });
      queue = response.catch(() => {});
      return response;
    },
    get closed() { return closed; },
    async close() {
      if (closed) return;
      closed = true;
      process.closeStdin();
      try {
        // Startup cancellation may need to finish Chrome's 10-second launch.
        await deadline(process.wait(), 20000, "close");
      } catch {
        process.kill();
      }
    },
  };
}

export async function signIn() {
  const attempt = ++generation;
  const loginDeadline = Date.now() + 240000;
  await closeMusic();
  if (active) await active.close();
  if (attempt !== generation) throw new Error(t("登录已取消，请重试。"));
  const helper = startHelper();
  active = helper;
  const current = () => {
    if (attempt !== generation) throw new Error(t("登录已取消，请重试。"));
  };
  try {
    const started = await helper.request({ op: "start" }, 60000);
    current();
    host.signInPrompt({ qr: started.qr, text: t("请使用汽水音乐 App 扫码，并在手机上确认登录。") });
    const until = Math.min(loginDeadline, Date.now() + Math.min(started.expiresIn || 240000, 210000));
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      current();
      const result = await helper.request({ op: "check" });
      current();
      if (result.status === "confirmed") {
        if (!result.session || !result.account || !result.account.id) throw new Error(t("汽水接口返回异常，请稍后重试。"));
        // Music may have started with the old account while this QR was open.
        // Invalidate those replies at the moment the validated session changes.
        const committed = ++generation;
        host.storage.set(SESSION_KEY, { ...result.session, account: result.account });
        await closeMusic();
        if (committed !== generation) throw new Error(t("登录已取消，请重试。"));
        return result.account;
      }
      if (result.status === "scanned") {
        host.signInPrompt({ qr: started.qr, text: t("已扫码，请在手机上确认登录。") });
      }
    }
    throw new Error(t("二维码已过期，请重新登录。"));
  } finally {
    await helper.close();
    if (active === helper) active = null;
  }
}

export async function account() {
  const saved = host.storage.get(SESSION_KEY);
  if (!saved) return null;
  const attempt = generation;
  const helper = startHelper();
  try {
    const result = await helper.request({ op: "account", session: saved });
    if (attempt !== generation) return null;
    return result.account;
  } catch (error) {
    if (attempt !== generation) return null;
    // A failed network request does not discard credentials. An invalid session
    // is removed only if another login has not replaced it in the meantime.
    if (error.code === "signIn" && attempt === generation) {
      ++generation;
      host.storage.remove(SESSION_KEY);
      await closeMusic();
      return null;
    }
    throw error;
  } finally {
    await helper.close();
  }
}

export async function signOut() {
  ++generation;
  host.storage.remove(SESSION_KEY);
  const helper = active;
  active = null;
  await Promise.all([helper?.close(), closeMusic()]);
}

async function music(method, params = {}, persistent = false) {
  const saved = host.storage.get(SESSION_KEY);
  if (!saved) throw fail("signIn", t("请先登录汽水音乐。"));
  const attempt = generation;
  // MyGO can prefetch while another track resolves. Independent helpers keep
  // each request within the host deadline, without waiting behind another song.
  const helper = startHelper();
  musicHelpers.add(helper);
  let retained = false;
  try {
    const reply = await helper.request({ op: "music", method, params, session: saved });
    if (attempt !== generation) throw fail("signIn", t("账号已切换，请重试。"));
    if (persistent) {
      retained = true;
      retainedAudio.push(helper);
      // Retain recent URLs for downloads and seeks, bounding buffered audio.
      // Pending resolutions are never evicted by this completed-helper list.
      while (retainedAudio.length > 4) {
        const oldest = retainedAudio.shift();
        musicHelpers.delete(oldest);
        oldest.close().catch(() => {});
      }
    }
    return reply;
  } finally {
    if (!retained) { musicHelpers.delete(helper); await helper.close(); }
  }
}

export async function home() { return (await music("home")).result; }
export async function playlists() { return (await music("playlists")).result; }
export async function playlist({ id }) { return (await music("playlist", { id })).result; }
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
    state = { count: 0, played: [], pending: null };
    feedStates.set(id, state);
  }
  // Coalesce only the same station. Different modes never share a request queue
  // or wait behind another mode's network deadline.
  if (state.pending) return state.pending;
  const params = { id, count: ++state.count, played: state.played };
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
    const reply = await music("feed", params);
    if (attempt !== generation) throw fail("signIn", t("账号已切换，请重试。"));
    const tracks = reply.result;
    if (!Array.isArray(tracks)) throw new Error(t("汽水接口返回异常，请稍后重试。"));
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
  return [recommendationStation(), ...modes.map(modeStation)];
}
export async function stationNext({ id }) { return nextFeed(id); }
export async function browse({ page }) {
  if (page === "listening-modes") {
    const modes = (await music("modes")).result;
    const groups = new Map();
    for (const mode of modes) {
      const group = groups.get(mode.group) || [];
      group.push(modeStation(mode));
      groups.set(mode.group, group);
    }
    return { title: "听歌模式", subtitle: "按心情和场景听歌，点击模式开始持续播放", sections: Array.from(groups, ([title, stations]) => ({ title, stations })) };
  }
  if (typeof page === "string" && /^recommendations(?::\d{1,15})?$/.test(page)) {
    const tracks = await nextFeed("recommendations");
    return { title: "推荐", sections: [
      { stations: [recommendationStation()] },
      { tracks, links: [{ title: "换一批", page: `recommendations:${++browseSequence}` }] },
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
