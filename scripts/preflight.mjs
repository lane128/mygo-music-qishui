// Login preflight must execute the plugin in MyGO's actual sandbox and HTTP stack.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const source = process.env.MYGO_SOURCE_DIR
if (!source || !path.isAbsolute(source)) {
  console.error('预检需要 MyGO 宿主源码的绝对路径：MYGO_SOURCE_DIR=/absolute/path/to/mygo npm run preflight')
  console.error('请先将 test/host_integration_test.go 放入宿主的 internal/plugin 目录。此命令验证沙箱内二维码申请与主动取消；手机扫码登录仍需人工验收。')
  process.exitCode = 1
} else {
  console.log('通过 MyGO 宿主验证沙箱登录与取消；不会显示二维码、令牌或账号数据。')
  const testName = 'TestQishuiPluginLiveCancel'
  const child = spawn('go', ['-C', source, 'test', './internal/plugin', '-run', '^' + testName + '$', '-count=1', '-v'], {
    // Keep raw host output private: HTTP failures can contain login URLs.
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      QISHUI_HOST_PREFLIGHT: '1',
      QISHUI_PLUGIN_DIR: fileURLToPath(new URL('..', import.meta.url)),
    },
  })
  let output = ''
  let overflow = false
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    if (overflow) return
    output += chunk
    if (output.length > 1048576) { overflow = true; output = ''; child.kill() }
  })
  child.once('error', () => {
    console.error('无法启动 MyGO 宿主预检；请检查 Go 安装与宿主源码路径。')
    process.exitCode = 1
  })
  child.once('close', code => {
    const passed = code === 0 && !overflow && output.split('\n').some(line => line.startsWith('--- PASS: ' + testName + ' ('))
    console[passed ? 'log' : 'error'](passed
      ? 'MyGO 宿主沙箱预检：通过。手机扫码登录仍需人工验收。'
      : 'MyGO 宿主沙箱预检未通过；请检查宿主测试已安装、Go 构建环境与网络。原始输出已隐藏，避免泄露登录信息。')
    process.exitCode = passed ? 0 : 1
  })
}
