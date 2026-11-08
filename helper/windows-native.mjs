// Windows-only native work runs in a fresh AppContainer and kill-on-close Job.
// Runtime files are copied to private scratch; installed files/ACLs are untouched.
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pluginRoot } from './runtime.mjs'
import { error } from './protocol.mjs'

const MAX_AUDIO = 128 * 1024 * 1024

export function createWindowsNative({ plugin = pluginRoot, node = process.execPath, platform = process.platform, arch = process.arch, spawnProcess = spawn } = {}) {
  async function regular(file) {
    try {
      const actual = await realpath(file)
      if (!(await stat(actual)).isFile()) throw error('setup')
      return actual
    } catch { throw error('setup') }
  }
  async function isolated(program, files, operation, signal) {
    let root
    try {
      if (platform !== 'win32' || arch !== 'x64') throw error('setup')
      if (signal?.aborted) throw error('canceled')
      const launcher = await regular(path.join(plugin, 'runtime/native/windows-runner.exe'))
      const executable = await regular(node)
      root = await mkdtemp(path.join(tmpdir(), 'qishui-windows-'))
      const staged = path.join(root, program + '.exe')
      await copyFile(executable, staged)
      for (const name of files) await copyFile(await regular(path.join(plugin, 'runtime/native', name)), path.join(root, name))
      if (signal?.aborted) throw error('canceled')
      const run = (args, input, limit) => launch(launcher, staged, root, args, input, limit, signal)
      return await operation(root, run)
    } catch (cause) {
      throw error(signal?.aborted || cause?.kind === 'canceled' ? 'canceled' : cause?.kind === 'setup' ? 'setup' : 'unavailable')
    } finally {
      // Windows handles must be closed before cleanup. Retry only filesystem
      // sharing violations, never a signing request or a playback authorization.
      if (root) {
        try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }) }
        catch { throw error('unavailable') }
      }
    }
  }
  function launch(launcher, executable, root, args, input, limit, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(error('canceled')); return }
      const child = spawnProcess(launcher, ['--root', root, '--parent', String(process.pid), '--timeout-ms', '22000', '--', executable, ...args], {
        cwd: root, windowsHide: true, shell: false,
        env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', TEMP: root, TMP: root },
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      const chunks = []
      let size = 0, failed = false, launchFailed = false, stopping = false, forced
      const stop = () => {
        failed = true
        if (stopping) return
        stopping = true
        // A marker lets the launcher close its Job and delete its profile first.
        writeFile(path.join(root, '.cancel'), '').catch(() => child.kill('SIGKILL'))
        forced = setTimeout(() => child.kill('SIGKILL'), 2000)
      }
      const timer = setTimeout(stop, 22500)
      signal?.addEventListener('abort', stop, { once: true })
      child.stdout.on('data', chunk => {
        size += chunk.length
        if (size > limit) stop()
        else chunks.push(chunk)
      })
      child.stdin.on('error', () => {})
      child.once('error', () => { failed = true; launchFailed = true })
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(forced)
        signal?.removeEventListener('abort', stop)
        if (failed || code !== 0) reject(error(signal?.aborted ? 'canceled' : launchFailed || code === 125 ? 'setup' : 'unavailable'))
        else resolve(Buffer.concat(chunks))
      })
      child.stdin.end(input)
      if (signal?.aborted) stop()
    })
  }
  return {
    async signRequest(spec, script) {
      return isolated('node', ['bdms.node', 'metasecml.dll'], async (root, run) => {
        const output = await run(['-e', script, path.join(root, 'bdms.node')], JSON.stringify({ url: spec.url, headers: spec.headers, did: spec.did }), 65536)
        const signed = JSON.parse(output.toString('utf8'))
        const names = Object.keys(signed)
        if (names.length !== 2 || !names.includes('x-helios') || !names.includes('x-medusa') ||
            Object.values(signed).some(value => typeof value !== 'string' || !value || /[\r\n\0]/.test(value))) throw error('unavailable')
        return signed
      }, spec.signal)
    },
    async decodeResource(data, auth, { signal } = {}) {
      if (!Buffer.isBuffer(data) || data.length > MAX_AUDIO || typeof auth !== 'string' || auth.length > 4096) throw error('unavailable')
      return isolated('node', [], async (root, run) => {
        const script = await readFile(path.join(plugin, 'helper/resource.cjs'))
        const decoder = path.join(root, 'resource.cjs')
        await writeFile(decoder, script, { mode: 0o600 })
        return run([decoder, '--decode'], JSON.stringify({ audio: data.toString('base64'), auth }), MAX_AUDIO)
      }, signal)
    },
  }
}
