/**
 * Cross-component result-set state for advanced search.
 *
 * The SearchMapPanel hook is the sole writer — on every successful
 * search, it publishes the set of matched node URNs (plus a stable
 * query hash) so that components OUTSIDE the panel can react:
 *
 *   - ContextViewCanvas applies a `.search-match` outline to visible
 *     matches (W3 — useSearchHighlight).
 *   - SearchPinOverlay renders pins for off-screen matches anchored
 *     to their nearest visible ancestor (W3).
 *   - ChevronMatchBadge shows `[N matches inside]` on collapsed
 *     ancestors that contain matches (W3 — derived via
 *     useContainmentHierarchy.descendantHasMatch).
 *
 * The panel's internal UI state machine (idle → templateSelected →
 * running → results) stays in `useAdvancedSearch` — that's panel-
 * private. Only the cross-cutting "what URNs matched the last query?"
 * lives here.
 */
import { useMemo } from 'react'
import { create } from 'zustand'

import type { AggregationSpec, AncestorRef, Predicate } from '@/types/search'


/**
 * Options the builder passes into ``runPredicate`` (formerly hardcoded
 * inside ``useAdvancedSearch``). Templates set their own options via
 * ``SearchTemplate.build``; this is for the visual-builder / JSON-editor
 * authoring flow.
 *
 * The defaults are exposed as ``DEFAULT_DRAFT_OPTIONS`` so the OptionsPanel
 * can render a reset affordance and so the runner can fall back to them
 * when ``draftOptions`` is ``null``.
 */
export interface DraftOptions {
    aggregations: AggregationSpec[]
    pageSize: number
    candidateCap: number
    includeAncestorPath: boolean
}

export const DEFAULT_DRAFT_OPTIONS: DraftOptions = {
    // No default aggregation — when a builder or free-form query
    // returns N matches, the user wants to SEE the N matches, not a
    // single "1 group · N items" bucket that hides every entity name
    // until they drill in. Templates that genuinely want aggregation
    // (e.g. "Overview by entity type") set their own ``options`` in
    // ``SearchTemplate.build`` and bypass this default entirely.
    aggregations: [],
    pageSize: 50,
    candidateCap: 5000,
    includeAncestorPath: true,
}


/**
 * One validation issue reported by the visual builder's reducer.
 * Mirrors ``ValidationIssue`` from ``useBuilderReducer`` — we re-export
 * the shape here so consumers outside the builder (the new QueryFooter)
 * can read it without depending on the reducer module.
 */
export interface BuilderValidationIssue {
    path: readonly number[]
    message: string
    severity: 'error' | 'warn'
}


/**
 * One entry in the per-view "Recent queries" list. Auto-saved on every
 * successful dispatch. Loadable by click from the empty hero and the
 * LibraryPopover's "Mine" tab.
 *
 * ``pinned`` entries don't count toward the 10-unpinned cap and are
 * never auto-evicted — that's the implicit "save this query" mechanism
 * for users who want to keep a query around without an explicit naming
 * dialog. ``label`` is the DSL form (``stringifyPredicate`` output)
 * computed at save-time so re-rendering doesn't need to walk the tree.
 */
export interface RecentQueryEntry {
    viewId: string
    predicate: Predicate
    /** Human-readable DSL form, derived via stringifyPredicate at save-time. */
    label: string
    /** Unix-ms when this entry was saved. Also the stable id used by
     *  togglePin / remove actions — collisions are impossible at ms
     *  resolution unless two dispatches land in the same ms, which the
     *  caller's addRecent dedupe path handles anyway. */
    timestamp: number
    pinned: boolean
    /** Origin marker. ``'recent'`` (default) = auto-captured on
     *  dispatch. ``'mine'`` = explicitly saved by the user via the
     *  Library popover's "Save as…" action; rendered with ``name``
     *  instead of ``label`` and never auto-evicted. */
    source?: 'recent' | 'mine'
    /** Human-readable name supplied via "Save as…" (only set when
     *  ``source === 'mine'``). Replaces the DSL ``label`` in the UI. */
    name?: string
    /** Optional one-line description supplied via "Save as…" (only set
     *  when ``source === 'mine'``). Shown as secondary text. */
    description?: string
}


/**
 * How the canvas should treat the current search results visually.
 *
 *   highlight  — Default. Direct matches pulse + bright; ancestors
 *                stay bright; everything else dims to opacity-40.
 *                This is the behavior that shipped with the original
 *                Advanced Search.
 *   isolate    — Render ONLY direct matches and their ancestor spine;
 *                hide everything unrelated. Useful when the user wants
 *                a clean view of just the matches without visual
 *                noise from the rest of the graph.
 *   hide       — Inverse: hide the matched nodes, render everything
 *                else. Useful for "show me what does NOT match" flows
 *                (e.g. "find tables without owners" → hide the
 *                tables with owners to focus on the gaps).
 */
export type CanvasFilterMode = 'highlight' | 'isolate' | 'hide'


interface SearchStoreState {
    /**
     * The view this result set belongs to. When the panel is closed or
     * the user has not run a search yet, this is null.
     */
    viewId: string | null
    /**
     * The set of node URNs matched by the most recent successful
     * search. Includes URNs from `hits[]` AND from each
     * aggregate bucket's `sampleHits` (so aggregate-only mode still
     * highlights its preview hits on the canvas). Empty when no
     * search is active.
     */
    matchUrnSet: ReadonlySet<string>
    /**
     * A stable identifier for the current query. Lets consumers detect
     * "same result set as last time" without diffing the URN set. We
     * use JSON.stringify of the SearchQuery — deterministic within a
     * runtime; collisions across runtimes are irrelevant for this
     * purpose.
     */
    queryHash: string | null
    /**
     * The predicate currently being authored. Single source of truth
     * shared across the visual builder, the JSON editor, and templates.
     *
     * - Visual builder mirrors its reducer tree here on every change.
     * - JSON editor reads from here and writes back on valid edits.
     * - Templates write here via ``seedDraftPredicate`` when the user
     *   picks one or customises it.
     *
     * ``null`` means "no draft yet — show the empty-state hero in the
     * builder, blank textarea in the JSON editor".
     */
    draftPredicate: Predicate | null
    /**
     * Monotonic counter incremented whenever ``draftPredicate`` is
     * REPLACED from outside the visual builder (e.g. by a template
     * seed or a JSON-editor commit). The builder's effect uses this to
     * decide whether to call ``loadSeed`` and reset its reducer tree.
     * Changes that originate INSIDE the builder bump the value, but
     * the builder's effect ignores its own writes by tracking the
     * counter it last applied.
     */
    draftRevision: number
    /**
     * Per-request options (aggregation, page size, candidate cap,
     * include-ancestor-path) the visual builder / JSON editor flow uses
     * when calling the backend. ``null`` means "use defaults".
     *
     * Templates supply their own options via ``SearchTemplate.build`` and
     * therefore ignore this field — only ``runPredicate`` reads it.
     */
    draftOptions: DraftOptions | null
    /**
     * Validation issues emitted by the builder reducer on every change.
     * Mirrored into the store so the QueryFooter (which is rendered by
     * the panel shell, not the builder) can gate the Run button without
     * re-deriving the issue set.
     *
     * Empty when there is no draft, or when the tree validates cleanly.
     */
    builderValidation: ReadonlyArray<BuilderValidationIssue>
    /**
     * For every node URN that's an ancestor of one or more matches,
     * the total number of matches sitting anywhere in its subtree.
     *
     * Derived from each hit's ``ancestorPath``: a single hit contributes
     * +1 to every UNIQUE ancestor URN on its path. This is the "[N
     * matches inside]" count rendered as a chevron badge on collapsed
     * canvas nodes — the badge value reflects the FULL subtree count,
     * not just the immediate children, so a domain can show "47" even
     * when matches sit four levels deep inside its containers.
     */
    ancestorMatchCounts: ReadonlyMap<string, number>
    /**
     * For every ancestor URN, a per-entityType breakdown of the matching
     * descendants. The inner map keys are leaf hit entity types
     * (``schemaField``, ``dataset``, …) and values are counts. Lets the
     * canvas badge surface ``"3 inside · 2 fields, 1 dataset"`` instead
     * of a bare number, so a user can see at a glance what's matched
     * inside a collapsed container before expanding it.
     *
     * Derived from the same ancestor-path walk as ``ancestorMatchCounts``;
     * each unique (ancestor, leafEntityType) pair contributes +1 per hit.
     */
    ancestorMatchTypeBreakdowns: ReadonlyMap<string, ReadonlyMap<string, number>>
    /**
     * In-memory undo stack — snapshots of the draft taken at
     * meaningful structural boundaries (chip add/remove, clear,
     * paste-DSL commit, example seed, recent-query load). NOT bumped
     * on per-keystroke value edits inside ConditionRows — those use
     * the no-history ``seedDraftPredicate`` path.
     *
     * Capped at 50 entries; entries beyond that are dropped from the
     * oldest end. Resets when the panel unmounts (``clear`` clears it).
     */
    historyPast: ReadonlyArray<Predicate | null>
    /**
     * Symmetric redo stack. Cleared on every fresh ``commitDraft``
     * (any new structural change invalidates the redo path).
     */
    historyFuture: ReadonlyArray<Predicate | null>
    /**
     * Per-view rolling log of the queries the user has dispatched.
     * Last 10 unpinned per view + unbounded pinned. Persisted to
     * localStorage so they survive page reloads.
     */
    recentQueries: ReadonlyArray<RecentQueryEntry>

    /**
     * A predicate handed to the Advanced Search panel from OUTSIDE it
     * (e.g. the Property Manager's value clicks / quick actions). The
     * panel consumes it on mount/change and runs it through the real
     * search engine, so an external surface can "open + seed + run"
     * without owning the run pipeline. Cleared on consume.
     */
    pendingRunPredicate: Predicate | null

    /**
     * Scope mode for the next search run.
     *
     *   visible    — Only URNs currently rendered on the canvas. Fast
     *                feedback regardless of graph size, matches the
     *                user's mental model of "search what I see." The
     *                default.
     *   view       — The view's authorised root URNs + containment
     *                expansion. Searches everything in the view, even
     *                folders the user has collapsed.
     *   data_source — Entire data source. Power-user override; results
     *                may include URNs not in this view (the panel
     *                surfaces a disclaimer).
     */
    scopeMode: 'visible' | 'view' | 'data_source'

    /**
     * Row-selection state for the multi-select "Group selected as
     * AND / OR" affordance in the visual builder.
     *
     * ``selectionParent`` is a stable path key: ``''`` = root,
     * ``'0'`` = child at index 0 of root, ``'0/1'`` = the second
     * child of root's first group, etc. Selection is scoped to one
     * parent at a time — clicking a checkbox in a different parent
     * clears the prior selection and starts fresh. Reason: crossing
     * depths would mean rewriting tree topology, which is the
     * territory of drag-drop (deferred).
     *
     * Cleared automatically when ``draftPredicate`` changes (the
     * indices may no longer be valid after an edit).
     */
    selectionParent: string | null
    selectedIndices: ReadonlyArray<number>

    /**
     * Ordered list of matched URNs derived at ``setResult`` time from
     * the iterable passed by ``useAdvancedSearch``. Preserves the
     * backend hit order so the MatchBar stepper walks results in the
     * same order the user sees them in ``ResultsPane``.
     *
     * ``matchUrnSet`` (above) remains the source of truth for "is this
     * URN a match" lookups; this is purely the ordered companion used
     * by the prev/next stepper and ``focusedMatchIndex``.
     */
    orderedMatchUrns: ReadonlyArray<string>

    /**
     * Index into ``orderedMatchUrns`` of the match the user is currently
     * focused on via the MatchBar stepper or keyboard (J/K/↑/↓). Drives:
     *   - ResultsPane auto-scrolls the focused row into view.
     *   - useRevealSearchHit auto-fires for the focused URN.
     *   - The focused result row gets an additional pulse/highlight class.
     *
     * ``null`` means "nothing focused" — the initial state after a fresh
     * query and after ``clear()``. First press of the stepper / J / →
     * initializes to 0 (or -1 + step which becomes 0). Reset to ``null``
     * on every ``setResult`` so a new query doesn't carry over stale
     * focus.
     */
    focusedMatchIndex: number | null

    /**
     * How the canvas should treat search matches visually. See the
     * ``CanvasFilterMode`` doc for per-mode semantics. Persisted
     * per-view in localStorage so the user's preference survives panel
     * close/reopen and page reloads.
     *
     * Default ``'highlight'`` matches the behaviour that shipped with
     * the original Advanced Search.
     */
    canvasFilterMode: CanvasFilterMode
}


/**
 * Per-hit input to the ancestor rollup derivation. The leaf entity type
 * is needed alongside the path so the breakdown map can tally matches
 * by what kind of node sits at the end of each path.
 */
export interface AncestorPathInfo {
    path: ReadonlyArray<AncestorRef>
    leafEntityType: string
}

/**
 * One bucket of the server's ``ancestor`` aggregation: an exact match
 * count for a single ancestor URN, with an optional per-entityType
 * breakdown (from ``bucket.typeCounts``). Passed to ``setResult`` on top
 * of the page-derived ``ancestorPaths`` rollup.
 */
export interface AncestorCountInfo {
    urn: string
    count: number
    breakdown?: ReadonlyMap<string, number>
}

interface SearchStoreActions {
    setResult: (input: {
        viewId: string
        matchUrns: Iterable<string>
        /** Per-hit ancestor info (path + the entityType of the hit at the
         *  end of that path). Used to derive both ``ancestorMatchCounts``
         *  and ``ancestorMatchTypeBreakdowns`` so the canvas can surface
         *  roll-up counts AND a per-type breakdown on collapsed nodes.
         *  Ancestors ``ancestorCounts`` doesn't cover keep these values. */
        ancestorPaths?: Iterable<AncestorPathInfo>
        /** Exact per-ancestor match counts from the server's ``ancestor``
         *  aggregation. When provided, each entry OVERRIDES that URN's
         *  page-derived rollup — the aggregation covers every match in
         *  the view, not just the hits on the current page, so it stays
         *  correct across ``loadMore``. An entry with no ``breakdown``
         *  clears that URN's, rather than leaving a page-derived
         *  composition under a whole-view count. */
        ancestorCounts?: Iterable<AncestorCountInfo>
        queryHash: string
    }) => void
    /** Replace the draft with a value from outside the builder (template /
     *  JSON editor / load-saved-query). Bumps ``draftRevision``.
     *
     *  Does NOT push to undo history — call ``commitDraft`` for that.
     *  This is the no-history mutation used by per-keystroke value
     *  edits inside ConditionRows. */
    seedDraftPredicate: (predicate: Predicate | null) => void
    /** Like ``seedDraftPredicate``, but ALSO pushes the previous draft
     *  onto the undo stack and clears the redo stack. Use for
     *  user-committed structural changes: chip add/remove, clear,
     *  paste-DSL commit, example seed, recent-query load,
     *  quick-search submit. */
    commitDraft: (predicate: Predicate | null) => void
    /** Pop from ``historyPast``, push current to ``historyFuture``,
     *  set draft = popped. No-op when past is empty. */
    undo: () => void
    /** Symmetric to ``undo``. No-op when future is empty. */
    redo: () => void
    /** Mirror an internal builder-reducer state into the store. Does NOT
     *  bump ``draftRevision`` since the change originated in the builder
     *  itself — bumping would cause an infinite loadSeed loop. */
    syncDraftFromBuilder: (predicate: Predicate | null) => void
    /** Update the per-request options the visual builder uses. Pass a
     *  partial to merge; pass ``null`` to reset to defaults. */
    setDraftOptions: (patch: Partial<DraftOptions> | null) => void
    /** Mirror the current builder validation issues into the store. */
    setBuilderValidation: (issues: ReadonlyArray<BuilderValidationIssue>) => void
    /** Auto-save a dispatched query to the per-view Recent list. Dedup
     *  by ``(viewId, JSON.stringify(predicate))`` — re-running the same
     *  query bumps the existing entry to the top rather than duplicating.
     *  Caller supplies ``label`` (DSL string) so the store doesn't have
     *  to depend on the panel's stringifier. */
    addRecent: (entry: { viewId: string; predicate: Predicate; label: string }) => void
    /** Flip the ``pinned`` flag on a Recent entry by its timestamp.
     *  Pinned entries are never auto-evicted by the 10-cap. */
    togglePinRecent: (timestamp: number) => void
    /** Drop one Recent entry by its timestamp. Used by hover-X. */
    removeRecent: (timestamp: number) => void
    /** Wipe ONLY the search-result fields (matchUrnSet, ancestor maps,
     *  queryHash) — leaves draft, history, recent intact. Used by the
     *  QueryCard auto-run effect when the draft empties out: we want
     *  the canvas spotlight to go away but the user must still be able
     *  to undo back to their previous draft. */
    clearSearchResults: () => void
    clear: () => void
    /** Load a predicate into the builder AND request the panel run it —
     *  the "open in Advanced Search + run" bridge used by the Property
     *  Manager. The caller also opens the panel. */
    requestSearchRun: (predicate: Predicate) => void
    /** Atomic read-and-clear of the pending run predicate (panel-side). */
    consumePendingRun: () => Predicate | null
    /** Persist the scope mode chosen by the user in the panel header.
     *  Applies to every subsequent run until changed. */
    setScopeMode: (mode: 'visible' | 'view' | 'data_source') => void
    /** Toggle a row at ``index`` inside ``parentPath`` selected /
     *  unselected. Selecting in a different parent clears the prior
     *  selection (single-parent scope). */
    toggleRowSelection: (parentPath: string, index: number) => void
    /** Clear all row selection. */
    clearRowSelection: () => void
    /** Move the focused-match cursor by one step. ``'next'`` advances,
     *  ``'prev'`` retreats. Wraps around at both ends (clicking next
     *  on the last match jumps to the first). No-op when
     *  ``orderedMatchUrns`` is empty. Initializes to 0 when called
     *  from the ``null`` state. */
    stepFocus: (direction: 'next' | 'prev') => void
    /** Set the focused-match index directly (e.g. when the user clicks
     *  a specific result row). Pass ``null`` to clear focus. Out-of-
     *  range values are coerced to the valid range. */
    setFocusedMatchIndex: (index: number | null) => void
    /** Set the canvas filter mode. Persisted per-view in localStorage. */
    setCanvasFilterMode: (mode: CanvasFilterMode, viewId: string | null) => void
    /** Promote a Recent entry into a named, pinned "Mine" entry. Sets
     *  ``source: 'mine'``, ``pinned: true``, and the supplied ``name`` /
     *  ``description``. Used by the Library popover's "Save as…" flow.
     *  No-op when the timestamp doesn't match an existing entry. */
    promoteToMine: (timestamp: number, name: string, description?: string) => void
    /** Save the current draft directly into the Mine library without
     *  going through the recent-runs path. Used by the QueryCard
     *  header's Save button so a user can persist a query before
     *  ever running it. Dedupe by ``(viewId, predicate)`` — saving
     *  the same predicate twice updates the existing entry instead
     *  of creating a duplicate. Always sets ``pinned: true`` and
     *  ``source: 'mine'``. */
    saveDraftAsMineEntry: (entry: {
        viewId: string
        predicate: Predicate
        label: string
        name: string
        description?: string
    }) => void
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>()
const EMPTY_MAP: ReadonlyMap<string, number> = new Map<string, number>()
const EMPTY_BREAKDOWN_MAP: ReadonlyMap<string, ReadonlyMap<string, number>>
    = new Map<string, ReadonlyMap<string, number>>()


/**
 * Walks the per-hit ancestor paths and derives two rollups in a single
 * pass: total match count per ancestor URN, AND a per-entityType
 * breakdown per ancestor URN. Within a single hit we deduplicate
 * ancestors via a per-hit Set so a malformed path with the same
 * ancestor twice never inflates either count.
 */
function deriveAncestorRollups(infos: Iterable<AncestorPathInfo>): {
    counts: Map<string, number>
    breakdowns: Map<string, Map<string, number>>
} {
    const counts = new Map<string, number>()
    const breakdowns = new Map<string, Map<string, number>>()
    for (const { path, leafEntityType } of infos) {
        const seen = new Set<string>()
        for (const ref of path) {
            if (!ref || !ref.urn) continue
            if (seen.has(ref.urn)) continue
            seen.add(ref.urn)
            counts.set(ref.urn, (counts.get(ref.urn) ?? 0) + 1)
            if (leafEntityType) {
                let breakdown = breakdowns.get(ref.urn)
                if (!breakdown) {
                    breakdown = new Map<string, number>()
                    breakdowns.set(ref.urn, breakdown)
                }
                breakdown.set(leafEntityType, (breakdown.get(leafEntityType) ?? 0) + 1)
            }
        }
    }
    return { counts, breakdowns }
}

/**
 * Overlays the server's exact ``ancestor`` aggregation onto the
 * page-derived rollup, in place. A bucket wins outright for its own URN —
 * it counts the whole candidate set, not just this page's hits, and no
 * summing is needed because each bucket already IS that ancestor's total.
 *
 * Ancestors the server sent no bucket for keep their rollup value rather
 * than disappearing: the aggregation is capped at ``maxBuckets`` and is
 * computed over the candidate set, so a container the current page proves
 * has matches under it can still be missing from the response, and
 * dropping it would make Isolate/Hide swallow a container the user can
 * see a match inside.
 *
 * A bucket carrying no breakdown DELETES the rollup's. The count and the
 * breakdown are rendered together — SearchMatchBadge puts "42 matches
 * inside this subtree" straight above a type list whose bars are
 * proportioned to that list's own sum — so leaving the page's `{column: 1}`
 * beside the server's 42 would state a composition the count contradicts.
 * A count on its own is the honest answer. Most buckets now arrive WITH a
 * breakdown — the ``ancestor`` facet ships ``typeCounts`` per bucket — so
 * this path is the exception rather than the rule it once was.
 */
function overlayServerAncestorCounts(
    counts: Map<string, number>,
    breakdowns: Map<string, Map<string, number>>,
    infos: Iterable<AncestorCountInfo>,
): void {
    for (const { urn, count, breakdown } of infos) {
        if (!urn) continue
        counts.set(urn, count)
        if (breakdown) breakdowns.set(urn, new Map(breakdown))
        else breakdowns.delete(urn)
    }
}

const EMPTY_ISSUES: ReadonlyArray<BuilderValidationIssue> = Object.freeze([])

/**
 * Maximum entries kept in the undo stack. Generous — the user typically
 * cares about the last few; this just bounds memory in pathological
 * cases (a long session that mutates the draft thousands of times).
 */
const HISTORY_CAP = 50

/**
 * Cap on un-pinned Recent entries per view. Pinned entries are
 * unbounded — the implicit "save this query" mechanism.
 */
const RECENT_CAP_PER_VIEW = 10

/** localStorage key for the persisted Recent + Pinned list. */
const RECENT_STORAGE_KEY = 'synodic.advancedSearch.recent.v1'

/** localStorage key for the persisted canvas-filter-mode map (per
 *  viewId → mode). Separate from the recent list so a corrupt mode
 *  blob never wipes out the saved queries. */
const CANVAS_FILTER_STORAGE_KEY = 'synodic.advancedSearch.canvasFilterMode.v1'

const EMPTY_HISTORY: ReadonlyArray<Predicate | null> = Object.freeze([])
const EMPTY_RECENT: ReadonlyArray<RecentQueryEntry> = Object.freeze([])
const EMPTY_ORDERED_URNS: ReadonlyArray<string> = Object.freeze([])


/**
 * Best-effort load of the persisted Recent list. Silently returns an
 * empty list on parse failure (corrupted localStorage, schema change,
 * SSR, etc.) — the user just loses their history, never a crash.
 */
function loadRecentFromStorage(): ReadonlyArray<RecentQueryEntry> {
    try {
        const raw = localStorage.getItem(RECENT_STORAGE_KEY)
        if (!raw) return EMPTY_RECENT
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return EMPTY_RECENT
        // Soft validation — drop entries missing required fields rather
        // than throwing the whole list out.
        const valid = parsed.filter((e) =>
            e
            && typeof e.viewId === 'string'
            && typeof e.label === 'string'
            && typeof e.timestamp === 'number'
            && e.predicate
            && typeof e.predicate === 'object',
        )
        return valid as ReadonlyArray<RecentQueryEntry>
    } catch {
        return EMPTY_RECENT
    }
}


function saveRecentToStorage(entries: ReadonlyArray<RecentQueryEntry>): void {
    try {
        localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(entries))
    } catch {
        // Quota exceeded / privacy mode / disabled storage. Non-fatal —
        // the list still works in memory for the session.
    }
}


/**
 * Persisted shape for the per-view canvas filter mode. Stored as an
 * object so multiple views can hold distinct preferences in the same
 * localStorage key. Unknown viewIds resolve to ``'highlight'``.
 */
type CanvasFilterModeMap = Record<string, CanvasFilterMode>

function loadCanvasFilterMap(): CanvasFilterModeMap {
    try {
        const raw = localStorage.getItem(CANVAS_FILTER_STORAGE_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return {}
        // Soft validation: drop unknown mode values to avoid leaking a
        // garbage string into the render path.
        const out: CanvasFilterModeMap = {}
        for (const [k, v] of Object.entries(parsed)) {
            if (v === 'highlight' || v === 'isolate' || v === 'hide') {
                out[k] = v
            }
        }
        return out
    } catch {
        return {}
    }
}

function saveCanvasFilterMap(map: CanvasFilterModeMap): void {
    try {
        localStorage.setItem(CANVAS_FILTER_STORAGE_KEY, JSON.stringify(map))
    } catch {
        // Same non-fatal stance as saveRecentToStorage.
    }
}

export const useSearchStore = create<SearchStoreState & SearchStoreActions>((set, get) => ({
    viewId: null,
    matchUrnSet: EMPTY_SET,
    queryHash: null,
    draftPredicate: null,
    draftRevision: 0,
    draftOptions: null,
    builderValidation: EMPTY_ISSUES,
    ancestorMatchCounts: EMPTY_MAP,
    ancestorMatchTypeBreakdowns: EMPTY_BREAKDOWN_MAP,
    historyPast: EMPTY_HISTORY,
    historyFuture: EMPTY_HISTORY,
    recentQueries: loadRecentFromStorage(),
    pendingRunPredicate: null,
    // Default to 'view' — searches the full descendant set of the
    // view's top-level containers, including subtrees that haven't
    // been expanded yet. Matches the user's "search this view"
    // mental model on a canvas that lazy-loads children (only the
    // expanded portion lives in the local node store, so 'visible'
    // would silently drop lazy descendants from results). 'visible'
    // (narrow to currently-rendered nodes) and 'data_source' (escape
    // the view boundary) remain available via the picker.
    scopeMode: 'view',
    selectionParent: null,
    selectedIndices: [],
    orderedMatchUrns: EMPTY_ORDERED_URNS,
    focusedMatchIndex: null,
    // Initial mode is 'highlight'; per-view persisted overrides are
    // applied via the setCanvasFilterMode action on first read. We
    // don't seed from the map here because we don't know which view
    // is active at store-create time — callers (SearchMapPanel mount)
    // hydrate the right value via setCanvasFilterMode.
    canvasFilterMode: 'highlight',

    setResult: ({ viewId, matchUrns, ancestorPaths, ancestorCounts, queryHash }) => {
        const next = new Set<string>()
        // Build the ordered list and the set in one pass so iteration
        // order from the caller (backend hit order) is preserved for
        // the MatchBar stepper. Duplicates in the iterable still get
        // de-duped in the Set; the ordered array keeps the first
        // occurrence only.
        const ordered: string[] = []
        for (const urn of matchUrns) {
            if (!urn) continue
            if (!next.has(urn)) {
                next.add(urn)
                ordered.push(urn)
            }
        }
        // The page-derived rollup is the floor; the server's exact
        // per-ancestor counts (when this query asked for them) win for
        // every URN they cover.
        const { counts, breakdowns } = ancestorPaths
            ? deriveAncestorRollups(ancestorPaths)
            : { counts: new Map<string, number>(),
                breakdowns: new Map<string, Map<string, number>>() }
        if (ancestorCounts) {
            overlayServerAncestorCounts(counts, breakdowns, ancestorCounts)
        }
        set({
            viewId,
            matchUrnSet: next,
            orderedMatchUrns: ordered.length === 0 ? EMPTY_ORDERED_URNS : ordered,
            // Reset focus on every new result set — carrying over a
            // stale index across queries would land the user on a
            // different match than they expected.
            focusedMatchIndex: null,
            ancestorMatchCounts: counts,
            ancestorMatchTypeBreakdowns: breakdowns,
            queryHash,
        })
    },

    seedDraftPredicate: (predicate) => {
        set((s) => ({
            draftPredicate: predicate,
            draftRevision: s.draftRevision + 1,
            // Reset row-selection: indices into the old draft are no
            // longer valid against the new one.
            selectionParent: null,
            selectedIndices: [],
        }))
    },

    commitDraft: (predicate) => {
        set((s) => {
            const prev = s.draftPredicate
            // Hash-dedupe: a commit with the same shape as the current
            // draft is a no-op (avoids history bloat from redundant
            // calls like re-clicking the same example).
            if (JSON.stringify(prev) === JSON.stringify(predicate)) {
                return {}
            }
            const past = [...s.historyPast, prev]
            // Cap at HISTORY_CAP; drop oldest when over.
            const cappedPast = past.length > HISTORY_CAP
                ? past.slice(past.length - HISTORY_CAP)
                : past
            return {
                draftPredicate: predicate,
                draftRevision: s.draftRevision + 1,
                historyPast: cappedPast,
                historyFuture: EMPTY_HISTORY,
                // Reset row-selection — see seedDraftPredicate above.
                selectionParent: null,
                selectedIndices: [],
            }
        })
    },

    undo: () => {
        set((s) => {
            if (s.historyPast.length === 0) return {}
            const past = s.historyPast.slice(0, -1)
            const restored = s.historyPast[s.historyPast.length - 1]
            const future = [...s.historyFuture, s.draftPredicate]
            return {
                draftPredicate: restored,
                draftRevision: s.draftRevision + 1,
                historyPast: past,
                historyFuture: future,
            }
        })
    },

    redo: () => {
        set((s) => {
            if (s.historyFuture.length === 0) return {}
            const future = s.historyFuture.slice(0, -1)
            const restored = s.historyFuture[s.historyFuture.length - 1]
            const past = [...s.historyPast, s.draftPredicate]
            const cappedPast = past.length > HISTORY_CAP
                ? past.slice(past.length - HISTORY_CAP)
                : past
            return {
                draftPredicate: restored,
                draftRevision: s.draftRevision + 1,
                historyPast: cappedPast,
                historyFuture: future,
            }
        })
    },

    syncDraftFromBuilder: (predicate) => {
        // Internal mirror — do not bump revision. The builder is the
        // ORIGIN of this change; bumping would loop us back into
        // loadSeed in the builder's effect.
        set({ draftPredicate: predicate })
    },

    setDraftOptions: (patch) => {
        if (patch === null) {
            set({ draftOptions: null })
            return
        }
        set((s) => ({
            draftOptions: { ...(s.draftOptions ?? DEFAULT_DRAFT_OPTIONS), ...patch },
        }))
    },

    setBuilderValidation: (issues) => {
        set({ builderValidation: issues.length === 0 ? EMPTY_ISSUES : issues })
    },

    addRecent: ({ viewId, predicate, label }) => {
        const dedupeKey = JSON.stringify(predicate)
        const current = get().recentQueries
        // Find existing entry for this (viewId, predicate) so re-running
        // the same query bumps it to the top instead of duplicating.
        // Preserve its pinned state.
        const existing = current.find(
            (e) => e.viewId === viewId
                && JSON.stringify(e.predicate) === dedupeKey,
        )
        const filtered = current.filter((e) => e !== existing)

        const newEntry: RecentQueryEntry = {
            viewId,
            predicate,
            label,
            timestamp: Date.now(),
            pinned: existing?.pinned ?? false,
        }
        const next: RecentQueryEntry[] = [newEntry, ...filtered]

        // Enforce per-view cap on UNPINNED entries — pinned entries
        // don't count toward the cap and are never auto-evicted.
        const unpinnedKept: RecentQueryEntry[] = []
        const kept: RecentQueryEntry[] = []
        for (const e of next) {
            if (e.viewId === viewId && !e.pinned) {
                if (unpinnedKept.length < RECENT_CAP_PER_VIEW) {
                    unpinnedKept.push(e)
                    kept.push(e)
                }
                // Else: drop this entry — over the cap.
            } else {
                kept.push(e)
            }
        }
        saveRecentToStorage(kept)
        set({ recentQueries: kept })
    },

    togglePinRecent: (timestamp) => {
        const next = get().recentQueries.map((e) =>
            e.timestamp === timestamp ? { ...e, pinned: !e.pinned } : e,
        )
        saveRecentToStorage(next)
        set({ recentQueries: next })
    },

    removeRecent: (timestamp) => {
        const next = get().recentQueries.filter((e) => e.timestamp !== timestamp)
        saveRecentToStorage(next)
        set({ recentQueries: next })
    },

    clearSearchResults: () => {
        set({
            viewId: null,
            matchUrnSet: EMPTY_SET,
            orderedMatchUrns: EMPTY_ORDERED_URNS,
            focusedMatchIndex: null,
            queryHash: null,
            ancestorMatchCounts: EMPTY_MAP,
            ancestorMatchTypeBreakdowns: EMPTY_BREAKDOWN_MAP,
        })
    },

    requestSearchRun: (predicate) => {
        // Load into the builder (history-aware, so the user sees + can
        // edit/undo it), then flag the panel to run it.
        get().commitDraft(predicate)
        set({ pendingRunPredicate: predicate })
    },

    consumePendingRun: () => {
        const current = get().pendingRunPredicate
        if (current !== null) set({ pendingRunPredicate: null })
        return current
    },

    setScopeMode: (mode) => {
        set({ scopeMode: mode })
    },

    toggleRowSelection: (parentPath, index) => {
        const cur = get()
        // Switching parents → start a fresh selection at the new
        // parent with just this row.
        if (cur.selectionParent !== parentPath) {
            set({ selectionParent: parentPath, selectedIndices: [index] })
            return
        }
        const idx = cur.selectedIndices.indexOf(index)
        if (idx >= 0) {
            const next = cur.selectedIndices.filter((i) => i !== index)
            set({
                selectionParent: next.length === 0 ? null : parentPath,
                selectedIndices: next,
            })
        } else {
            // Preserve insertion order — important when the bulk-group
            // action wraps "in the position of the first selected row".
            set({
                selectionParent: parentPath,
                selectedIndices: [...cur.selectedIndices, index],
            })
        }
    },

    clearRowSelection: () => {
        set({ selectionParent: null, selectedIndices: [] })
    },

    clear: () => {
        set((s) => ({
            viewId: null,
            matchUrnSet: EMPTY_SET,
            orderedMatchUrns: EMPTY_ORDERED_URNS,
            focusedMatchIndex: null,
            queryHash: null,
            draftPredicate: null,
            draftRevision: s.draftRevision + 1,
            draftOptions: null,
            builderValidation: EMPTY_ISSUES,
            ancestorMatchCounts: EMPTY_MAP,
            ancestorMatchTypeBreakdowns: EMPTY_BREAKDOWN_MAP,
            // Wipe the in-memory undo stack — the panel is closing,
            // it would be confusing to "undo" into a query the user
            // can't see the chips for. Recent + Pinned persist
            // separately via localStorage.
            historyPast: EMPTY_HISTORY,
            historyFuture: EMPTY_HISTORY,
        }))
    },

    stepFocus: (direction) => {
        const { orderedMatchUrns, focusedMatchIndex } = get()
        if (orderedMatchUrns.length === 0) return
        const last = orderedMatchUrns.length - 1
        let nextIndex: number
        if (focusedMatchIndex === null) {
            // First press always lands on index 0, regardless of
            // direction — there's no "previous to nothing" semantic.
            nextIndex = 0
        } else if (direction === 'next') {
            nextIndex = focusedMatchIndex >= last ? 0 : focusedMatchIndex + 1
        } else {
            nextIndex = focusedMatchIndex <= 0 ? last : focusedMatchIndex - 1
        }
        set({ focusedMatchIndex: nextIndex })
    },

    setFocusedMatchIndex: (index) => {
        const { orderedMatchUrns } = get()
        if (index === null) {
            set({ focusedMatchIndex: null })
            return
        }
        if (orderedMatchUrns.length === 0) {
            set({ focusedMatchIndex: null })
            return
        }
        const last = orderedMatchUrns.length - 1
        // Coerce to valid range — out-of-band callers (stale render,
        // race with a new query) should land on the nearest valid
        // index rather than crash a downstream reveal lookup.
        const clamped = Math.max(0, Math.min(last, index))
        set({ focusedMatchIndex: clamped })
    },

    setCanvasFilterMode: (mode, viewId) => {
        set({ canvasFilterMode: mode })
        // Persist per-view so closing the panel and reopening it on
        // the same view restores the preference. Across views, each
        // view holds its own setting.
        if (viewId) {
            const current = loadCanvasFilterMap()
            current[viewId] = mode
            saveCanvasFilterMap(current)
        }
    },

    promoteToMine: (timestamp, name, description) => {
        const trimmedName = name.trim()
        if (!trimmedName) return
        const next = get().recentQueries.map((e) =>
            e.timestamp === timestamp
                ? {
                    ...e,
                    source: 'mine' as const,
                    name: trimmedName,
                    description: description?.trim() || undefined,
                    pinned: true,
                }
                : e,
        )
        saveRecentToStorage(next)
        set({ recentQueries: next })
    },

    saveDraftAsMineEntry: ({ viewId, predicate, label, name, description }) => {
        const trimmedName = name.trim()
        if (!trimmedName) return
        const dedupeKey = JSON.stringify(predicate)
        const current = get().recentQueries
        // De-dupe by (viewId, predicate). Saving the same predicate
        // twice should UPDATE the existing entry's name/description
        // rather than create two entries with different names that
        // point at the same query.
        const existing = current.find(
            (e) => e.viewId === viewId
                && JSON.stringify(e.predicate) === dedupeKey,
        )
        const filtered = current.filter((e) => e !== existing)
        const entry: RecentQueryEntry = {
            viewId,
            predicate,
            label,
            timestamp: existing?.timestamp ?? Date.now(),
            pinned: true,
            source: 'mine',
            name: trimmedName,
            description: description?.trim() || undefined,
        }
        const next = [entry, ...filtered]
        saveRecentToStorage(next)
        set({ recentQueries: next })
    },
}))


// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

/** Subscribe to the current match-URN set as a stable reference. */
export function useMatchUrnSet(): ReadonlySet<string> {
    return useSearchStore((s) => s.matchUrnSet)
}

/**
 * Subscribe to whether a single URN is in the current match set.
 * Re-renders only when this URN's membership flips — fast enough to
 * call inside the react-flow node renderer for hundreds of nodes.
 */
export function useIsMatch(urn: string | undefined): boolean {
    return useSearchStore((s) => (urn ? s.matchUrnSet.has(urn) : false))
}

/** The view + queryHash this result set belongs to. */
export function useSearchResultMeta(): { viewId: string | null; queryHash: string | null } {
    return useSearchStore((s) => ({ viewId: s.viewId, queryHash: s.queryHash }))
}

/** Subscribe to the current draft predicate (read-only for consumers). */
export function useDraftPredicate(): Predicate | null {
    return useSearchStore((s) => s.draftPredicate)
}

/** Subscribe to the revision counter so the builder can detect
 *  externally-originated draft changes. */
export function useDraftRevision(): number {
    return useSearchStore((s) => s.draftRevision)
}

/** Subscribe to the current draft options (or null when defaults apply). */
export function useDraftOptions(): DraftOptions | null {
    return useSearchStore((s) => s.draftOptions)
}

/** Subscribe to the builder's validation issues. */
export function useBuilderValidation(): ReadonlyArray<BuilderValidationIssue> {
    return useSearchStore((s) => s.builderValidation)
}

/**
 * Subscribe to the roll-up match count for a single ancestor URN.
 * Returns 0 when the URN isn't a match-bearing ancestor; re-renders
 * only when this URN's count changes — fast enough to call inside the
 * node renderer for hundreds of nodes.
 */
export function useAncestorMatchCount(urn: string | undefined): number {
    return useSearchStore((s) => (urn ? s.ancestorMatchCounts.get(urn) ?? 0 : 0))
}

/** Subscribe to the whole ancestor-match-count map (for components
 *  that need to derive aggregates across many URNs at once). */
export function useAncestorMatchCounts(): ReadonlyMap<string, number> {
    return useSearchStore((s) => s.ancestorMatchCounts)
}

/**
 * Subscribe to the per-entityType breakdown of matches sitting under an
 * ancestor URN. Returns an empty (frozen) map when the URN isn't a
 * match-bearing ancestor. Reference-stable when empty so React doesn't
 * thrash on rows that never participate in a search.
 */
export function useAncestorMatchBreakdown(urn: string | undefined): ReadonlyMap<string, number> {
    return useSearchStore((s) =>
        (urn ? s.ancestorMatchTypeBreakdowns.get(urn) ?? EMPTY_MAP : EMPTY_MAP),
    )
}

/**
 * True when a search is currently driving canvas highlighting (any match
 * has been published). Used by the canvas to flip on spotlight mode —
 * dim non-matches + non-ancestors, leave matches and the ancestor chain
 * at full opacity.
 */
export function useIsSearchSpotlightActive(): boolean {
    return useSearchStore((s) => s.matchUrnSet.size > 0)
}


// ---------------------------------------------------------------------------
// History + Recent selectors
// ---------------------------------------------------------------------------

/** True when there's at least one entry in the undo stack. */
export function useCanUndo(): boolean {
    return useSearchStore((s) => s.historyPast.length > 0)
}

/** True when there's at least one entry in the redo stack. */
export function useCanRedo(): boolean {
    return useSearchStore((s) => s.historyFuture.length > 0)
}

/**
 * Recent queries for a specific view, sorted: pinned first by recency,
 * then unpinned by recency.
 *
 * Critical: the Zustand selector returns the RAW reference-stable
 * ``recentQueries`` array; the filter + sort happens inside ``useMemo``
 * downstream. Doing filter/sort inside the selector would create a
 * fresh array on every render — Zustand's referential equality check
 * would flag that as a change, trigger a re-render, re-run the
 * selector, ad infinitum (the "Maximum update depth" loop).
 */
export function useRecentQueries(viewId: string | null | undefined): ReadonlyArray<RecentQueryEntry> {
    const all = useSearchStore((s) => s.recentQueries)
    return useMemo(() => {
        if (!viewId) return EMPTY_RECENT
        const forView = all.filter((e) => e.viewId === viewId)
        if (forView.length === 0) return EMPTY_RECENT
        return [...forView].sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
            return b.timestamp - a.timestamp
        })
    }, [all, viewId])
}


// ---------------------------------------------------------------------------
// MatchBar / canvas-filter selectors
// ---------------------------------------------------------------------------

/** Subscribe to the ordered match URN list (backend hit order). */
export function useOrderedMatchUrns(): ReadonlyArray<string> {
    return useSearchStore((s) => s.orderedMatchUrns)
}

/** Subscribe to the focused-match index (or null when none). */
export function useFocusedMatchIndex(): number | null {
    return useSearchStore((s) => s.focusedMatchIndex)
}

/**
 * Subscribe to the URN of the currently focused match. ``null`` when
 * nothing is focused or the result set is empty. Convenience around
 * ``orderedMatchUrns[focusedMatchIndex]`` for components that only
 * care about the focused URN (e.g. the reveal effect in ResultsPane).
 */
export function useFocusedMatchUrn(): string | null {
    return useSearchStore((s) =>
        s.focusedMatchIndex !== null
            ? s.orderedMatchUrns[s.focusedMatchIndex] ?? null
            : null,
    )
}

/** Subscribe to the current canvas filter mode. */
export function useCanvasFilterMode(): CanvasFilterMode {
    return useSearchStore((s) => s.canvasFilterMode)
}

/**
 * Subscribe to whether a single URN is the currently focused match.
 * Each row gets its own subscription; Zustand's referential equality
 * means a row only re-renders when its own focus state flips, not on
 * every step. This is what makes the MatchBar stepper feel free even
 * with 1000+ result rows mounted.
 */
export function useIsFocusedMatch(urn: string | undefined): boolean {
    return useSearchStore((s) => {
        if (!urn || s.focusedMatchIndex === null) return false
        return s.orderedMatchUrns[s.focusedMatchIndex] === urn
    })
}

/**
 * Read the persisted canvas filter mode for a given view from
 * localStorage. Returns ``'highlight'`` when no entry exists. Pure
 * read; no store subscription. Used at panel-mount time to hydrate
 * ``canvasFilterMode`` for the active view.
 */
export function readPersistedCanvasFilterMode(viewId: string | null | undefined): CanvasFilterMode {
    if (!viewId) return 'highlight'
    const map = loadCanvasFilterMap()
    return map[viewId] ?? 'highlight'
}
