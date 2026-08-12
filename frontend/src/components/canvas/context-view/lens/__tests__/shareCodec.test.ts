/**
 * shareCodec — round-trip fidelity and defensive decoding. A share link
 * must never be able to break the canvas: every malformed input decodes
 * to null, never a throw.
 */
import { describe, expect, it } from 'vitest'
import { decodeLensShare, encodeLensShare } from '../shareCodec'

const full = {
  entries: ['urn:a', 'urn:b', 'urn:c'],
  cursor: 1,
  expansions: ['down:urn:b', 'up:urn:b'],
  children: ['urn:b'],
  drills: ['urn:b urn:sys AGGREGATED'],
}

describe('shareCodec', () => {
  it('round-trips a full exploration', () => {
    expect(decodeLensShare(encodeLensShare(full))).toEqual({ v: 2, ...full })
  })

  it('round-trips unicode labels in urns', () => {
    const state = { ...full, entries: ['urn:数据集:α', 'urn:b'], cursor: 0 }
    expect(decodeLensShare(encodeLensShare(state))?.entries[0]).toBe('urn:数据集:α')
  })

  it('produces a URL-safe token', () => {
    const token = encodeLensShare(full)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('clamps an out-of-range cursor instead of rejecting the walk', () => {
    const token = encodeLensShare({ ...full, cursor: 99 })
    expect(decodeLensShare(token)?.cursor).toBe(2)
  })

  it('tolerates missing gesture lists from a minimal token', () => {
    const json = JSON.stringify({ v: 2, entries: ['urn:a'], cursor: 0 })
    const token = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(decodeLensShare(token)).toEqual({
      v: 2,
      entries: ['urn:a'],
      cursor: 0,
      expansions: [],
      children: [],
      drills: [],
    })
  })

  it.each([
    ['empty', ''],
    ['not base64', '!!!not-base64!!!'],
    ['not json', btoa('hello world')],
    ['wrong version', btoa(JSON.stringify({ v: 1, entries: ['a'], cursor: 0 }))],
    ['no entries', btoa(JSON.stringify({ v: 2, entries: [], cursor: 0 }))],
    ['entries not strings', btoa(JSON.stringify({ v: 2, entries: [1], cursor: 0 }))],
    ['cursor not a number', btoa(JSON.stringify({ v: 2, entries: ['a'], cursor: 'x' }))],
    ['json scalar', btoa('42')],
  ])('decodes %s to null, never a throw', (_name, raw) => {
    expect(decodeLensShare(raw)).toBeNull()
  })

  it('rejects absurdly long tokens outright', () => {
    expect(decodeLensShare('A'.repeat(20000))).toBeNull()
  })
})
