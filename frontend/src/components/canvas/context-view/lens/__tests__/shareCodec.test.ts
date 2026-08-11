import { describe, it, expect } from 'vitest'
import { encodeLensShare, decodeLensShare } from '../shareCodec'

describe('lens shareCodec', () => {
  it('round-trips an exploration, including unicode and URN punctuation', () => {
    const state = {
      entries: ['urn:li:dataset:(urn:li:dataPlatform:sf,revenue €,PROD)', 'urn:li:schemaField:(x,y)'],
      cursor: 1,
      mode: 'graph' as const,
      groups: ['in:urn:li:dataset:(a,b)'],
      frontier: ['out:urn:li:schemaField:(x,y)'],
      containers: ['in:urn:li:dataPlatform:snowflake'],
      frameAll: ['in:urn:li:dataPlatform:snowflake'],
      contains: ['urn:li:schemaField:(x,y)'],
      framePages: [['in:urn:li:dataPlatform:snowflake', 6]] as Array<[string, number]>,
      frameQueries: [['in:urn:li:dataPlatform:snowflake', 'revenue €']] as Array<[string, string]>,
    }
    const token = encodeLensShare(state)
    // URL-safe: no characters that need query escaping.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeLensShare(token)).toEqual({ v: 1, ...state })
  })

  it('rejects malformed input instead of throwing (a link can never break the app)', () => {
    expect(decodeLensShare('not-base64!!!')).toBeNull()
    expect(decodeLensShare(encodeLensShare({ entries: ['a'], cursor: 0, mode: 'graph', groups: [], frontier: [], containers: [], frameAll: [], contains: [], framePages: [], frameQueries: [] }).slice(4))).toBeNull()
    // Wrong version / shapes.
    const forge = (o: unknown) => {
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
      return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }
    expect(decodeLensShare(forge({ v: 2, entries: ['a'], cursor: 0, mode: 'graph', groups: [], frontier: [] }))).toBeNull()
    expect(decodeLensShare(forge({ v: 1, entries: [], cursor: 0, mode: 'graph', groups: [], frontier: [] }))).toBeNull()
    expect(decodeLensShare(forge({ v: 1, entries: ['a'], cursor: 5, mode: 'graph', groups: [], frontier: [] }))).toBeNull()
    expect(decodeLensShare(forge({ v: 1, entries: ['a'], cursor: 0, mode: 'columns', groups: [], frontier: [] }))).toBeNull()
    expect(decodeLensShare(forge({ v: 1, entries: ['a'], cursor: 0, mode: 'graph', groups: 'x', frontier: [] }))).toBeNull()
  })

  it('rejects a malformed page/query pair rather than restoring nonsense', () => {
    const forge = (o: unknown) => {
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
      return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }
    const base = { v: 1, entries: ['a'], cursor: 0, mode: 'graph', groups: [], frontier: [] }
    expect(decodeLensShare(forge({ ...base, framePages: [['k', -1]] }))).toBeNull()
    expect(decodeLensShare(forge({ ...base, framePages: [['k', 'two']] }))).toBeNull()
    expect(decodeLensShare(forge({ ...base, framePages: 'nope' }))).toBeNull()
    expect(decodeLensShare(forge({ ...base, frameQueries: [['k', 3]] }))).toBeNull()
    expect(decodeLensShare(forge({ ...base, contains: [1] }))).toBeNull()
  })

  it('opens a link written before containers or frame modes existed', () => {
    // Older links carry neither field; they must still restore.
    const legacy = btoa(String.fromCharCode(...new TextEncoder().encode(
      JSON.stringify({ v: 1, entries: ['a', 'b'], cursor: 1, mode: 'graph', groups: [], frontier: [] }),
    ))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(decodeLensShare(legacy)?.containers).toEqual([])
    expect(decodeLensShare(legacy)?.frameAll).toEqual([])
  })
})
