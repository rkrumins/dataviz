/**
 * lensGraph — merge-core semantics.
 *
 * These pin the foundations the whole lens stands on: hop assignment
 * (first placement wins, cycles draw edges not duplicate cards), the
 * three fold rules (exact repeat, rollup absorption, covered-rollup
 * coverage), containment vs lineage separation (ancestors never become
 * lineage cards), inherited traces contributing banners but never
 * records, and the three key namespaces staying isolated.
 */
import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode, TraceV2Result } from '@/providers/GraphDataProvider'
import {
  createLensSession,
  expansionKeyOf,
  failChildren,
  failDrill,
  failExpansion,
  isRollupCovered,
  mergeAncestors,
  mergeChildren,
  mergeDegrees,
  mergeDrill,
  mergeExpansion,
  mergeNodes,
  shownEdgeFloors,
  startChildren,
  startDrill,
  startExpansion,
  visibleRecords,
  type ExpansionInput,
  type LensSessionState,
} from '../lensGraph'

const OPTS = {
  containmentEdgeTypes: ['CONTAINS', 'BELONGS_TO'],
  invertedContainmentTypes: new Set(['BELONGS_TO']),
}

let edgeSeq = 0
const edge = (
  sourceUrn: string,
  targetUrn: string,
  edgeType = 'FLOWS_TO',
  properties?: Record<string, unknown>,
): GraphEdge => ({ id: `e${edgeSeq++}`, sourceUrn, targetUrn, edgeType, properties })

const node = (urn: string, entityType = 'dataset', displayName = urn): GraphNode => ({
  urn,
  entityType,
  displayName,
  properties: {},
})

const emptyTrace = (overrides: Partial<TraceV2Result> = {}): TraceV2Result => ({
  nodes: [],
  edges: [],
  containmentEdges: [],
  upstreamUrns: new Set(),
  downstreamUrns: new Set(),
  focus: { urn: 'f', level: 3, entityType: 'dataset' },
  effectiveLevel: 3,
  isInherited: false,
  inheritedFromUrn: null,
  truncated: false,
  truncationReason: null,
  ...overrides,
})

const input = (overrides: Partial<ExpansionInput> = {}): ExpansionInput => ({
  rawEdges: [],
  rawTruncated: false,
  trace: null,
  ...overrides,
})

const expandDown = (state: LensSessionState, urn: string, i: ExpansionInput) =>
  mergeExpansion(state, expansionKeyOf('down', urn), urn, i, OPTS)
const expandUp = (state: LensSessionState, urn: string, i: ExpansionInput) =>
  mergeExpansion(state, expansionKeyOf('up', urn), urn, i, OPTS)

describe('hop assignment', () => {
  it('places raw partners one hop out on each side of the focal', () => {
    let s = createLensSession('f')
    s = expandDown(s, 'f', input({ rawEdges: [edge('f', 'sink')] }))
    s = expandUp(s, 'f', input({ rawEdges: [edge('src', 'f')] }))
    expect(s.hops.get('f')).toBe(0)
    expect(s.hops.get('sink')).toBe(1)
    expect(s.hops.get('src')).toBe(-1)
  })

  it('keeps the first placement when an entity reappears in the other direction', () => {
    let s = createLensSession('f')
    s = expandDown(s, 'f', input({ rawEdges: [edge('f', 'x')] }))
    // x also feeds f — a cycle. x keeps hop +1; the new edge still lands.
    s = expandUp(s, 'f', input({ rawEdges: [edge('x', 'f')] }))
    expect(s.hops.get('x')).toBe(1)
    const recs = visibleRecords(s)
    expect(recs).toHaveLength(2)
    expect(new Set(recs.map(r => `${r.source}->${r.target}`))).toEqual(
      new Set(['f->x', 'x->f']),
    )
  })

  it('follows edge orientation, not the gesture direction', () => {
    let s = createLensSession('f')
    // A downstream expansion that surfaces an INCOMING edge places the
    // partner upstream — orientation is the truth, the gesture is not.
    s = expandDown(s, 'f', input({ rawEdges: [edge('in', 'f')] }))
    expect(s.hops.get('in')).toBe(-1)
  })

  it('expands a placed partner one further hop out', () => {
    let s = createLensSession('f')
    s = expandDown(s, 'f', input({ rawEdges: [edge('f', 'a')] }))
    s = expandDown(s, 'a', input({ rawEdges: [edge('a', 'b')] }))
    expect(s.hops.get('b')).toBe(2)
    // No cap: keep walking.
    s = expandDown(s, 'b', input({ rawEdges: [edge('b', 'c')] }))
    s = expandDown(s, 'c', input({ rawEdges: [edge('c', 'd')] }))
    s = expandDown(s, 'd', input({ rawEdges: [edge('d', 'e5')] }))
    s = expandDown(s, 'e5', input({ rawEdges: [edge('e5', 'e6')] }))
    expect(s.hops.get('e6')).toBe(6)
  })

  it('reports newly placed urns as arrivals with a bumped token', () => {
    let s = createLensSession('f')
    const before = s.arrivals.token
    s = expandDown(s, 'f', input({ rawEdges: [edge('f', 'a'), edge('f', 'b')] }))
    expect(s.arrivals.token).toBe(before + 1)
    expect(new Set(s.arrivals.urns)).toEqual(new Set(['a', 'b']))
    // A merge that places nothing new leaves arrivals untouched.
    const again = expandDown(s, 'f', input({ rawEdges: [edge('f', 'a')] }))
    expect(again.arrivals.token).toBe(s.arrivals.token)
  })
})

describe('fold rules', () => {
  it('folds exact repeats into one record, keeping the max weight floor', () => {
    let s = createLensSession('f')
    s = expandDown(s, 'f', input({ rawEdges: [edge('f', 'a'), edge('f', 'a')] }))
    const recs = visibleRecords(s)
    expect(recs).toHaveLength(1)
    expect(recs[0].bundledCount).toBe(1)
  })

  it('absorbs a rollup into a concrete record to the same pair (rollup first)', () => {
    let s = createLensSession('f')
    s = expandDown(
      s,
      'f',
      input({
        rawEdges: [
          edge('f', 'a', 'AGGREGATED', { weight: 7, sourceEdgeTypes: ['FLOWS_TO'] }),
          edge('f', 'a', 'FLOWS_TO'),
        ],
      }),
    )
    const recs = visibleRecords(s)
    expect(recs).toHaveLength(1)
    expect(recs[0].edgeTypeNorm).toBe('FLOWS_TO')
    expect(recs[0].aggregated).toBe(false)
    expect(recs[0].bundledCount).toBe(7)
    expect(recs[0].rollupEdge).toEqual({ sourceUrn: 'f', targetUrn: 'a' })
  })

  it('absorbs a rollup into a concrete record to the same pair (concrete first)', () => {
    let s = createLensSession('f')
    s = expandDown(s, 'f', input({ rawEdges: [edge('f', 'a', 'TRANSFORMS')] }))
    s = expandDown(
      s,
      'f',
      input({
        rawEdges: [edge('f', 'a', 'AGGREGATED', { weight: 3, sourceEdgeTypes: ['TRANSFORMS', 'FLOWS_TO'] })],
      }),
    )
    const recs = visibleRecords(s)
    expect(recs).toHaveLength(1)
    expect(recs[0].edgeTypeNorm).toBe('TRANSFORMS')
    expect(recs[0].alsoTypes).toContain('FLOWS_TO')
    expect(recs[0].bundledCount).toBe(3)
    expect(recs[0].rollupEdge).toEqual({ sourceUrn: 'f', targetUrn: 'a' })
  })

  it('covers a rollup when a concrete partner sits under the rolled-up endpoint', () => {
    let s = createLensSession('f')
    // Rollup says f -> platform; concrete says f -> table, and the
    // table is contained (transitively) under the platform.
    s = expandDown(
      s,
      'f',
      input({
        rawEdges: [edge('f', 'platform', 'AGGREGATED', { weight: 4 })],
        trace: emptyTrace({
          containmentEdges: [
            edge('platform', 'db', 'CONTAINS'),
            edge('db', 'table', 'CONTAINS'),
          ],
        }),
      }),
    )
    expect(visibleRecords(s)).toHaveLength(1)
    s = expandDown(s, 'f', input({ rawEdges: [edge('f', 'table')] }))
    const visible = visibleRecords(s)
    expect(visible).toHaveLength(1)
    expect(visible[0].target).toBe('table')
    // The covered record is presentation-filtered, not deleted.
    const rollup = [...s.records.values()].find(r => r.aggregated)
    expect(rollup).toBeDefined()
    expect(isRollupCovered(s, rollup!)).toBe(true)
  })

  it('drops self-loops and containment edge types from lineage records', () => {
    let s = createLensSession('f')
    s = expandDown(
      s,
      'f',
      input({ rawEdges: [edge('f', 'f'), edge('f', 'child', 'CONTAINS')] }),
    )
    expect(visibleRecords(s)).toHaveLength(0)
    expect(s.hops.has('child')).toBe(false)
  })

  it('ignores edges that do not touch the expanded node', () => {
    let s = createLensSession('f')
    s = expandDown(s, 'f', input({ rawEdges: [edge('other', 'stranger')] }))
    expect(visibleRecords(s)).toHaveLength(0)
    expect(s.hops.has('stranger')).toBe(false)
  })
})

describe('containment and hierarchy', () => {
  it('fills parents from trace containment without placing ancestors', () => {
    let s = createLensSession('f')
    s = expandDown(
      s,
      'f',
      input({
        rawEdges: [edge('f', 'col')],
        trace: emptyTrace({
          nodes: [node('table'), node('schema')],
          containmentEdges: [edge('schema', 'table', 'CONTAINS'), edge('table', 'col', 'CONTAINS')],
        }),
      }),
    )
    expect(s.parents.get('col')).toBe('table')
    expect(s.parents.get('table')).toBe('schema')
    expect(s.hops.has('table')).toBe(false)
    expect(s.hops.has('schema')).toBe(false)
  })

  it('reads child-to-parent containment types the right way round', () => {
    let s = createLensSession('f')
    s = expandDown(
      s,
      'f',
      input({
        rawEdges: [edge('f', 'col')],
        trace: emptyTrace({ containmentEdges: [edge('col', 'table', 'BELONGS_TO')] }),
      }),
    )
    expect(s.parents.get('col')).toBe('table')
  })

  it('merges an ancestor chain nearest-first and marks the root', () => {
    let s = createLensSession('f')
    s = mergeAncestors(s, 'f', [node('db'), node('platform'), node('domain')])
    expect(s.parents.get('f')).toBe('db')
    expect(s.parents.get('db')).toBe('platform')
    expect(s.parents.get('platform')).toBe('domain')
    expect(s.parents.get('domain')).toBeNull()
  })

  it('an empty ancestor chain marks the node itself as a known root', () => {
    let s = createLensSession('f')
    s = mergeAncestors(s, 'f', [])
    expect(s.parents.get('f')).toBeNull()
  })
})

describe('children (containment opens)', () => {
  const page = (urns: string[], hasMore: boolean, total: number, cursor: string | null) => ({
    children: urns.map(u => node(u)),
    containmentEdges: urns.map(u => edge('f', u, 'CONTAINS')),
    lineageEdges: [],
    totalChildren: total,
    hasMore,
    nextCursor: cursor,
  })

  it('accumulates pages in server order and inherits the parent hop', () => {
    let s = createLensSession('f')
    s = startChildren(s, 'f')
    s = mergeChildren(s, 'f', page(['a', 'b'], true, 4, 'b'), OPTS)
    s = mergeChildren(s, 'f', page(['c', 'd'], false, 4, null), OPTS)
    const kids = s.children.get('f')!
    expect(kids.state).toBe('done')
    expect(kids.urns).toEqual(['a', 'b', 'c', 'd'])
    expect(kids.hasMore).toBe(false)
    for (const u of kids.urns) {
      expect(s.hops.get(u)).toBe(0)
      expect(s.parents.get(u)).toBe('f')
    }
  })

  it('folds lineage edges shipped with a children page', () => {
    let s = createLensSession('f')
    s = mergeChildren(
      s,
      'f',
      {
        children: [node('a')],
        containmentEdges: [edge('f', 'a', 'CONTAINS')],
        lineageEdges: [edge('a', 'elsewhere')],
        totalChildren: 1,
        hasMore: false,
        nextCursor: null,
      },
      OPTS,
    )
    expect(visibleRecords(s)).toHaveLength(1)
  })
})

describe('drills', () => {
  it('places constituents on the side of the drilled pair they belong to', () => {
    let s = createLensSession('f')
    s = expandDown(s, 'f', input({ rawEdges: [edge('f', 'sys', 'AGGREGATED', { weight: 2 })] }))
    const rollup = [...s.records.values()].find(r => r.aggregated)!
    s = startDrill(s, rollup.id)
    s = mergeDrill(
      s,
      rollup.id,
      emptyTrace({
        nodes: [node('t1'), node('t2')],
        containmentEdges: [edge('sys', 't1', 'CONTAINS'), edge('sys', 't2', 'CONTAINS')],
        edges: [edge('f', 't1'), edge('f', 't2')],
      }),
      OPTS,
    )
    const drill = s.drills.get(rollup.id)!
    expect(drill.state).toBe('done')
    expect(drill.recordIds).toHaveLength(2)
    expect(s.hops.get('t1')).toBe(1)
    expect(s.hops.get('t2')).toBe(1)
    // The drilled rollup is now covered by its own constituents.
    expect(isRollupCovered(s, s.records.get(rollup.id)!)).toBe(true)
  })
})

describe('inherited traces', () => {
  it('records the banner but never folds an ancestor lineage as this node', () => {
    let s = createLensSession('f')
    s = expandDown(
      s,
      'f',
      input({
        trace: emptyTrace({
          isInherited: true,
          inheritedFromUrn: 'parentDb',
          edges: [edge('parentDb', 'otherDb', 'AGGREGATED', { weight: 9 })],
          nodes: [node('parentDb'), node('otherDb')],
          containmentEdges: [edge('parentDb', 'f', 'CONTAINS')],
        }),
      }),
    )
    expect(visibleRecords(s)).toHaveLength(0)
    expect(s.hops.has('otherDb')).toBe(false)
    const exp = s.expansions.get(expansionKeyOf('down', 'f'))!
    expect(exp.isInherited).toBe(true)
    expect(exp.inheritedFromUrn).toBe('parentDb')
    // Containment context still landed.
    expect(s.parents.get('f')).toBe('parentDb')
  })
})

describe('status transitions and truncation', () => {
  it('tracks loading → done with truncation from either source', () => {
    let s = createLensSession('f')
    const key = expansionKeyOf('down', 'f')
    s = startExpansion(s, key)
    expect(s.expansions.get(key)!.state).toBe('loading')
    s = mergeExpansion(s, key, 'f', input({ rawEdges: [edge('f', 'a')], rawTruncated: true }), OPTS)
    const exp = s.expansions.get(key)!
    expect(exp.state).toBe('done')
    expect(exp.truncated).toBe(true)
    expect(exp.truncationReason).toBe('fetch_limit')
  })

  it('carries the server truncation reason through', () => {
    let s = createLensSession('f')
    const key = expansionKeyOf('down', 'f')
    s = mergeExpansion(
      s,
      key,
      'f',
      input({ trace: emptyTrace({ truncated: true, truncationReason: 'max_nodes' }) }),
      OPTS,
    )
    expect(s.expansions.get(key)!.truncationReason).toBe('max_nodes')
  })

  it('marks failures per key and lets a retry overwrite them', () => {
    let s = createLensSession('f')
    const key = expansionKeyOf('up', 'f')
    s = failExpansion(s, key)
    expect(s.expansions.get(key)!.state).toBe('error')
    s = mergeExpansion(s, key, 'f', input({ rawEdges: [edge('src', 'f')] }), OPTS)
    expect(s.expansions.get(key)!.state).toBe('done')
    s = failChildren(s, 'f')
    expect(s.children.get('f')!.state).toBe('error')
    s = failDrill(s, 'some-record')
    expect(s.drills.get('some-record')!.state).toBe('error')
  })
})

describe('key-namespace isolation (regression)', () => {
  it('an expansion, a children open and a drill on the same urn never collide', () => {
    let s = createLensSession('f')
    s = expandDown(s, 'f', input({ rawEdges: [edge('f', 'a', 'AGGREGATED', { weight: 2 })] }))
    const rollup = [...s.records.values()].find(r => r.aggregated)!
    s = startChildren(s, 'f')
    s = failChildren(s, 'f')
    s = startDrill(s, rollup.id)
    s = failDrill(s, rollup.id)
    // The lineage expansion is untouched by the other two axes failing.
    expect(s.expansions.get(expansionKeyOf('down', 'f'))!.state).toBe('done')
    expect(s.children.get('f')!.state).toBe('error')
    expect(s.drills.get(rollup.id)!.state).toBe('error')
    // And keys live in disjoint maps: no cross-reads possible.
    expect(s.expansions.has('f')).toBe(false)
    expect(s.children.has(expansionKeyOf('down', 'f'))).toBe(false)
  })
})

describe('nodes and degrees', () => {
  it('hydrated nodes win over stubs and stubs never clobber them', () => {
    let s = createLensSession('f')
    s = mergeNodes(s, [node('a', 'dataset', 'a')])
    s = mergeNodes(s, [node('a', 'dataset', 'Orders (gold)')])
    expect(s.nodes.get('a')!.displayName).toBe('Orders (gold)')
    s = mergeNodes(s, [node('a', 'dataset', 'a')])
    expect(s.nodes.get('a')!.displayName).toBe('Orders (gold)')
  })

  it('merges degrees and leaves unknowns absent', () => {
    let s = createLensSession('f')
    s = mergeDegrees(s, { a: { in: 3, out: 5 } })
    expect(s.degrees.get('a')).toEqual({ in: 3, out: 5 })
    expect(s.degrees.has('b')).toBe(false)
  })

  it('sums shown-edge floors per node and direction in edge units', () => {
    let s = createLensSession('f')
    s = expandDown(
      s,
      'f',
      input({
        rawEdges: [
          edge('f', 'a', 'AGGREGATED', { weight: 4 }),
          edge('f', 'b', 'FLOWS_TO'),
        ],
      }),
    )
    const floors = shownEdgeFloors(s)
    expect(floors.get(expansionKeyOf('down', 'f'))).toBe(5)
    expect(floors.get(expansionKeyOf('up', 'a'))).toBe(4)
    expect(floors.get(expansionKeyOf('up', 'b'))).toBe(1)
  })
})
