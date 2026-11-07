// Match the native signer to the desktop client protocol on each supported OS.
// This module is also bundled into MyGO's sandbox; it has no Node dependencies.
import { error } from './protocol.mjs'

export function signedClient(platform = 'darwin') {
  if (platform === 'windows' || platform === 'win32') return { device_platform: 'windows', device_type: 'Windows', os_version: 'Windows 10' }
  if (platform === 'darwin') return { device_platform: 'mac', device_type: 'Mac', os_version: 'darwin' }
  throw error('setup')
}
