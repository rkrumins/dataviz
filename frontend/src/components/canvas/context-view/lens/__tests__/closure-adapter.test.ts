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

import { toLensClosure, mergeClosures, emptyWalkModel } from '../closure-adapter'
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
        expect(m.frontierUp).toEqual([{ urn: 'urn:li:table:t_raw', totalCount: null, nextCursor: null }])
    })

    it("distinguishes depth-exhausted (cursor-less) from budget-cut ('e:0') frontier entries", () => {
        const m = toLensClosure(toResponse(fixture.initial), FOCUS_URN)
        // t_raw: depth ran out -> cursor-less.
        expect(m.frontierUp).toEqual([{ urn: 'urn:li:table:t_raw', totalCount: 3, nextCursor: null }])
        // t_report: node-budget cut -> resumable from the start.
        expect(m.frontierDown).toEqual([{ urn: 'urn:li:table:t_report', totalCount: 9, nextCursor: 'e:0' }])
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
        expect(m2.frontierDown).toEqual([{ urn: 'urn:li:table:t_report', totalCount: 9, nextCursor: 'e:0' }])

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
        expect(m3.frontierDown).toEqual([{ urn: 'urn:li:table:t_report', totalCount: 9, nextCursor: 'e:41' }])

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
