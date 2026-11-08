// Run: node native/signer/validate.mjs [--sdk /absolute/verified/native/dir]
// Build-time tooling only. SDK always runs under Seatbelt; values stay in pipes
// and parent memory. No account files, network, raw stderr or signatures printed.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSigner } from './build.mjs'
const root = path.dirname(fileURLToPath(import.meta.url))
const did = '1234567890123456'
export function frame({ did, url, headerLines }) {
  return Buffer.concat([did, url, headerLines].flatMap(s => { const b = Buffer.from(s); const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return [n, b] }))
}
const request = endpoint => ({ did, url: `https://api.qishui.com${endpoint}?aid=386088&app_name=luna_pc&device_id=${did}&fp=${did}`, headerLines: 'accept\r\napplication/json\r\nuser-agent\r\nLunaPC/3.7.0(452316191)' })
const endpoints = ['/luna/pc/feed/mode', '/luna/pc/feed/song-tab', '/luna/pc/discover', '/luna/pc/discover/mix', '/luna/pc/feed/radio/tracks', '/luna/pc/me/recently-played-media', '/luna/pc/track_v2', '/luna/pc/comments', '/luna/pc/me/playlist', ...(await import('../../helper/catalog-core.mjs')).libraryWritePaths]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function run(file, args, input, cwd) {
  const r = spawnSync(file, args, { input, cwd, timeout: 20000, maxBuffer: 131072, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: cwd } })
  assert.ifError(r.error); assert.equal(r.signal, null, 'Unexpected process signal; output withheld')
  return r
}
function validOutput(bytes) {
  assert.ok(bytes.length > 0 && bytes.length <= 65536)
  const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const p = s.split('\r\n'); if (p.at(-1) === '') p.pop()
  assert.ok(p.length > 0 && p.length % 2 === 0 && p.length <= 128)
  const names = new Set()
  for (let i = 0; i < p.length; i += 2) {
    assert.ok(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(p[i]) && p[i + 1].length > 0 && !/[\r\n\0]/.test(p[i + 1]), 'Invalid header structure; values withheld')
    const name = p[i].toLowerCase(); assert.ok(!names.has(name), 'Duplicate output header'); names.add(name)
  }
  assert.ok(names.has('x-helios') && names.has('x-medusa'), 'Required headers absent; values withheld')
}
async function main() {
  assert.equal(process.platform, 'darwin', 'Native execution validation currently requires macOS arm64')
  assert.equal(process.arch, 'arm64')
  const args = process.argv.slice(2)
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--sdk' && path.isAbsolute(args[1])))
  const scratch = await mkdtemp(path.join(root, '.validation-'))
  const executable = path.join(scratch, 'signer')
  try {
    const build = await buildSigner({ platform: 'darwin', arch: 'arm64', output: executable })
    await assert.rejects(buildSigner({ platform: 'darwin', arch: 'arm64', output: executable }), /already exists/)
    await assert.rejects(buildSigner({ platform: 'windows', arch: 'arm64', output: path.join(scratch, 'unsupported') }), /Unsupported/)
    const unit = path.join(scratch, 'boundary-tests')
    const compile = run('/usr/bin/clang++', ['-std=c++17', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', path.join(root, 'include'), path.join(root, 'signer.test.cpp'), '-o', unit], undefined, root)
    assert.equal(compile.status, 0, 'Boundary test build failed')
    assert.equal(run(unit, [], undefined, scratch).status, 0, 'ASan/UBSan boundary tests failed; output withheld')
    const base = request(endpoints[0]), valid = frame(base)
    const malformed = [Buffer.alloc(0), Buffer.from('{}'), valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from([0])]), Buffer.alloc(131073), Buffer.from([255, 255, 255, 255])]
    const invalidRequests = [
      { ...base, did: did.slice(1) }, { ...base, did: did + '1' }, { ...base, did: '١٢٣٤٥٦٧٨٩٠١٢٣٤٥٦' },
      { ...base, url: base.url.replace('https:', 'http:') }, { ...base, url: base.url.replace('api.qishui.com', 'example.com') },
      { ...base, url: base.url.replace('api.qishui.com', 'api.qishui.com.evil') }, { ...base, url: base.url.replace('api.qishui.com', 'api.qishui.com:444') },
      { ...base, url: base.url.replace('api.qishui.com', 'x@api.qishui.com') }, { ...base, url: base.url + '#fragment' },
      { ...base, url: base.url.replace(endpoints[0], '/unlisted') }, { ...base, url: base.url.replace(did, '1234567890123457') },
      { ...base, url: base.url + '&%64evice_id=' + did }, { ...base, url: base.url + '&q=%00' },
      { ...base, headerLines: 'bad name\r\nvalue' }, { ...base, headerLines: 'x\r\nv\ninjected' }, { ...base, headerLines: 'x\r\nv\0' },
      { ...base, headerLines: 'x' }, { ...base, headerLines: '' }, { ...base, headerLines: 'x\r\nv\r\n' },
      { ...base, headerLines: Array.from({ length: 65 }, (_, i) => `x-${i}\r\nv`).join('\r\n') }, { ...base, headerLines: 'x\r\n' + 'a'.repeat(65536) },
    ]
    malformed.push(...invalidRequests.map(frame))
    for (const input of malformed) { const r = run(executable, [], input, scratch); assert.equal(r.status, 64); assert.equal(r.stdout.length, 0); assert.equal(r.stderr.toString(), 'signer: invalid input\n') }
    const cli = run(executable, ['unexpected'], valid, scratch); assert.equal(cli.status, 64); assert.equal(cli.stdout.length, 0)
    const missing = run(executable, [], valid, scratch); assert.equal(missing.status, 70); assert.equal(missing.stdout.length, 0); assert.equal(missing.stderr.toString(), 'signer: SDK load failed\n')
    let sdkCases = 0, sdkHashes
    if (args.length) {
      const sdk = await realpath(args[1])
      const files = ['bdms.node', 'libMetaSecML.dylib']
      sdkHashes = await Promise.all(files.map(async name => sha(await readFile(path.join(sdk, name)))))
      for (const name of files) await copyFile(path.join(sdk, name), path.join(scratch, name))
      const allow = [executable, ...files.map(name => path.join(scratch, name))]
      const home = await realpath(homedir())
      const ancestors = new Set()
      for (const file of allow) for (let parent = path.dirname(file); parent !== path.dirname(parent); parent = path.dirname(parent)) if (parent === home || parent.startsWith(home + path.sep)) ancestors.add(parent)
      const readable = [...allow, ...ancestors]
      const policy = '(version 1)\n(allow default)\n(deny network*)\n' +
        `(deny file-read* (require-all (subpath ${JSON.stringify(home)}) ${readable.map(p => `(require-not (literal ${JSON.stringify(p)}))`).join(' ')}))\n` +
        [...ancestors].map(p => `(deny file-read-data (literal ${JSON.stringify(p)}))\n`).join('') +
        '(deny file-read* (subpath "/Library/Keychains"))\n' +
        '(deny file-write* (require-not (literal "/dev/null")))\n' +
        `(deny process-exec (require-not (literal ${JSON.stringify(executable)})))\n`
      const sandbox = (input, extra = '') => run('/usr/bin/sandbox-exec', ['-p', policy + extra, executable], input, scratch)
      const successes = endpoints.map(request)
      successes.push({ ...base, headerLines: 'x-research\r\n测试 Café 🎵', url: base.url + '&research=%E6%B5%8B%E8%AF%95' })
      successes.push({ ...base, headerLines: Array.from({ length: 64 }, (_, i) => `x-research-${i}\r\nvalue-${i}`).join('\r\n') })
      for (const req of successes) { const r = sandbox(frame(req)); assert.equal(r.status, 0, /^signer: SDK [a-z ]+\n$/.test(r.stderr.toString()) ? r.stderr.toString().trim() : 'Sandboxed SDK failed; output withheld'); assert.equal(r.stderr.length, 0); validOutput(r.stdout); sdkCases++ }
      for (let i = 0; i < 5; i++) { const r = sandbox(valid); assert.equal(r.status, 0); validOutput(r.stdout); sdkCases++ }
      for (const name of files) { const r = sandbox(valid, `(deny file-read* (literal ${JSON.stringify(path.join(scratch, name))}))`); assert.equal(r.status, 70); assert.equal(r.stdout.length, 0); assert.equal(r.stderr.toString(), 'signer: SDK load failed\n') }
      for (const req of [{ ...base, url: `https://api.qishui.com${endpoints[0]}?device_id=${did}` }]) { const r = sandbox(frame(req)); assert.equal(r.status, 70); assert.equal(r.stdout.length, 0); assert.equal(r.stderr.toString(), 'signer: SDK output rejected\n') }
      assert.deepEqual(await Promise.all(files.map(async name => sha(await readFile(path.join(sdk, name))))), sdkHashes)
      assert.deepEqual(await Promise.all(files.map(async name => sha(await readFile(path.join(scratch, name))))), sdkHashes)
    }
    console.log(JSON.stringify({ build, addressAndUndefinedSanitizers: 'passed', malformedInputsRejected: malformed.length, cliRejected: true, missingSdkControlled: true, sdkCases, sdkHashes, sdkSeatbelt: sdkCases > 0, upstreamAcceptance: 'not tested', windowsExecution: 'not tested' }))
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
