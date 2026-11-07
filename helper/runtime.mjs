// Native signing and audio resources resolve from the installed plugin directory.
import { fileURLToPath } from 'node:url'

export const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
