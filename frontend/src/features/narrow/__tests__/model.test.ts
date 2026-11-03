import { describe, expect, it } from 'vitest'

import type { MembershipResult } from '@/types/membership'

import {
  canRetry,
  canonicalSpec,
  describeNarrow,
  layerDistribution,
  NO_EXPANSION,
  PRESETS,
  presetOf,
  seedsLabel,
  specFor,
  specKey,
  truncationNotes,
  usesLineage,
  visibilityOf,
} from '../model'

function result(partial: Partial<MembershipResult> = {}): MembershipResult {
  return {
    specHash: 'h', members: [], wholeSubtree: [], chains: {},
    counts: { seeds: 0, inside: 0, upstream: 0, downstream: 0, partnerInside: 0, total: 0 },
    missingSeeds: 0, truncated: [], dataVersion: '', elapsedMs: 0, ...partial,
  }
}

describe('presets', () => {
  it('cover what people asked for: one and two levels in, direct partners, the entire upstream', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['just', 'one-level', 'two-levels', 'neighbours', 'upstream', 'downstream'])
    expect(PRESETS.find((p) => p.id === 'neighbours')!.expand)
      .toEqual({ children: 0, upstream: 1, downstream: 1, partnerChildren: 1 })
  })

  it('are recognised from an expansion, and a hand-made one is custom', () => {
    expect(presetOf({ ...NO_EXPANSION, upstream: 'all' })).toBe('upstream')
    expect(presetOf({ ...NO_EXPANSION, upstream: 3 })).toBeNull()
    expect(presetOf(NO_EXPANSION)).toBe('just')
  })

  it('say which need the Lineage trace', () => {
    for (const p of PRESETS) expect(p.lineage).toBe(usesLineage(p.expand))
  })
})

describe('identity', () => {
  it('one scope, one key, whatever the order of its seeds', () => {
    const a = specFor({ urns: ['b', 'a', 'a', ' '] }, { upstream: 2 })
    const b = specFor({ urns: ['a', 'b'] }, { upstream: 2 })
    expect(canonicalSpec(a).seeds.urns).toEqual(['a', 'b'])
    expect(specKey(a)).toBe(specKey(b))
    expect(specKey(a)).not.toBe(specKey(specFor({ urns: ['a', 'b'] }, { upstream: 3 })))
  })
})

describe('the sentence', () => {
  const show = (expand: Parameters<typeof specFor>[1], urns = ['x']) =>
    describeNarrow(specFor({ urns }, expand), urns.length === 1 ? 'orders' : `${urns.length} entities`)

  it('names the seeds alone', () => {
    expect(show({})).toBe('orders')
  })

  it('agrees with one seed or several', () => {
    expect(show({ children: 'all' })).toBe('orders and everything inside it')
    expect(show({ children: 1 }, ['a', 'b'])).toBe('2 entities and one level inside them')
  })

  it('reads each part of the reach', () => {
    expect(show({ children: 2, upstream: 'all' })).toBe('orders, two levels inside it and everything upstream')
    expect(show({ upstream: 2, downstream: 1 })).toBe('orders, its sources 2 steps up and what it feeds one step down')
    expect(show({ upstream: 1, downstream: 1, partnerChildren: 1 }, ['a', 'b']))
      .toBe('2 entities, their sources and consumers one step out and what sits directly inside those')
    expect(show({ upstream: 'all', downstream: 'all', partnerChildren: 'all' }))
      .toBe('orders, everything upstream and downstream and everything inside those')
  })

  it('names one seed by name and several by count', () => {
    expect(seedsLabel(['urn:1'], () => 'orders')).toBe('orders')
    expect(seedsLabel(['a', 'b', 'c'], () => 'x')).toBe('3 entities')
  })
})

describe('limits', () => {
  it('are said in words, and only a short answer offers a retry', () => {
    const capped = result({ truncated: [{ reason: 'member_cap', seen: 60000, limit: 50000 }] })
    expect(truncationNotes(capped)[0]).toMatch(/more than 50,000 entities/)
    expect(canRetry(capped)).toBe(false)
    expect(canRetry(result({ truncated: [{ reason: 'deadline', seen: 1, limit: 1 }] }))).toBe(true)
    expect(canRetry(result({ truncated: [{ reason: 'incomplete', seen: 1, limit: 1 }] }))).toBe(true)
  })
})

describe('what the canvas draws', () => {
  const r = result({
    members: [
      { urn: 'col', via: 'seed' },
      { urn: 'src', via: 'upstream', hops: 1 },
      { urn: 'loose', via: 'downstream', hops: 1 },
    ],
    chains: { col: ['tbl', 'dom'], src: ['dom'], loose: [] },
    wholeSubtree: ['col'],
  })

  it('counts the members inside each container', () => {
    const vis = visibilityOf(r)
    expect(vis.byUrn.get('src')?.hops).toBe(1)
    expect(Object.fromEntries(vis.ancestors)).toEqual({ tbl: 1, dom: 2 })
    expect(vis.whole.has('col')).toBe(true)
  })

  it('places each member in the layer it, or its nearest drawn container, sits in', () => {
    const layers: Record<string, string> = { tbl: 'gold', dom: 'bronze' }
    const { layers: shares, elsewhere } = layerDistribution(r, (u) => layers[u])
    expect(shares).toEqual([{ layerId: 'gold', count: 1 }, { layerId: 'bronze', count: 1 }])
    expect(elsewhere).toBe(1)
  })
})
