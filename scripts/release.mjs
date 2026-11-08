#!/usr/bin/env node
// Local release preparation for the MyGO Qishui plugin.
//
// The single stable entry for planning, checking and preparing a local
// candidate. It never commits, pushes, tags, publishes or talks to a live
// account. Existing build, test, package and host-test entry points remain the
// implementation; this file only sequences them, fingerprints their inputs and
// records a local report.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const selfPath = fileURLToPath(import.meta.url)
export const defaultRoot = fileURLToPath(new URL('..', import.meta.url))

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
export const VERSION_FILES = ['plugin.json', 'package.json', 'package-lock.json']
export const DOC_FILES = new Set(['README.md', 'NOTICE.md', 'PLAYBACK-HISTORY.md', 'VALIDATION.md', 'RELEASE.md', 'CLAUDE.md'])
export const GENERATED_OUTPUT_NAMES = new Set(['report.json', 'report.json.tmp', 'logs', 'extracted', 'overlays'])
export const HOST_TEST_FIXTURES = [
  ['host_integration_test.go', 'qishui_release_external_test.go'],
  ['host_release_test.go', 'qishui_release_verify_test.go'],
  ['host_windows_package_test.go', 'qishui_release_winpackage_test.go'],
  ['host_darwin_package_test.go', 'qishui_release_macpackage_test.go'],
]
export const HOST_TEST_NAMES = [
  'TestQishuiPluginRuntime',
  'TestQishuiPluginNetworkOnlyLogin',
  'TestQishuiPluginZipInstall',
  'TestQishuiWindowsPackageInstall',
  'TestQishuiDarwinAMD64PackageInstall',
  'TestQishuiReleaseRuntimeLayout',
]
export const HOST_TEST_PATTERN = '^TestQishui(Plugin(Runtime|NetworkOnlyLogin|ZipInstall)|WindowsPackageInstall|DarwinAMD64PackageInstall|ReleaseRuntimeLayout)$'
export const NATIVE_IPC_TESTS = [
  'TestAudioBridgeHTTP',
  'TestBridgeBoundsTTLAndClose',
  'TestIPCInvalidLinesContinue',
  'TestEOFStopsActiveRequestAndBridge',
  'TestEOFCancelsBlockedResponseWrite',
  'TestStartupIdleAndParentCancellation',
]
export const PLATFORM_TARGETS = [
  { name: 'darwin-arm64', platform: 'darwin', arch: 'arm64', target: 'darwin-arm64', windows: false },
  { name: 'windows-amd64', platform: 'windows', arch: 'amd64', target: 'windows-amd64', windows: true },
  { name: 'darwin-amd64', platform: 'darwin', arch: 'amd64', target: 'darwin-amd64', windows: false },
  { name: 'windows-arm64', platform: 'windows', arch: 'arm64', target: 'windows-arm64', windows: true },
]

const SOURCE_EXCLUSIONS = /^(?:dist|node_modules|\.git|\.claude)(?:\/|$)/
const AUDIO_PATH = /(?:^|\/)[^/]*(?:audio|gapless|ffmpeg|aac|flac|decoder|convert|playback|media)[^/]*$/i
const AUTH_PATH = /(?:^|\/)[^/]*(?:auth|login|session|account|membership|member|profile|cookie)[^/]*$/i
const COMPATIBILITY_FILES = new Set([
  'plugin.json', 'helper/protocol.mjs', 'helper/client-profile.mjs',
  'helper/catalog-core.mjs',
  'scripts/package.mjs', 'scripts/package-layout.mjs', 'scripts/runtime-assets.mjs',
])
const TOOLCHAIN_FILES = new Set([
  'package.json', 'package-lock.json', 'scripts/build.mjs', 'scripts/build-native.mjs',
  'scripts/build-ffmpeg.mjs', 'scripts/ffmpeg-config.mjs', 'native/signer/build.mjs',
])

export class ReleaseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReleaseError'
  }
}

const sha256 = data => createHash('sha256').update(data).digest('hex')
export const fingerprint = value => sha256(Buffer.from(stableStringify(value)))

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
}

export async function sha256File(file) {
  return sha256(await readFile(file))
}

function safeMessage(error) {
  return String(error?.message || error || 'unknown error').replace(/\s+/g, ' ').slice(0, 600)
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new ReleaseError(label + ' is required')
  return value
}

function requireAbsolute(value, label) {
  if (!value || !path.isAbsolute(value)) throw new ReleaseError(label + ' must be an absolute path')
  return path.resolve(value)
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] || 0, y = right[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// Commands

export function createRunner({ cwd = process.cwd(), env = process.env } = {}) {
  return {
    async run(command, args, options = {}) {
      const {
        cwd: runCwd = cwd, env: overrides = {}, unset = [], log,
        timeout = 300000, maxBytes = 16 * 1024 * 1024,
      } = options
      const childEnv = { ...env, ...overrides }
      for (const key of unset) delete childEnv[key]
      const started = Date.now()
      let stdout = '', stderr = '', bytes = 0, overflow = false, timedOut = false, spawnError = null
      let settled = false
      const child = spawn(command, args, {
        cwd: runCwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
      })
      const collect = (chunk, stream) => {
        bytes += chunk.length
        if (bytes > maxBytes) {
          overflow = true
          child.kill('SIGKILL')
          return
        }
        if (stream === 'stdout') stdout += chunk.toString('utf8')
        else stderr += chunk.toString('utf8')
      }
      child.stdout.on('data', chunk => collect(chunk, 'stdout'))
      child.stderr.on('data', chunk => collect(chunk, 'stderr'))
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
      const status = await new Promise(resolve => {
        child.once('error', error => {
          spawnError = safeMessage(error)
          if (!settled) { settled = true; resolve(null) }
        })
        child.once('close', code => {
          if (!settled) { settled = true; resolve(code) }
        })
      }).finally(() => clearTimeout(timer))
      const text = stdout + stderr
      if (log) {
        await mkdir(path.dirname(log), { recursive: true })
        await writeFile(log, text)
      }
      return {
        command, args, status, stdout, stderr, text, overflow, timedOut, spawnError, log,
        durationMs: Date.now() - started,
      }
    },
  }
}

async function runGit(runner, root, args, { optional = false } = {}) {
  const result = await runner.run('git', ['-C', root, ...args], { cwd: root, timeout: 120000 })
  if (result.status !== 0) {
    if (optional) return null
    throw new ReleaseError('git ' + args.join(' ') + ' failed; the release entry needs a git checkout')
  }
  return result.stdout
}

export async function latestReleaseBase({ root, runner }) {
  const value = await runGit(runner, root, ['tag', '--merged', 'HEAD', '--list', 'v[0-9]*', '--sort=-version:refname'], { optional: true })
  const tag = value?.split('\n').find(name => /^v\d+\.\d+\.\d+$/.test(name))
  if (!tag) throw new ReleaseError('No reachable stable release tag found; pass --base explicitly')
  return tag
}

export async function resolveBase({ root, runner, base }) {
  const ref = base || await latestReleaseBase({ root, runner })
  const commit = (await runGit(runner, root, ['rev-parse', '--verify', ref + '^{commit}'])).trim()
  const head = (await runGit(runner, root, ['rev-parse', 'HEAD'])).trim()
  return { ref, commit, head }
}

// Changed tracked and untracked files since the release base; working-tree
// content is included, not only commits.
export async function collectChangedFiles({ root, runner, base }) {
  const diff = await runGit(runner, root, ['diff', '--name-status', '-z', '--no-renames', base, '--'])
  const untracked = await runGit(runner, root, ['ls-files', '--others', '--exclude-standard', '-z'])
  const changes = []
  const tokens = diff.split('\0').filter(Boolean)
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i], name = tokens[i + 1]
    if (!SOURCE_EXCLUSIONS.test(name)) changes.push({ path: name, status: status[0] })
  }
  for (const name of untracked.split('\0').filter(Boolean)) {
    if (!SOURCE_EXCLUSIONS.test(name)) changes.push({ path: name, status: '?' })
  }
  for (const change of changes) {
    if (![...VERSION_FILES, 'src/plugin.mjs'].includes(change.path) || change.status === 'D') continue
    const before = await runGit(runner, root, ['show', base + ':' + change.path], { optional: true })
    const after = await readFile(path.join(root, change.path), 'utf8').catch(() => null)
    if (before === null || after === null) { change.apiChanged = true; continue }
    if (VERSION_FILES.includes(change.path)) {
      change.versionOnly = normalizedDigest(change.path, before) === normalizedDigest(change.path, after)
    } else {
      const api = text => [...new Set([
        ...text.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g),
        ...text.matchAll(/\b(host(?:\.\w+)+)/g),
      ].map(match => match[1]))].sort()
      change.apiChanged = fingerprint(api(before)) !== fingerprint(api(after))
    }
  }
  const seen = new Set()
  return changes.filter(item => {
    const key = item.status + '\0' + item.path
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => a.path.localeCompare(b.path))
}

export async function collectSourceFiles({ root, runner }) {
  const output = await runGit(runner, root, ['ls-files', '-z', '-co', '--exclude-standard'])
  return [...new Set(output.split('\0').filter(Boolean))].sort()
}

function normalizedDigest(name, data) {
  if (VERSION_FILES.includes(name)) {
    try {
      const value = JSON.parse(data)
      delete value.version
      if (name === 'package-lock.json' && value.packages && value.packages['']) delete value.packages[''].version
      return sha256(Buffer.from(stableStringify(value)))
    } catch {}
  }
  return sha256(data)
}

// sourceFingerprint covers every relevant file, including documentation and
// version manifests. testFingerprint ignores documentation and normalises the
// three version fields so check results survive a version-only bump.
export async function computeSourceFingerprints(root, files) {
  const full = [], semantic = []
  for (const name of [...files].sort()) {
    if (SOURCE_EXCLUSIONS.test(name)) continue
    let data
    try {
      data = await readFile(path.join(root, name))
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error
      full.push([name, '-'])
      semantic.push([name, '-'])
      continue
    }
    full.push([name, sha256(data)])
    if (!DOC_FILES.has(name) && !name.endsWith('.md')) semantic.push([name, normalizedDigest(name, data)])
  }
  return {
    files: full.length,
    sourceFingerprint: fingerprint(full),
    testFingerprint: fingerprint(semantic),
  }
}

export function classifyChanges(changes) {
  const scopes = new Set()
  const scopesFor = name => {
    if (changes.find(change => change.path === name)?.versionOnly) return new Set(['package'])
    const found = new Set()
    if (DOC_FILES.has(name) || name.endsWith('.md') || name.startsWith('docs/')) return new Set(['docs'])
    if (TOOLCHAIN_FILES.has(name) || /(?:^|\/)go\.(?:mod|sum)$/.test(name) || /^native\/signer\/.*\.mjs$/.test(name)) {
      found.add('deps')
      found.add('package')
    }
    if (name.startsWith('native/') || name === 'helper/audio-convert.c' || name === 'scripts/build-native.mjs') found.add('native')
    if (AUDIO_PATH.test(name)) found.add('audio')
    if (AUTH_PATH.test(name) || name === 'src/plugin.mjs' || name === 'helper/protocol.mjs' || name === 'helper/catalog-core.mjs' || name === 'helper/comments.mjs') found.add('auth')
    if (COMPATIBILITY_FILES.has(name) || changes.find(change => change.path === name)?.apiChanged) found.add('compatibility')
    if (/\.(?:mjs|cjs|js)$/.test(name)) found.add('js')
    if ((name.startsWith('scripts/') || name.startsWith('package')) && !found.has('deps')) found.add('package')
    if (!found.size) found.add('other')
    return found
  }
  for (const change of changes) for (const scope of scopesFor(change.path)) scopes.add(scope)
  const order = ['docs', 'js', 'package', 'deps', 'auth', 'compatibility', 'native', 'audio', 'other']
  const list = order.filter(scope => scopes.has(scope))
  const relevant = changes.filter(change => !scopesFor(change.path).has('docs') || scopesFor(change.path).size > 1)
  return {
    scopes: list,
    native: scopes.has('native'),
    audio: scopes.has('audio'),
    auth: scopes.has('auth'),
    compatibility: scopes.has('compatibility'),
    deps: scopes.has('deps'),
    docsOnly: changes.length > 0 && list.length === 1 && list[0] === 'docs',
    nativeRace: scopes.has('native') || scopes.has('audio') || scopes.has('deps'),
    hostCount: scopes.has('compatibility') ? 2 : 1,
    changedCount: changes.length,
    relevantChangedCount: relevant.length,
  }
}

// ---------------------------------------------------------------------------
// Version manifests and candidate output

export async function syncVersionManifests(root, version) {
  if (!VERSION_PATTERN.test(version || '')) throw new ReleaseError('Version must look like X.Y.Z')
  const parsed = []
  for (const name of VERSION_FILES) {
    const file = path.join(root, name)
    let value
    try {
      value = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      throw new ReleaseError('Cannot read ' + name + ': ' + safeMessage(error))
    }
    parsed.push({ name, file, value })
  }
  const [, , lock] = parsed
  if (!lock.value.packages || !Object.hasOwn(lock.value.packages, '')) throw new ReleaseError('package-lock.json has no root package entry')
  parsed[0].value.version = version
  parsed[1].value.version = version
  lock.value.version = version
  lock.value.packages[''].version = version
  const hashes = {}
  for (const item of parsed) {
    const bytes = Buffer.from(JSON.stringify(item.value, null, 2) + '\n')
    await writeFile(item.file, bytes)
    hashes[item.name] = { sha256: sha256(bytes), bytes: bytes.length }
  }
  return { version, manifests: hashes }
}

async function writeReport(reportPath, report) {
  report.updatedAt = new Date().toISOString()
  const temp = reportPath + '.tmp'
  await writeFile(temp, JSON.stringify(report, null, 2) + '\n')
  await rename(temp, reportPath)
}

export async function ensureCandidateDirectory(output, version) {
  const dir = path.resolve(output)
  await mkdir(dir, { recursive: true })
  const names = await readdir(dir)
  const reportPath = path.join(dir, 'report.json')
  let report = null
  if (names.includes('report.json')) {
    report = JSON.parse(await readFile(reportPath, 'utf8'))
    if (report.version !== version) throw new ReleaseError(`Existing candidate report is for ${report.version}, not ${version}`)
  } else {
    const collisions = names.filter(name => GENERATED_OUTPUT_NAMES.has(name))
    if (collisions.length) throw new ReleaseError('Candidate output has generated paths without report.json: ' + collisions.join(', '))
  }
  return { dir, names, reportPath, report }
}

function rememberIssues(report, issues) {
  report.unresolved = [...new Map([
    ...(report.unresolved || []).map(issue => [issue.text, issue]),
    ...issues.map(text => [text, { text, resolved: false }]),
  ]).values()]
}

function createReport({ command, version, root, base, head, source, scopes, changes }) {
  return {
    schemaVersion: 1,
    command,
    commands: [command],
    version,
    root,
    base,
    head,
    source,
    scopes,
    changes,
    inputs: {},
    stages: [],
    packages: [],
    pendingManualChecks: [],
    unresolved: [],
    readyForRelease: false,
    status: 'incomplete',
    failure: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function stageLogPath(context, name) {
  return path.join(context.candidate.dir, 'logs', name + '.log')
}

async function writeTextLog(file, text) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text.endsWith('\n') ? text : text + '\n')
}

async function artifactCurrent(artifact) {
  try {
    if (artifact.treeHash) return (await hashTree(artifact.path)).sha256 === artifact.treeHash
    const info = await stat(artifact.path)
    if (!info.isFile()) return false
    if (artifact.bytes !== undefined && info.size !== artifact.bytes) return false
    return await sha256File(artifact.path) === artifact.sha256
  } catch {
    return false
  }
}

async function stageStillCurrent(stage) {
  if (!stage || stage.status !== 'passed') return false
  if (!stage.log) return false
  try {
    if (await sha256File(stage.log) !== stage.logSha256) return false
  } catch {
    return false
  }
  for (const artifact of stage.artifacts || []) if (!(await artifactCurrent(artifact))) return false
  return true
}

function setStage(report, record) {
  const index = report.stages.findIndex(stage => stage.name === record.name)
  if (index === -1) report.stages.push(record)
  else report.stages[index] = record
}

// Sequential executor shared by check and prepare. A stage that fails blocks
// every dependent stage; the partial report is always persisted first.
export async function executePipeline({ stages, context }) {
  const { report, save } = context
  for (let position = 0; position < stages.length; position++) {
    const stage = stages[position]
    const log = stageLogPath(context, stage.name)
    await mkdir(path.dirname(log), { recursive: true })
    try {
      if (stage.when && !(await stage.when(context))) {
        await writeTextLog(log, 'skipped: ' + (stage.skipReason || 'not applicable for this change scope'))
        setStage(report, {
          name: stage.name, status: 'skipped', required: Boolean(stage.required), log,
          logSha256: await sha256File(log), fingerprint: null, outputs: null,
          reason: stage.skipReason || 'not applicable for this change scope',
        })
        await save()
        continue
      }
      const stageFingerprint = await stage.fingerprint(context)
      const prior = report.stages.find(item => item.name === stage.name)
      if (prior && prior.fingerprint === stageFingerprint && await stageStillCurrent(prior)) {
        context.state[stage.name] = prior.outputs || {}
        if (stage.after) await stage.after(context)
        setStage(report, { ...prior, status: 'passed', reused: true, reusedAt: new Date().toISOString() })
        await save()
        continue
      }
      const startedAt = new Date().toISOString()
      const outputs = await stage.run(context, { log })
      const artifacts = stage.artifacts ? await stage.artifacts(outputs, context) : []
      if (!(await stat(log).catch(() => null))) await writeTextLog(log, 'stage completed without a command log')
      setStage(report, {
        name: stage.name, status: 'passed', required: true, fingerprint: stageFingerprint,
        startedAt, finishedAt: new Date().toISOString(), log, logSha256: await sha256File(log),
        artifacts, outputs,
      })
      context.state[stage.name] = outputs
      if (stage.after) await stage.after(context)
      await save()
    } catch (error) {
      const message = safeMessage(error)
      await appendFile(log, '\nfailed: ' + message + '\n').catch(() => {})
      setStage(report, {
        name: stage.name, status: 'failed', required: true, fingerprint: null,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        log, logSha256: await sha256File(log).catch(() => null), artifacts: [], outputs: null, error: message,
      })
      for (const later of stages.slice(position + 1)) {
        const laterLog = stageLogPath(context, later.name)
        await writeTextLog(laterLog, 'skipped: blocked by failed stage ' + stage.name).catch(() => {})
        setStage(report, {
          name: later.name, status: 'skipped', required: Boolean(later.required), log: laterLog,
          logSha256: await sha256File(laterLog).catch(() => null), fingerprint: null, outputs: null,
          reason: 'blocked by failed stage ' + stage.name, blockedBy: stage.name,
        })
      }
      report.status = 'failed'
      report.failure = { stage: stage.name, message, log }
      report.readyForRelease = false
      await save()
      throw new ReleaseError(stage.name + ': ' + message + ' (log: ' + log + ')')
    }
  }
  report.status = report.stages.some(stage => stage.status === 'failed') ? 'failed' : 'passed'
  await save()
  return report
}

// ---------------------------------------------------------------------------
// Packaging identity

export async function hashTree(directory) {
  const entries = []
  async function walk(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix + entry.name
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new ReleaseError('Tree contains a symbolic link: ' + relative)
      if (entry.isDirectory()) await walk(absolute, relative + '/')
      else if (entry.isFile()) {
        const info = await lstat(absolute)
        entries.push([relative, sha256(await readFile(absolute)), info.size, info.mode & 0o777])
      } else throw new ReleaseError('Tree contains a special file: ' + relative)
    }
  }
  await walk(directory, '')
  entries.sort((a, b) => a[0].localeCompare(b[0]))
  return { sha256: fingerprint(entries), files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry[2], 0) }
}

// Only execution inputs invalidate native/audio results; bundled docs and versions do not.
export async function packagedTestInputs(directory, mode) {
  const names = ['bin', 'runtime/native', 'test/fixtures']
  if (mode === 'native') names.push('test/native-worker.test')
  else if (mode === 'adapters') {
    names.push('helper', ...['worker', 'gapless', 'ffmpeg', 'playback'].map(name => 'test/' + name + '.test.mjs'))
  } else throw new ReleaseError('Unknown packaged test mode: ' + mode)
  const entries = await Promise.all(names.map(async name => {
    const absolute = path.join(directory, name)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new ReleaseError('Packaged test input is a symbolic link: ' + name)
    return [name, info.isDirectory() ? (await hashTree(absolute)).sha256 : await sha256File(absolute), info.mode & 0o777]
  }))
  return fingerprint(entries)
}

export async function listFiles(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name
    const absolute = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new ReleaseError('Package contains a symbolic link: ' + relative)
    if (entry.isDirectory()) result.push(...await listFiles(absolute, relative + '/'))
    else if (entry.isFile()) result.push(relative)
    else throw new ReleaseError('Package contains a special file: ' + relative)
  }
  return result.sort()
}

export function parsePackageArchives(text) {
  const archives = text.split(/\r?\n/).map(line => line.trim())
    .filter(line => path.isAbsolute(line) && /\.zip$/i.test(line))
  const validation = archives.filter(file => /-validation\.zip$/i.test(file))
  const runtime = archives.filter(file => !/-validation\.zip$/i.test(file))
  if (archives.length !== 2 || runtime.length !== 1 || validation.length !== 1) {
    throw new ReleaseError('package.mjs did not report exactly one runtime and one validation ZIP')
  }
  return { runtime: runtime[0], validation: validation[0], archives }
}

export async function unpackZip(archive, destination) {
  const { unzipSync } = await import('fflate')
  const bytes = await readFile(archive)
  const entries = unzipSync(bytes)
  await mkdir(destination, { recursive: true })
  if ((await readdir(destination)).length) throw new ReleaseError('Extraction directory must be new or empty: ' + destination)
  let files = 0, total = 0
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue
    if (!name || path.isAbsolute(name) || name.includes('\\') || name.split('/').includes('..')) {
      throw new ReleaseError('Unsafe archive entry: ' + name)
    }
    const target = path.join(destination, name)
    await mkdir(path.dirname(target), { recursive: true })
    const executable = name.startsWith('bin/') ||
      /^runtime\/native\/(?:qishui-sign|ffmpeg|audio-convert)(?:\.exe)?$/.test(name) ||
      /^test\/[^/]+\.test(?:\.exe)?$/.test(name)
    await writeFile(target, Buffer.from(data), { flag: 'wx', mode: executable ? 0o755 : 0o644 })
    files++
    total += data.length
  }
  return { dir: destination, files, bytes: total, archiveSha256: sha256(bytes) }
}

// ---------------------------------------------------------------------------
// Package verification

export async function verifySourceMatchesPackage({ root, dir, validation, layout }) {
  const sourceRoots = validation
    ? [...layout.runtimeSource, ...layout.validationSource]
    : [...layout.runtimeSource]
  const expected = new Set()
  async function walk(absolute, relative, start) {
    let info
    try {
      info = await lstat(absolute)
    } catch (error) {
      throw new ReleaseError('Missing package source: ' + relative + ' (' + safeMessage(error) + ')')
    }
    if (info.isSymbolicLink()) throw new ReleaseError('Package source is a symbolic link: ' + relative)
    if (info.isDirectory()) {
      if (!validation && /(?:^|\/)(?:tests?|testdata)(?:\/|$)/.test(relative)) return
      for (const name of await readdir(absolute)) await walk(path.join(absolute, name), relative + '/' + name, start)
      return
    }
    if (!info.isFile()) throw new ReleaseError('Package source is not a regular file: ' + relative)
    if (!validation) {
      if (/_test\.go$/.test(relative) || /\.test\.(?:cpp|mjs)$/.test(relative)) return
      if (relative === 'native/signer/validate.mjs') return
    }
    expected.add(relative)
  }
  for (const name of sourceRoots) {
    const relative = name.replace(/\/$/, '')
    if (expected.has(relative)) continue
    await walk(path.join(root, relative), relative, relative)
  }
  const packaged = new Set(await listFiles(dir))
  for (const name of expected) {
    if (!packaged.has(name)) throw new ReleaseError('Package is missing source file: ' + name)
    const [sourceHash, packageHash] = [await sha256File(path.join(root, name)), await sha256File(path.join(dir, name))]
    if (sourceHash !== packageHash) throw new ReleaseError('Package source differs from the working tree: ' + name)
  }
  return { checked: expected.size }
}

export function verifyManifestVersions(plugin, pkg, lock, version) {
  if (plugin?.version !== version) throw new ReleaseError('plugin.json version is not ' + version)
  if (pkg?.version !== version) throw new ReleaseError('package.json version is not ' + version)
  if (lock?.version !== version) throw new ReleaseError('package-lock.json version is not ' + version)
  if (lock?.packages?.['']?.version !== version) throw new ReleaseError('package-lock.json root package version is not ' + version)
}

// `runtime` and `validation` map archive names to { sha256, value? }. Windows
// BUILD.json may add exactly the two native test digest entries in validation.
export function compareRuntimeValidation(runtime, validation, { platform }) {
  const allowedExtra = platform === 'windows' ? new Set(['native-worker.test.exe', 'windows-runner.test.exe']) : new Set()
  for (const [name, artifact] of Object.entries(runtime)) {
    if (!validation[name]) throw new ReleaseError('Validation package is missing runtime file: ' + name)
    if (name === 'runtime/native/BUILD.json') {
      const before = artifact.value, after = validation[name].value
      if (!before || !after) throw new ReleaseError('Unable to compare Windows BUILD.json')
      for (const [key, value] of Object.entries(before)) if (after[key] !== value) throw new ReleaseError('Validation BUILD.json changed runtime digest: ' + key)
      for (const key of Object.keys(after)) {
        if (!Object.hasOwn(before, key) && !allowedExtra.has(key)) throw new ReleaseError('Validation BUILD.json has an unexpected test entry: ' + key)
      }
      continue
    }
    if (artifact.sha256 !== validation[name].sha256) throw new ReleaseError('Runtime/validation mismatch: ' + name)
  }
}

async function verifyPackageContents({ root, dir, validation, version, layout, assets, platform, arch, runner }) {
  if (platform === 'darwin' && arch === 'amd64') {
    assets = { ...assets, darwin: assets.darwinAMD64, darwinFfmpeg: assets.darwinAMD64Ffmpeg }
    if (!assets.darwin || !assets.darwinFfmpeg) throw new ReleaseError('Intel macOS asset hashes are missing')
  }
  const files = await listFiles(dir)
  layout.checkPackageLayout(files, { validation })
  const plugin = await readJson(path.join(dir, 'plugin.json'))
  const pkg = await readJson(path.join(dir, 'package.json'))
  const lock = await readJson(path.join(dir, 'package-lock.json'))
  verifyManifestVersions(plugin, pkg, lock, version)
  if (plugin.id !== 'qishui-app-login') throw new ReleaseError('Unexpected plugin id in final package')
  const source = await verifySourceMatchesPackage({ root, dir, validation, layout })
  const required = [
    'LICENSE', 'NOTICE.md', 'src/plugin.mjs', 'native/worker/go.mod', 'native/signer/signer.cpp',
    'native/signer/include/NODE-LICENSE', 'native/signer/licenses/LIBCXX-LICENSE',
    'native/signer/licenses/LIBCXXABI-LICENSE', 'native/signer/licenses/LIBUNWIND-LICENSE',
    'native/signer/licenses/provenance.json',
  ]
  if (platform === 'darwin') {
    if (files.includes('runtime/native/audio-convert')) throw new ReleaseError('macOS package still contains the retired AudioToolbox converter')
    for (const name of Object.keys(assets.darwin || {})) required.push('runtime/native/' + name)
    for (const name of Object.keys(assets.darwinFfmpeg || {})) required.push('runtime/native/' + name)
    required.push(`bin/qishui-helper-darwin-${arch}`, 'runtime/native/qishui-sign', 'runtime/native/NATIVE-BUILD.json', 'runtime/native/GO-LICENSE')
    if (arch === 'amd64') required.push('runtime/native/SOURCES.json')
  } else {
    for (const name of Object.keys(assets.windows || {})) required.push('runtime/native/' + name)
    required.push(
      `bin/qishui-helper-windows-${arch}.exe`, 'runtime/native/qishui-sign.exe',
      'runtime/native/windows-runner.exe', 'runtime/native/NATIVE-BUILD.json',
      'runtime/native/GO-LICENSE', 'runtime/native/X-SYS-LICENSE',
      'scripts/build-ffmpeg.mjs', 'scripts/ffmpeg-config.mjs',
      'native/windows-runner/main_windows.go', 'native/windows-runner/go.mod', 'native/windows-runner/go.sum',
    )
  }
  if (validation) {
    required.push('scripts/verify-windows.mjs', 'scripts/verify-windows.cmd')
    if (platform === 'darwin') required.push('test/native-worker.test')
    if (platform === 'windows') required.push('test/native-worker.test.exe', 'test/windows-runner.test.exe')
  }
  const present = new Set(files)
  for (const name of [...new Set(required)]) {
    if (!present.has(name)) throw new ReleaseError('Package is missing a required component: ' + name)
    if (!(await stat(path.join(dir, name))).size) throw new ReleaseError('Package component is empty: ' + name)
  }
  const nativeBuild = await readJson(path.join(dir, 'runtime/native/NATIVE-BUILD.json'))
  if (nativeBuild.platform !== platform || nativeBuild.arch !== arch) throw new ReleaseError('Native build platform mismatch in final package')
  if (platform === 'darwin') {
    for (const [name, expected] of Object.entries(assets.darwin || {})) if (await sha256File(path.join(dir, 'runtime/native', name)) !== expected) throw new ReleaseError('Packaged native asset hash mismatch: ' + name)
    for (const [name, expected] of Object.entries(assets.darwinFfmpeg || {})) if (await sha256File(path.join(dir, 'runtime/native', name)) !== expected) throw new ReleaseError('Packaged FFmpeg asset hash mismatch: ' + name)
    if (assets.inspectDarwinAudio) {
      const { inspectDarwinAudio } = await import('./runtime-assets.mjs')
      inspectDarwinAudio(await readFile(path.join(dir, 'runtime/native/ffmpeg')), arch)
    }
    const signature = await runner.run('/usr/bin/codesign', ['--verify', '--strict', path.join(dir, 'runtime/native/ffmpeg')], { cwd: root, timeout: 60000 })
    if (signature.status !== 0) throw new ReleaseError('Packaged macOS FFmpeg signature verification failed')
  }
  return { files: files.length, sourceFiles: source.checked, manifestVersions: { plugin: plugin.version, package: pkg.version, lock: lock.version } }
}

export async function checkFinalPackages({ root, version, extracted, assets, layout, platform, runner }) {
  const result = {}
  for (const item of extracted) {
    const entries = {}
    for (const name of await listFiles(item.dir)) {
      const artifact = { sha256: await sha256File(path.join(item.dir, name)) }
      if (name === 'runtime/native/BUILD.json') artifact.value = await readJson(path.join(item.dir, name))
      entries[name] = artifact
    }
    item.entries = entries
    result[item.kind] = await verifyPackageContents({
      root, dir: item.dir, validation: item.kind === 'validation', version, layout,
      assets, platform: item.platform, arch: item.arch, runner,
    })
  }
  const runtime = extracted.find(item => item.kind === 'runtime')
  const validation = extracted.find(item => item.kind === 'validation')
  if (!runtime || !validation) throw new ReleaseError('Both runtime and validation packages are required')
  compareRuntimeValidation(runtime.entries, validation.entries, { platform })
  return result
}

// ---------------------------------------------------------------------------
// Test output parsing

function count(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) return Number(match[1])
  }
  return null
}

export function parseSourceTests(text) {
  return {
    tests: count(text, [/ℹ tests (\d+)/, /# tests (\d+)/]),
    pass: count(text, [/ℹ pass (\d+)/, /# pass (\d+)/]),
    fail: count(text, [/ℹ fail (\d+)/, /# fail (\d+)/]),
    skipped: count(text, [/ℹ skipped (\d+)/, /# skipped (\d+)/]) ?? 0,
    goOk: /^ok\s+qishui-worker\b/m.test(text),
  }
}

export function parseNodeTests(text) {
  return {
    pass: count(text, [/ℹ pass (\d+)/, /# pass (\d+)/]),
    fail: count(text, [/ℹ fail (\d+)/, /# fail (\d+)/]),
    skipped: count(text, [/ℹ skipped (\d+)/, /# skipped (\d+)/]) ?? 0,
    failedLines: (text.match(/^not ok\s+\d+/gm) || []).length,
  }
}

export function parseHostTests(text) {
  const passed = [...text.matchAll(/^--- PASS: (\S+)/gm)].map(match => match[1])
  const skipped = [...text.matchAll(/^--- SKIP: (\S+)/gm)].map(match => match[1])
  const failed = [...text.matchAll(/^--- FAIL: (\S+)/gm)].map(match => match[1])
  return { passed, skipped, failed, ok: /^ok\s+\S+/m.test(text), passLine: /^PASS$/m.test(text) }
}

export function parseNativeChecks(text, { mode, expected = [] }) {
  const passed = [...text.matchAll(/^--- PASS: (\S+)/gm)].map(match => match[1])
  const skipped = [...text.matchAll(/^--- SKIP: (\S+)/gm)].map(match => match[1])
  const failed = [...text.matchAll(/^--- FAIL: (\S+)/gm)].map(match => match[1])
  const missing = expected.filter(name => !passed.includes(name))
  return { passed, skipped, failed, missing, ok: passed.length > 0 && skipped.length === 0 && failed.length === 0 && (mode !== 'smoke' || missing.length === 0) }
}

function assertCommand(result, label) {
  if (result.spawnError) throw new ReleaseError(label + ' could not start: ' + result.spawnError)
  if (result.overflow) throw new ReleaseError(label + ' produced too much output')
  if (result.timedOut) throw new ReleaseError(label + ' timed out')
  if (result.status !== 0) throw new ReleaseError(label + ' failed with exit ' + result.status)
}

// ---------------------------------------------------------------------------
// Host identity and overlay

export async function inspectHost({ hostSource, runner }) {
  const dir = await realpath(requireAbsolute(hostSource, 'host source'))
  const info = await stat(dir)
  if (!info.isDirectory()) throw new ReleaseError('Host source is not a directory: ' + dir)
  const goMod = await readFile(path.join(dir, 'go.mod'))
  const pluginDir = path.join(dir, 'internal/plugin')
  const pluginInfo = await stat(pluginDir).catch(() => null)
  if (!pluginInfo?.isDirectory()) throw new ReleaseError('Host source has no internal/plugin package: ' + dir)
  const optional = async args => {
    const result = await runner.run('git', ['-C', dir, ...args], { cwd: dir, timeout: 120000 })
    return result.status === 0 ? result.stdout.trim() : null
  }
  const head = await optional(['rev-parse', 'HEAD'])
  const tags = (await optional(['tag', '--points-at', 'HEAD'])) || ''
  const describe = await optional(['describe', '--tags', '--always'])
  const mygoResult = await runner.run('go', ['-C', dir, 'list', '-m', '-f', '{{.Version}}', 'github.com/egoist/mygo'], { cwd: dir, timeout: 120000 })
  const versions = new Set()
  for (const tag of tags.split('\n')) if (/^v?\d+\.\d+\.\d+$/.test(tag.trim())) versions.add(tag.trim().replace(/^v/, ''))
  if (!versions.size && describe && /^v?\d+\.\d+\.\d+$/.test(describe)) versions.add(describe.replace(/^v/, ''))
  const tree = await hashTree(pluginDir)
  return {
    path: dir, goModSha256: sha256(goMod), head,
    tags: tags.split('\n').filter(Boolean), describe,
    appVersion: [...versions][0] || null, appVersions: [...versions],
    mygoModuleVersion: mygoResult.status === 0 ? mygoResult.stdout.trim() : null,
    pluginTreeHash: tree.sha256, pluginFiles: tree.files,
  }
}

export async function createHostOverlay({ hostSource, testRoot, destination }) {
  const pluginDir = path.join(hostSource, 'internal/plugin')
  const existing = await readdir(pluginDir)
  const replace = {}
  const removed = []
  for (const name of existing.filter(name => name.endsWith('_test.go'))) {
    const file = path.join(pluginDir, name)
    const text = await readFile(file, 'utf8')
    if (text.includes('func TestQishui') || /^qishui.*_test\.go$/i.test(name)) {
      replace[file] = ''
      removed.push(file)
    }
  }
  const added = []
  for (const [sourceName, virtualName] of HOST_TEST_FIXTURES) {
    const source = path.join(testRoot, sourceName)
    await stat(source).catch(() => { throw new ReleaseError('Missing host test fixture: ' + source) })
    const virtual = path.join(pluginDir, virtualName)
    replace[virtual] = source
    added.push({ source, virtual })
  }
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, JSON.stringify({ Replace: replace }, null, 2) + '\n')
  return { overlay: destination, replace, removed, added }
}

// ---------------------------------------------------------------------------
// Plan / check / prepare

function sourceTestTools(toolchain) {
  return { node: process.version, npm: toolchain?.npm, go: toolchain?.go }
}

async function sourceTestEnvironment({ root, env }) {
  const result = {}
  if (env.QISHUI_FFMPEG_DIR && path.isAbsolute(env.QISHUI_FFMPEG_DIR)) {
    const ffmpeg = path.join(env.QISHUI_FFMPEG_DIR, 'ffmpeg')
    if (await stat(ffmpeg).then(info => info.isFile()).catch(() => false)) result.QISHUI_TEST_FFMPEG = ffmpeg
  }
  const nativeFiles = ['bdms.node', 'libMetaSecML.dylib', 'ffmpeg'].map(name => path.join(root, 'runtime/native', name))
  if ((await Promise.all(nativeFiles.map(file => stat(file).then(info => info.isFile()).catch(() => false)))).every(Boolean)) {
    result.QISHUI_TEST_NATIVE = '1'
  }
  return result
}

async function toolchainIdentity({ root, runner }) {
  const versionOf = async (command, args) => {
    const result = await runner.run(command, args, { cwd: root, timeout: 120000 })
    return result.status === 0 ? result.stdout.trim() : null
  }
  const packageVersion = async name => {
    try { return (await readJson(path.join(root, 'node_modules', name, 'package.json'))).version }
    catch { return null }
  }
  return {
    node: process.version, platform: process.platform, arch: process.arch,
    npm: await versionOf('npm', ['--version']), go: await versionOf('go', ['version']),
    git: await versionOf('git', ['--version']),
    clang: await versionOf('/usr/bin/clang', ['--version']),
    esbuild: await packageVersion('esbuild'), fflate: await packageVersion('fflate'),
  }
}

export async function planRelease({
  root = defaultRoot, base, version, hostSources = [], env = process.env,
  runner = createRunner({ cwd: root }),
} = {}) {
  root = path.resolve(root)
  const resolved = await resolveBase({ root, runner, base })
  const changes = await collectChangedFiles({ root, runner, base: resolved.commit })
  const scopes = classifyChanges(changes)
  const files = await collectSourceFiles({ root, runner })
  const source = await computeSourceFingerprints(root, files)
  const currentVersion = version || (await readJson(path.join(root, 'plugin.json'))).version
  const hosts = []
  for (const hostSource of hostSources) hosts.push(await inspectHost({ hostSource, runner }))
  const toolchain = await toolchainIdentity({ root, runner })
  const stages = ['source-tests']
  if (scopes.nativeRace) stages.push('native-race')
  const prepareStages = [
    'prerequisites', 'version-sync', 'build-index', 'source-tests',
    ...(scopes.nativeRace ? ['native-race'] : []),
    ...PLATFORM_TARGETS.map(target => 'package-' + target.name),
    ...PLATFORM_TARGETS.map(target => 'unpack-' + target.name),
    'package-checks', 'windows-static', 'mac-native',
  ]
  if (scopes.native || scopes.audio) prepareStages.push('adapters')
  prepareStages.push(...hostSources.map(host => 'host-' + path.basename(host)))
  return {
    readOnly: true,
    root,
    base: resolved,
    version: currentVersion,
    changed: changes,
    scopes,
    requiredHosts: scopes.compatibility ? 2 : 1,
    providedHosts: hosts,
    fingerprints: source,
    toolchain,
    checkStages: stages,
    prepareStages,
    notes: [
      'plan is read-only: no directories, logs, manifests or packages are written',
      scopes.compatibility ? 'compatibility scope requires a host at minAppVersion and a newer host' : 'one tagged host source is required for prepare',
    ],
  }
}

function nativeRaceStage(root, scopes) {
  return {
    name: 'native-race', required: scopes.nativeRace,
    when: () => scopes.nativeRace,
    skipReason: 'no native, audio or dependency change',
    fingerprint: ctx => fingerprint({ kind: 'native-race', source: ctx.fingerprints.testFingerprint, go: ctx.toolchain.go }),
    run: async (ctx, { log }) => {
      const result = await ctx.runner.run('npm', ['run', 'test:native'], { cwd: root, log, timeout: 900000 })
      assertCommand(result, 'native race tests')
      if (!/^ok\s+qishui-worker\b/m.test(result.text) || /^FAIL\b/m.test(result.text)) throw new ReleaseError('native race tests did not pass cleanly')
      return { passed: true }
    },
  }
}

export async function checkRelease({
  root = defaultRoot, version, base, output, issues = [], env = process.env,
  runner = createRunner({ cwd: root }),
} = {}) {
  root = path.resolve(root)
  const current = version || (await readJson(path.join(root, 'plugin.json'))).version
  const resolved = await resolveBase({ root, runner, base })
  const changes = await collectChangedFiles({ root, runner, base: resolved.commit })
  const scopes = classifyChanges(changes)
  const files = await collectSourceFiles({ root, runner })
  const source = await computeSourceFingerprints(root, files)
  const candidate = await ensureCandidateDirectory(output || path.join(root, 'dist', 'release-' + current), current)
  const report = candidate.report || createReport({
    command: 'check', version: current, root, base: resolved, head: resolved.head, source, scopes, changes,
  })
  report.command = 'check'
  rememberIssues(report, issues)
  if (!report.commands.includes('check')) report.commands.push('check')
  report.base = resolved
  report.head = resolved.head
  report.source = source
  report.scopes = scopes
  report.changes = changes
  const context = {
    root, candidate, report, version: current, scopes, env, runner,
    fingerprints: source, state: {}, toolchain: null,
    save: () => writeReport(candidate.reportPath, report),
  }
  context.logPath = name => stageLogPath(context, name)
  context.toolchain = await toolchainIdentity({ root, runner })
  await context.save()
  const testEnv = await sourceTestEnvironment({ root, env })
  const stages = [
    {
      name: 'source-tests',
      fingerprint: ctx => fingerprint({ kind: 'source-tests', source: ctx.fingerprints.testFingerprint, env: testEnv, tools: sourceTestTools(ctx.toolchain) }),
      run: async (ctx, { log }) => {
        const result = await ctx.runner.run('npm', ['test'], { cwd: ctx.root, env: testEnv, log, timeout: 900000 })
        assertCommand(result, 'npm test')
        const parsed = parseSourceTests(result.text)
        if (parsed.fail === null || parsed.pass === null || parsed.fail !== 0 || parsed.pass < 1 || !parsed.goOk) {
          throw new ReleaseError('source test suite did not report a clean pass and Go test result')
        }
        const index = path.join(ctx.root, 'index.js')
        return { ...parsed, indexSha256: await sha256File(index), indexBytes: (await stat(index)).size }
      },
      artifacts: outputs => [{ path: path.join(root, 'index.js'), sha256: outputs.indexSha256, bytes: outputs.indexBytes }],
    },
    nativeRaceStage(root, scopes),
  ]
  try {
    await executePipeline({ stages, context })
  } catch (error) {
    report.status = 'failed'
    report.readyForRelease = false
    await context.save()
    throw error
  }
  report.status = 'passed'
  report.readyForRelease = false
  report.pendingManualChecks = pendingManualChecks(scopes)
  await context.save()
  return report
}

export function pendingManualChecks(scopes) {
  const pending = []
  if (scopes.native || scopes.audio) {
    pending.push({
      scope: 'windows', status: 'pending', requiredForRelease: true,
      reason: 'Windows amd64 native/audio/isolated execution was not performed; only static and host installation checks ran on macOS',
    })
    pending.push({
      scope: 'windows-arm64', status: 'pending', requiredForRelease: true,
      reason: 'Windows 11 ARM64 AppContainer execution of x64 signing/audio subprocesses needs real-device acceptance; static checks do not test emulation',
    })
    pending.push({
      scope: 'darwin-amd64', status: 'pending', requiredForRelease: true,
      reason: 'Intel macOS signing, isolated execution and audio need an Intel Mac or Rosetta; cross-building and host installation checks do not execute Intel programs',
    })
  }
  if (scopes.audio) {
    pending.push({
      scope: 'audio', status: 'pending', requiredForRelease: true,
      reason: 'macOS audio precision/full-scale fixtures may be automated; real device listening remains a manual acceptance step',
    })
  }
  if (scopes.auth) {
    pending.push({
      scope: 'account', status: 'pending', requiredForRelease: true,
      reason: 'real VIP/SVIP account display and session recovery remain a manual acceptance step; no live account was used',
    })
  }
  return pending
}

async function loadRuntimeAssets() {
  return await import('./runtime-assets.mjs')
}

async function requireFile(file, label) {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) throw new ReleaseError('Missing ' + label + ': ' + file)
  return file
}

export async function validateExpectedFiles(directory, expected, label) {
  if (!expected || !Object.keys(expected).length) throw new ReleaseError('No expected ' + label + ' hashes are defined')
  const result = {}
  for (const [name, hash] of Object.entries(expected)) {
    const file = await requireFile(path.join(directory, name), label + ' file ' + name)
    if (await sha256File(file) !== hash) throw new ReleaseError('Checksum mismatch for ' + label + ' file: ' + name)
    result[name] = hash
  }
  return result
}

async function validateAssets({ env, runner, expectedAssets }) {
  const nativeDir = await realpath(requireAbsolute(env.QISHUI_NATIVE_DIR, 'QISHUI_NATIVE_DIR'))
  const ffmpegDir = await realpath(requireAbsolute(env.QISHUI_FFMPEG_DIR, 'QISHUI_FFMPEG_DIR'))
  const windowsDir = await realpath(requireAbsolute(env.QISHUI_WINDOWS_ASSETS, 'QISHUI_WINDOWS_ASSETS'))
  const intelNativeDir = await realpath(requireAbsolute(env.QISHUI_DARWIN_AMD64_NATIVE_DIR, 'QISHUI_DARWIN_AMD64_NATIVE_DIR'))
  const intelFfmpegDir = await realpath(requireAbsolute(env.QISHUI_DARWIN_AMD64_FFMPEG_DIR, 'QISHUI_DARWIN_AMD64_FFMPEG_DIR'))
  const zig = requireAbsolute(env.QISHUI_ZIG, 'QISHUI_ZIG')
  const module = expectedAssets ? { ...expectedAssets } : await loadRuntimeAssets()
  const darwin = module.DARWIN_FILES
  const darwinFfmpeg = module.DARWIN_FFMPEG_FILES
  const windows = module.WINDOWS_FILES
  const assets = {
    darwin: await validateExpectedFiles(nativeDir, darwin, 'macOS native'),
    darwinFfmpeg: await validateExpectedFiles(ffmpegDir, darwinFfmpeg, 'macOS FFmpeg'),
    darwinAMD64: await validateExpectedFiles(intelNativeDir, module.DARWIN_AMD64_FILES, 'Intel macOS native'),
    darwinAMD64Ffmpeg: await validateExpectedFiles(intelFfmpegDir, module.DARWIN_AMD64_FFMPEG_FILES, 'Intel macOS FFmpeg'),
    windows: await validateExpectedFiles(windowsDir, windows, 'Windows runtime'),
    inspectDarwinAudio: typeof module.inspectDarwinAudio === 'function',
  }
  await requireFile(zig, 'Zig executable')
  const zigVersion = await runner.run(zig, ['version'], { timeout: 60000 })
  if (zigVersion.status !== 0 || !/^0\.15\.2\b/.test(zigVersion.stdout.trim())) throw new ReleaseError('QISHUI_ZIG must report version 0.15.2')
  return {
    ...assets,
    directories: { native: nativeDir, ffmpeg: ffmpegDir, windows: windowsDir, intelNative: intelNativeDir, intelFfmpeg: intelFfmpegDir },
    zig: { path: zig, sha256: await sha256File(zig), version: zigVersion.stdout.trim() },
  }
}

async function checkPrepareInputs({ root, version, resolvedBase, scopes, hostSources, env, runner, expectedAssets }) {
  if (!VERSION_PATTERN.test(version || '')) throw new ReleaseError('prepare requires --version X.Y.Z')
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new ReleaseError('Local preparation is supported on macOS arm64 only')
  if (!hostSources.length) throw new ReleaseError('prepare requires at least one absolute --host-source')
  if (hostSources.some(source => !path.isAbsolute(source))) throw new ReleaseError('--host-source values must be absolute paths')
  if (scopes.compatibility && hostSources.length < 2) throw new ReleaseError('compatibility changes require two --host-source values (minimum and newer host)')
  const hosts = []
  for (const hostSource of hostSources) hosts.push(await inspectHost({ hostSource, runner }))
  if (new Set(hosts.map(host => host.path)).size !== hosts.length) throw new ReleaseError('Host sources must be distinct directories')
  const plugin = await readJson(path.join(root, 'plugin.json'))
  if (!plugin.minAppVersion) throw new ReleaseError('plugin.json has no minAppVersion')
  if (scopes.compatibility) {
    const versions = hosts.map(host => host.appVersion)
    if (versions.some(version => !version)) throw new ReleaseError('Cannot verify compatibility hosts: each host must be checked out at a version tag')
    if (!versions.includes(plugin.minAppVersion)) throw new ReleaseError('No host source is at minAppVersion ' + plugin.minAppVersion)
    if (!versions.some(version => compareVersions(version, plugin.minAppVersion) > 0)) throw new ReleaseError('No newer/current host source is available')
  }
  const toolchain = await toolchainIdentity({ root, runner })
  if (Number(String(process.versions.node).split('.')[0]) < 20) throw new ReleaseError('Node 20 or newer is required')
  if (!toolchain.npm) throw new ReleaseError('npm is required')
  if (!toolchain.go) throw new ReleaseError('Go is required')
  if (!toolchain.clang) throw new ReleaseError('Apple clang is required')
  await requireFile(path.join(root, 'node_modules/esbuild/package.json'), 'esbuild development dependency')
  await requireFile(path.join(root, 'node_modules/fflate/package.json'), 'fflate development dependency')
  const assets = await validateAssets({ env, runner, expectedAssets })
  return { hosts, plugin, toolchain, assets, base: resolvedBase }
}

export async function prepareRelease({
  root = defaultRoot, version, base, hostSources = [], output, issues = [],
  env = process.env, runner = createRunner({ cwd: root, env }), expectedAssets,
} = {}) {
  root = path.resolve(root)
  if (!VERSION_PATTERN.test(version || '')) throw new ReleaseError('prepare requires --version X.Y.Z')
  if (!hostSources.length) throw new ReleaseError('prepare requires at least one --host-source')
  if (hostSources.some(source => !path.isAbsolute(source))) throw new ReleaseError('--host-source values must be absolute paths')
  const resolved = await resolveBase({ root, runner, base })
  const changes = await collectChangedFiles({ root, runner, base: resolved.commit })
  const scopes = classifyChanges(changes)
  const files = await collectSourceFiles({ root, runner })
  const source = await computeSourceFingerprints(root, files)
  const candidate = await ensureCandidateDirectory(output || path.join(root, 'dist', 'release-' + version), version)
  const report = candidate.report || createReport({
    command: 'prepare', version, root, base: resolved, head: resolved.head, source, scopes, changes,
  })
  report.command = 'prepare'
  if (!report.commands.includes('prepare')) report.commands.push('prepare')
  report.base = resolved
  report.head = resolved.head
  report.source = source
  report.scopes = scopes
  report.changes = changes
  rememberIssues(report, issues)
  const context = {
    root, candidate, report, version, scopes, env, runner,
    fingerprints: source, state: {}, toolchain: null, layout: null,
    save: () => writeReport(candidate.reportPath, report),
  }
  context.logPath = name => stageLogPath(context, name)
  await context.save()

  const layout = await import('./package-layout.mjs')
  context.layout = layout
  const testEnv = await sourceTestEnvironment({ root, env })
  const stage = (name, definition) => ({ name, ...definition })
  const refreshSource = async ctx => {
    ctx.fingerprints = await computeSourceFingerprints(root, await collectSourceFiles({ root, runner }))
    report.source = ctx.fingerprints
  }

  const stages = [
    stage('prerequisites', {
      fingerprint: async ctx => {
        // Recheck files/tools even when their paths stayed the same. Hydrate the
        // toolchain before cache reuse so downstream fingerprints stay stable.
        ctx.currentInputs = await checkPrepareInputs({
          root, version, resolvedBase: resolved, scopes, hostSources, env, runner: ctx.runner, expectedAssets,
        })
        ctx.toolchain = ctx.currentInputs.toolchain
        const { base: ignoredBase, ...inputs } = ctx.currentInputs
        return fingerprint({ kind: 'prerequisites', version, base: resolved.commit, scopes, inputs })
      },
      run: async ctx => {
        const inputs = ctx.currentInputs
        await writeTextLog(stageLogPath(ctx, 'prerequisites'), JSON.stringify({
          hosts: inputs.hosts, toolchain: inputs.toolchain, assets: inputs.assets,
        }, null, 2))
        return inputs
      },
    }),
    stage('version-sync', {
      fingerprint: async () => fingerprint({
        kind: 'version-sync', version,
        manifests: await Promise.all(VERSION_FILES.map(name => sha256File(path.join(root, name)))),
      }),
      run: async () => {
        const outputs = await syncVersionManifests(root, version)
        await writeTextLog(stageLogPath(context, 'version-sync'), JSON.stringify(outputs, null, 2))
        return outputs
      },
      artifacts: outputs => VERSION_FILES.map(name => ({ path: path.join(root, name), ...outputs.manifests[name] })),
      after: refreshSource,
    }),
    stage('build-index', {
      fingerprint: ctx => fingerprint({ kind: 'build-index', source: ctx.fingerprints.testFingerprint, tools: { node: process.version, esbuild: ctx.state.prerequisites?.toolchain?.esbuild } }),
      run: async (ctx, { log }) => {
        const result = await ctx.runner.run(process.execPath, ['scripts/build.mjs'], { cwd: root, log, timeout: 300000 })
        assertCommand(result, 'index build')
        return { sha256: await sha256File(path.join(root, 'index.js')), bytes: (await stat(path.join(root, 'index.js'))).size }
      },
      artifacts: outputs => [{ path: path.join(root, 'index.js'), sha256: outputs.sha256, bytes: outputs.bytes }],
      after: refreshSource,
    }),
    stage('source-tests', {
      fingerprint: ctx => fingerprint({ kind: 'source-tests', source: ctx.fingerprints.testFingerprint, env: testEnv, tools: sourceTestTools(ctx.state.prerequisites?.toolchain) }),
      run: async (ctx, { log }) => {
        const result = await ctx.runner.run('npm', ['test'], { cwd: root, env: testEnv, log, timeout: 1200000 })
        assertCommand(result, 'npm test')
        const parsed = parseSourceTests(result.text)
        if (parsed.fail === null || parsed.pass === null || parsed.fail !== 0 || parsed.pass < 1 || !parsed.goOk) {
          throw new ReleaseError('source test suite did not report a clean pass and Go test result')
        }
        return { ...parsed, indexSha256: await sha256File(path.join(root, 'index.js')), indexBytes: (await stat(path.join(root, 'index.js'))).size }
      },
      artifacts: outputs => [{ path: path.join(root, 'index.js'), sha256: outputs.indexSha256, bytes: outputs.indexBytes }],
    }),
    nativeRaceStage(root, scopes),
    ...PLATFORM_TARGETS.map(target => stage('package-' + target.name, {
      fingerprint: ctx => fingerprint({
        kind: 'package', target, source: ctx.fingerprints.sourceFingerprint,
        version: ctx.state['version-sync']?.version, manifests: ctx.state['version-sync']?.manifests,
        index: ctx.state['build-index']?.sha256, assets: ctx.state.prerequisites?.assets, tools: ctx.toolchain,
      }),
      run: async (ctx, { log }) => {
        const result = await ctx.runner.run(process.execPath, ['scripts/package.mjs', '--target', target.target], {
          cwd: root, log, timeout: 1800000,
          env: {
            QISHUI_NATIVE_DIR: env.QISHUI_NATIVE_DIR, QISHUI_FFMPEG_DIR: env.QISHUI_FFMPEG_DIR,
            QISHUI_DARWIN_AMD64_NATIVE_DIR: env.QISHUI_DARWIN_AMD64_NATIVE_DIR,
            QISHUI_DARWIN_AMD64_FFMPEG_DIR: env.QISHUI_DARWIN_AMD64_FFMPEG_DIR,
            QISHUI_WINDOWS_ASSETS: env.QISHUI_WINDOWS_ASSETS, QISHUI_ZIG: env.QISHUI_ZIG,
          },
        })
        assertCommand(result, target.name + ' package')
        const parsed = parsePackageArchives(result.text)
        const archives = {}
        for (const [kind, file] of [['runtime', parsed.runtime], ['validation', parsed.validation]]) {
          const info = await stat(file)
          if (!info.isFile() || !info.size) throw new ReleaseError('Package archive is missing or empty: ' + file)
          archives[kind] = { path: file, sha256: await sha256File(file), bytes: info.size }
        }
        return { platform: target.platform, arch: target.arch, target: target.target, archives }
      },
      artifacts: outputs => Object.values(outputs.archives),
    })),
    ...PLATFORM_TARGETS.map(target => stage('unpack-' + target.name, {
      fingerprint: ctx => {
        const pkg = ctx.state['package-' + target.name]
        return fingerprint({ kind: 'unpack', extractor: 'fflate-unzip-v1', archives: pkg ? Object.fromEntries(Object.entries(pkg.archives).map(([kind, value]) => [kind, value.sha256])) : null })
      },
      run: async ctx => {
        const pkg = ctx.state['package-' + target.name]
        if (!pkg) throw new ReleaseError('Package stage output is unavailable')
        const extracted = []
        for (const kind of ['runtime', 'validation']) {
          const archive = pkg.archives[kind]
          if (await sha256File(archive.path) !== archive.sha256) throw new ReleaseError('Package archive changed after build: ' + archive.path)
          const extractionRoot = path.join(candidate.dir, 'extracted')
          await mkdir(extractionRoot, { recursive: true })
          const dir = await mkdtemp(path.join(extractionRoot, target.name + '-' + kind + '-'))
          const unpacked = await unpackZip(archive.path, dir)
          const tree = await hashTree(dir)
          extracted.push({ kind, dir, ...unpacked, treeHash: tree.sha256, files: tree.files, bytes: tree.bytes, platform: target.platform, arch: target.arch })
        }
        await writeTextLog(stageLogPath(ctx, 'unpack-' + target.name), JSON.stringify(extracted, null, 2))
        return { platform: target.platform, arch: target.arch, extracted }
      },
      artifacts: outputs => outputs.extracted.map(item => ({ path: item.dir, treeHash: item.treeHash })),
    })),
    stage('package-checks', {
      fingerprint: async ctx => fingerprint({
        kind: 'package-checks', version,
        trees: Object.fromEntries(PLATFORM_TARGETS.map(target => [target.name,
          ctx.state['unpack-' + target.name]?.extracted.map(item => item.treeHash)])),
        layout: ctx.state.prerequisites ? await sha256File(path.join(root, 'scripts/package-layout.mjs')) : null,
      }),
      run: async ctx => {
        const checks = {}
        for (const target of PLATFORM_TARGETS) {
          const unpacked = ctx.state['unpack-' + target.name]
          checks[target.name] = await checkFinalPackages({
            root, version, extracted: unpacked.extracted, assets: ctx.state.prerequisites.assets,
            layout: ctx.layout, platform: target.platform, runner: ctx.runner,
          })
        }
        await writeTextLog(stageLogPath(ctx, 'package-checks'), JSON.stringify(checks, null, 2))
        return checks
      },
    }),
    stage('windows-static', {
      fingerprint: async ctx => fingerprint({
        kind: 'windows-static',
        trees: PLATFORM_TARGETS.filter(target => target.windows).map(target => ctx.state['unpack-' + target.name]?.extracted.map(item => item.treeHash)),
        inspector: ctx.fingerprints ? await sha256File(path.join(root, 'scripts/verify-windows.mjs')) : null,
      }),
      run: async ctx => {
        const { checkWindowsPackage } = await import('./verify-windows.mjs')
        const result = {}
        for (const target of PLATFORM_TARGETS.filter(target => target.windows)) {
          result[target.name] = {}
          for (const item of ctx.state['unpack-' + target.name].extracted) {
            result[target.name][item.kind] = await checkWindowsPackage(item.dir)
          }
        }
        const output = { staticOnly: true, packages: result, execution: scopes.native || scopes.audio ? 'pending' : 'not required for this change scope' }
        await writeTextLog(stageLogPath(ctx, 'windows-static'), JSON.stringify(output, null, 2))
        return output
      },
    }),
    stage('mac-native', {
      fingerprint: async ctx => fingerprint({
        kind: 'mac-native', inputs: await packagedTestInputs(ctx.state['unpack-darwin-arm64'].extracted.find(item => item.kind === 'validation').dir, 'native'),
        mode: scopes.native || scopes.audio ? 'full' : 'smoke', platform: process.platform, arch: process.arch,
      }),
      run: async (ctx, { log }) => {
        const validation = ctx.state['unpack-darwin-arm64'].extracted.find(item => item.kind === 'validation')
        if (!validation) throw new ReleaseError('macOS validation package is unavailable')
        const binary = path.join(validation.dir, 'test/native-worker.test')
        await requireFile(binary, 'macOS packaged native test binary')
        const mode = scopes.native || scopes.audio ? 'full' : 'smoke'
        const args = ['-test.v', '-test.timeout=5m']
        if (mode === 'smoke') args.push('-test.run', '^(' + NATIVE_IPC_TESTS.join('|') + ')$')
        const result = await ctx.runner.run(binary, args, {
          cwd: validation.dir, log, timeout: 400000,
          env: { PATH: '/usr/bin:/bin', QISHUI_NATIVE_ROOT: validation.dir },
        })
        assertCommand(result, 'macOS packaged native tests')
        const parsed = parseNativeChecks(result.text, { mode, expected: mode === 'smoke' ? NATIVE_IPC_TESTS : [] })
        if (!parsed.ok) throw new ReleaseError('macOS packaged native tests had failures or skips')
        return { mode, ...parsed }
      },
    }),
    stage('adapters', {
      required: scopes.native || scopes.audio,
      when: () => scopes.native || scopes.audio,
      skipReason: 'no native or audio impact',
      fingerprint: async ctx => fingerprint({
        kind: 'adapters', inputs: await packagedTestInputs(ctx.state['unpack-darwin-arm64'].extracted.find(item => item.kind === 'validation').dir, 'adapters'),
        node: process.version,
      }),
      run: async (ctx, { log }) => {
        const validation = ctx.state['unpack-darwin-arm64'].extracted.find(item => item.kind === 'validation')
        const names = ['worker', 'gapless', 'ffmpeg', 'playback']
        const files = names.map(name => path.join(validation.dir, 'test', name + '.test.mjs'))
        for (const file of files) await requireFile(file, 'adapter test ' + path.basename(file))
        const result = await ctx.runner.run(process.execPath, [
          '--experimental-vm-modules', '--test', ...files,
        ], {
          cwd: validation.dir, log, timeout: 900000,
          env: {
            PATH: '/usr/bin:/bin', QISHUI_NATIVE_ROOT: validation.dir,
            QISHUI_TEST_FFMPEG: path.join(validation.dir, 'runtime/native/ffmpeg'),
            QISHUI_TEST_NATIVE: '1',
          },
        })
        assertCommand(result, 'packaged adapter tests')
        const parsed = parseNodeTests(result.text)
        if (parsed.fail !== 0 || parsed.pass < 1 || parsed.skipped !== 0 || parsed.failedLines) throw new ReleaseError('packaged adapter tests had failures or skips')
        return parsed
      },
    }),
    ...(hostSources.map(hostSource => {
      const id = 'host-' + path.basename(hostSource).replace(/[^a-z0-9_.-]+/gi, '-') + '-' + fingerprint(path.resolve(hostSource)).slice(0, 8)
      return stage(id, {
        fingerprint: async ctx => fingerprint({
          kind: 'host', host: await inspectHost({ hostSource, runner: ctx.runner }),
          fixtures: await Promise.all(HOST_TEST_FIXTURES.map(([name]) => sha256File(path.join(root, 'test', name)))),
          packages: {
            mac: ctx.state['package-darwin-arm64']?.archives.runtime.sha256,
            windows: ctx.state['package-windows-amd64']?.archives.runtime.sha256,
            windowsValidation: ctx.state['package-windows-amd64']?.archives.validation.sha256,
            intel: ctx.state['package-darwin-amd64']?.archives.runtime.sha256,
            intelValidation: ctx.state['package-darwin-amd64']?.archives.validation.sha256,
            windowsArm64: ctx.state['package-windows-arm64']?.archives.runtime.sha256,
            windowsArm64Validation: ctx.state['package-windows-arm64']?.archives.validation.sha256,
          },
          go: ctx.state.prerequisites?.toolchain?.go,
        }),
        run: async (ctx, { log }) => {
          const identity = await inspectHost({ hostSource, runner: ctx.runner })
          const overlayPath = path.join(candidate.dir, 'overlays', id + '.json')
          const overlay = await createHostOverlay({ hostSource: identity.path, testRoot: path.join(root, 'test'), destination: overlayPath })
          const mac = ctx.state['package-darwin-arm64'].archives.runtime
          const win = ctx.state['package-windows-amd64'].archives
          const intel = ctx.state['package-darwin-amd64'].archives
          const winArm64 = ctx.state['package-windows-arm64'].archives
          const macDir = ctx.state['unpack-darwin-arm64'].extracted.find(item => item.kind === 'runtime').dir
          const result = await ctx.runner.run('go', [
            '-C', identity.path, 'test', '-overlay', overlayPath, '-run', HOST_TEST_PATTERN,
            '-count=1', '-v', '-timeout=10m', './internal/plugin',
          ], {
            cwd: identity.path, log, timeout: 900000,
            env: {
              QISHUI_PLUGIN_DIR: macDir, QISHUI_PLUGIN_ZIP: mac.path,
              QISHUI_WINDOWS_PLUGIN_ZIP: win.runtime.path,
              QISHUI_WINDOWS_VALIDATION_ZIP: win.validation.path,
              QISHUI_WINDOWS_ARM64_PLUGIN_ZIP: winArm64.runtime.path,
              QISHUI_WINDOWS_ARM64_VALIDATION_ZIP: winArm64.validation.path,
              QISHUI_DARWIN_AMD64_PLUGIN_ZIP: intel.runtime.path,
              QISHUI_DARWIN_AMD64_VALIDATION_ZIP: intel.validation.path,
            },
            unset: ['QISHUI_CHECK_RELEASE', 'QISHUI_HOST_PREFLIGHT', 'QISHUI_RELEASE_VERSION', 'QISHUI_RELEASE_PREVIOUS_VERSION', 'QISHUI_RELEASE_SHA256', 'QISHUI_SCENE_FIXTURE'],
          })
          assertCommand(result, 'host package tests')
          const parsed = parseHostTests(result.text)
          const missing = HOST_TEST_NAMES.filter(name => !parsed.passed.includes(name))
          if (missing.length || parsed.skipped.length || parsed.failed.length) throw new ReleaseError('host package tests had failures or skips: ' + [...missing, ...parsed.skipped, ...parsed.failed].join(', '))
          return { host: identity, overlay: overlayPath, removed: overlay.removed, tests: parsed }
        },
      })
    })),
  ]

  try {
    await executePipeline({ stages, context })
    const finalSource = await computeSourceFingerprints(root, await collectSourceFiles({ root, runner }))
    if (finalSource.sourceFingerprint !== context.fingerprints.sourceFingerprint) {
      throw new ReleaseError('Source changed during preparation; rerun prepare to validate the affected stages')
    }
    report.failure = null
  } catch (error) {
    report.status = 'failed'
    report.failure = report.failure || { stage: 'unknown', message: safeMessage(error), log: null }
    report.pendingManualChecks = pendingManualChecks(scopes)
    report.readyForRelease = false
    await context.save()
    throw error
  }

  report.status = 'passed'
  report.pendingManualChecks = pendingManualChecks(scopes)
  report.readyForRelease = report.pendingManualChecks.length === 0 && report.unresolved.length === 0
  report.inputs = {
    prerequisites: context.state.prerequisites ? {
      hosts: context.state.prerequisites.hosts, assets: context.state.prerequisites.assets,
      toolchain: context.state.prerequisites.toolchain,
    } : null,
    tests: Object.fromEntries(await Promise.all(HOST_TEST_FIXTURES.map(async ([name]) => [name, await sha256File(path.join(root, 'test', name))]))),
  }
  report.packages = PLATFORM_TARGETS.flatMap(target => {
    const pkg = context.state['package-' + target.name]
    const unpacked = context.state['unpack-' + target.name]
    if (!pkg || !unpacked) return []
    return unpacked.extracted.map(item => ({
      platform: target.platform, arch: target.arch, kind: item.kind,
      archive: pkg.archives[item.kind].path, sha256: pkg.archives[item.kind].sha256, bytes: pkg.archives[item.kind].bytes,
      extracted: item.dir, treeHash: item.treeHash, unpackedBytes: item.bytes, files: item.files,
    }))
  })
  await context.save()
  return report
}

// ---------------------------------------------------------------------------
// CLI

export const USAGE = `Usage:
  node scripts/release.mjs plan    [--version X.Y.Z] [--base REF] [--host-source DIR]... [--output DIR] [--issue TEXT]...
  node scripts/release.mjs check   [--version X.Y.Z] [--base REF] [--output DIR] [--issue TEXT]...
  node scripts/release.mjs prepare --version X.Y.Z --host-source DIR [--host-source DIR]... [--base REF] [--output DIR] [--issue TEXT]...

Environment for prepare:
  QISHUI_NATIVE_DIR, QISHUI_FFMPEG_DIR, QISHUI_WINDOWS_ASSETS, QISHUI_ZIG (absolute)
  QISHUI_DARWIN_AMD64_NATIVE_DIR, QISHUI_DARWIN_AMD64_FFMPEG_DIR (absolute)
Defaults: --base is the latest reachable v* tag; --output is dist/release-<version>.
prepare never commits, pushes, tags or publishes. Windows/Intel/audio/account manual
checks stay pending and keep readyForRelease false.`

export function parseArgs(argv) {
  const options = { command: null, hostSources: [], issues: [], help: false, version: null, base: null, output: null }
  const valueFlags = new Set(['--version', '--base', '--output', '--host-source', '--issue'])
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') { options.help = true; continue }
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=')
      const flag = equals === -1 ? argument : argument.slice(0, equals)
      const inline = equals === -1 ? null : argument.slice(equals + 1)
      if (!valueFlags.has(flag)) throw new ReleaseError('Unknown option: ' + flag)
      const value = inline ?? argv[++index]
      if (value === undefined || value.startsWith('--')) throw new ReleaseError(flag + ' requires a value')
      if (flag === '--host-source') options.hostSources.push(value)
      else if (flag === '--issue') options.issues.push(value)
      else options[flag.slice(2)] = value
      continue
    }
    if (options.command) throw new ReleaseError('Unexpected argument: ' + argument)
    options.command = argument
  }
  if (options.help) return options
  if (!['plan', 'check', 'prepare'].includes(options.command)) throw new ReleaseError('Command must be plan, check or prepare')
  return options
}

function printReport(report) {
  console.log('release ' + report.command + ': ' + report.status)
  for (const stage of report.stages) console.log('  ' + stage.name + ': ' + stage.status + (stage.reused ? ' (reused)' : '') + (stage.log ? ' log=' + stage.log : ''))
  if (report.packages.length) {
    for (const pkg of report.packages) console.log('  ' + pkg.platform + '-' + pkg.arch + ' ' + pkg.kind + ': ' + pkg.bytes + ' bytes sha256=' + pkg.sha256)
  }
  for (const pending of report.pendingManualChecks) console.log('  manual ' + pending.scope + ': pending - ' + pending.reason)
  console.log('readyForRelease: ' + report.readyForRelease)
}

export async function main(argv = process.argv.slice(2), { root = defaultRoot } = {}) {
  const options = parseArgs(argv)
  if (options.help) { console.log(USAGE); return 0 }
  const runner = createRunner({ cwd: root })
  try {
    if (options.command === 'plan') {
      const result = await planRelease({ root, base: options.base, version: options.version, hostSources: options.hostSources, runner })
      console.log(JSON.stringify(result, null, 2))
      return 0
    }
    if (options.command === 'check') {
      const report = await checkRelease({ root, version: options.version, base: options.base, output: options.output, issues: options.issues, runner })
      printReport(report)
      return report.status === 'passed' ? 0 : 1
    }
    const report = await prepareRelease({
      root, version: options.version, base: options.base, hostSources: options.hostSources,
      output: options.output, issues: options.issues, runner,
    })
    printReport(report)
    return report.status === 'passed' ? 0 : 1
  } catch (error) {
    console.error('release: ' + safeMessage(error))
    return 1
  }
}

const entry = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null
const self = await realpath(selfPath).catch(() => null)
if (entry && self && entry === self) process.exitCode = await main()
