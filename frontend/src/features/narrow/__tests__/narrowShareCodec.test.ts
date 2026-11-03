import { describe, expect, it } from 'vitest'

import { specFor } from '../model'
import {
  canShareNarrow,
  decodeNarrowShare,
  encodeNarrowShare,
  NARROW_SHARE_URN_CAP,
  narrowLink,
} from '../narrowShareCodec'

const enc = (obj: unknown) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('narrowShareCodec', () => {
  it('round-trips a scope and the sender’s words for its seeds', () => {
    const spec = specFor({ urns: ['urn:a', 'urn:ü'] }, { children: 1, upstream: 'all', partnerChildren: 1 })
    expect(decodeNarrowShare(encodeNarrowShare(spec, 'orders and 1 more'))).toEqual({ v: 1, spec, label: 'orders and 1 more' })
  })

  it('carries a search as its seeds', () => {
    const spec = specFor({ query: { kind: 'text', value: 'orders' } as never }, { downstream: 2 }, 'dataSource')
    expect(decodeNarrowShare(encodeNarrowShare(spec))?.spec).toEqual(spec)
  })

  it.each([
    ['garbage', 'not base64 !!'],
    ['wrong version', enc({ v: 2, spec: specFor({ urns: ['a'] }) })],
    ['both kinds of seed', enc({ v: 1, spec: { ...specFor({ urns: ['a'] }), seeds: { urns: ['a'], query: {} } } })],
    ['no seeds', enc({ v: 1, spec: { ...specFor({ urns: ['a'] }), seeds: { urns: [] } } })],
    ['a depth past the limit', enc({ v: 1, spec: specFor({ urns: ['a'] }, { upstream: 26 }) })],
    ['children past two levels', enc({ v: 1, spec: specFor({ urns: ['a'] }, { children: 3 }) })],
    ['an unknown boundary', enc({ v: 1, spec: { ...specFor({ urns: ['a'] }), within: 'galaxy' } })],
  ])('refuses %s', (_why, token) => {
    expect(decodeNarrowShare(token)).toBeNull()
  })

  it('shares a hand-picked scope only up to what a link can carry', () => {
    const many = Array.from({ length: NARROW_SHARE_URN_CAP + 1 }, (_, i) => `urn:${i}`)
    expect(canShareNarrow(specFor({ urns: many.slice(1) }))).toBe(true)
    expect(canShareNarrow(specFor({ urns: many }))).toBe(false)
  })

  it('makes a link that opens on the narrowing alone', () => {
    const link = new URL(narrowLink(specFor({ urns: ['a'] }), 'a', 'https://x.test/views/v1?trace=t&lens=l&tab=2'))
    expect(link.searchParams.get('trace')).toBeNull()
    expect(link.searchParams.get('lens')).toBeNull()
    expect(link.searchParams.get('tab')).toBe('2')
    expect(decodeNarrowShare(link.searchParams.get('narrow')!)?.spec.seeds.urns).toEqual(['a'])
  })
})
