// ZIPs carry Node, Playwright and the login assets. Only the installed browser
// is discovered on the machine; no installation paths are requested from users.
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { error } from './protocol.mjs'

export const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

export function browserCandidates(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    path.join(home, 'Applications/Chromium.app/Contents/MacOS/Chromium'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ]
  if (platform === 'win32') return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
    .map(base => path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome']
}

export async function findBrowser(candidates = browserCandidates(), exists = async file => {
  try { await access(file, constants.X_OK); return true } catch { return false }
}) {
  for (const candidate of candidates) if (await exists(candidate)) return candidate
  throw error('browserMissing')
}

export async function browserRuntime(config = {}) {
  // Overrides remain available to developer tests, not in the plugin interface.
  const playwrightPath = config.playwrightPath || process.env.PLAYWRIGHT_CORE || path.join(pluginRoot, 'node_modules/playwright-core')
  const securityDir = config.securityDir || process.env.QISHUI_SECURITY_DIR || path.join(pluginRoot, 'runtime/security')
  const chromiumPath = config.chromiumPath || process.env.QISHUI_CHROMIUM_PATH || await findBrowser()
  if (![playwrightPath, securityDir, chromiumPath].every(value => typeof value === 'string' && path.isAbsolute(value))) throw error('setup')
  return { playwrightPath, securityDir, chromiumPath }
}
