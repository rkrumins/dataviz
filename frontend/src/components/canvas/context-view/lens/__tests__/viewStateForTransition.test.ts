/**
 * T26 R1 — `viewStateForTransition`, the single owner of what a focal
 * transition does to `LensViewState`. Pinned per (kind × field-class):
 * every field of `LensViewState`, for both the RESET group (the five
 * in-session kinds, proven identical by T25-C2) and the SURVIVE/CLAMP
 * group (`'share-restore'`, the one kind a shared link seeds fields
 * from). The regression this guards: a stray hand-built `LensViewState`
 * on some transition path forgetting to reset one field — the exact
 * T17-A/C2 stale-state defect family this function makes structurally
 * impossible by being the ONLY place a transition's view state is built.
 */
import { describe, it, expect } from 'vitest'
import { buildLensSubgraph, type LensSubgraph } from '../lens-subgraph'
import type { LensWalkNode } from '../closure-adapter'
import {
    viewStateForTransition,
    initialLensViewState,
    revealKey,
    type LensViewState,
    type LensViewSeed,
    type LensViewTransitionKind,
} from '../focus-layout'

const wnode = (urn: string): LensWalkNode => ({
    id: urn,
    type: 'generic',
    position: { x: 0, y: 0 },
    data: { urn, label: urn, type: 'dataset' },
    urn,
    displayName: urn,
    entityType: 'dataset',
}) as unknown as LensWalkNode

function subgraph(focus: string, others: string[] = ['A'], parent?: string): LensSubgraph<LensWalkNode> {
    return buildLensSubgraph<LensWalkNode>({
        focusUrn: focus,
        nodes: [focus, ...others, ...(parent ? [parent] : [])].map(wnode),
        lineageEdges: others.map((u, i) => ({ id: `h${i}`, sourceUrn: u, targetUrn: focus, edgeType: 'DERIVES_FROM' })),
        containmentEdges: parent ? [{ sourceUrn: parent, targetUrn: focus }] : [],
    })
}

const sg = subgraph('FOCUS')

// A view state with every field populated non-trivially, standing in for
// whatever the PREVIOUS focal's session accrued — passed as `prev` to
// prove the RESET kinds ignore it completely.
const populated: LensViewState = {
    selection: 'X',
    revealed: new Map([['in:X', 3]]),
    expandedContainment: new Set(['C1']),
    collapsedContainment: new Set(['C2']),
    frameShowAll: new Set(['C3']),
    walkedThrough: new Set(['C4']),
    drawnRank: new Map([['X', 1]]),
    frameQueries: new Map([['C1', 'q']]),
    frameOffsets: new Map([['C1', 2]]),
    pinned: new Set(['X']),
    condensedOpen: new Set(['conn1']),
}

const RESET_KINDS: LensViewTransitionKind[] = ['reanchor', 'back', 'forward', 'path-jump', 'lens-open']

describe('viewStateForTransition — the five RESET kinds are identical (T25-C2), and ignore `prev` entirely', () => {
    for (const kind of RESET_KINDS) {
        it(`${kind}: every field resets to fresh, whatever prev holds`, () => {
            const v = viewStateForTransition(kind, populated, { sg })
            expect(v.selection).toBeNull()
            expect([...v.revealed.entries()]).toEqual([[revealKey('in', 'FOCUS'), 1], [revealKey('out', 'FOCUS'), 1]])
            expect([...v.expandedContainment]).toContain('FOCUS')
            expect(v.collapsedContainment.size).toBe(0)
            expect(v.frameShowAll.size).toBe(0)
            expect(v.walkedThrough.size).toBe(0)
            expect(v.drawnRank.size).toBe(0)
            expect(v.frameQueries.size).toBe(0)
            expect(v.frameOffsets.size).toBe(0)
            expect(v.pinned.size).toBe(0)
            expect(v.condensedOpen.size).toBe(0)
        })

        it(`${kind}: prev === null produces the exact same result as a populated prev`, () => {
            expect(viewStateForTransition(kind, null, { sg })).toEqual(viewStateForTransition(kind, populated, { sg }))
        })
    }

    it('every RESET kind matches initialLensViewState(sg) — the delegation contract', () => {
        for (const kind of RESET_KINDS) {
            expect(viewStateForTransition(kind, null, { sg })).toEqual(initialLensViewState(sg))
        }
    })

    it('expandedContainment carries the full ancestor chain to the focus, not just the focus itself', () => {
        const nested = subgraph('FOCUS', ['A'], 'PARENT')
        const v = viewStateForTransition('reanchor', null, { sg: nested })
        expect([...v.expandedContainment]).toEqual(expect.arrayContaining(['FOCUS', 'PARENT']))
    })
})

describe('viewStateForTransition — share-restore SURVIVES the seed\'s fields, RESETS the rest', () => {
    const seed: LensViewSeed = {
        revealed: [['in:X', 2], ['out:Y', 1]],
        opened: ['C1', 'C2'],
        collapsed: ['C3'],
        frameAll: ['C4'],
        frameQueries: [['C1', 'find me']],
        framePages: [['C1', 3]],
        pinned: ['P1', 'P2'],
        condensedOpen: ['conn1'],
    }

    it('SURVIVE fields come from the seed verbatim', () => {
        const v = viewStateForTransition('share-restore', null, { sg, seed })
        expect([...v.revealed.entries()]).toEqual(seed.revealed)
        expect([...v.expandedContainment]).toEqual(seed.opened)
        expect([...v.collapsedContainment]).toEqual(seed.collapsed)
        expect([...v.frameShowAll]).toEqual(seed.frameAll)
        expect([...v.frameQueries.entries()]).toEqual(seed.frameQueries)
        expect([...v.frameOffsets.entries()]).toEqual(seed.framePages)
        expect([...v.pinned]).toEqual(seed.pinned)
        expect([...v.condensedOpen]).toEqual(seed.condensedOpen)
    })

    it('RESET fields stay fresh even though a seed is present', () => {
        const v = viewStateForTransition('share-restore', populated, { sg, seed })
        expect(v.selection).toBeNull()
        expect(v.walkedThrough.size).toBe(0)
        expect(v.drawnRank.size).toBe(0)
    })

    it('no seed at all (defensive) falls back to a full fresh reset, same as the five RESET kinds', () => {
        expect(viewStateForTransition('share-restore', null, { sg })).toEqual(initialLensViewState(sg))
        expect(viewStateForTransition('share-restore', null, { sg, seed: null })).toEqual(initialLensViewState(sg))
    })
})
