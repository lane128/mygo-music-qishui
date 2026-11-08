import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWindowsNative } from '../helper/windows-native.mjs'

async function fixture(t, respond) {
  const plugin = await mkdtemp(path.join(tmpdir(), 'qishui-win-fixture-'))
  t.after(() => rm(plugin, { recursive: true, force: true }))
  await mkdir(path.join(plugin, 'runtime/native'), { recursive: true })
  await mkdir(path.join(plugin, 'helper'))
  for (const name of ['windows-runner.exe', 'bdms.node', 'metasecml.dll']) await writeFile(path.join(plugin, 'runtime/native', name), 'fixture-' + name)
  const node = path.join(plugin, 'fixture-node.exe')
  await writeFile(node, 'fixture-node')
  await writeFile(path.join(plugin, 'helper/resource.cjs'), '/* fixture decoder */')
  const calls = [], started = new EventEmitter()
  const native = createWindowsNative({ plugin, node, platform: 'win32', arch: 'x64', spawnProcess(command, args, options) {
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough()
    child.kill = () => { child.emit('close', 1); return true }
    const call = { command, args, options, child, root: options.cwd }
    calls.push(call)
    const input = []
    child.stdin.on('data', chunk => input.push(chunk))
    child.stdin.on('finish', () => {
      call.input = Buffer.concat(input)
      Promise.resolve(respond(call)).then(output => {
        if (output !== undefined) { child.stdout.end(output); child.emit('close', 0) }
      }, () => child.emit('close', 1))
      started.emit('started')
    })
    return child
  } })
  return { native, calls, started, plugin }
}
const spec = { url: 'https://api.qishui.com/luna/pc/feed/mode?device_id=1234567890123456', did: '1234567890123456', headers: { Cookie: ['sessionid', 'synthetic-private'].join('=') } }
const signatures = { 'x-helios': 'fixture-helios', 'x-medusa': 'fixture-medusa' }

// Simulate only the OS launcher; exercise real staging, IPC and cleanup code.
test('Windows signer stages a matching DLL pair and keeps account data out of argv and environment', async t => {
  let staged
  const f = await fixture(t, async call => {
    staged = await Promise.all(['node.exe', 'bdms.node', 'metasecml.dll'].map(name => readFile(path.join(call.root, name), 'utf8')))
    return JSON.stringify(signatures)
  })
  assert.deepEqual(await f.native.signRequest(spec, 'fixed signing code'), signatures)
  const [call] = f.calls
  assert.deepEqual(staged, ['fixture-node', 'fixture-bdms.node', 'fixture-metasecml.dll'])
  assert.equal(call.options.windowsHide, true)
  assert.equal(call.options.shell, false)
  assert.equal(call.command, await realpath(path.join(f.plugin, 'runtime/native/windows-runner.exe')))
  assert.equal(call.args[call.args.indexOf('--') + 1], path.join(call.root, 'node.exe'))
  assert.equal(call.args[call.args.indexOf('--parent') + 1], String(process.pid))
  assert.deepEqual(JSON.parse(call.input), spec)
  assert.equal(JSON.stringify([call.args, call.options.env]).includes('synthetic-private'), false)
  assert.equal(call.options.env.TEMP, call.root)
  await assert.rejects(access(call.root))
})

test('Windows resource decoder uses the shipped source through private stdin', async t => {
  let decoder
  const f = await fixture(t, async call => {
    decoder = await readFile(path.join(call.root, 'resource.cjs'), 'utf8')
    return Buffer.from('fLaCdecoded-fixture')
  })
  const output = await f.native.decodeResource(Buffer.from('encrypted-fixture'), 'synthetic-grant')
  assert.equal(output.toString(), 'fLaCdecoded-fixture')
  assert.equal(decoder, '/* fixture decoder */')
  assert.equal(f.calls[0].args.at(-1), '--decode')
  assert.deepEqual(JSON.parse(f.calls[0].input), { audio: Buffer.from('encrypted-fixture').toString('base64'), auth: 'synthetic-grant' })
  assert.equal(f.calls[0].args.join(' ').includes('synthetic-grant'), false)
  await assert.rejects(access(f.calls[0].root))
})

test('Windows development adapter has no runtime conversion operation', async t => {
  const f = await fixture(t, () => { throw Error('must not spawn') })
  assert.deepEqual(Object.keys(f.native).sort(), ['decodeResource', 'signRequest'])
  assert.equal(f.calls.length, 0)
})

test('Windows cancellation waits for launcher cleanup and removes private scratch', { timeout: 5000 }, async t => {
  let markerObserved = false
  const f = await fixture(t, call => {
    // Mirror the real launcher's marker polling; filesystem notifications may
    // coalesce a new directory and its first file on macOS.
    const poll = setInterval(async () => {
      try { await access(path.join(call.root, '.cancel')) } catch { return }
      if (markerObserved) return
      markerObserved = true
      clearInterval(poll)
      call.child.emit('close', 130)
    }, 10)
    call.child.once('close', () => clearInterval(poll))
    t.after(() => clearInterval(poll))
    return undefined
  })
  const controller = new AbortController()
  const started = once(f.started, 'started')
  const working = f.native.signRequest({ ...spec, signal: controller.signal }, 'fixed signing code')
  const rejected = assert.rejects(working, cause => cause.kind === 'canceled' && !cause.message.includes('synthetic'))
  await started
  controller.abort()
  await rejected
  assert.equal(markerObserved, true, 'launcher must consume cancellation before cleanup; forced termination is not success')
  await assert.rejects(access(f.calls[0].root))
})

test('Windows isolation setup failures stay distinct from account or audio failures', async t => {
  const f = await fixture(t, call => { call.child.emit('close', 125) })
  await assert.rejects(f.native.signRequest(spec, 'code'), cause => cause.kind === 'setup')
  await assert.rejects(access(f.calls[0].root))
})

test('Windows refuses unsupported architectures and corrupt signer output', async t => {
  const unsupported = createWindowsNative({ platform: 'win32', arch: 'ia32', spawnProcess: () => { throw Error('must not spawn') } })
  await assert.rejects(unsupported.signRequest(spec, 'code'), cause => cause.kind === 'setup')
  for (const output of ['private raw failure', JSON.stringify({ ...signatures, Extra: 'bad' }), JSON.stringify({ ...signatures, 'x-medusa': 'bad\r\nheader' })]) {
    const f = await fixture(t, () => output)
    await assert.rejects(f.native.signRequest(spec, 'code'), cause => cause.kind === 'unavailable' && !cause.message.includes('private raw failure'))
    await assert.rejects(access(f.calls[0].root))
  }
})
