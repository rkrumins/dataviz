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
  recordRenderStates,
  resolveToCarded,
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
  it('places only anchor-side constituents; the other side stays whole', () => {
    let s = createLensSession('f')
    s = expandDown(s, 'f', input({ rawEdges: [edge('f', 'sys', 'AGGREGATED', { weight: 2 })] }))
    const rollup = [...s.records.values()].find(r => r.aggregated)!
    s = startDrill(s, rollup.id, 'sys')
    s = mergeDrill(
      s,
      rollup.id,
      emptyTrace({
        nodes: [node('t1'), node('t2'), node('fSrc')],
        containmentEdges: [
          edge('sys', 't1', 'CONTAINS'),
          edge('sys', 't2', 'CONTAINS'),
          // The drill also names a finer endpoint UNDER the focal — the
          // level-aligned shape real cubes return.
          edge('f', 'fSrc', 'CONTAINS'),
        ],
        edges: [edge('f', 't1'), edge('fSrc', 't2')],
      }),
      OPTS,
      'sys',
    )
    const drill = s.drills.get(rollup.id)!
    expect(drill.state).toBe('done')
    expect(drill.anchorUrn).toBe('sys')
    expect(drill.recordIds).toHaveLength(2)
    expect(s.hops.get('t1')).toBe(1)
    expect(s.hops.get('t2')).toBe(1)
    // Focal-side descendant is recorded but NOT placed: its wire keeps
    // rendering through the focal card until that side is opened.
    expect(s.hops.has('fSrc')).toBe(false)
    expect(s.parents.get('fSrc')).toBe('f')
    // The drilled rollup is now covered by its own constituents.
    expect(isRollupCovered(s, s.records.get(rollup.id)!)).toBe(true)
  })

  it('excludes the backend echo of the drilled pair itself (done-empty terminal)', () => {
    let s = createLensSession('f')
    s = expandDown(s, 'f', input({ rawEdges: [edge('f', 'sys', 'AGGREGATED', { weight: 3 })] }))
    const rollup = [...s.records.values()].find(r => r.aggregated)!
    s = mergeDrill(
      s,
      rollup.id,
      emptyTrace({ edges: [edge('f', 'sys', 'AGGREGATED', { weight: 3 })] }),
      OPTS,
      'sys',
    )
    const drill = s.drills.get(rollup.id)!
    expect(drill.state).toBe('done')
    expect(drill.recordIds).toHaveLength(0)
    // An echo-only drill refines nothing: the record still draws.
    expect(recordRenderStates(s).get(rollup.id)).toBe('shown')
    expect(visibleRecords(s).map(r => r.id)).toEqual([rollup.id])
  })
})

describe('refinement render states', () => {
  /** f —AGG→ B, drilled at B into appA→App1 (AGG), drilled at App1
   *  into t1→tbl1 (concrete): the three-level macro→micro chain. */
  const chained = () => {
    let s = createLensSession('f')
    s = expandDown(s, 'f', input({ rawEdges: [edge('f', 'B', 'AGGREGATED', { weight: 8 })] }))
    const top = [...s.records.values()].find(r => r.aggregated)!
    s = startDrill(s, top.id, 'B')
    s = mergeDrill(
      s,
      top.id,
      emptyTrace({
        nodes: [node('App1'), node('appA')],
        containmentEdges: [edge('B', 'App1', 'CONTAINS'), edge('f', 'appA', 'CONTAINS')],
        edges: [edge('appA', 'App1', 'AGGREGATED', { weight: 4 })],
      }),
      OPTS,
      'B',
    )
    const mid = [...s.records.values()].find(r => r.aggregated && r.source === 'appA')!
    s = startDrill(s, mid.id, 'App1')
    s = mergeDrill(
      s,
      mid.id,
      emptyTrace({
        nodes: [node('tbl1'), node('t1')],
        containmentEdges: [edge('App1', 'tbl1', 'CONTAINS'), edge('appA', 't1', 'CONTAINS')],
        edges: [edge('t1', 'tbl1', 'FLOWS_TO')],
      }),
      OPTS,
      'App1',
    )
    const leaf = [...s.records.values()].find(r => !r.aggregated)!
    return { s, top, mid, leaf }
  }

  it('hides each refined step and shows only the deepest truth', () => {
    const { s, top, mid, leaf } = chained()
    const states = recordRenderStates(s)
    expect(states.get(top.id)).toBe('refined')
    expect(states.get(mid.id)).toBe('refined')
    expect(states.get(leaf.id)).toBe('shown')
    expect(visibleRecords(s).map(r => r.id)).toEqual([leaf.id])
    // Structure stays derivable: refined endpoints keep their hops.
    expect(s.hops.get('B')).toBe(1)
    expect(s.hops.get('App1')).toBe(1)
  })

  it('folding an anchor un-refines its drill and folds the chain below', () => {
    const { s, top, mid, leaf } = chained()
    const atB = recordRenderStates(s, new Set(['B']))
    expect(atB.get(top.id)).toBe('shown')
    expect(atB.get(mid.id)).toBe('folded')
    expect(atB.get(leaf.id)).toBe('folded')
    expect(visibleRecords(s, new Set(['B'])).map(r => r.id)).toEqual([top.id])
    const atApp1 = recordRenderStates(s, new Set(['App1']))
    expect(atApp1.get(top.id)).toBe('refined')
    expect(atApp1.get(mid.id)).toBe('shown')
    expect(atApp1.get(leaf.id)).toBe('folded')
  })

  it('a record revealed by several drills folds only when no path shows it', () => {
    let s = createLensSession('f')
    s = expandDown(
      s,
      'f',
      input({
        rawEdges: [
          edge('f', 'p', 'AGGREGATED', { weight: 2 }),
          edge('f', 'q', 'AGGREGATED', { weight: 2 }),
          edge('f', 'm', 'AGGREGATED', { weight: 2 }),
          edge('f', 'dead', 'AGGREGATED', { weight: 2 }),
        ],
      }),
    )
    const id = (partner: string) =>
      [...s.records.values()].find(r => r.target === partner)!.id
    // p's drill reveals m (live path). q has NO drill, so its reveal of
    // dead never fires; dead's own drill would reveal m too, but dead
    // itself is folded — m must still be shown via p.
    s = {
      ...s,
      drills: new Map([
        [id('p'), { state: 'done' as const, recordIds: [id('m')], anchorUrn: 'p' }],
        [id('dead'), { state: 'done' as const, recordIds: [id('m')], anchorUrn: 'dead' }],
        [id('q'), { state: 'done' as const, recordIds: [id('dead')], anchorUrn: 'q' }],
      ]),
    }
    // Make q's drill dead by folding q.
    const states = recordRenderStates(s, new Set(['q']))
    expect(states.get(id('q'))).toBe('shown')
    expect(states.get(id('dead'))).toBe('folded')
    expect(states.get(id('m'))).toBe('shown')
  })
})

describe('structural coverage among shown records', () => {
  it('a strictly finer aggregated record covers its coarser sibling', () => {
    let s = createLensSession('f')
    s = expandDown(s, 'f', input({ rawEdges: [edge('f', 'B', 'AGGREGATED', { weight: 6 })] }))
    const top = [...s.records.values()].find(r => r.aggregated)!
    // One wave lands the same truth at two grains (full-cube shape).
    s = mergeDrill(
      s,
      top.id,
      emptyTrace({
        nodes: [node('App1'), node('fApp')],
        containmentEdges: [edge('B', 'App1', 'CONTAINS'), edge('f', 'fApp', 'CONTAINS')],
        edges: [
          edge('f', 'App1', 'AGGREGATED', { weight: 4 }),
          edge('fApp', 'App1', 'AGGREGATED', { weight: 4 }),
        ],
      }),
      OPTS,
      'B',
    )
    const visible = visibleRecords(s)
    expect(visible).toHaveLength(1)
    expect(visible[0].source).toBe('fApp')
    expect(visible[0].target).toBe('App1')
  })

  it('mutual cover (corrupt containment cycle) keeps both records', () => {
    let s = createLensSession('f')
    s = expandDown(
      s,
      'f',
      input({
        rawEdges: [
          edge('p', 'f', 'AGGREGATED', { weight: 2 }),
          edge('c', 'f', 'AGGREGATED', { weight: 2 }),
        ],
        trace: emptyTrace({
          containmentEdges: [edge('p', 'c', 'CONTAINS'), edge('c', 'p', 'CONTAINS')],
        }),
      }),
    )
    expect(visibleRecords(s)).toHaveLength(2)
  })
})

describe('resolution and containment guards', () => {
  it('resolves to the nearest carded self-or-ancestor', () => {
    let s = createLensSession('f')
    s = mergeAncestors(s, 'c', [node('b'), node('a')])
    expect(resolveToCarded(s.parents, new Set(['c', 'a']), 'c')).toBe('c')
    expect(resolveToCarded(s.parents, new Set(['b', 'a']), 'c')).toBe('b')
    expect(resolveToCarded(s.parents, new Set(['a']), 'c')).toBe('a')
    expect(resolveToCarded(s.parents, new Set(['z']), 'c')).toBeUndefined()
  })

  it('survives containment cycles without looping', () => {
    const parents = new Map<string, string | null>([
      ['x', 'y'],
      ['y', 'x'],
    ])
    expect(resolveToCarded(parents, new Set(['q']), 'x')).toBeUndefined()
  })

  it('containment writes are first-write-wins', () => {
    let s = createLensSession('f')
    s = expandDown(
      s,
      'f',
      input({
        rawEdges: [edge('f', 'x')],
        trace: emptyTrace({ containmentEdges: [edge('parent1', 'x', 'CONTAINS')] }),
      }),
    )
    s = expandUp(
      s,
      'f',
      input({
        rawEdges: [edge('x', 'f')],
        trace: emptyTrace({ containmentEdges: [edge('parent2', 'x', 'CONTAINS')] }),
      }),
    )
    expect(s.parents.get('x')).toBe('parent1')
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
    s = startDrill(s, rollup.id, 'a')
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
    const floors = shownEdgeFloors(visibleRecords(s))
    expect(floors.get(expansionKeyOf('down', 'f'))).toBe(5)
    expect(floors.get(expansionKeyOf('up', 'a'))).toBe(4)
    expect(floors.get(expansionKeyOf('up', 'b'))).toBe(1)
  })

  it('floors count only the records the caller supplies', () => {
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
    const only = visibleRecords(s).filter(r => r.target === 'b')
    const floors = shownEdgeFloors(only)
    expect(floors.get(expansionKeyOf('down', 'f'))).toBe(1)
    expect(floors.has(expansionKeyOf('up', 'a'))).toBe(false)
  })
})
