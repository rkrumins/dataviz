import { describe, it, expect } from 'vitest'
import { encodeLensShare, decodeLensShare, type LensShareStateV2 } from '../shareCodec'

const forge = (o: unknown) => {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fullV2 = (): Omit<LensShareStateV2, 'v'> => ({
  entries: ['urn:li:dataset:(urn:li:dataPlatform:sf,revenue €,PROD)', 'urn:li:schemaField:(x,y)'],
  cursor: 1,
  mode: 'graph',
  direction: 'in',
  depth: 2,
  revealed: [['in:urn:li:dataset:(a,b)', 2]],
  opened: ['urn:li:dataPlatform:snowflake'],
  collapsed: ['urn:li:dataset:(a,b)'],
  frameAll: ['urn:li:dataPlatform:snowflake'],
  framePages: [['urn:li:dataPlatform:snowflake', 6]],
  frameQueries: [['urn:li:dataPlatform:snowflake', 'revenue €']],
})

describe('lens shareCodec v2', () => {
  it('round-trips a full exploration, including unicode and URN punctuation', () => {
    const state = fullV2()
    const token = encodeLensShare(state)
    // URL-safe: no characters that need query escaping.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeLensShare(token)).toEqual({ v: 2, ...state })
  })

  it('round-trips the "both" direction and depth 1', () => {
    const state = { ...fullV2(), direction: 'both' as const, depth: 1 }
    const token = encodeLensShare(state)
    expect(decodeLensShare(token)).toEqual({ v: 2, ...state })
  })

  it('rejects malformed input instead of throwing (a link can never break the app)', () => {
    expect(decodeLensShare('not-base64!!!')).toBeNull()
    expect(decodeLensShare(encodeLensShare(fullV2()).slice(4))).toBeNull()
  })

  it('rejects a wrong or missing version', () => {
    expect(decodeLensShare(forge({ v: 3, entries: ['a'], cursor: 0, mode: 'graph' }))).toBeNull()
    expect(decodeLensShare(forge({ entries: ['a'], cursor: 0, mode: 'graph' }))).toBeNull()
  })

  it('rejects malformed entries/cursor/mode on a v2 token', () => {
    const base = fullV2()
    expect(decodeLensShare(forge({ v: 2, ...base, entries: [] }))).toBeNull()
    expect(decodeLensShare(forge({ v: 2, ...base, cursor: 5 }))).toBeNull()
    expect(decodeLensShare(forge({ v: 2, ...base, mode: 'columns' }))).toBeNull()
  })

  it('rejects a malformed direction or depth', () => {
    const base = fullV2()
    expect(decodeLensShare(forge({ v: 2, ...base, direction: 'sideways' }))).toBeNull()
    expect(decodeLensShare(forge({ v: 2, ...base, depth: 0 }))).toBeNull()
    expect(decodeLensShare(forge({ v: 2, ...base, depth: 'two' }))).toBeNull()
  })

  it('rejects malformed exploration fields rather than restoring nonsense', () => {
    const base = fullV2()
    expect(decodeLensShare(forge({ v: 2, ...base, opened: 'x' }))).toBeNull()
    expect(decodeLensShare(forge({ v: 2, ...base, collapsed: [1] }))).toBeNull()
    expect(decodeLensShare(forge({ v: 2, ...base, frameAll: [1] }))).toBeNull()
    expect(decodeLensShare(forge({ v: 2, ...base, revealed: [['k', -1]] }))).toBeNull()
    expect(decodeLensShare(forge({ v: 2, ...base, revealed: [['k', 'two']] }))).toBeNull()
    expect(decodeLensShare(forge({ v: 2, ...base, framePages: [['k', -1]] }))).toBeNull()
    expect(decodeLensShare(forge({ v: 2, ...base, frameQueries: [['k', 3]] }))).toBeNull()
  })

  it('a v1 token restores only entries, cursor and mode — graceful, documented degrade', () => {
    // The shape the OLD (pre-v2) encoder actually wrote, exploration
    // fields and all — a real link from before this task must still open.
    const legacyToken = forge({
      v: 1,
      entries: ['a', 'b', 'c'],
      cursor: 1,
      mode: 'list',
      closed: ['in:a'],
      frontier: ['out:b'],
      containers: ['in:a'],
      frameAll: ['in:a'],
      contains: ['a'],
      framePages: [['a', 2]],
      frameQueries: [['a', 'q']],
    })
    expect(decodeLensShare(legacyToken)).toEqual({
      v: 1, entries: ['a', 'b', 'c'], cursor: 1, mode: 'list',
    })
  })

  it('a v1 token with no exploration fields at all still opens', () => {
    const legacyToken = forge({ v: 1, entries: ['a'], cursor: 0, mode: 'graph' })
    expect(decodeLensShare(legacyToken)).toEqual({ v: 1, entries: ['a'], cursor: 0, mode: 'graph' })
  })

  it('a v1 token with garbage in the (unconsumed) exploration fields still opens', () => {
    // Nothing downstream reads these for a v1 link, so a malformed shape
    // there must not sink an otherwise-valid path + mode restore.
    const legacyToken = forge({ v: 1, entries: ['a'], cursor: 0, mode: 'graph', closed: 'not-an-array' })
    expect(decodeLensShare(legacyToken)).toEqual({ v: 1, entries: ['a'], cursor: 0, mode: 'graph' })
  })
})
