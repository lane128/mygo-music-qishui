// MyGO runs this file in its JavaScript sandbox. Node and Chrome are used only
// by the helper; credentials pass over stdin/stdout, never command arguments.
const SESSION_KEY = "session";
const t = host.t || ((text) => text);
let generation = 0;
let active = null;

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
  return {
    async request(spec, ms = 25000) {
      if (closed) throw new Error(t("登录已取消，请重试。"));
      process.write(JSON.stringify(spec) + "\n");
      const raw = await deadline(process.readLine(), ms, t("汽水登录请求超时，请重试。"));
      let frame;
      try { frame = JSON.parse(raw); } catch { /* Do not expose worker output. */ }
      if (!frame || typeof frame !== "object") throw new Error(t("汽水登录辅助进程已停止，请重试。"));
      if (!frame.ok) {
        const messages = {
          setup: "登录组件无法启动，请重新安装完整的插件 ZIP。",
          browserMissing: "未找到 Chrome 浏览器，请安装 Google Chrome 后重新登录。",
          signature: "汽水登录签名未生成，请检查登录组件版本。",
          rateLimit: "汽水请求过于频繁，请稍后重新登录。",
          verify: "汽水要求额外验证，请先在官方 App 完成验证后重试。",
          expired: "二维码已过期，请重新登录。",
          rejected: "汽水拒绝了本次登录，请稍后重试。",
          session: "未取得有效的汽水登录态，请重新登录。",
          network: "无法连接汽水音乐，请检查网络后重试。",
          response: "汽水接口返回异常，请稍后重试。",
        };
        throw fail(["setup", "browserMissing"].includes(frame.error) ? "setup" : frame.error === "session" ? "signIn" : "",
          t(messages[frame.error] || "汽水登录失败，请重试。"));
      }
      return frame;
    },
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
        // A single write replaces credentials only after a real account lookup.
        host.storage.set(SESSION_KEY, { ...result.session, account: result.account });
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
      host.storage.remove(SESSION_KEY);
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
  if (helper) await helper.close();
}
