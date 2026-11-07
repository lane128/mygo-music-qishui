// Build-only macOS candidate. Never alters the signed upstream executable.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = (program, args, options = {}) => execFileSync(program, args, {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options,
})
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function unused(file) {
  try { await lstat(file) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`Refusing to overwrite existing output: ${file}`)
}

async function inspectSignature(file) {
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', '--entitlements', ':-', file], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  })
  if (result.error || result.status !== 0) throw new Error('Cannot inspect code signature', { cause: result.error })
  const flags = /CodeDirectory[^\n]*flags=0x([0-9a-f]+)/i.exec(result.stderr)
  if (!flags || !result.stdout.includes('<plist')) throw new Error('Missing signing flags or entitlements')
  const entitlements = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: result.stdout }))
  return {
    xml: result.stdout, flags: Number.parseInt(flags[1], 16), entitlements,
    authorities: [...result.stderr.matchAll(/^Authority=(.*)$/gm)].map(match => match[1]),
    teamIdentifier: /^TeamIdentifier=(.*)$/m.exec(result.stderr)?.[1] || null,
    details: result.stderr,
  }
}

const stable = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
const exportsOf = file => [...new Set(run('/usr/bin/nm', ['-gjU', file]).split('\n').filter(Boolean))].sort()

export async function prepareNode({ source, destination, metadataPath = `${destination}.json` }) {
  if (process.platform !== 'darwin') throw new Error('Node trimming requires macOS signing tools')
  if (!source || !destination) throw new Error('source and destination are required')
  source = await realpath(source)
  const output = async file => path.join(await realpath(path.dirname(path.resolve(file))), path.basename(file))
  destination = await output(destination)
  metadataPath = await output(metadataPath)
  if (source === destination || source === metadataPath || destination === metadataPath) throw new Error('Source and outputs must be different files')
  await unused(destination)
  await unused(metadataPath)
  if (!(await stat(source)).isFile()) throw new Error('Source must be a regular executable')

  // No source or derived executable is run until its own strict signature check.
  run('/usr/bin/codesign', ['--verify', '--strict', source])
  const original = await inspectSignature(source)
  if (!(original.flags & 0x10000) || original.flags & 0x2 || !original.authorities.length) {
    throw new Error('Expected a vendor-signed source with hardened runtime enabled')
  }
  const before = await readFile(source)
  const sourceVersion = run(source, ['--version']).trim()
  if (!/^v\d+\.\d+\.\d+$/.test(sourceVersion)) throw new Error('Source did not report a Node version')
  const sourceExports = exportsOf(source)
  if (!sourceExports.length) throw new Error('Source exports are empty')
  const scratch = await mkdtemp(path.join(path.dirname(destination), '.qishui-node-trim-'))
  let published = false
  try {
    const candidate = path.join(scratch, 'node')
    const entitlementFile = path.join(scratch, 'entitlements.plist')
    await copyFile(source, candidate, constants.COPYFILE_EXCL)
    await writeFile(entitlementFile, original.xml, { flag: 'wx' })
    run('/usr/bin/strip', ['-x', candidate])
    const candidateExports = exportsOf(candidate)
    if (JSON.stringify(sourceExports) !== JSON.stringify(candidateExports)) throw new Error('Stripping changed exported symbols')
    // Ad hoc signing is intentional: the original vendor signature no longer applies.
    const options = `0x${original.flags.toString(16)}`
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', options, '--entitlements', entitlementFile, candidate])
    run('/usr/bin/codesign', ['--verify', '--strict', candidate])
    const derived = await inspectSignature(candidate)
    if (derived.flags !== (original.flags | 0x2) || stable(original.entitlements) !== stable(derived.entitlements)) {
      throw new Error('Derived signature did not preserve source flags and entitlements')
    }
    if (JSON.stringify(sourceExports) !== JSON.stringify(exportsOf(candidate))) throw new Error('Signing changed exported symbols')
    const version = run(candidate, ['--version']).trim()
    if (version !== sourceVersion) throw new Error('Derived Node version changed')
    const after = await readFile(candidate)
    if (after.length >= before.length) throw new Error('Trimming did not reduce executable size')
    if (digest(await readFile(source)) !== digest(before)) throw new Error('Source changed during preparation')
    const metadata = {
      schemaVersion: 1,
      source: { path: source, sha256: digest(before), bytes: before.length, version: sourceVersion,
        signing: { flags: original.flags, authorities: original.authorities, teamIdentifier: original.teamIdentifier, entitlements: original.entitlements } },
      derived: { sha256: digest(after), bytes: after.length, version,
        signing: { kind: 'ad-hoc', vendorSignatureApplies: false, strictVerificationPassed: true,
          flags: derived.flags, entitlements: derived.entitlements } },
      provenance: { strip: { tool: '/usr/bin/strip', flags: ['-x'] },
        signing: { tool: '/usr/bin/codesign', identity: '-', options,
          notice: 'Locally modified and ad hoc signed; the original vendor signature no longer applies.' },
        exports: { command: 'nm -gjU', count: sourceExports.length, unchanged: true } },
    }
    // link refuses existing files, including aliases of source, without replacing them.
    await link(candidate, destination)
    published = true
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return metadata
  } catch (error) {
    if (published) await rm(destination)
    throw error
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  try {
    const [source, destination, metadataPath, ...extra] = process.argv.slice(2)
    if (!source || !destination || extra.length) throw new Error('Usage: node scripts/prepare-node.mjs SOURCE DESTINATION [METADATA]')
    const result = await prepareNode({ source, destination, ...(metadataPath ? { metadataPath } : {}) })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
