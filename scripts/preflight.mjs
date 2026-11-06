// Checks signatures and polling, without printing a QR, token or account data.
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const worker = spawn(process.execPath, [fileURLToPath(new URL('../helper/worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'ignore'] })
const lines = readline.createInterface({ input: worker.stdout })[Symbol.asyncIterator]()
const exited = new Promise(resolve => worker.on('exit', resolve))
const timer = setTimeout(() => worker.kill(), 90000)
async function request(spec) {
  worker.stdin.write(JSON.stringify(spec) + '\n')
  const { value, done } = await lines.next()
  if (done) throw new Error('helper stopped')
  const frame = JSON.parse(value)
  if (!frame.ok) throw new Error(frame.error)
  return frame
}
try {
  const result = await request({ op: 'start', config: {} })
  if (!result.qr) throw new Error('missing QR')
  console.log('签名二维码申请：通过（未显示二维码）')
  for (let i = 0; i < 3; i++) {
    await delay(3000)
    const state = await request({ op: 'check' })
    if (state.status !== 'new') throw new Error('unexpected login state')
  }
  console.log('同一会话连续三次签名轮询：通过')
  console.log('尚未进行手机扫码及真实账号验收。')
} catch (err) {
  const known = ['setup', 'signature', 'rateLimit', 'verify', 'expired', 'rejected', 'session', 'network', 'response']
  console.error('预检失败：' + (known.includes(err.message) ? err.message : 'helper'))
  process.exitCode = 1
} finally {
  worker.stdin.end()
  await exited
  clearTimeout(timer)
}
