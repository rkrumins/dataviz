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
 *   * TWO dispatch lanes over one compile step. The debounced lane skips
 *     a predicate whose hash is already the one that ran — otherwise
 *     Enter, plus the debounce landing 300 ms behind it, costs two
 *     identical queries. The explicit lane (Enter) never skips: pressing
 *     Enter on unchanged text means "ask again", and after a failed run
 *     it is the only way back (`runState` holds the failed hash). The
 *     panel's own Run button is unguarded for the same reason;
 *   * the panel opening itself on the first results for a query — and not
 *     again, so a user who closes it can keep it closed while later pages
 *     of the same query arrive.
 *
 * `clearOnUnmount: false` is what keeps highlights on the canvas after the
 * panel closes. They end when the query is cleared or the view changes:
 * `teardown` does both, because this hook does NOT remount on a view
 * switch — the canvas route is not keyed on the view id, so a switch that
 * only cleared highlights would leave the box, the pipeline and the
 * panel's auto-open memory holding the previous view's search.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import {
    useAdvancedSearch,
    type PanelView,
    type UseAdvancedSearchResult,
} from '@/hooks/useAdvancedSearch'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useSearchStore } from '@/store/searchStore'
import type { Predicate, SearchHit } from '@/types/search'
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


/**
 * Compile a quick query into what the pipeline runs, plus its hash.
 *
 * Routed through `buildRunnablePredicate` — the same function QueryCard
 * uses — so the hash is the identical string on both surfaces: that is
 * what lets the debounced lane recognise its own running query, and what
 * keeps QueryCard's auto-run quiet once the session has committed the
 * draft it just ran.
 */
function runnableFor(
    q: QuickQuery,
    minLength: number,
): { predicate: Predicate; hash: string } | null {
    return buildRunnablePredicate(buildQuickPredicate(q, minLength))
}


/**
 * Whether the panel has anything to show BESIDES the builder — a running
 * skeleton, result rows, or an error card.
 *
 * Exported because two rules depend on it and must not disagree: the
 * builder may only be collapsed when this is true, and the chip that
 * collapses it is only offered when it is. Split across two files with
 * two hand-written conditions, they drifted once already — the chip was
 * offered over a state that refused to collapse.
 */
export function hasReportableView(view: PanelView): boolean {
    return view.kind === 'running'
        || view.kind === 'results'
        || view.kind === 'error'
}


/**
 * The slice of the session a LAYER COLUMN reads.
 *
 * Split off the session for one reason: a column memoises an O(rows)
 * flat tree — and, on top of it, the navigable index, the visible count
 * and the density buckets — on whatever it reads out of the search. The
 * session object changes identity on every character typed in the
 * header, so reading THAT rebuilt every column on the board per
 * keystroke, with no row box open anywhere.
 *
 * This value is referentially STABLE for as long as the search is
 * view-wide: everything a column would react to is null until a box
 * actually clamps the session to a container. When one has, it changes
 * exactly when the column's answer changes — the text, and the page the
 * hit rows are read off.
 */
export interface ViewRowSearch {
    /** The container the search is clamped to, or null while it is
     *  view-wide. The row whose URN this names is the row whose box is
     *  open. */
    scope: Exclude<QuickScope, 'view'> | null
    /** The query itself — for the local name filter — and only while it
     *  is scoped. Null is not "no query": it is "no query this column
     *  has any business filtering on". */
    quick: QuickQuery | null
    /** Whether the standing result answers `quick`. See the session's
     *  own field: a column that splices hit rows in beside real ones has
     *  to ask this before it draws any. */
    resultMatchesQuick: boolean
    /** The pipeline's view, so the column can read the hits inside its
     *  container off the current result page. Scoped only, for the same
     *  reason. */
    view: PanelView | null

    /** Open or retarget the scope — what a row box does when it is typed
     *  into. Identity-stable. */
    setQuick: (partial: Partial<QuickQuery>) => void
    /** Unclamp — what emptying or closing a row box does. */
    clearScope: () => void
    /** "See all in panel", from the overflow row under a container. */
    openPanel: () => void
}


export interface ViewSearchSessionOptions {
    viewId: string
    layers: ViewLayerConfig[]
    assignments: Record<string, LayerAssignmentEntry>
}

export interface ViewSearchSession {
    /** The view every query in this session is scoped to. The surfaces
     *  that need it — the header's property-key menu — read it here
     *  rather than reaching for the schema store on their own. */
    viewId: string
    /** What the header box holds right now. */
    quick: QuickQuery
    /** Patch one or more fields; a text change starts the debounce. */
    setQuick: (partial: Partial<QuickQuery>) => void
    /** Enter: run what's in the box now, single characters included, and
     *  unconditionally — including a re-run of a query that just failed. */
    runNow: () => void
    /** The × : abort, drop the results, the highlights and the draft, and
     *  empty the box. The same teardown a view switch performs. */
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
    /** Put the builder away without closing the panel — the panel's own
     *  Refine chip is a toggle, and `closePanel` would take the results
     *  with it. */
    closeRefine: () => void

    /** The header input, so `/` and Esc can focus it from anywhere. */
    inputRef: RefObject<HTMLInputElement | null>
    /**
     * Whether the results now standing are the answer to what is in the box.
     *
     * A result set outlives the query that produced it: the box keeps taking
     * keystrokes, and the debounced lane deliberately ignores anything under
     * two characters. So "there are results" and "these results answer this
     * box" are different questions, and any surface that splices hits in
     * beside real rows — the row-level box does — has to ask the second one.
     * The header only ever reports a count, so it can live with the first.
     */
    resultMatchesQuick: boolean

    /** Which layer column a hit badges under, for this view's layout. */
    resolveLayer: (hit: SearchHit) => string | null
    /** The view's layer columns, in board order. `resolveLayer` answers
     *  WHICH layer; the panel's grouping also needs the name and the
     *  order to render, and reading the layout a second time from the
     *  schema store is how the two would drift. */
    layers: ViewLayerConfig[]

    /**
     * The pipeline underneath, whole.
     *
     * Not a curated subset: the header renders `view`, and the panel needs
     * `runState` for its own same-hash defence plus the template surface
     * (`isIdle`, `selectTemplate`, `setInput`, `run`, `runTemplate`,
     * `resetTemplate`) that it destructures from its own hook instance
     * today. Handing it `session.advanced` wholesale is what lets it stop
     * running a second search of its own.
     */
    advanced: UseAdvancedSearchResult

    /**
     * What the layer columns read, on its own context.
     *
     * Exposed here so the canvas can provide both from one hook, but a
     * column must never reach it through the session: consuming the
     * session is exactly the subscription this exists to avoid.
     */
    rowSearch: ViewRowSearch
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

    // Which query the panel has already opened itself for. A result set
    // is published on every page of a query, and the user's close must
    // survive them.
    const autoOpenedHashRef = useRef<string | null>(null)

    const teardown = useCallback(() => {
        // `resetTemplate` is the pipeline's own teardown: it aborts the
        // in-flight request, drops the run state and rewinds the view to
        // idle. Plain `cancel` leaves `view.kind === 'results'`, so the
        // header would keep reporting a match count for a query that is
        // gone.
        advancedRef.current.resetTemplate()
        // What the session itself published: the draft it commits on every
        // dispatch, and the highlights on the canvas.
        useSearchStore.getState().clear()
        setQuickState(DEFAULT_QUICK)
        // Whatever comes next is a fresh query as far as the panel is
        // concerned, even when it hashes to the same string.
        autoOpenedHashRef.current = null
        // Same rule `openPanel` applies, applied to the state this just
        // produced: there are no results any more, so a panel still open
        // has nothing to report on and the builder is its only content.
        setRefineOpen(true)
    }, [])

    // A view switch is a teardown, not just an un-highlight: this hook
    // does not remount when the canvas swaps views, so everything above
    // would otherwise still describe the view the user just left.
    useEffect(() => () => { teardown() }, [viewId, teardown])

    const dispatch = useCallback((runnable: { predicate: Predicate; hash: string }) => {
        useSearchStore.getState().commitDraft(runnable.predicate)
        void advancedRef.current.runPredicate(runnable.predicate, SEARCH_OPTIONS)
    }, [])

    const debouncedQuick = useDebouncedValue(quick, DEBOUNCE_MS)
    useEffect(() => {
        const runnable = runnableFor(debouncedQuick, QUICK_MIN_LENGTH)
        // The debounced lane — and ONLY this lane — skips a query that is
        // already the running one: Enter, then the debounce landing 300 ms
        // behind it, would otherwise ask the server the same thing twice.
        if (!runnable || advancedRef.current.runState?.hash === runnable.hash) return
        dispatch(runnable)
    }, [debouncedQuick, dispatch])

    const runNow = useCallback(() => {
        // Deliberately unguarded. Enter on unchanged text means "ask
        // again" — and after a failure it is the only way back, since
        // `runState` then holds that very hash with status 'failed'.
        const runnable = runnableFor(quick, EXPLICIT_MIN_LENGTH)
        if (runnable) dispatch(runnable)
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

    // EXPLICIT_MIN_LENGTH, not the debounce's floor: the question is whether
    // the standing result answers this box, and a single character that
    // Enter actually ran is a legitimate yes.
    const runStateHash = advanced.runState?.hash
    const resultMatchesQuick = useMemo(() => {
        const runnable = runnableFor(quick, EXPLICIT_MIN_LENGTH)
        // Never compare the two sides directly. With an empty box and no run
        // both are undefined, and `undefined === undefined` would hand every
        // consumer a standing result for a query that does not exist.
        return runnable !== null && runStateHash === runnable.hash
    }, [quick, runStateHash])

    const resultsHash = advanced.view.kind === 'results'
        ? (advanced.runState?.hash ?? null)
        : null
    useEffect(() => {
        if (resultsHash === null || autoOpenedHashRef.current === resultsHash) return
        autoOpenedHashRef.current = resultsHash
        setPanelOpen(true)
    }, [resultsHash])

    // Opening decides what the panel opens ON, once, here — rather than
    // the panel deriving it from "are there results right now?". That
    // derivation had the builder unmount mid-word: on a cold open it
    // showed only because no results existed yet, and the first thing the
    // user typed auto-ran 250 ms later and took it away.
    // Deliberately NOT `hasReportableView`: opening asks "is there an
    // answer to open ON?", and a query still running is not one yet —
    // the user who just hit ⌘⇧F should land on the builder, not on a
    // skeleton. Collapsing asks the weaker "will anything remain?".
    const openPanel = useCallback(() => {
        setPanelOpen(true)
        setRefineOpen(advancedRef.current.view.kind !== 'results')
    }, [])
    const closePanel = useCallback(() => {
        setPanelOpen(false)
        // Refine is a mode of the open panel, not a state of its own.
        setRefineOpen(false)
    }, [])
    // Routed through the two above so "closing clears Refine" lives in one
    // place — ⌘⇧F is bound here, so this is a common way the panel closes.
    const togglePanel = useCallback(() => {
        if (panelOpen) closePanel()
        else openPanel()
    }, [panelOpen, closePanel, openPanel])
    const refine = useCallback(() => {
        setPanelOpen(true)
        setRefineOpen(true)
    }, [])
    const closeRefine = useCallback(() => {
        // Collapsing has to leave something behind. Before the first run,
        // after a Clear and after a view switch the builder IS the panel:
        // putting it away would blank the rail, and the chip that did it
        // would be the only way back.
        if (!hasReportableView(advancedRef.current.view)) return
        setRefineOpen(false)
    }, [])

    const resolveLayer = useCallback((hit: SearchHit) => resolveHitLayer(
        hit.node,
        hit.ancestorPath ?? [],
        assignments,
        layers,
    ), [assignments, layers])

    // The columns' slice. Every scoped field collapses to a constant
    // while the search is view-wide, so this whole object keeps its
    // identity across a header keystroke — and across the results that
    // keystroke brings back.
    const rowScope = quick.scope === 'view' ? null : quick.scope
    const scopedQuick = rowScope ? quick : null
    const scopedView = rowScope ? advanced.view : null
    const scopedMatches = rowScope ? resultMatchesQuick : false
    const rowSearch = useMemo<ViewRowSearch>(() => ({
        scope: rowScope,
        quick: scopedQuick,
        resultMatchesQuick: scopedMatches,
        view: scopedView,
        setQuick, clearScope, openPanel,
    }), [rowScope, scopedQuick, scopedMatches, scopedView, setQuick, clearScope, openPanel])

    return useMemo(() => ({
        viewId,
        quick, setQuick, runNow, clearQuery: teardown, setScope, clearScope,
        panelOpen, openPanel, closePanel, togglePanel,
        refineOpen, refine, closeRefine,
        resultMatchesQuick,
        inputRef, resolveLayer, layers,
        advanced, rowSearch,
    }), [
        viewId,
        quick, setQuick, runNow, teardown, setScope, clearScope,
        panelOpen, openPanel, closePanel, togglePanel,
        refineOpen, refine, closeRefine, resultMatchesQuick,
        resolveLayer, layers, advanced, rowSearch,
    ])
}
