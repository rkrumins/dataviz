/**
 * closure-adapter tests.
 *
 * Loads the SAME shared fixture backend/tests/test_trace_closure_wire_contract.py
 * validates (trace_closure_walk_fixture.json) — the drift tripwire: if the
 * backend wire model and this adapter ever disagree on shape, one suite or
 * the other fails.
 *
 * The fixture is a three-hop walk: `initial` (focus t_orders, one upstream
 * partner t_raw, two downstream partners t_report/t_report2 with two
 * parallel edges into t_report), `extension` (t_raw extended further
 * upstream, with a seam edge straight into t_orders), `hubPage` (t_report's
 * downstream hub paged one step further). See the fixture file for the
 * full node/edge inventory.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, beforeAll } from 'vitest'

import { toLensClosure, mergeClosures, emptyWalkModel, type LensWalkModel } from '../closure-adapter'
import { buildLensSubgraph } from '../lens-subgraph'
import type {
    GraphNode,
    GraphEdge,
    TraceV2Result,
    LensClosureExtras,
} from '@/providers/GraphDataProvider'

const FOCUS_URN = 'urn:li:table:t_orders'

// ── Fixture loading ──────────────────────────────────────────────────────

interface RawFrontierEntry {
    urn: string
    totalCount?: number | null
    nextCursor?: string | null
}

interface RawClosureDoc {
    nodes: GraphNode[]
    edges: GraphEdge[]
    containmentEdges: GraphEdge[]
    upstreamUrns: string[]
    downstreamUrns: string[]
    focus: { urn: string; level: number; entityType: string }
    effectiveLevel: number
    isInherited: boolean
    inheritedFromUrn: string | null
    truncated: boolean
    truncationReason: string | null
    frontierUp: RawFrontierEntry[]
    frontierDown: RawFrontierEntry[]
    seedTruncated: boolean
}

interface WalkFixture {
    initial: RawClosureDoc
    extension: RawClosureDoc
    hubPage: RawClosureDoc
}

let fixture: WalkFixture

beforeAll(() => {
    const path = resolve(
        __dirname,
        '../../../../../../../backend/tests/fixtures/trace_closure_walk_fixture.json',
    )
    fixture = JSON.parse(readFileSync(path, 'utf-8')) as WalkFixture
})

/** Mirrors what `normalizeTraceV2` does on the real provider before the
 *  adapter ever sees a response: Set-ify the direction urns. */
function toResponse(doc: RawClosureDoc): TraceV2Result & LensClosureExtras {
    return {
        ...doc,
        upstreamUrns: new Set(doc.upstreamUrns),
        downstreamUrns: new Set(doc.downstreamUrns),
    }
}

function makeResponse(
    overrides: Partial<TraceV2Result & LensClosureExtras> & { focus: TraceV2Result['focus'] },
): TraceV2Result & LensClosureExtras {
    return {
        nodes: [],
        edges: [],
        containmentEdges: [],
        upstreamUrns: new Set(),
        downstreamUrns: new Set(),
        effectiveLevel: 0,
        isInherited: false,
        inheritedFromUrn: null,
        truncated: false,
        truncationReason: null,
        frontierUp: [],
        frontierDown: [],
        seedTruncated: false,
        ...overrides,
    }
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value)
        for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v)
    }
    return value
}

// ── toLensClosure ─────────────────────────────────────────────────────────

describe('toLensClosure', () => {
    it('converts nodes (participants + spines), containment spines, direction sets as Sets, parallel edges', () => {
        const m = toLensClosure(toResponse(fixture.initial), FOCUS_URN)

        // 4-level t_orders spine + t_raw's spine (minus the shared domain) +
        // the shared downstream spine + 2 tables = 12 participants.
        expect(m.nodes).toHaveLength(12)
        expect(m.nodes.map(n => n.urn)).toContain('urn:li:table:t_raw')

        expect(m.containmentEdges).toHaveLength(10)
        expect(
            m.containmentEdges.some(
                e => e.sourceUrn === 'urn:li:domain:dom_finance' && e.targetUrn === 'urn:li:application:app_sales',
            ),
        ).toBe(true)

        expect(m.upstreamUrns).toBeInstanceOf(Set)
        expect(m.downstreamUrns).toBeInstanceOf(Set)
        expect(m.upstreamUrns.has('urn:li:table:t_raw')).toBe(true)
        expect(m.downstreamUrns.has('urn:li:table:t_report')).toBe(true)
        expect(m.downstreamUrns.has('urn:li:table:t_report2')).toBe(true)

        // Two parallel edges t_orders -> t_report: distinct ids, both present.
        const parallel = m.lineageEdges.filter(
            e => e.sourceUrn === 'urn:li:table:t_orders' && e.targetUrn === 'urn:li:table:t_report',
        )
        expect(parallel).toHaveLength(2)
        expect(parallel[0]!.id).not.toBe(parallel[1]!.id)
    })

    it('normalizes a frontier entry with absent totalCount/nextCursor to null (synthetic variant)', () => {
        const synthetic = makeResponse({
            focus: { urn: 'x', level: 0, entityType: 'table' },
            frontierUp: [{ urn: 'urn:li:table:t_raw' }],
        })
        const m = toLensClosure(synthetic, 'x')
        expect(m.frontierUp).toEqual([{ urn: 'urn:li:table:t_raw', totalCount: null, nextCursor: null, kind: 'depth' }])
    })

    it("distinguishes depth-exhausted (cursor-less) from budget-cut ('e:0') frontier entries", () => {
        const m = toLensClosure(toResponse(fixture.initial), FOCUS_URN)
        // t_raw: depth ran out -> cursor-less.
        expect(m.frontierUp).toEqual([{ urn: 'urn:li:table:t_raw', totalCount: 3, nextCursor: null, kind: 'depth' }])
        // t_report: node-budget cut -> resumable from the start.
        expect(m.frontierDown).toEqual([{ urn: 'urn:li:table:t_report', totalCount: 9, nextCursor: 'e:0', kind: 'cut' }])
    })
})

// ── toLensClosure — edge grain ───────────────────────────────────────────

describe('toLensClosure — edge grain', () => {
    const base = (over: Partial<TraceV2Result & LensClosureExtras> = {}): TraceV2Result & LensClosureExtras => ({
        nodes: [], edges: [], containmentEdges: [],
        upstreamUrns: new Set(), downstreamUrns: new Set(),
        focus: { urn: 'F', level: 0, entityType: 'dataset' },
        effectiveLevel: 0, isInherited: false, inheritedFromUrn: null,
        truncated: false, truncationReason: null,
        frontierUp: [], frontierDown: [], seedTruncated: false,
        ...over,
    })

    it('tags edges with grain: AGGREGATED → rollup with weight, others → raw', () => {
        const m = toLensClosure(base({
            edges: [
                { id: 'r1', sourceUrn: 'a', targetUrn: 'b', edgeType: 'TRANSFORMS' },
                { id: 'g1', sourceUrn: 'A', targetUrn: 'B', edgeType: 'AGGREGATED', properties: { weight: 7 } },
            ] as never,
        }), 'F')
        expect(m.lineageEdges.find(e => e.id === 'r1')).toMatchObject({ kind: 'raw', weight: null })
        expect(m.lineageEdges.find(e => e.id === 'g1')).toMatchObject({ kind: 'rollup', weight: 7 })
    })
})

// ── mergeClosures — edge grain ───────────────────────────────────────────

describe('mergeClosures — edge grain', () => {
    const base = (over: Partial<TraceV2Result & LensClosureExtras> = {}): TraceV2Result & LensClosureExtras => ({
        nodes: [], edges: [], containmentEdges: [],
        upstreamUrns: new Set(), downstreamUrns: new Set(),
        focus: { urn: 'F', level: 0, entityType: 'dataset' },
        effectiveLevel: 0, isInherited: false, inheritedFromUrn: null,
        truncated: false, truncationReason: null,
        frontierUp: [], frontierDown: [], seedTruncated: false,
        ...over,
    })

    it('preserves kind/weight through a union, last write wins on a re-shipped edge', () => {
        const m1 = toLensClosure(base({
            edges: [{ id: 'g1', sourceUrn: 'A', targetUrn: 'B', edgeType: 'AGGREGATED', properties: { weight: 7 } }] as never,
        }), 'F')
        const m2 = mergeClosures(m1, base({
            edges: [{ id: 'g1', sourceUrn: 'A', targetUrn: 'B', edgeType: 'AGGREGATED', properties: { weight: 12 } }] as never,
        }), { rootUrn: 'F', direction: 'both' })

        expect(m2.lineageEdges.find(e => e.id === 'g1')).toMatchObject({ kind: 'rollup', weight: 12 })
    })
})

// ── mergeClosures — walk accumulation ───────────────────────────────────

describe('mergeClosures — walk accumulation', () => {
    it('unions the extension in: counts, cleared t_raw frontier, new leaf frontiers, seam edge resolves', () => {
        const m1 = toLensClosure(toResponse(fixture.initial), FOCUS_URN)
        const m2 = mergeClosures(m1, toResponse(fixture.extension), {
            rootUrn: 'urn:li:table:t_raw',
            direction: 'up',
        })

        // 12 + 9 incoming - 4 re-shipped-overlap (t_raw's own spine) = 17.
        expect(m2.nodes).toHaveLength(17)
        // 4 + 3 new lineage edges (no id overlap) = 7.
        expect(m2.lineageEdges).toHaveLength(7)
        // 10 + 7 incoming - 3 re-shipped-overlap = 14.
        expect(m2.containmentEdges).toHaveLength(14)

        // t_raw's own expansion completed (no entry for it in the response)
        // -> the merge clears its stored cursor entry.
        expect(m2.frontierUp.find(f => f.urn === 'urn:li:table:t_raw')).toBeUndefined()
        // The two new leaves' frontier entries are present.
        expect(m2.frontierUp.map(f => f.urn).sort()).toEqual(
            ['urn:li:table:t_src_a', 'urn:li:table:t_src_b'].sort(),
        )
        // frontierDown is untouched by an 'up' merge — t_report's cut entry survives.
        expect(m2.frontierDown).toEqual([{ urn: 'urn:li:table:t_report', totalCount: 9, nextCursor: 'e:0', kind: 'cut' }])

        // The seam edge (t_src_a -> t_orders) is present in the union...
        const seam = m2.lineageEdges.find(e => e.id === 'e:7')
        expect(seam).toBeDefined()
        expect(seam?.targetUrn).toBe('urn:li:table:t_orders')
        // ...and both endpoints now resolve post-union, so buildLensSubgraph
        // does NOT drop it (the sibling module's defensive-drop only fires
        // for an edge whose endpoint is still missing).
        const sg = buildLensSubgraph(m2)
        expect(sg.lineageEdges.some(e => e.id === 'e:7')).toBe(true)
    })
})

// ── mergeClosures — hub paging ───────────────────────────────────────────

describe('mergeClosures — hub paging', () => {
    it('a further page advances the cursor; an exhausted page clears it', () => {
        const m1 = toLensClosure(toResponse(fixture.initial), FOCUS_URN)
        const m2 = mergeClosures(m1, toResponse(fixture.extension), {
            rootUrn: 'urn:li:table:t_raw',
            direction: 'up',
        })
        const m3 = mergeClosures(m2, toResponse(fixture.hubPage), {
            rootUrn: 'urn:li:table:t_report',
            direction: 'down',
        })

        // 17 + 9 incoming - 4 re-shipped-overlap (t_report's own spine) = 22.
        expect(m3.nodes).toHaveLength(22)
        expect(m3.frontierDown).toEqual([{ urn: 'urn:li:table:t_report', totalCount: 9, nextCursor: 'e:41', kind: 'cut' }])

        // A synthetic exhausted page: no entry for t_report at all.
        const exhausted = makeResponse({ focus: { urn: 'urn:li:table:t_report', level: 0, entityType: 'table' } })
        const m4 = mergeClosures(m3, exhausted, { rootUrn: 'urn:li:table:t_report', direction: 'down' })
        expect(m4.frontierDown.find(f => f.urn === 'urn:li:table:t_report')).toBeUndefined()
    })
})

// ── mergeClosures — idempotence ──────────────────────────────────────────

describe('mergeClosures — idempotence', () => {
    it('initial: merging twice deep-equals merging once', () => {
        const base = emptyWalkModel(FOCUS_URN)
        const response = toResponse(fixture.initial)
        const ctx = { rootUrn: FOCUS_URN, direction: 'both' as const }
        const once = mergeClosures(base, response, ctx)
        const twice = mergeClosures(once, response, ctx)
        expect(twice).toEqual(once)
    })

    it('extension: merging twice deep-equals merging once', () => {
        const base = mergeClosures(emptyWalkModel(FOCUS_URN), toResponse(fixture.initial), {
            rootUrn: FOCUS_URN,
            direction: 'both',
        })
        const response = toResponse(fixture.extension)
        const ctx = { rootUrn: 'urn:li:table:t_raw', direction: 'up' as const }
        const once = mergeClosures(base, response, ctx)
        const twice = mergeClosures(once, response, ctx)
        expect(twice).toEqual(once)
    })

    it('hubPage: merging twice deep-equals merging once', () => {
        const afterInitial = mergeClosures(emptyWalkModel(FOCUS_URN), toResponse(fixture.initial), {
            rootUrn: FOCUS_URN,
            direction: 'both',
        })
        const base = mergeClosures(afterInitial, toResponse(fixture.extension), {
            rootUrn: 'urn:li:table:t_raw',
            direction: 'up',
        })
        const response = toResponse(fixture.hubPage)
        const ctx = { rootUrn: 'urn:li:table:t_report', direction: 'down' as const }
        const once = mergeClosures(base, response, ctx)
        const twice = mergeClosures(once, response, ctx)
        expect(twice).toEqual(once)
    })
})

// ── mergeClosures — purity ───────────────────────────────────────────────

describe('mergeClosures — purity', () => {
    it('never mutates model or response (frozen inputs survive a merge)', () => {
        const m1 = deepFreeze(toLensClosure(toResponse(fixture.initial), FOCUS_URN))
        const response = deepFreeze(toResponse(fixture.extension))

        expect(() =>
            mergeClosures(m1, response, { rootUrn: 'urn:li:table:t_raw', direction: 'up' }),
        ).not.toThrow()

        // Untouched: still the pre-merge counts.
        expect(m1.nodes).toHaveLength(12)
        expect(response.nodes).toHaveLength(9)
    })
})

// ── mergeClosures — node payload ─────────────────────────────────────────

describe('mergeClosures — node payload', () => {
    it('last write wins on a re-shipped node (synthetic: same urn, changed childCount)', () => {
        const urn = 'urn:li:table:t_x'
        const r1 = makeResponse({
            focus: { urn, level: 0, entityType: 'table' },
            nodes: [{ urn, entityType: 'table', displayName: 'X', properties: {}, childCount: 5 }],
        })
        const r2 = makeResponse({
            focus: { urn, level: 0, entityType: 'table' },
            nodes: [{ urn, entityType: 'table', displayName: 'X', properties: {}, childCount: 9 }],
        })

        const m1 = toLensClosure(r1, urn)
        const m2 = mergeClosures(m1, r2, { rootUrn: urn, direction: 'both' })

        expect(m2.nodes.find(n => n.urn === urn)?.data.childCount).toBe(9)
    })
})

describe('seedCursor — the focus-contents resume point', () => {
  const base = (over: Partial<TraceV2Result & LensClosureExtras> = {}): TraceV2Result & LensClosureExtras => ({
    nodes: [], edges: [], containmentEdges: [],
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    focus: { urn: 'F', level: 0, entityType: 'dataset' },
    effectiveLevel: 0, isInherited: false, inheritedFromUrn: null,
    truncated: false, truncationReason: null,
    frontierUp: [], frontierDown: [], seedTruncated: false,
    ...over,
  })

  it('rides into the model and merges authoritatively for FOCUS-anchored responses', () => {
    let m = toLensClosure(base({ seedTruncated: true, seedCursor: 's:w3' }), 'F')
    expect(m.seedCursor).toBe('s:w3')

    // A focus-anchored continuation ADVANCES the cursor…
    m = mergeClosures(m, base({ seedTruncated: true, seedCursor: 's:w6' }), { rootUrn: 'F', direction: 'both' })
    expect(m.seedCursor).toBe('s:w6')
    // …and drains it when the page came back uncapped.
    m = mergeClosures(m, base({ seedCursor: null }), { rootUrn: 'F', direction: 'both' })
    expect(m.seedCursor).toBeNull()
  })

  it('a CARD-anchored extend never touches the focus-contents cursor', () => {
    let m = toLensClosure(base({ seedCursor: 's:w3' }), 'F')
    m = mergeClosures(m, base({ seedCursor: null }), { rootUrn: 'someCard', direction: 'up' })
    expect(m.seedCursor).toBe('s:w3')
  })
})

// ── Degree-exact walk contract (2026-08-21) ──────────────────────────────

describe('frontier entries carry their kind', () => {
  const base = (over: Partial<TraceV2Result & LensClosureExtras> = {}): TraceV2Result & LensClosureExtras => ({
    nodes: [], edges: [], containmentEdges: [],
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    focus: { urn: 'F', level: 0, entityType: 'dataset' },
    effectiveLevel: 0, isInherited: false, inheritedFromUrn: null,
    truncated: false, truncationReason: null,
    frontierUp: [], frontierDown: [], seedTruncated: false,
    ...over,
  })

  it('reads the wire reason; a cursored entry without one is a cut, a bare one is depth', () => {
    const m = toLensClosure(base({
      frontierUp: [
        { urn: 'cut1', totalCount: 3, nextCursor: null, reason: 'cut' },
        { urn: 'dep1', totalCount: 3, nextCursor: null, reason: 'depth' },
        { urn: 'hub', totalCount: 50, nextCursor: 'e:9' },          // old server: no reason
        { urn: 'old', totalCount: 1, nextCursor: null },            // old server: no reason
      ],
    }), 'F')
    expect(m.frontierUp.map(f => [f.urn, f.kind])).toEqual([
      ['cut1', 'cut'], ['dep1', 'depth'], ['hub', 'cut'], ['old', 'depth'],
    ])
  })
})

describe('mergeClosures — bulk drains', () => {
  const base = (over: Partial<TraceV2Result & LensClosureExtras> = {}): TraceV2Result & LensClosureExtras => ({
    nodes: [], edges: [], containmentEdges: [],
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    focus: { urn: 'F', level: 0, entityType: 'dataset' },
    effectiveLevel: 0, isInherited: false, inheritedFromUrn: null,
    truncated: false, truncationReason: null,
    frontierUp: [], frontierDown: [], seedTruncated: false,
    ...over,
  })
  const entry = (urn: string, reason: 'cut' | 'depth' = 'cut') => ({ urn, totalCount: 2, nextCursor: null, reason })

  it('clearFrontierRoots drops every batched anchor before the union — a drained anchor disappears, a re-reported one survives', () => {
    let m = toLensClosure(base({ frontierDown: [entry('a'), entry('b'), entry('c')] }), 'F')
    // One request re-seeded a and b; the server says b still has more.
    m = mergeClosures(m, base({ frontierDown: [entry('b')] }), {
      rootUrn: 'a', direction: 'down', clearFrontierRoots: ['a', 'b'],
    })
    expect(m.frontierDown.map(f => f.urn)).toEqual(['b', 'c'])
  })
})

describe('mergeClosures — a coarse page merges without authority (Part G)', () => {
  const base = (over: Partial<TraceV2Result & LensClosureExtras> = {}): TraceV2Result & LensClosureExtras => ({
    nodes: [], edges: [], containmentEdges: [],
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    focus: { urn: 'F', level: 0, entityType: 'dataset' },
    effectiveLevel: 0, isInherited: false, inheritedFromUrn: null,
    truncated: false, truncationReason: null,
    frontierUp: [], frontierDown: [], seedTruncated: false,
    ...over,
  })
  const node = (urn: string) => ({ urn, displayName: urn, entityType: 'dataset', properties: {} })
  const cell = (s: string, t: string, weight: number) =>
    ({ id: `agg:${s}>${t}`, sourceUrn: s, targetUrn: t, edgeType: 'AGGREGATED', properties: { weight } }) as never

  it('keeps the fine page\'s seed cursor and frontier when the coarse page lands second', () => {
    const fine = toLensClosure(base({
      nodes: [node('F'), node('c1')], truncated: true, truncationReason: 'max_nodes', seedTruncated: true, seedCursor: 's:c2',
      frontierDown: [{ urn: 'c1', totalCount: 9, nextCursor: 'e:3', reason: 'cut' }],
    }), 'F')
    const merged = mergeClosures(fine, base({
      nodes: [node('F'), node('P')], edges: [cell('F', 'P', 40)], downstreamUrns: new Set(['P']),
    }), { rootUrn: 'F', direction: 'both', authoritative: false })
    expect(merged.seedCursor).toBe('s:c2')
    expect(merged.frontierDown.map(f => f.urn)).toEqual(['c1'])
    expect(merged.lineageEdges.find(e => e.id === 'agg:F>P')).toMatchObject({ kind: 'rollup', weight: 40 })
    expect(merged.nodes.map(n => n.urn).sort()).toEqual(['F', 'P', 'c1'])
    expect(merged.downstreamUrns.has('P')).toBe(true)
  })

  it('order does not matter: coarse-then-fine and fine-then-coarse are the same model', () => {
    const coarseRes = base({ nodes: [node('F'), node('P')], edges: [cell('F', 'P', 40)], downstreamUrns: new Set(['P']) })
    const fineRes = base({
      nodes: [node('F'), node('c1')], truncated: true, truncationReason: 'max_nodes', seedTruncated: true, seedCursor: 's:c2',
      frontierDown: [{ urn: 'c1', totalCount: 9, nextCursor: 'e:3', reason: 'cut' }],
    })
    const a = mergeClosures(toLensClosure(coarseRes, 'F'), fineRes, { rootUrn: 'F', direction: 'both' })
    const b = mergeClosures(toLensClosure(fineRes, 'F'), coarseRes, { rootUrn: 'F', direction: 'both', authoritative: false })
    const shape = (m: LensWalkModel) => ({
      nodes: m.nodes.map(n => n.urn).sort(), edges: m.lineageEdges.map(e => e.id).sort(),
      up: [...m.upstreamUrns].sort(), down: [...m.downstreamUrns].sort(),
      seedCursor: m.seedCursor, frontierDown: m.frontierDown.map(f => f.urn), truncated: m.truncated,
    })
    expect(shape(a)).toEqual(shape(b))
    expect(a.seedCursor).toBe('s:c2')
  })
})

describe('partiality is derived, never sticky', () => {
  const base = (over: Partial<TraceV2Result & LensClosureExtras> = {}): TraceV2Result & LensClosureExtras => ({
    nodes: [], edges: [], containmentEdges: [],
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    focus: { urn: 'F', level: 0, entityType: 'dataset' },
    effectiveLevel: 0, isInherited: false, inheritedFromUrn: null,
    truncated: false, truncationReason: null,
    frontierUp: [], frontierDown: [], seedTruncated: false,
    ...over,
  })

  it('truncated is true while a seed cursor or a cut entry remains, and false once they drain', () => {
    let m = toLensClosure(base({
      truncated: true, truncationReason: 'max_nodes', seedTruncated: true, seedCursor: 's:x',
      frontierDown: [{ urn: 'c', totalCount: 2, nextCursor: null, reason: 'cut' }],
    }), 'F')
    expect(m.truncated).toBe(true)

    // The seed pages drain…
    m = mergeClosures(m, base({ seedCursor: null }), { rootUrn: 'F', direction: 'both' })
    expect(m.truncated).toBe(true)          // …but the cut entry is still owed
    // …and the cut entry is re-seeded and comes back complete.
    m = mergeClosures(m, base({}), { rootUrn: 'c', direction: 'down', clearFrontierRoots: ['c'] })
    expect(m.truncated).toBe(false)
    expect(m.truncationReason).toBeNull()
    expect(m.seedTruncated).toBe(false)
  })

  it('a depth entry alone is not partiality — it is the next hop', () => {
    const m = toLensClosure(base({
      frontierUp: [{ urn: 'p', totalCount: 4, nextCursor: null, reason: 'depth' }],
    }), 'F')
    expect(m.truncated).toBe(false)
  })

  it('a failure reason on the latest page is kept while the page is partial', () => {
    const m = toLensClosure(base({
      truncated: true, truncationReason: 'timeout',
      frontierDown: [{ urn: 'c', totalCount: 2, nextCursor: null, reason: 'cut' }],
    }), 'F')
    expect(m.truncationReason).toBe('timeout')
  })
})
