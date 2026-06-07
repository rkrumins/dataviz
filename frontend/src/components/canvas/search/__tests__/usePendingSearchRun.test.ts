/**
 * usePendingSearchRun — the "Open in Advanced Search + run" bridge.
 *
 * Regression coverage for the first-click race: the dispatch MUST be
 * deferred past the panel's mount churn (React StrictMode's
 * mount→unmount→mount probe, and the destructive ``useAdvancedSearch``
 * unmount cleanup that runs between the two mounts on first open). A
 * synchronous consume burned the one-shot flag on the doomed first mount,
 * so the surviving mount searched nothing — only the SECOND click worked.
 */
import { StrictMode } from 'react'
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { usePendingSearchRun } from '../usePendingSearchRun'
import { useSearchStore } from '@/store/searchStore'
import type { Predicate } from '@/types/search'


const P: Predicate = { kind: 'hasProperty', key: 'transformLogic', negate: false }

beforeEach(() => {
    useSearchStore.setState({ pendingRunPredicate: null, draftPredicate: null })
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})


describe('usePendingSearchRun', () => {
    it('defers past the mount probe, then runs once and re-seeds the draft', () => {
        const runPredicate = vi.fn().mockResolvedValue(undefined)
        const commitDraft = vi.fn()
        useSearchStore.setState({ pendingRunPredicate: P })

        renderHook(() => usePendingSearchRun(runPredicate, commitDraft), { wrapper: StrictMode })

        // Effects have flushed (including StrictMode's mount→unmount→mount
        // probe) but the dispatch is deferred to a macrotask: the one-shot
        // flag is NOT yet consumed and nothing has run. A synchronous consume
        // would have burned the flag here — losing it across the remount.
        expect(runPredicate).not.toHaveBeenCalled()
        expect(useSearchStore.getState().pendingRunPredicate).toEqual(P)

        act(() => { vi.runAllTimers() })

        // Exactly once — the probe's cleanup cancelled the doomed first
        // attempt's timer, so only the settled mount dispatches.
        expect(runPredicate).toHaveBeenCalledTimes(1)
        expect(runPredicate.mock.calls[0][0]).toEqual(P)
        expect(runPredicate.mock.calls[0][1]).toMatchObject({
            results: 'hits', pageSize: 5000, includeAncestorPath: true,
        })
        // Re-seeds the builder (clear() may have wiped the seeded draft
        // between the probe's two mounts).
        expect(commitDraft).toHaveBeenCalledWith(P)
        // Flag consumed exactly once.
        expect(useSearchStore.getState().pendingRunPredicate).toBeNull()
    })

    it('does nothing when there is no pending predicate', () => {
        const runPredicate = vi.fn().mockResolvedValue(undefined)
        const commitDraft = vi.fn()

        renderHook(() => usePendingSearchRun(runPredicate, commitDraft), { wrapper: StrictMode })
        act(() => { vi.runAllTimers() })

        expect(runPredicate).not.toHaveBeenCalled()
        expect(commitDraft).not.toHaveBeenCalled()
    })
})
