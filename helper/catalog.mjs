// Node adapter used only by granted playback and development tests. The shared
// catalogue implementation also runs inside MyGO with host-provided primitives.
import { createHash, randomUUID } from 'node:crypto'
import { Catalog as PortableCatalog, requestJSON as portableRequest } from './catalog-core.mjs'
export * from './catalog-core.mjs'

export function requestJSON(session, path, options, deps = {}) {
  return portableRequest(session, path, options, {
    platform: process.platform,
    md5: text => createHash('md5').update(text).digest('hex'),
    sign: async spec => (await import('./native.mjs')).signRequest(spec),
    ...deps,
  })
}
export class Catalog extends PortableCatalog {
  constructor(session, options = {}) {
    super(session, { request: requestJSON, uuid: randomUUID, ...options })
  }
}
