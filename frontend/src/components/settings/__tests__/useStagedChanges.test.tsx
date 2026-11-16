/**
 * Staging: an edit stages a value at this scope and nothing is sent; the diff says what is in force
 * before and after; changing a value back drops it; the version a person decided on is the one
 * sent; a save can be undone at the versions in force after it.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GRAPH_VALUES, PLATFORM_VALUES } from '../__fixtures__/resolved'
import type { ResolvedValues } from '../types'
import { useStagedChanges } from '../useStagedChanges'

const DELETE = 'imports.guardDeleteShare'

function bump(values: ResolvedValues, key: string, version: number, graphValue: ResolvedValues[string]['effective'] | null) {
    const r = values[key]
    return {
        ...values,
        [key]: {
            ...r,
            version,
            effective: graphValue ?? r.effective,
            trail: r.trail.map((t) => (t.scope === 'graph' ? { ...t, value: graphValue } : t)),
        },
    }
}

describe('useStagedChanges', () => {
    it('stages a value, diffs it against the value in force, counts it, and drops it when put back', () => {
        const { result } = renderHook(() => useStagedChanges(GRAPH_VALUES, 'graph'))
        act(() => result.current.stage(DELETE, 0.25))
        expect(result.current.dirtyCount).toBe(1)
        expect(result.current.isStaged(DELETE)).toBe(true)
        expect(result.current.valueAt(DELETE)).toBe(0.25)
        expect(result.current.changes).toEqual([
            { key: DELETE, ownBefore: 0.3, ownAfter: 0.25, before: 0.3, after: 0.25, expectedVersion: 3 },
        ])
        act(() => result.current.stage(DELETE, 0.3))
        expect(result.current.dirtyCount).toBe(0)
        expect(result.current.valueAt(DELETE)).toBe(0.3)
    })

    it('stages null to inherit, and says what would then be in force', () => {
        const { result } = renderHook(() => useStagedChanges(GRAPH_VALUES, 'graph'))
        act(() => result.current.stage('reads.mode', null))
        expect(result.current.changes[0]).toMatchObject({ ownBefore: 'beside', ownAfter: null, before: 'in_place', after: 'latest' })
        expect(result.current.payload()).toEqual([{ key: 'reads.mode', value: null, expectedVersion: 3 }])
        expect(result.current.next['reads.mode']).toBe('latest')
        expect(result.current.current['reads.mode']).toBe('in_place')
    })

    it('unstages one change and resets them all', () => {
        const { result } = renderHook(() => useStagedChanges(GRAPH_VALUES, 'graph'))
        act(() => {
            result.current.stage(DELETE, 0.1)
            result.current.stage('imports.identifier', 'urn')
        })
        expect(result.current.dirtyCount).toBe(2)
        act(() => result.current.unstage(DELETE))
        expect(result.current.changes.map((c) => c.key)).toEqual(['imports.identifier'])
        act(() => result.current.reset())
        expect(result.current.dirtyCount).toBe(0)
    })

    it('sends the version first seen across re-edits, and takes the current one when re-applying after a conflict', () => {
        const { result, rerender } = renderHook(({ values }) => useStagedChanges(values, 'graph'), { initialProps: { values: GRAPH_VALUES } })
        act(() => result.current.stage(DELETE, 0.25))
        rerender({ values: bump(GRAPH_VALUES, DELETE, 7, 0.3) })
        act(() => result.current.stage(DELETE, 0.2))
        expect(result.current.expectedVersion(DELETE)).toBe(3)
        expect(result.current.payload()).toEqual([{ key: DELETE, value: 0.2, expectedVersion: 3 }])
        act(() => result.current.rebase())
        expect(result.current.payload()).toEqual([{ key: DELETE, value: 0.2, expectedVersion: 7 }])
    })

    it('remembers what a save changed, and builds the undo at the versions in force after it', () => {
        const { result, rerender } = renderHook(({ values }) => useStagedChanges(values, 'graph'), { initialProps: { values: GRAPH_VALUES } })
        act(() => result.current.stage(DELETE, 0.25))
        act(() => result.current.markSaved())
        expect(result.current.dirtyCount).toBe(0)
        expect(result.current.lastSaved?.map((c) => c.key)).toEqual([DELETE])
        // The page refetches: the saved value is now this graph's own, at a new version.
        rerender({ values: bump(GRAPH_VALUES, DELETE, 4, 0.25) })
        expect(result.current.undoPayload()).toEqual([{ key: DELETE, value: 0.3, expectedVersion: 4 }])
        act(() => result.current.clearUndo())
        expect(result.current.lastSaved).toBeNull()
    })

    it('ignores a key the scope does not have', () => {
        const { result } = renderHook(() => useStagedChanges(GRAPH_VALUES, 'graph'))
        act(() => result.current.stage('updates.pacingRatio', 1))
        expect(result.current.dirtyCount).toBe(0)
    })
})

describe('useStagedChanges: the platform’s limits', () => {
    const READS = 'reads.mode'
    const ALL = { allowed: ['latest', 'in_place', 'beside'] }

    it('stages limits beside a value, as one PATCH item per key, and drops limits put back as they were', () => {
        const { result } = renderHook(() => useStagedChanges(PLATFORM_VALUES, 'platform'))
        act(() => {
            result.current.stage(READS, 'in_place')
            result.current.stageLimits(READS, ALL)
        })
        expect(result.current.dirtyCount).toBe(2)
        expect(result.current.stagedLimits(READS)).toEqual(ALL)
        expect(result.current.limitChanges).toEqual([{ key: READS, ownBefore: null, ownAfter: ALL, before: { allowed: ['latest', 'in_place'] }, expectedVersion: 1 }])
        expect(result.current.payload()).toEqual([{ key: READS, value: 'in_place', limits: ALL, expectedVersion: 1 }])
        // The limits in force again (the defaults, in another order): nothing to save for them.
        act(() => result.current.stageLimits(READS, { allowed: ['in_place', 'latest'] }))
        expect(result.current.stagedLimits(READS)).toBeUndefined()
        expect(result.current.payload()).toEqual([{ key: READS, value: 'in_place', expectedVersion: 1 }])
    })

    it('stages limits alone, and back to the defaults (null) only when some are saved', () => {
        const { result } = renderHook(() => useStagedChanges(PLATFORM_VALUES, 'platform'))
        act(() => result.current.stageLimits('forks.maxPerGraph', { range: [0, 50] }))
        expect(result.current.payload()).toEqual([{ key: 'forks.maxPerGraph', limits: { range: [0, 50] }, expectedVersion: PLATFORM_VALUES['forks.maxPerGraph'].version }])
        act(() => result.current.stageLimits(READS, null))
        expect(result.current.stagedLimits(READS)).toBeUndefined()   // none saved: the defaults already apply
    })

    it('undoes saved limits at the versions in force after the save, and never below the platform', () => {
        const { result, rerender } = renderHook(({ values }) => useStagedChanges(values, 'platform'), { initialProps: { values: PLATFORM_VALUES } })
        act(() => result.current.stageLimits(READS, ALL))
        act(() => result.current.markSaved())
        rerender({ values: { ...PLATFORM_VALUES, [READS]: { ...PLATFORM_VALUES[READS], version: 5, limits: ALL } } })
        expect(result.current.undoPayload()).toEqual([{ key: READS, limits: null, expectedVersion: 5 }])

        const graph = renderHook(() => useStagedChanges(GRAPH_VALUES, 'graph'))
        act(() => graph.result.current.stageLimits(READS, ALL))
        expect(graph.result.current.dirtyCount).toBe(0)
    })
})
