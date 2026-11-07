// Preserve int64 scene IDs on hosts without JSON.rawJSON. Serialize values as
// JSON tokens directly, so user strings can never be mistaken for raw numbers.
import { error } from './protocol.mjs'

export function stringifyBody(value) {
  if (typeof JSON.rawJSON === 'function') {
    return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? JSON.rawJSON(v.toString()) : v)
  }
  const ancestors = new Set()
  function encode(v, array = false) {
    if (typeof v === 'bigint') {
      if (v < 0n || v > 9223372036854775807n) throw error('response')
      return v.toString()
    }
    if (v === undefined) return array ? 'null' : undefined
    if (v === null || ['string', 'boolean', 'number'].includes(typeof v)) return JSON.stringify(v)
    if (typeof v !== 'object' || ancestors.has(v)) throw error('response')
    ancestors.add(v)
    let result
    if (Array.isArray(v)) result = '[' + Array.from(v, item => encode(item, true)).join(',') + ']'
    else result = '{' + Object.keys(v).flatMap(key => {
      const item = encode(v[key])
      return item === undefined ? [] : [JSON.stringify(key) + ':' + item]
    }).join(',') + '}'
    ancestors.delete(v)
    return result
  }
  return encode(value)
}
