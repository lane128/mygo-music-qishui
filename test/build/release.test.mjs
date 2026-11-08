import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  HOST_TEST_NAMES, classifyChanges, collectChangedFiles, compareRuntimeValidation,
  computeSourceFingerprints, createHostOverlay, ensureCandidateDirectory, executePipeline,
  parseArgs, parseHostTests, parseNativeChecks, parseNodeTests, parsePackageArchives,
  packagedTestInputs, parseSourceTests, prepareRelease, sha256File, syncVersionManifests,
  validateExpectedFiles, verifyManifestVersions, verifySourceMatchesPackage,
} from '../../scripts/release.mjs'

async function temporary(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2) + '\n')
}

async function fakeManifests(root, version = '1.0.9') {
  await writeJson(path.join(root, 'plugin.json'), { id: 'qishui-app-login', version, minAppVersion: '0.1.20' })
  await writeJson(path.join(root, 'package.json'), { name: 'qishui', version, private: true })
  await writeJson(path.join(root, 'package-lock.json'), {
    name: 'qishui', version, lockfileVersion: 3, packages: { '': { name: 'qishui', version } },
  })
}

test('change scope includes working tree and untracked files and derives host requirements', async () => {
  const runner = {
    async run(command, args) {
      assert.equal(command, 'git')
      if (args.includes('diff')) {
        assert.ok(args.includes('v1.0.9'))
        return { status: 0, stdout: 'M\0helper/membership.mjs\0A\0native/worker/gapless.go\0M\0scripts/package-layout.mjs\0', stderr: '', text: '' }
      }
      if (args.includes('--others')) {
        return { status: 0, stdout: 'test/authentication.test.mjs\0README.md\0', stderr: '', text: '' }
      }
      throw new Error('unexpected git invocation')
    },
  }
  const changes = await collectChangedFiles({ root: '/tmp/unused', runner, base: 'v1.0.9' })
  assert.deepEqual(changes.map(change => change.path), [
    'helper/membership.mjs', 'native/worker/gapless.go', 'README.md', 'scripts/package-layout.mjs', 'test/authentication.test.mjs',
  ])
  const scopes = classifyChanges(changes)
  assert.ok(scopes.auth)
  assert.ok(scopes.native)
  assert.ok(scopes.audio)
  assert.ok(scopes.compatibility)
  assert.equal(scopes.hostCount, 2)
  assert.equal(scopes.docsOnly, false)
  const docs = classifyChanges([{ path: 'README.md', status: 'M' }])
  assert.deepEqual(docs.scopes, ['docs'])
  assert.equal(docs.docsOnly, true)
  assert.equal(docs.hostCount, 1)
  assert.equal(classifyChanges([{ path: 'index.js', status: 'M' }, { path: 'helper/membership.mjs', status: 'M' }]).hostCount, 1)
  assert.equal(classifyChanges([{ path: 'src/plugin.mjs', status: 'M', apiChanged: false }]).hostCount, 1)
  assert.equal(classifyChanges([{ path: 'src/plugin.mjs', status: 'M', apiChanged: true }]).hostCount, 2)
  const versionOnly = classifyChanges([{ path: 'plugin.json', status: 'M', versionOnly: true }, { path: 'package.json', status: 'M', versionOnly: true }])
  assert.equal(versionOnly.hostCount, 1)
  assert.equal(versionOnly.nativeRace, false)
})

// Ordinary implementation and version changes need one host; a new host API needs compatibility coverage.
test('scope compares actual manifest and host API changes against the release base', async () => {
  const fixture = await temporary('qishui-release-scope-')
  try {
    await mkdir(path.join(fixture.dir, 'src'))
    const oldSource = 'export async function account() { return host.storage.get("session") }'
    const before = JSON.stringify({ version: '1.0.9', minAppVersion: '0.1.20' })
    await writeFile(path.join(fixture.dir, 'src/plugin.mjs'), oldSource.replace('return ', 'const value = 1; return '))
    await writeJson(path.join(fixture.dir, 'plugin.json'), { version: '1.0.10', minAppVersion: '0.1.20' })
    const runner = { async run(command, args) {
      if (args.includes('diff')) return { status: 0, stdout: 'M\0src/plugin.mjs\0M\0plugin.json\0' }
      if (args.includes('--others')) return { status: 0, stdout: '' }
      return { status: 0, stdout: args.at(-1).endsWith('src/plugin.mjs') ? oldSource : before }
    } }
    const changes = await collectChangedFiles({ root: fixture.dir, runner, base: 'v1.0.9' })
    assert.equal(classifyChanges(changes).hostCount, 1)
    assert.equal(changes.find(change => change.path === 'plugin.json').versionOnly, true)
    await writeFile(path.join(fixture.dir, 'src/plugin.mjs'), oldSource.replace('host.storage.get("session")', 'host.crypto.md5("value")'))
    assert.equal(classifyChanges(await collectChangedFiles({ root: fixture.dir, runner, base: 'v1.0.9' })).hostCount, 2)
  } finally { await fixture.cleanup() }
})

test('semantic fingerprints survive version/document edits but change with dirty source and new files', async () => {
  const temporaryRoot = await temporary('qishui-release-fingerprint-')
  try {
    const root = temporaryRoot.dir
    await fakeManifests(root)
    await writeJson(path.join(root, 'README.md'), { text: 'one' })
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src/plugin.mjs'), 'export const value = 1\n')
    const files = ['plugin.json', 'package.json', 'package-lock.json', 'README.md', 'src/plugin.mjs']
    const first = await computeSourceFingerprints(root, files)

    await writeJson(path.join(root, 'README.md'), { text: 'two' })
    await writeJson(path.join(root, 'plugin.json'), { id: 'qishui-app-login', version: '1.0.10', minAppVersion: '0.1.20' })
    await writeJson(path.join(root, 'package.json'), { name: 'qishui', version: '1.0.10', private: true })
    await writeJson(path.join(root, 'package-lock.json'), {
      name: 'qishui', version: '1.0.10', lockfileVersion: 3, packages: { '': { name: 'qishui', version: '1.0.10' } },
    })
    const versionOnly = await computeSourceFingerprints(root, files)
    assert.notEqual(versionOnly.sourceFingerprint, first.sourceFingerprint)
    assert.equal(versionOnly.testFingerprint, first.testFingerprint)

    await writeFile(path.join(root, 'src/plugin.mjs'), 'export const value = 2\n')
    const dirty = await computeSourceFingerprints(root, files)
    assert.notEqual(dirty.testFingerprint, versionOnly.testFingerprint)

    await writeFile(path.join(root, 'src/new-untracked.mjs'), 'export const added = true\n')
    const untracked = await computeSourceFingerprints(root, [...files, 'src/new-untracked.mjs'])
    assert.notEqual(untracked.testFingerprint, dirty.testFingerprint)
  } finally {
    await temporaryRoot.cleanup()
  }
})

test('version sync updates all three manifests and never half-writes when a manifest is missing', async () => {
  const temporaryRoot = await temporary('qishui-release-version-')
  try {
    const root = temporaryRoot.dir
    await fakeManifests(root)
    const result = await syncVersionManifests(root, '1.0.10')
    const plugin = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'))
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
    assert.equal(plugin.version, '1.0.10')
    assert.equal(pkg.version, '1.0.10')
    assert.equal(lock.version, '1.0.10')
    assert.equal(lock.packages[''].version, '1.0.10')
    assert.equal(result.manifests['plugin.json'].sha256, await sha256File(path.join(root, 'plugin.json')))

    const broken = await temporary('qishui-release-version-broken-')
    try {
      await writeJson(path.join(broken.dir, 'plugin.json'), { version: '1.0.9' })
      await writeJson(path.join(broken.dir, 'package.json'), { version: '1.0.9' })
      await assert.rejects(syncVersionManifests(broken.dir, '1.0.10'), /package-lock\.json/)
      assert.equal(JSON.parse(await readFile(path.join(broken.dir, 'plugin.json'), 'utf8')).version, '1.0.9')
    } finally {
      await broken.cleanup()
    }
  } finally {
    await temporaryRoot.cleanup()
  }
})

test('candidate output preserves author notes and refuses generated collisions without a report', async () => {
  const temporaryRoot = await temporary('qishui-release-output-')
  try {
    const candidate = path.join(temporaryRoot.dir, 'candidate')
    await mkdir(candidate, { recursive: true })
    await writeFile(path.join(candidate, 'notes.md'), 'author notes\n')
    const fresh = await ensureCandidateDirectory(candidate, '1.0.10')
    assert.equal(fresh.report, null)
    assert.ok((await readFile(path.join(candidate, 'notes.md'), 'utf8')).includes('author notes'))

    const collision = path.join(temporaryRoot.dir, 'collision')
    await mkdir(path.join(collision, 'logs'), { recursive: true })
    await writeFile(path.join(collision, 'logs/stale.log'), 'stale\n')
    await assert.rejects(ensureCandidateDirectory(collision, '1.0.10'), /generated paths without report\.json/)

    await writeJson(path.join(candidate, 'report.json'), { version: '1.0.9' })
    await assert.rejects(ensureCandidateDirectory(candidate, '1.0.10'), /Existing candidate report is for 1\.0\.9/)
  } finally {
    await temporaryRoot.cleanup()
  }
})

test('missing required inputs are rejected before prepare mutates anything', async () => {
  const temporaryRoot = await temporary('qishui-release-prereq-')
  try {
    const root = temporaryRoot.dir
    await fakeManifests(root)
    const before = await readFile(path.join(root, 'plugin.json'), 'utf8')
    await assert.rejects(prepareRelease({ root, version: '1.0.10', hostSources: [] }), /host-source/)
    await assert.rejects(prepareRelease({ root, hostSources: [] }), /--version/)
    assert.equal(await readFile(path.join(root, 'plugin.json'), 'utf8'), before)
    await assert.rejects(validateExpectedFiles(root, { 'missing.bin': '0'.repeat(64) }, 'fixture'), /Missing fixture file/)
    await assert.rejects(validateExpectedFiles(root, { 'plugin.json': '0'.repeat(64) }, 'fixture'), /Checksum mismatch/)
  } finally {
    await temporaryRoot.cleanup()
  }
})

test('package version, source and runtime/validation mismatches are rejected', async () => {
  assert.doesNotThrow(() => verifyManifestVersions({ version: '1.0.10' }, { version: '1.0.10' }, { version: '1.0.10', packages: { '': { version: '1.0.10' } } }, '1.0.10'))
  assert.throws(() => verifyManifestVersions({ version: '1.0.9' }, { version: '1.0.10' }, { version: '1.0.10', packages: { '': { version: '1.0.10' } } }, '1.0.10'), /plugin\.json version/)
  assert.throws(() => verifyManifestVersions({ version: '1.0.10' }, { version: '1.0.10' }, { version: '1.0.10', packages: { '': { version: '1.0.9' } } }, '1.0.10'), /root package version/)

  const runtime = { 'index.js': { sha256: 'a' }, 'runtime/native/BUILD.json': { sha256: 'b', value: { 'worker.exe': 'x' } } }
  assert.doesNotThrow(() => compareRuntimeValidation(runtime, {
    'index.js': { sha256: 'a' },
    'runtime/native/BUILD.json': { sha256: 'c', value: { 'worker.exe': 'x', 'native-worker.test.exe': 't' } },
  }, { platform: 'windows' }))
  assert.throws(() => compareRuntimeValidation(runtime, {
    'index.js': { sha256: 'different' },
    'runtime/native/BUILD.json': { sha256: 'b', value: { 'worker.exe': 'x' } },
  }, { platform: 'windows' }), /Runtime\/validation mismatch/)
  assert.throws(() => compareRuntimeValidation(runtime, {
    'index.js': { sha256: 'a' },
    'runtime/native/BUILD.json': { sha256: 'c', value: { 'worker.exe': 'x', 'unexpected.test.exe': 't' } },
  }, { platform: 'windows' }), /unexpected test entry/)
  assert.throws(() => compareRuntimeValidation(runtime, {
    'index.js': { sha256: 'a' },
    'runtime/native/BUILD.json': { sha256: 'c', value: { 'worker.exe': 'changed' } },
  }, { platform: 'windows' }), /changed runtime digest/)

  const root = await temporary('qishui-release-source-check-')
  const packageRoot = await temporary('qishui-release-source-package-')
  try {
    await mkdir(path.join(root.dir, 'src'), { recursive: true })
    await mkdir(path.join(packageRoot.dir, 'src'), { recursive: true })
    await writeFile(path.join(root.dir, 'src/plugin.mjs'), 'source\n')
    await writeFile(path.join(packageRoot.dir, 'src/plugin.mjs'), 'stale\n')
    await assert.rejects(verifySourceMatchesPackage({
      root: root.dir, dir: packageRoot.dir, validation: false,
      layout: { runtimeSource: ['src'], validationSource: [], checkPackageLayout() {} },
    }), /source differs from the working tree/)
  } finally {
    await root.cleanup()
    await packageRoot.cleanup()
  }
})

test('pipeline failure stops dependents, persists a summary and honours resume hashes', async () => {
  const temporaryRoot = await temporary('qishui-release-pipeline-')
  try {
    const candidate = { dir: temporaryRoot.dir }
    const report = { stages: [], status: 'incomplete', readyForRelease: false }
    const save = async () => writeFile(path.join(candidate.dir, 'report.json'), JSON.stringify(report, null, 2))
    let laterRan = false
    const runner = { calls: 0, async run() { this.calls++; return { status: 1, stdout: '', stderr: 'private diagnostic', text: 'private diagnostic' } } }
    const failing = {
      name: 'first', required: true, fingerprint: () => 'first-v1',
      run: async (context, { log }) => {
        const result = await context.runner.run('false', [])
        await writeFile(log, 'command log\n')
        if (result.status !== 0) throw new Error('command failed')
      },
      artifacts: () => [],
    }
    const dependent = {
      name: 'second', required: true, fingerprint: () => 'second-v1',
      run: async () => { laterRan = true }, artifacts: () => [],
    }
    const context = { candidate, report, save, state: {}, runner }
    await assert.rejects(executePipeline({ stages: [failing, dependent], context }), /first: command failed/)
    assert.equal(laterRan, false)
    assert.equal(runner.calls, 1)
    assert.equal(report.status, 'failed')
    assert.equal(report.failure.stage, 'first')
    assert.equal(report.stages.find(stage => stage.name === 'second').status, 'skipped')
    assert.equal(report.stages.find(stage => stage.name === 'second').blockedBy, 'first')
    const persisted = JSON.parse(await readFile(path.join(candidate.dir, 'report.json'), 'utf8'))
    assert.equal(persisted.stages.find(stage => stage.name === 'first').status, 'failed')
    assert.ok(!JSON.stringify(persisted).includes('private diagnostic'))
    assert.match(await readFile(persisted.stages[0].log, 'utf8'), /command log/, 'failure must preserve the original evidence')

    const resume = { dir: temporaryRoot.dir }
    const resumeReport = { stages: [], status: 'incomplete', readyForRelease: false }
    const resumeSave = async () => writeFile(path.join(resume.dir, 'report.json'), JSON.stringify(resumeReport, null, 2))
    const calls = { first: 0, second: 0 }
    const makeStage = name => ({
      name, required: true,
      fingerprint: context => name === 'second' ? 'fp-second-' + (context.state.first?.revision || '') : 'fp-first',
      run: async (context, { log }) => {
        calls[name]++
        const artifact = path.join(resume.dir, name + '.out')
        await writeFile(artifact, name + '-output-' + calls[name])
        await writeFile(log, name + ' log\n')
        return { artifact, sha: await sha256File(artifact), revision: calls[name] }
      },
      artifacts: outputs => [{ path: outputs.artifact, sha256: outputs.sha }],
    })
    const resumeContext = { candidate: resume, report: resumeReport, save: resumeSave, state: {}, runner: { run: async () => ({ status: 0, stdout: '', stderr: '', text: '' }) } }
    const stages = [makeStage('first'), makeStage('second')]
    await executePipeline({ stages, context: resumeContext })
    assert.deepEqual(calls, { first: 1, second: 1 })
    await executePipeline({ stages, context: resumeContext })
    assert.deepEqual(calls, { first: 1, second: 1 }, 'unchanged inputs must reuse both stages')
    assert.equal(resumeReport.stages.find(stage => stage.name === 'first').reused, true)

    await writeFile(path.join(resume.dir, 'first.out'), 'tampered')
    await executePipeline({ stages, context: resumeContext })
    assert.deepEqual(calls, { first: 2, second: 2 }, 'artifact hash change must invalidate the dependent stage')

    await rm(path.join(resume.dir, 'logs', 'first.log'))
    await executePipeline({ stages, context: resumeContext })
    assert.equal(calls.first, 3, 'missing log must invalidate reuse')
  } finally {
    await temporaryRoot.cleanup()
  }
})

test('host overlay adds three virtual fixtures, replaces old Qishui tests and never writes into the host', async () => {
  const hostRoot = await temporary('qishui-release-host-')
  const fixtureRoot = await temporary('qishui-release-fixtures-')
  const outputRoot = await temporary('qishui-release-overlay-')
  try {
    const pluginDir = path.join(hostRoot.dir, 'internal/plugin')
    await mkdir(pluginDir, { recursive: true })
    await writeJson(path.join(hostRoot.dir, 'go.mod'), { module: 'mygo-music' })
    await writeFile(path.join(pluginDir, 'qishui_external_test.go'), 'package plugin\nfunc TestQishuiPluginRuntime(t *testing.T) {}\n')
    await writeFile(path.join(pluginDir, 'qishui_helpers_test.go'), 'package plugin\nfunc qishuiAuthFixture() {}\n')
    await writeFile(path.join(pluginDir, 'other_test.go'), 'package plugin\nfunc TestOther(t *testing.T) {}\n')
    for (const [sourceName] of [['host_integration_test.go'], ['host_release_test.go'], ['host_windows_package_test.go']]) {
      await writeFile(path.join(fixtureRoot.dir, sourceName), 'package plugin\n')
    }
    const hostBefore = await sha256File(path.join(pluginDir, 'qishui_external_test.go'))
    const overlayPath = path.join(outputRoot.dir, 'overlays', 'host.json')
    const overlay = await createHostOverlay({
      hostSource: hostRoot.dir, testRoot: fixtureRoot.dir, destination: overlayPath,
    })
    const document = JSON.parse(await readFile(overlayPath, 'utf8'))
    assert.equal(overlay.removed.length, 2)
    assert.equal(document.Replace[path.join(pluginDir, 'qishui_external_test.go')], '')
    assert.equal(document.Replace[path.join(pluginDir, 'qishui_helpers_test.go')], '')
    assert.equal(document.Replace[path.join(pluginDir, 'other_test.go')], undefined)
    for (const [sourceName, virtualName] of [
      ['host_integration_test.go', 'qishui_release_external_test.go'],
      ['host_release_test.go', 'qishui_release_verify_test.go'],
      ['host_windows_package_test.go', 'qishui_release_winpackage_test.go'],
    ]) {
      assert.equal(document.Replace[path.join(pluginDir, virtualName)], path.join(fixtureRoot.dir, sourceName))
    }
    assert.equal(await sha256File(path.join(pluginDir, 'qishui_external_test.go')), hostBefore)
    assert.ok(!overlayPath.startsWith(hostRoot.dir))
  } finally {
    await hostRoot.cleanup()
    await fixtureRoot.cleanup()
    await outputRoot.cleanup()
  }
})

test('packaged audio checks reuse results across documentation changes but reject changed execution inputs', async () => {
  const docs = classifyChanges([{ path: 'native/worker/README.md', status: 'M' }])
  assert.equal(docs.docsOnly, true)
  assert.equal(docs.nativeRace, false)
  assert.equal(docs.auth, false)
  assert.equal(docs.audio, false)
  const fixture = await temporary('qishui-execution-inputs-')
  try {
    const write = async (name, content = 'fixture') => {
      const file = path.join(fixture.dir, name)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, content)
    }
    for (const name of [
      'bin/worker', 'runtime/native/ffmpeg', 'test/fixtures/audio.m4a',
      'test/native-worker.test', 'helper/native.mjs',
      ...['worker', 'gapless', 'ffmpeg', 'playback'].map(name => 'test/' + name + '.test.mjs'),
    ]) await write(name)
    const native = await packagedTestInputs(fixture.dir, 'native')
    const adapters = await packagedTestInputs(fixture.dir, 'adapters')
    await write('RELEASE.md', 'updated docs')
    await write('plugin.json', '{"version":"1.0.11"}')
    assert.equal(await packagedTestInputs(fixture.dir, 'native'), native)
    assert.equal(await packagedTestInputs(fixture.dir, 'adapters'), adapters)
    await write('test/ffmpeg.test.mjs', 'new assertion')
    assert.equal(await packagedTestInputs(fixture.dir, 'native'), native)
    assert.notEqual(await packagedTestInputs(fixture.dir, 'adapters'), adapters)
    await write('runtime/native/ffmpeg', 'changed executable')
    assert.notEqual(await packagedTestInputs(fixture.dir, 'native'), native)
  } finally {
    await fixture.cleanup()
  }
})

test('test output and archive parsers reject skips and incomplete package reports', () => {
  const source = parseSourceTests('ℹ tests 5\nℹ pass 4\nℹ fail 0\nℹ skipped 1\nok  \tqishui-worker\n')
  assert.deepEqual(source, { tests: 5, pass: 4, fail: 0, skipped: 1, goOk: true })

  const host = parseHostTests(HOST_TEST_NAMES.map(name => '--- PASS: ' + name + ' (0.1s)').join('\n') + '\nPASS\nok\tmygo-music/internal/plugin\n')
  assert.deepEqual(host.skipped, [])
  assert.deepEqual(host.failed, [])
  assert.deepEqual(host.passed, HOST_TEST_NAMES)
  assert.equal(parseHostTests('--- SKIP: TestQishuiPluginRuntime').skipped[0], 'TestQishuiPluginRuntime')

  assert.equal(parseNativeChecks('--- PASS: TestAudioBridgeHTTP', { mode: 'smoke', expected: ['TestAudioBridgeHTTP'] }).ok, true)
  assert.equal(parseNativeChecks('--- SKIP: TestAudioBridgeHTTP', { mode: 'smoke', expected: ['TestAudioBridgeHTTP'] }).ok, false)
  assert.equal(parseNativeChecks('--- PASS: Other', { mode: 'smoke', expected: ['TestAudioBridgeHTTP'] }).ok, false)

  assert.equal(parseNodeTests('ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ skipped 0').skipped, 0)
  assert.equal(parseNodeTests('ℹ tests 2\nℹ pass 1\nℹ fail 0\nℹ skipped 1').skipped, 1)

  const parsed = parsePackageArchives('/tmp/a/plugin-darwin-arm64-1.0.10-1.zip\n/tmp/a/plugin-darwin-arm64-1.0.10-1-validation.zip\n')
  assert.match(parsed.runtime, /-1\.zip$/)
  assert.match(parsed.validation, /-validation\.zip$/)
  assert.throws(() => parsePackageArchives('/tmp/a/one.zip\n'), /exactly one runtime and one validation/)

  assert.deepEqual(
    parseArgs(['prepare', '--version', '1.0.10', '--host-source', '/a', '--host-source=/b', '--issue', 'known']),
    { command: 'prepare', hostSources: ['/a', '/b'], issues: ['known'], help: false, version: '1.0.10', base: null, output: null },
  )
  assert.throws(() => parseArgs(['prepare', '--unknown', 'x']), /Unknown option/)
  assert.throws(() => parseArgs(['release']), /Command must be/)
})
