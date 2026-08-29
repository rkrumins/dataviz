/**
 * The one search session a canvas owns.
 *
 * ContextViewCanvas calls this hook and puts the result on
 * `ViewSearchSessionContext`; the header box, the layer columns and the
 * results panel read the same object back through that module's
 * `useViewSearchSession()`. Hence "controller": this side BUILDS the
 * session, the context side READS it. One session means one query,
 * one result set and one set of highlights — the header box and the panel
 * can no longer disagree about what was searched.
 *
 * It **composes** `useAdvancedSearch` rather than re-running its pipeline:
 * that hook already aborts superseded requests, ignores late responses,
 * pages the cursor and publishes to the search store. What lives here is
 * everything above it:
 *
 *   * the quick query (`quickPredicate.ts`) and its 300 ms debounce;
 *   * `commitDraft` of the very predicate it dispatches, so Refine opens
 *     on the identical condition row and QueryCard's own auto-run stays
 *     quiet (it compares the same hash);
 *   * the run-once guard: Enter and the debounce landing behind it would
 *     otherwise cost two identical queries;
 *   * the panel opening itself on the first results for a query — and not
 *     again, so a user who closes it can keep it closed while later pages
 *     of the same query arrive.
 *
 * `clearOnUnmount: false` is what keeps highlights on the canvas after the
 * panel closes. They end when the query is cleared or the view changes —
 * hence the teardown effect keyed on `viewId`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import {
    useAdvancedSearch,
    type PanelView,
    type UseAdvancedSearchResult,
} from '@/hooks/useAdvancedSearch'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useSearchStore } from '@/store/searchStore'
import type { SearchHit } from '@/types/search'
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'

import { buildRunnablePredicate } from '../panel/runnablePredicate'
import { SEARCH_OPTIONS } from '../searchOptions'

import {
    DEFAULT_QUICK,
    QUICK_MIN_LENGTH,
    buildQuickPredicate,
    type QuickQuery,
    type QuickScope,
} from './quickPredicate'
import { resolveHitLayer } from './resolveHitLayer'


/** Long enough that a typed word is one request, short enough that the
 *  results feel like they belong to the keystroke that asked for them. */
const DEBOUNCE_MS = 300

/** Enter's floor: anything the user actually typed, run once, on purpose. */
const EXPLICIT_MIN_LENGTH = 1


export interface ViewSearchSessionOptions {
    viewId: string
    layers: ViewLayerConfig[]
    assignments: Record<string, LayerAssignmentEntry>
}

export interface ViewSearchSession {
    /** What the header box holds right now. */
    quick: QuickQuery
    /** Patch one or more fields; a text change starts the debounce. */
    setQuick: (partial: Partial<QuickQuery>) => void
    /** Enter: run what's in the box now, single characters included. */
    runNow: () => void
    /** The × : abort, drop the results and the draft, empty the box. */
    clearQuery: () => void
    /** Clamp the search to one container (the row box, a result group). */
    setScope: (scope: Exclude<QuickScope, 'view'>) => void
    clearScope: () => void

    panelOpen: boolean
    openPanel: () => void
    closePanel: () => void
    togglePanel: () => void
    /** Whether the panel should show the builder (QueryCard) as well. */
    refineOpen: boolean
    /** The sparkles chip: open the panel on the builder. */
    refine: () => void

    /** The header input, so `/` and Esc can focus it from anywhere. */
    inputRef: RefObject<HTMLInputElement | null>
    /** Which layer column a hit badges under, for this view's layout. */
    resolveLayer: (hit: SearchHit) => string | null

    // The pipeline underneath, for the surfaces that render its state.
    view: PanelView
    runPredicate: UseAdvancedSearchResult['runPredicate']
    loadMore: () => Promise<void>
    isLoadingMore: boolean
    cancel: () => void
}


export function useViewSearchSessionController(
    { viewId, layers, assignments }: ViewSearchSessionOptions,
): ViewSearchSession {
    const advanced = useAdvancedSearch(viewId, { clearOnUnmount: false })
    const [quick, setQuickState] = useState<QuickQuery>(DEFAULT_QUICK)
    const [panelOpen, setPanelOpen] = useState(false)
    const [refineOpen, setRefineOpen] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

    // Read the pipeline through a ref so `dispatch` can stay
    // identity-stable. It must: the debounce effect depends on it, and an
    // effect that re-fired whenever the run state changed would
    // re-dispatch the query the user had just cleared. Synced in an
    // effect declared BEFORE that one, so a dispatch always sees the
    // pipeline as of the render it is reacting to.
    const advancedRef = useRef(advanced)
    useEffect(() => { advancedRef.current = advanced })

    // Highlights outlive the panel, but not the view — a canvas that
    // swaps views (or goes away) leaves nothing lit behind it.
    useEffect(() => () => { useSearchStore.getState().clear() }, [viewId])

    const dispatch = useCallback((q: QuickQuery, minLength: number) => {
        // Route through buildRunnablePredicate so the hash is computed
        // exactly the way QueryCard computes it — same string, same
        // skip decision on both surfaces.
        const runnable = buildRunnablePredicate(buildQuickPredicate(q, minLength))
        if (!runnable) return
        if (advancedRef.current.runState?.hash === runnable.hash) return
        useSearchStore.getState().commitDraft(runnable.predicate)
        void advancedRef.current.runPredicate(runnable.predicate, SEARCH_OPTIONS)
    }, [])

    const debouncedQuick = useDebouncedValue(quick, DEBOUNCE_MS)
    useEffect(() => {
        dispatch(debouncedQuick, QUICK_MIN_LENGTH)
    }, [debouncedQuick, dispatch])

    const runNow = useCallback(() => {
        dispatch(quick, EXPLICIT_MIN_LENGTH)
    }, [dispatch, quick])

    const setQuick = useCallback((partial: Partial<QuickQuery>) => {
        setQuickState((prev) => ({ ...prev, ...partial }))
    }, [])

    const setScope = useCallback((scope: Exclude<QuickScope, 'view'>) => {
        setQuickState((prev) => ({ ...prev, scope }))
    }, [])

    const clearScope = useCallback(() => {
        setQuickState((prev) => ({ ...prev, scope: 'view' }))
    }, [])

    // Which query the panel has already opened itself for. A result set
    // is published on every page of a query, and the user's close must
    // survive them.
    const autoOpenedHashRef = useRef<string | null>(null)
    const resultsHash = advanced.view.kind === 'results'
        ? (advanced.runState?.hash ?? null)
        : null
    useEffect(() => {
        if (resultsHash === null || autoOpenedHashRef.current === resultsHash) return
        autoOpenedHashRef.current = resultsHash
        setPanelOpen(true)
    }, [resultsHash])

    const openPanel = useCallback(() => { setPanelOpen(true) }, [])
    const closePanel = useCallback(() => {
        setPanelOpen(false)
        // Refine is a mode of the open panel, not a state of its own.
        setRefineOpen(false)
    }, [])
    const togglePanel = useCallback(() => { setPanelOpen((open) => !open) }, [])
    const refine = useCallback(() => {
        setPanelOpen(true)
        setRefineOpen(true)
    }, [])

    const clearQuery = useCallback(() => {
        // `resetTemplate` is the pipeline's full teardown: it aborts the
        // in-flight request, clears the published result-set and the
        // draft, and rewinds the view to idle. Plain `cancel` leaves
        // `view.kind === 'results'`, so the header would keep reporting a
        // match count for a query the user had just cleared.
        advancedRef.current.resetTemplate()
        // The session owns the draft it commits on every dispatch, so it
        // drops it here rather than leaning on the teardown above to do
        // it — clearing the box must not leave Refine holding a query
        // that is no longer running.
        useSearchStore.getState().commitDraft(null)
        setQuickState(DEFAULT_QUICK)
        // The next results are a fresh query as far as the panel is
        // concerned, even when the user retypes the same word.
        autoOpenedHashRef.current = null
    }, [])

    const resolveLayer = useCallback((hit: SearchHit) => resolveHitLayer(
        hit.node,
        hit.ancestorPath ?? [],
        assignments,
        layers,
    ), [assignments, layers])

    return useMemo(() => ({
        quick, setQuick, runNow, clearQuery, setScope, clearScope,
        panelOpen, openPanel, closePanel, togglePanel,
        refineOpen, refine,
        inputRef, resolveLayer,
        view: advanced.view,
        runPredicate: advanced.runPredicate,
        loadMore: advanced.loadMore,
        isLoadingMore: advanced.isLoadingMore,
        cancel: advanced.cancel,
    }), [
        quick, setQuick, runNow, clearQuery, setScope, clearScope,
        panelOpen, openPanel, closePanel, togglePanel,
        refineOpen, refine, resolveLayer,
        advanced.view, advanced.runPredicate, advanced.loadMore,
        advanced.isLoadingMore, advanced.cancel,
    ])
}
