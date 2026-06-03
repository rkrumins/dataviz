/**
 * usePendingSearchRun — the "Open in Advanced Search + run" bridge.
 *
 * An external surface (the Property Manager's value clicks / quick-action
 * cards) calls ``searchStore.requestSearchRun(predicate)``, which seeds the
 * draft (so the builder shows + can edit it) and sets ``pendingRunPredicate``.
 * The surface then opens the panel. This hook — mounted inside the panel —
 * consumes that flag and runs the predicate through the real engine
 * (``useAdvancedSearch.runPredicate``) once, so the constructed query
 * executes and spotlights the matches regardless of run mode.
 *
 * Why the macrotask defer (not a plain synchronous consume): on the FIRST
 * open the canvas seeds the draft + flag and THEN mounts the panel.
 * ``useAdvancedSearch``'s unmount cleanup ``abort()``s any in-flight run and
 * ``clear()``s the store (wiping the seeded draft). Under React StrictMode
 * (dev) the panel is probed mount→unmount→mount, so that destructive cleanup
 * fires BETWEEN the two mounts. A synchronous consume on the first mount
 * would burn the one-shot flag and start a run the cleanup immediately
 * aborts, leaving the surviving mount with a null flag and an empty draft —
 * the "first click searches nothing, second click works" race.
 *
 * Deferring to a ``setTimeout(0)`` and cancelling it in the effect cleanup
 * fixes this: the probe's cleanup cancels the pre-churn attempt, so only the
 * settled mount consumes the flag, re-seeds the draft (which ``clear()`` may
 * have wiped), and runs. Correct in dev (StrictMode) and prod (runs once).
 */
import { useEffect } from 'react'

import { useSearchStore } from '@/store/searchStore'
import type { Predicate, SearchQuery } from '@/types/search'


/** Hits-only run options so a Property-Manager value click renders the
 *  individual matches, not a single aggregate bucket. Mirrors the options
 *  the visual builder uses for a free-form run. */
const BRIDGE_RUN_OPTIONS: SearchQuery['options'] = {
    results: 'hits',
    pageSize: 5000,
    includeAncestorPath: true,
}


export function usePendingSearchRun(
    runPredicate: (predicate: Predicate, options?: SearchQuery['options']) => Promise<void>,
    commitDraft: (predicate: Predicate) => void,
): void {
    const pendingRunPredicate = useSearchStore((s) => s.pendingRunPredicate)
    useEffect(() => {
        if (!pendingRunPredicate) return
        const t = setTimeout(() => {
            const p = useSearchStore.getState().consumePendingRun()
            if (!p) return
            commitDraft(p)
            void runPredicate(p, BRIDGE_RUN_OPTIONS)
        }, 0)
        return () => clearTimeout(t)
    }, [pendingRunPredicate, runPredicate, commitDraft])
}
