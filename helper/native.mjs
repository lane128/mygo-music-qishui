// Official SDK runs offline, without access to account files or persistent writes.
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pluginRoot } from './runtime.mjs'
import { error } from './protocol.mjs'
import { createWindowsNative } from './windows-native.mjs'

const windows = createWindowsNative()

const MAX_AUDIO = 128 * 1024 * 1024
const signScript = `
const fs = require('node:fs');
try {
 const req = JSON.parse(fs.readFileSync(0, 'utf8'));
 const sdk = require(process.argv[1]);
 sdk.init({deviceId:req.did});
 const pairs = sdk.generateHttpSignatureHeaders(req.url,
   Object.entries(req.headers).flatMap(([name,value])=>[name,value]).join('\\r\\n')).split('\\r\\n').filter(Boolean);
 const headers = {};
 for(let i=0;i+1<pairs.length;i+=2) if(/^x-(helios|medusa)$/i.test(pairs[i])) headers[pairs[i].toLowerCase()]=pairs[i+1];
 fs.writeSync(1,JSON.stringify(headers)); process.exit(0);
} catch { process.exit(1); }
`

function quote(value) { return JSON.stringify(value) }

export function sandboxPolicy(root, readable, home = homedir()) {
  // Seatbelt matches canonical paths; macOS TMPDIR commonly begins with /var,
  // whose real location is /private/var. An unexpanded deny can silently miss.
  root = realpathSync(root)
  home = realpathSync(home)
  readable = readable.map(file => realpathSync(file))
  const ancestors = new Set()
  for (const file of readable) {
    for (let parent = path.dirname(file); parent !== path.dirname(parent); parent = path.dirname(parent)) {
      if (parent === home || parent.startsWith(home + path.sep)) ancestors.add(parent)
    }
  }
  // Node resolves an absolute addon with lstat on each ancestor. Permit only
  // ancestor metadata; directory listings and account contents remain denied.
  const exceptions = [...readable, ...ancestors].map(file => `(require-not (literal ${quote(file)}))`).join(' ')
  return '(version 1)\n(allow default)\n(deny network*)\n' +
    `(deny file-read* (require-all (subpath ${quote(home)}) ${exceptions}))\n` +
    [...ancestors].map(dir => `(deny file-read-data (literal ${quote(dir)}))\n`).join('') +
    '(deny file-read* (subpath "/Library/Keychains"))\n' +
    `(deny file-write* (require-not (subpath ${quote(root)})))\n`
}

function run(command, args, { input, limit, root, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(error('canceled'))
    const child = spawn(command, args, {
      cwd: root, env: { PATH: '/usr/bin:/bin', TMPDIR: root, LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const chunks = []
    let size = 0, failed = false
    const stop = () => { failed = true; child.kill('SIGKILL') }
    const timer = setTimeout(stop, 22000)
    signal?.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size > limit) stop()
      else chunks.push(chunk)
    })
    child.stdin.on('error', () => {})
    child.once('error', () => { failed = true })
    child.once('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (failed || code !== 0) reject(error(signal?.aborted ? 'canceled' : 'unavailable'))
      else resolve(Buffer.concat(chunks))
    })
    child.stdin.end(input)
  })
}

async function regular(file) {
  try {
    const resolved = await realpath(file)
    if (!(await stat(resolved)).isFile()) throw error('setup')
    return resolved
  } catch { throw error('setup') }
}

async function isolated(operation) {
  let root
  try {
    if (process.platform !== 'darwin') throw error('setup')
    root = await mkdtemp(path.join(tmpdir(), 'qishui-audio-'))
    return await operation(root)
  } catch (cause) {
    // Never expose subprocess stderr, local paths, signed URLs or authorization.
    throw error(['setup', 'canceled'].includes(cause?.kind) ? cause.kind : 'unavailable')
  } finally {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

export async function signRequest({ url, headers, did, signal }) {
  if (process.platform === 'win32') return windows.signRequest({ url, headers, did, signal }, signScript)
  return isolated(async root => {
    const node = await regular(process.execPath)
    const module = await regular(path.join(pluginRoot, 'runtime/native/bdms.node'))
    const library = await regular(path.join(pluginRoot, 'runtime/native/libMetaSecML.dylib'))
    const flat = {}
    for (const [key, value] of Object.entries(headers)) flat[key.toLowerCase()] = String(value)
    const output = await run('/usr/bin/sandbox-exec', [
      '-p', sandboxPolicy(root, [node, module, library]), node, '-e', signScript, module,
    ], { input: JSON.stringify({ url, headers: flat, did }), root, signal, limit: 65536 })
    const signed = JSON.parse(output.toString('utf8'))
    const keys = Object.keys(signed)
    if (keys.length !== 2 || !keys.includes('x-helios') || !keys.includes('x-medusa') ||
      keys.some(key => typeof signed[key] !== 'string' || !signed[key] || /[\r\n\0]/.test(signed[key]))) throw error('unavailable')
    return signed
  })
}

export async function decodeResource(data, auth, { signal } = {}) {
  if (process.platform === 'win32') return windows.decodeResource(data, auth, { signal })
  if (!Buffer.isBuffer(data) || data.length > MAX_AUDIO || typeof auth !== 'string' || auth.length > 4096) throw error('unavailable')
  return isolated(async root => {
    const node = await regular(process.execPath)
    // Pass our reviewed interpreter as source; the child needs no project reads.
    const script = await readFile(new URL('./resource.cjs', import.meta.url), 'utf8')
    return run('/usr/bin/sandbox-exec', ['-p', sandboxPolicy(root, [node]), node, '-e', script, '--', '--decode'], {
      input: JSON.stringify({ audio: data.toString('base64'), auth }), limit: MAX_AUDIO, root, signal,
    })
  })
}

export async function convertAAC(data, { signal } = {}) {
  if (process.platform === 'win32') return windows.convertAAC(data, { signal })
  if (!Buffer.isBuffer(data) || data.length > MAX_AUDIO) throw error('unavailable')
  return isolated(async root => {
    const converter = await regular(path.join(pluginRoot, 'runtime/native/audio-convert'))
    const input = path.join(root, 'input.m4a'), output = path.join(root, 'output.flac')
    await writeFile(input, data, { mode: 0o600 })
    // The converter can read its own private input but never the account home.
    await run('/usr/bin/sandbox-exec', ['-p', sandboxPolicy(root, [converter, input]), converter, input, output], {
      input: Buffer.alloc(0), limit: 4096, root, signal,
    })
    const info = await stat(output)
    if (info.size <= 0 || info.size > MAX_AUDIO) throw error('unavailable')
    return readFile(output)
  })
}
