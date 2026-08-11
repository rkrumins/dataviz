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
    }
    const token = encodeLensShare(state)
    // URL-safe: no characters that need query escaping.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeLensShare(token)).toEqual({ v: 1, ...state })
  })

  it('rejects malformed input instead of throwing (a link can never break the app)', () => {
    expect(decodeLensShare('not-base64!!!')).toBeNull()
    expect(decodeLensShare(encodeLensShare({ entries: ['a'], cursor: 0, mode: 'graph', groups: [], frontier: [], containers: [], frameAll: [] }).slice(4))).toBeNull()
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

  it('opens a link written before containers or frame modes existed', () => {
    // Older links carry neither field; they must still restore.
    const legacy = btoa(String.fromCharCode(...new TextEncoder().encode(
      JSON.stringify({ v: 1, entries: ['a', 'b'], cursor: 1, mode: 'graph', groups: [], frontier: [] }),
    ))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(decodeLensShare(legacy)?.containers).toEqual([])
    expect(decodeLensShare(legacy)?.frameAll).toEqual([])
  })
})
