import { describe, expect, it } from 'vitest'

import { specFor } from '../model'
import {
  canShareNarrow,
  decodeNarrowShare,
  encodeNarrowShare,
  NARROW_SHARE_URL_MAX,
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
    const made = narrowLink(specFor({ urns: ['a'] }), 'a', undefined, 'https://x.test/views/v1?trace=t&lens=l&narrowSaved=n1&tab=2')
    const link = new URL(made.url!)
    expect(link.searchParams.get('trace')).toBeNull()
    expect(link.searchParams.get('lens')).toBeNull()
    expect(link.searchParams.get('narrowSaved')).toBeNull()
    expect(link.searchParams.get('tab')).toBe('2')
    expect(decodeNarrowShare(link.searchParams.get('narrow')!)?.spec.seeds.urns).toEqual(['a'])
  })

  it('keeps the reach into the tables it comes to, and their lineage — and refuses their lineage alone', () => {
    const spec = specFor({ urns: ['urn:a'] }, { upstream: 2, partnerChildren: 1, partnerHosts: true, partnerLineage: true })
    expect(decodeNarrowShare(encodeNarrowShare(spec))?.spec).toEqual(spec)
    const hostsOnly = specFor({ urns: ['urn:a'] }, { upstream: 2, partnerChildren: 1, partnerHosts: true })
    expect(decodeNarrowShare(encodeNarrowShare(hostsOnly))?.spec.expand).not.toHaveProperty('partnerLineage')
    expect(decodeNarrowShare(enc({ v: 1, spec: specFor({ urns: ['a'] }, { partnerLineage: true }) }))).toBeNull()
    expect(decodeNarrowShare(enc({ v: 1, spec: specFor({ urns: ['a'] }, { partnerHosts: 'yes' as never }) }))).toBeNull()
  })

  it('carries the seeds’ names — only for its seeds, each cut to length', () => {
    const spec = specFor({ urns: ['urn:a', 'urn:b'] })
    const out = decodeNarrowShare(encodeNarrowShare(spec, '2 entities', { 'urn:a': 'Orders', 'urn:z': 'Not a seed', 'urn:b': 'x'.repeat(300) }))
    expect(out?.names).toEqual({ 'urn:a': 'Orders', 'urn:b': 'x'.repeat(120) })
    expect(decodeNarrowShare(enc({ v: 1, spec, names: { 'urn:a': 7, __proto__: 'x' } }))?.names).toBeUndefined()
  })

  it('drops the names before the link grows too long, and offers none past that', () => {
    const urns = Array.from({ length: 40 }, (_, i) => `urn:li:dataset:(urn:li:dataPlatform:hive,db.table_${i},PROD)`)
    const names = Object.fromEntries(urns.map((u, i) => [u, `A long descriptive name for table ${i} `.repeat(3)]))
    const some = narrowLink(specFor({ urns }), '40 entities', names, 'https://x.test/views/v1')
    expect(some.url!.length).toBeLessThanOrEqual(NARROW_SHARE_URL_MAX)
    expect(some.namesDropped).toBe(true)
    expect(decodeNarrowShare(new URL(some.url!).searchParams.get('narrow')!)?.names).toBeUndefined()
    const many = Array.from({ length: NARROW_SHARE_URN_CAP }, (_, i) => `urn:li:dataset:(urn:li:dataPlatform:hive,db.t_${i},PROD)`)
    expect(narrowLink(specFor({ urns: many }), 'many', undefined, 'https://x.test/views/v1')).toEqual({ url: null, namesDropped: false })
  })
})
