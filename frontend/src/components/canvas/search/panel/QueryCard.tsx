/**
 * QueryCard — the single Query Lens that holds the entire active query.
 *
 *   ╭─ Query · 3 filters ──────────── 🅥 Visual  </> Code ╮
 *   │ ⌕  name contains   [ customer       ]              │
 *   │ #  tag is          [ #PII ] [ + ]                  │
 *   │ ◇  type is in      [ dataset, schemaField   ▾ ]    │
 *   │ ↑  no upstream lineage                             │
 *   │ + Add filter                                       │
 *   ╰─────────────────────────────────────────────────────╯
 *
 * The card subscribes to ``searchStore.draftPredicate`` and renders
 * every top-level condition as a ConditionRow. Editing a row commits
 * back through ``upsertCondition`` and triggers a debounced auto-run.
 * The Visual ↔ Code toggle does NOT lose state — both modes write the
 * same draft. Code mode is a plain textarea with live "parsed N
 * filters" feedback; CodeMirror upgrade is deferred.
 *
 * Discovery telemetry shows next to the Add-filter button as a passive
 * chip ("12 tags · 37 keys · 4 types") so the user sees what
 * autocomplete will offer without opening anything.
 */
import { motion, AnimatePresence } from 'framer-motion'
import {
    AlertTriangle,
    Code2,
    Eye,
    Loader2,
    AlertCircle,
    CheckCircle2,
    Sparkles,
    ArrowRight,
    Play,
    Zap,
    Hand,
    Search,
    Box,
    Tag as TagIcon,
    Layers,
    ArrowDownToLine,
    FileCode,
    Undo2,
    Redo2,
    Star,
    X,
    CornerDownLeft,
} from 'lucide-react'
import {
    type FC,
    type ReactNode,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'

import { cn } from '@/lib/utils'
import { useActiveView, useSchemaStore } from '@/store/schema'
import {
    useCanRedo,
    useCanUndo,
    useDraftPredicate,
    useRecentQueries,
    useSearchStore,
    type RecentQueryEntry,
} from '@/store/searchStore'
import type { Predicate, SearchQuery } from '@/types/search'

import { useDiscovery } from '../builder/useDiscovery'

import { AddFilterPalette } from './AddFilterPalette'
import { OperatorPill } from './builder-atoms/OperatorPill'
import { RowJoiner } from './builder-atoms/RowJoiner'
import type { OpTone } from './builder-atoms/tones'
import { ConditionRow, isRowIncomplete } from './ConditionRow'
import type { LayerOption } from './layerOptions'
import { NestedGroupCard } from './NestedGroupCard'
import {
    appendCondition,
    duplicateConditionAt,
    removeConditionAt,
    replaceConditionAt,
    rootGroupOp,
    setRootGroupOp,
    topLevelConditions,
    wrapConditionAt,
    type RootGroupOp,
} from './predicateComposition'
import { parsePredicate, stringifyPredicate } from './predicateDsl'
import { buildRunnablePredicate } from './runnablePredicate'
import { WhatThisMeansDisclosure } from './WhatThisMeansDisclosure'


export interface QueryCardProps {
    viewId: string
    isRunning: boolean
    /** Run the current draft. Called debounced from row edits. */
    onRun: (predicate: Predicate, options?: SearchQuery['options']) => void
    /** Open Advanced drawer (for OR/NOT/path authoring). */
    onOpenAdvanced: () => void
}


/**
 * Free-form composition opts out of aggregation so the user sees
 * individual entity names, not a 1-bucket-of-N pile.
 *
 * ``pageSize`` matches the backend's CANDIDATE_CAP (5000): the panel
 * wants every match URN in one round-trip so canvas spotlight +
 * ancestor badges cover EVERY matched node, not just the first page.
 * Cursor pagination is wired backend-side for AI agents / future UI
 * that wants to iterate; the panel deliberately does a single shot.
 */
const HITS_ONLY_OPTIONS: SearchQuery['options'] = {
    results: 'hits',
    pageSize: 5000,
    includeAncestorPath: true,
}


type ViewMode = 'visual' | 'code'


export const QueryCard: FC<QueryCardProps> = ({
    viewId, isRunning, onRun, onOpenAdvanced,
}) => {
    const draftPredicate = useDraftPredicate()
    const seedDraftPredicate = useSearchStore((s) => s.seedDraftPredicate)
    // commitDraft pushes the previous draft onto the undo stack — use
    // it for every USER-COMMITTED STRUCTURAL CHANGE (chip add/remove,
    // clear, paste, example seed, quick-search submit, recent load).
    // seedDraftPredicate (above) is for per-keystroke value edits that
    // shouldn't bloat history.
    const commitDraft = useSearchStore((s) => s.commitDraft)
    const undo = useSearchStore((s) => s.undo)
    const redo = useSearchStore((s) => s.redo)
    const canUndo = useCanUndo()
    const canRedo = useCanRedo()
    const recentQueries = useRecentQueries(viewId)
    const togglePinRecent = useSearchStore((s) => s.togglePinRecent)
    const removeRecent = useSearchStore((s) => s.removeRecent)
    // clearSearchResults wipes match URNs / ancestor maps but leaves
    // draft + history alone — needed by the auto-run effect so an
    // empty draft doesn't destroy the history stack the user just
    // pushed by clicking "Clear all".
    const clearSearchResults = useSearchStore((s) => s.clearSearchResults)
    const discovery = useDiscovery(viewId)
    const knownEntityTypes = useEntityTypeNames()
    // Layers are a VIEW concept, not an entity property — source them
    // from the active view's reference-layout config first, then fall
    // back to any 'layer' / 'layerAssignment' values discovered from
    // entity property samples (for views without an explicit layer set).
    const discoveredLayers = useViewLayerOptions(discovery.getValueSamples)

    const [mode, setMode] = useState<ViewMode>('visual')

    /**
     * Code-only palette entries (path, withinHops) hand off to the
     * main panel's Code view rather than the AdvancedDrawer JSON tab.
     * Seed a stub predicate of the chosen kind into the draft
     * (preserving existing work via AND-wrap), then flip the local
     * mode to 'code' so the user lands directly in the DSL editor.
     */
    const handleOpenCode = useCallback((kind: 'path' | 'withinHops') => {
        const stub: Predicate = kind === 'path'
            ? ({
                kind: 'path',
                sourceUrns: [],
                targetUrns: [],
                maxHops: 4,
                edgeClass: 'lineage',
                direction: 'outgoing',
            } as unknown as Predicate)
            : ({
                kind: 'withinHops',
                urns: [],
                hops: 2,
                direction: 'both',
                edgeClass: 'lineage',
            } as unknown as Predicate)
        const current = useSearchStore.getState().draftPredicate
        let next: Predicate
        if (!current) {
            next = stub
        } else if (current.kind === 'group' && current.op === 'and') {
            next = {
                kind: 'group', op: 'and',
                children: [...current.children, stub],
            }
        } else {
            next = {
                kind: 'group', op: 'and',
                children: [current, stub],
            }
        }
        commitDraft(next)
        setMode('code')
    }, [commitDraft])
    // Identifies the most recently inserted condition kind so the
    // corresponding row's first editor gets autofocus on mount. Cleared
    // on a microtask so subsequent edits don't re-trigger focus.
    const [freshKind, setFreshKind] = useState<string | null>(null)

    // ─── Run mode (auto vs manual) + dispatch ──────────────────────
    // Auto: dispatch a debounced run on every complete draft change
    //       (snappy, original behaviour — the default).
    // Manual: only dispatch when the user clicks Run. Avoids the perf
    //       hit of round-tripping the backend on every chip add /
    //       row edit while composing a multi-tier filter.
    const [runMode, setRunMode] = useRunMode()
    // Tracked as state (not a ref) so the dirty/pulse calculation
    // re-renders correctly after a dispatch.
    const [lastRunHash, setLastRunHash] = useState<string | null>(null)

    const runnable = useMemo(() => buildRunnablePredicate(draftPredicate), [draftPredicate])
    const hasPendingChanges = runnable !== null && runnable.hash !== lastRunHash

    const dispatchRun = useCallback(() => {
        if (!runnable) return
        setLastRunHash(runnable.hash)
        onRun(runnable.predicate, HITS_ONLY_OPTIONS)
    }, [runnable, onRun])

    useEffect(() => {
        // Nothing complete — clear results so the canvas spotlight
        // doesn't lag behind the user's edits (applies to both modes).
        // Use ``clearSearchResults`` (not ``clear``) so the user's
        // undo stack survives — they should be able to undo back to a
        // populated draft even after the canvas has gone dim.
        if (runnable === null) {
            if (lastRunHash !== null) {
                clearSearchResults()
                setLastRunHash(null)
            }
            return
        }
        // Manual mode: wait for the explicit Run click.
        if (runMode === 'manual') return
        // Auto mode: debounce and dispatch when the hash actually changed.
        if (!hasPendingChanges) return
        const t = setTimeout(dispatchRun, 250)
        return () => clearTimeout(t)
    }, [runnable, runMode, hasPendingChanges, lastRunHash, clearSearchResults, dispatchRun])

    // ─── Row mutations ─────────────────────────────────────────────
    const conditions = useMemo(
        () => (draftPredicate ? topLevelConditions(draftPredicate) : []),
        [draftPredicate],
    )
    const activeEntityTypes = useMemo<string[]>(() => {
        const et = conditions.find((c) => c.kind === 'entityType')
        return et && et.kind === 'entityType' ? et.values : []
    }, [conditions])

    const handleRowChange = useCallback((index: number, next: Predicate) => {
        // Index-based replace preserves the root group op (AND vs OR)
        // and tolerates duplicate kinds — two TextPredicates with
        // different values, etc.
        const updated = replaceConditionAt(draftPredicate, index, next)
        seedDraftPredicate(updated)
    }, [draftPredicate, seedDraftPredicate])

    const handleRowRemove = useCallback((index: number) => {
        const updated = removeConditionAt(draftPredicate, index)
        commitDraft(updated)
    }, [draftPredicate, commitDraft])

    const handleAddOne = useCallback((p: Predicate) => {
        // Append, not replace: the user can now add multiple same-kind
        // predicates (e.g. two TextPredicates for "t2" AND "opp").
        const next = appendCondition(draftPredicate, p)
        commitDraft(next)
        setFreshKind(p.kind ?? null)
        // Clear shortly so future edits don't keep stealing focus.
        setTimeout(() => setFreshKind(null), 150)
    }, [draftPredicate, commitDraft])

    const handleAddMany = useCallback((preds: Predicate[]) => {
        let next = draftPredicate
        for (const p of preds) next = appendCondition(next, p)
        commitDraft(next)
        // Focus the last inserted kind so the user is on the last row
        // of a paste.
        const last = preds[preds.length - 1]
        if (last) {
            setFreshKind(last.kind ?? null)
            setTimeout(() => setFreshKind(null), 150)
        }
    }, [draftPredicate, commitDraft])

    const handleRootOpChange = useCallback((op: RootGroupOp) => {
        const next = setRootGroupOp(draftPredicate, op)
        commitDraft(next)
    }, [draftPredicate, commitDraft])

    const handleRowWrap = useCallback((index: number, op: OpTone) => {
        const next = wrapConditionAt(draftPredicate, index, op)
        commitDraft(next)
    }, [draftPredicate, commitDraft])

    const handleRowDuplicate = useCallback((index: number) => {
        const next = duplicateConditionAt(draftPredicate, index)
        commitDraft(next)
    }, [draftPredicate, commitDraft])

    const currentRootOp = rootGroupOp(draftPredicate)

    const handleClearAll = useCallback(() => {
        commitDraft(null)
    }, [commitDraft])

    // Quick-search Enter from the empty hero → wrap the typed value
    // in a name-substring TextPredicate and commit (pushes to history,
    // triggers the auto-run if in Auto mode).
    const handleQuickSearch = useCallback((value: string) => {
        const trimmed = value.trim()
        if (!trimmed) return
        commitDraft({
            kind: 'text', value: trimmed, target: 'name',
            match: 'substring', caseSensitive: false, boost: 1,
        })
    }, [commitDraft])

    // Recent-query load — restore an old predicate into the draft,
    // pushing the current draft onto the undo stack so the user can
    // undo back if they loaded the wrong one.
    const handleLoadRecent = useCallback((entry: RecentQueryEntry) => {
        commitDraft(entry.predicate)
    }, [commitDraft])

    // ─── Header summary ────────────────────────────────────────────
    const completeCount = conditions.filter((c) => !isRowIncomplete(c)).length
    const incompleteCount = conditions.length - completeCount

    // Empty state in Visual mode gets its own premium hero treatment —
    // no QUERY header chrome, no run controls (nothing to act on), just
    // a confident "start here" surface with example-led onboarding.
    const isEmptyVisual = mode === 'visual' && conditions.length === 0
    const showHeader = !isEmptyVisual

    return (
        <div
            data-search-panel-content
            className={cn(
                'rounded-2xl border border-glass-border bg-canvas-base/30',
                'flex flex-col',
            )}
        >
            {/* Header — hidden in the empty-visual hero state */}
            {showHeader && (
                <div className={cn(
                    'flex items-center justify-between gap-2 px-3 py-2',
                    'border-b border-glass-border/60',
                )}>
                    <div className="flex items-baseline gap-2 min-w-0">
                        <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-ink-muted/70">
                            Query
                        </span>
                        {conditions.length > 0 ? (
                            <span className="text-[11.5px] text-ink-muted tabular-nums">
                                {completeCount} filter{completeCount === 1 ? '' : 's'}
                                {incompleteCount > 0 && (
                                    <span className="text-amber-400/90">
                                        {' '}· {incompleteCount} incomplete
                                    </span>
                                )}
                            </span>
                        ) : (
                            <span className="text-[11.5px] text-ink-muted italic">
                                Code mode · paste DSL
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {conditions.length > 0 && (
                            <button
                                type="button"
                                onClick={handleClearAll}
                                disabled={isRunning}
                                className={cn(
                                    'text-[10.5px] text-ink-muted hover:text-rose-400 transition-colors',
                                    isRunning && 'opacity-50 cursor-not-allowed',
                                )}
                            >
                                Clear all
                            </button>
                        )}
                        <UndoRedoButtons
                            canUndo={canUndo}
                            canRedo={canRedo}
                            onUndo={undo}
                            onRedo={redo}
                        />
                        {conditions.length > 0 && (
                            <RunControls
                                runMode={runMode}
                                onRunModeChange={setRunMode}
                                canRun={runnable !== null}
                                hasPendingChanges={hasPendingChanges}
                                isRunning={isRunning}
                                onRunNow={dispatchRun}
                            />
                        )}
                        <div className="inline-flex rounded-md bg-canvas-base/40 border border-glass-border/60 p-0.5">
                            <ToggleBtn active={mode === 'visual'} onClick={() => setMode('visual')}>
                                <Eye className="w-3 h-3" /> Visual
                            </ToggleBtn>
                            <ToggleBtn active={mode === 'code'} onClick={() => setMode('code')}>
                                <Code2 className="w-3 h-3" /> Code
                            </ToggleBtn>
                        </div>
                    </div>
                </div>
            )}

            {/* Body — Visual / Code */}
            <div className={cn(
                'flex flex-col gap-2',
                isEmptyVisual ? 'p-0' : 'p-2.5',
            )}>
                {mode === 'visual' ? (
                    isEmptyVisual ? (
                        <PremiumEmptyHero
                            onSeed={(p) => commitDraft(p)}
                            onQuickSearch={handleQuickSearch}
                            onUseCodeMode={() => setMode('code')}
                            discoveredEntityTypes={knownEntityTypes}
                            discoveredTags={discovery.tagValues}
                            discoveredLayers={discoveredLayers}
                            discoveryLoading={discovery.isInitialLoading}
                            discoveryError={discovery.error}
                            propertyKeyCount={discovery.allKeys.length}
                            recentQueries={recentQueries}
                            onLoadRecent={handleLoadRecent}
                            onTogglePinRecent={togglePinRecent}
                            onRemoveRecent={removeRecent}
                        />
                    ) : (
                        <>
                            <WhatThisMeansDisclosure />
                            {conditions.length >= 2 && (
                                <RootMatchHeader
                                    op={currentRootOp}
                                    onChange={handleRootOpChange}
                                    disabled={isRunning}
                                />
                            )}
                            <AnimatePresence initial={false}>
                                {conditions.map((cond, i) => (
                                    <motion.div
                                        key={`${cond.kind}-${i}`}
                                        initial={{ opacity: 0, y: -4 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -4 }}
                                        transition={{ duration: 0.12 }}
                                    >
                                        {i > 0 && (
                                            <RowJoiner
                                                op={currentRootOp}
                                                onChange={(next) => handleRootOpChange(next)}
                                                disabled={isRunning}
                                            />
                                        )}
                                        {cond.kind === 'group' ? (
                                            <NestedGroupCard
                                                group={cond}
                                                onChange={(next) => {
                                                    if (next === null) handleRowRemove(i)
                                                    else handleRowChange(i, next)
                                                }}
                                                onRemove={() => handleRowRemove(i)}
                                                onWrap={(w) => handleRowWrap(i, w)}
                                                onDuplicate={() => handleRowDuplicate(i)}
                                                onOpenAdvanced={onOpenAdvanced}
                                                onSubmit={dispatchRun}
                                                disabled={isRunning}
                                                discovery={{
                                                    allKeys: discovery.allKeys,
                                                    keysByEntityType: discovery.keysByEntityType,
                                                    tagValues: discovery.tagValues,
                                                    getValueSamples: discovery.getValueSamples,
                                                }}
                                                knownEntityTypes={knownEntityTypes}
                                                activeEntityTypes={activeEntityTypes}
                                                discoveredLayers={discoveredLayers}
                                                parentPath=""
                                                index={i}
                                            />
                                        ) : (
                                            <ConditionRow
                                                value={cond}
                                                discovery={{
                                                    allKeys: discovery.allKeys,
                                                    keysByEntityType: discovery.keysByEntityType,
                                                    tagValues: discovery.tagValues,
                                                    getValueSamples: discovery.getValueSamples,
                                                }}
                                                knownEntityTypes={knownEntityTypes}
                                                activeEntityTypes={activeEntityTypes}
                                                discoveredLayers={discoveredLayers}
                                                isRunning={isRunning}
                                                autoFocus={cond.kind === freshKind}
                                                onChange={(next) => handleRowChange(i, next)}
                                                onRemove={() => handleRowRemove(i)}
                                                onWrap={(w) => handleRowWrap(i, w)}
                                                onDuplicate={() => handleRowDuplicate(i)}
                                                onOpenAdvanced={onOpenAdvanced}
                                                onSubmit={dispatchRun}
                                                parentPath=""
                                                index={i}
                                            />
                                        )}
                                    </motion.div>
                                ))}
                            </AnimatePresence>
                            <ExpensiveQueryNotice predicate={draftPredicate} />
                            <div className="flex items-center gap-2 pt-1 flex-wrap">
                                <AddFilterPalette
                                    counts={{
                                        entityTypes: knownEntityTypes.length,
                                        tags: discovery.tagValues.length,
                                        propertyKeys: discovery.allKeys.length,
                                        layers: discoveredLayers.length,
                                    }}
                                    samples={{
                                        // Discovery already orders these
                                        // by frequency; pass the head so
                                        // the palette previews the
                                        // highest-signal candidates first
                                        // (the SampleChips component
                                        // additionally caps at 4 visible
                                        // + a "+N" overflow chip).
                                        entityTypes: knownEntityTypes.slice(0, 8),
                                        tags: discovery.tagValues.slice(0, 8),
                                        propertyKeys: discovery.allKeys.slice(0, 8),
                                        layers: discoveredLayers.slice(0, 8).map((o) => o.label),
                                    }}
                                    onAdd={handleAddOne}
                                    onAddMany={handleAddMany}
                                    onOpenAdvanced={onOpenAdvanced}
                                    onOpenCode={handleOpenCode}
                                    disabled={isRunning}
                                />
                                <DiscoveryTelemetry
                                    loading={discovery.isInitialLoading}
                                    error={discovery.error}
                                    tags={discovery.tagValues.length}
                                    keys={discovery.allKeys.length}
                                    types={knownEntityTypes.length}
                                />
                            </div>
                        </>
                    )
                ) : (
                    <CodeMode
                        draft={draftPredicate}
                        isRunning={isRunning}
                        onCommit={(p) => commitDraft(p)}
                    />
                )}
            </div>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Expensive-query warning (W2 / regression follow-up)
// ---------------------------------------------------------------------------

/**
 * Inspect the current draft for predicate shapes that historically
 * cost the FalkorDB planner the most: topology probes (isOrphan /
 * isRoot / isLeaf) without any narrowing leaf next to them, plus
 * unscoped degree-zero filters. Surfaces a visible warning above
 * the Run controls so the user knows BEFORE clicking Run that the
 * query may take longer.
 */
function detectExpensiveShape(p: Predicate | null): string | null {
    if (!p) return null
    // Top-level orphan / root / leaf with no other leaf at the same
    // level: this walks every node in scope to check the absence of
    // incoming or outgoing edges. With the default ontology-bounded
    // scan it's bounded but still touches the full label set.
    const topology = new Set([
        'isOrphan', 'isRoot', 'isLeaf', 'hasIncoming', 'hasOutgoing',
    ])
    const collectLeafKinds = (node: Predicate, out: string[]) => {
        if (node.kind === 'group') {
            for (const c of node.children) collectLeafKinds(c, out)
        } else if (node.kind) {
            out.push(node.kind)
        }
    }
    const leaves: string[] = []
    collectLeafKinds(p, leaves)
    const hasTopology = leaves.some((k) => topology.has(k))
    const otherLeafCount = leaves.filter(
        (k) => !topology.has(k) && k !== 'text',
    ).length
    if (hasTopology && otherLeafCount === 0) {
        return (
            'Topology-only query (isRoot / isLeaf / isOrphan / hasIncoming / ' +
            'hasOutgoing) — runs a full scan against the bounded ontology. ' +
            'On large graphs this may take 10-30 seconds. Add a tag, ' +
            'entity type, or layer filter to narrow the candidate set.'
        )
    }
    if (leaves.length === 0) {
        return 'Empty predicate — every node in scope will be returned.'
    }
    return null
}


function ExpensiveQueryNotice({ predicate }: { predicate: Predicate | null }) {
    const reason = detectExpensiveShape(predicate)
    if (!reason) return null
    return (
        <div className={cn(
            'flex items-start gap-2.5 px-3 py-2.5 rounded-lg mt-1',
            'border-l-4 border-l-amber-400 border border-amber-400/50',
            'bg-amber-500/[0.18] dark:bg-amber-500/[0.14]',
            'shadow-[0_0_18px_-4px_rgba(245,158,11,0.35)]',
        )}>
            <div className={cn(
                'shrink-0 w-6 h-6 rounded-md flex items-center justify-center',
                'bg-amber-400/30 border border-amber-400/60',
            )}>
                <AlertTriangle className="w-3.5 h-3.5 text-amber-700 dark:text-amber-200" strokeWidth={2.6} />
            </div>
            <div className="flex-1 min-w-0 text-[12px] leading-snug">
                <div className="font-display font-semibold text-amber-900 dark:text-amber-100">
                    This query may be expensive
                </div>
                <div className="mt-0.5 text-amber-900/85 dark:text-amber-100/90">
                    {reason}
                </div>
            </div>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Code mode — DSL textarea with live parse feedback
// ---------------------------------------------------------------------------

function CodeMode({
    draft, isRunning, onCommit,
}: {
    draft: Predicate | null
    isRunning: boolean
    onCommit: (p: Predicate | null) => void
}) {
    const [text, setText] = useState(() => stringifyPredicate(draft))
    const lastDraftStr = useRef<string>(stringifyPredicate(draft))

    // Mirror external draft → text only when the user hasn't edited.
    useEffect(() => {
        const canonical = stringifyPredicate(draft)
        if (text === lastDraftStr.current) {
            setText(canonical)
        }
        lastDraftStr.current = canonical
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft])

    const parsed = useMemo(() => parsePredicate(text), [text])
    const commit = useCallback(() => {
        onCommit(parsed.predicate)
    }, [parsed, onCommit])

    return (
        <div className="flex flex-col gap-1.5">
            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        commit()
                    }
                }}
                onBlur={commit}
                disabled={isRunning}
                spellCheck={false}
                rows={4}
                placeholder='t2 AND (account OR opp) OR NOT T1'
                className={cn(
                    'w-full px-3 py-2 rounded-lg resize-none',
                    'bg-canvas-base/60 border border-glass-border',
                    'text-[12.5px] font-mono text-ink placeholder:text-ink-muted/60',
                    'focus:outline-none focus:border-accent-lineage/60',
                )}
            />
            <ParseFeedback
                recognized={parsed.recognized.length}
                fallback={parsed.fallbackText.length}
                isEmpty={!parsed.predicate}
                error={parsed.error}
            />
            <CodeModeCheatsheet />
            <div className="text-[10.5px] text-ink-muted/70 px-1">
                <kbd className="px-1 rounded bg-glass/40 text-ink-muted">⌘↵</kbd> or blur to apply ·{' '}
                use <span className="font-mono text-ink">AND</span> /{' '}
                <span className="font-mono text-ink">OR</span> /{' '}
                <span className="font-mono text-ink">NOT</span> with parentheses
            </div>
        </div>
    )
}


function CodeModeCheatsheet() {
    const [open, setOpen] = useState(false)
    return (
        <div className={cn(
            'rounded-md border border-glass-border/50',
            'bg-canvas-base/40 overflow-hidden',
        )}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    'w-full flex items-center justify-between gap-2',
                    'px-2.5 py-1.5 text-[10.5px] text-ink-muted',
                    'hover:bg-canvas-base/70 transition-colors',
                )}
            >
                <span className="inline-flex items-center gap-1.5">
                    <Code2 className="w-3 h-3" /> Cheat-sheet
                </span>
                <ArrowRight className={cn('w-3 h-3 transition-transform', open && 'rotate-90')} />
            </button>
            {open && (
                <div className="px-3 py-2 text-[10.5px] text-ink-muted/95 leading-relaxed">
                    <div className="font-mono whitespace-pre-wrap">
{`t2                       text in name contains "t2"
"customer orders"        quoted phrase
name CONTAINS foo        text in name
qname:foo                in qualifiedName
description:foo          in description
type:dataset             entityType IN [dataset]
type IN (dataset, schemaField)
tag:PII                  tag hasAny [PII]
tag:PII,GDPR             tag hasAny [PII, GDPR]
layer:Source             layer = "Source"
rowCount > 1000          property gt 1000
rowCount != 0
hasProperty:owner        node has property "owner"
noUpstream / noDownstream / noLineage
hasUpstream / hasDownstream

Combine with: AND, OR, NOT, parentheses, !

  t2 AND (account OR opp) OR NOT T1
  NOT tag:PII AND type:dataset
  (rowCount > 0) AND noUpstream`}
                    </div>
                </div>
            )}
        </div>
    )
}


function ParseFeedback({
    recognized, fallback, isEmpty, error,
}: { recognized: number; fallback: number; isEmpty: boolean; error?: string }) {
    if (error) {
        return (
            <div className="flex items-start gap-1.5 px-1 text-[10.5px] text-rose-300">
                <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                <span className="leading-snug">{error}</span>
            </div>
        )
    }
    if (isEmpty) {
        return (
            <div className="flex items-center gap-1.5 px-1 text-[10.5px] text-ink-muted/70">
                <AlertCircle className="w-3 h-3" />
                Empty query — type something or paste DSL.
            </div>
        )
    }
    const parts: ReactNode[] = []
    if (recognized > 0) {
        parts.push(
            <span key="r" className="inline-flex items-center gap-1 text-emerald-400/90">
                <CheckCircle2 className="w-3 h-3" />
                {recognized} structured filter{recognized === 1 ? '' : 's'}
            </span>,
        )
    }
    if (fallback > 0) {
        parts.push(
            <span key="f" className="inline-flex items-center gap-1 text-ink-muted">
                · {fallback} word{fallback === 1 ? '' : 's'} as substring text
            </span>,
        )
    }
    return (
        <div className="flex items-center flex-wrap gap-1 px-1 text-[10.5px]">
            {parts}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Premium empty hero — the entire QueryCard when no filters exist
// ---------------------------------------------------------------------------

/**
 * Owns the whole card surface when the draft is empty. Replaces the
 * dense "QUERY · empty" + dormant controls header with a confident
 * onboarding hero: a refined intro, a short stack of concrete example
 * queries (each one explains exactly what it does), and a quiet
 * footer for power users who'd rather paste DSL.
 *
 * Examples are dynamic — they reference real entity types / tags /
 * layers discovered in the active view so a first-time user sees a
 * working query against THEIR data, not a placeholder.
 */
function PremiumEmptyHero({
    onSeed, onQuickSearch, onUseCodeMode,
    discoveredEntityTypes, discoveredTags, discoveredLayers,
    discoveryLoading, discoveryError, propertyKeyCount,
    recentQueries, onLoadRecent, onTogglePinRecent, onRemoveRecent,
}: {
    onSeed: (p: Predicate) => void
    /** Quick-search Enter handler — wraps the typed string in a
     *  name-substring TextPredicate and commits it to the draft. */
    onQuickSearch: (value: string) => void
    onUseCodeMode: () => void
    discoveredEntityTypes: string[]
    discoveredTags: string[]
    discoveredLayers: LayerOption[]
    discoveryLoading: boolean
    discoveryError: Error | null
    propertyKeyCount: number
    recentQueries: ReadonlyArray<RecentQueryEntry>
    onLoadRecent: (entry: RecentQueryEntry) => void
    onTogglePinRecent: (timestamp: number) => void
    onRemoveRecent: (timestamp: number) => void
}) {
    const [quickValue, setQuickValue] = useState('')
    // W2.7 — when the user escalated from ContextViewHeader with a
    // typed quick-search query, the panel set
    // ``pendingSearchSeed`` on the store right before opening. The
    // hero consumes + atomically clears it on mount so the input
    // opens pre-filled with the user's text. Subsequent re-opens
    // see ``null`` and start empty as usual.
    useEffect(() => {
        const seed = useSearchStore.getState().consumePendingSearchSeed()
        if (seed) setQuickValue(seed)
    }, [])
    const submitQuick = () => {
        const trimmed = quickValue.trim()
        if (!trimmed) return
        onQuickSearch(trimmed)
        setQuickValue('')
    }
    type Example = {
        icon: typeof Search
        accent: string
        title: string
        description: string
        chips: string[]
        predicate: Predicate
    }

    const examples: Example[] = []

    // 1) Search by name — always available, the most universal entry point
    examples.push({
        icon: Search,
        accent: 'text-accent-lineage',
        title: 'Search by name',
        description:
            'Type a word and we surface every node whose display name contains it — try ' +
            '"account" or "customer" to see how it works.',
        chips: ['name contains "…"'],
        predicate: {
            kind: 'text', value: '', target: 'name',
            match: 'substring', caseSensitive: false, boost: 1,
        },
    })

    // 2) Browse one entity type — when the view has at least one type
    const primaryType = discoveredEntityTypes.find(
        (t) => /dataset|table|object/i.test(t),
    ) ?? discoveredEntityTypes[0]
    if (primaryType) {
        examples.push({
            icon: Box,
            accent: 'text-cyan-300',
            title: `Browse all ${primaryType}s`,
            description:
                `Open one drawer of the filing cabinet — every ${primaryType} in this view, ` +
                'unfiltered. Pair with a name filter later to narrow.',
            chips: [`type: ${primaryType}`],
            predicate: { kind: 'entityType', op: 'in', values: [primaryType] },
        })
    }

    // 3) Where is this tag used — only meaningful when tags exist
    if (discoveredTags.length > 0) {
        const tag = discoveredTags[0]
        examples.push({
            icon: TagIcon,
            accent: 'text-fuchsia-300',
            title: `Trace the "${tag}" tag`,
            description:
                `Find every node carrying the ${tag} tag — great for compliance audits or ` +
                'understanding where a label has spread across the graph.',
            chips: [`tag: ${tag}`],
            predicate: { kind: 'tag', op: 'hasAny', values: [tag] },
        })
    }

    // 4) Dead-ends — graph-shape, always available
    examples.push({
        icon: ArrowDownToLine,
        accent: 'text-amber-300',
        title: 'Find dead-ends',
        description:
            'Terminal nodes nothing reads from downstream — usually final reports, ' +
            'one-off exports, or candidates for cleanup.',
        chips: ['no downstream'],
        predicate: { kind: 'isLeaf', edgeClass: 'lineage' },
    })

    // 5) Browse a layer — only when the view has layers configured
    if (discoveredLayers.length > 0) {
        const layer = discoveredLayers[0]
        examples.push({
            icon: Layers,
            accent: 'text-emerald-300',
            title: `Browse the ${layer.label} layer`,
            description:
                `Everything this view assigns to the ${layer.label} layer — useful for ` +
                'understanding the shape of one stage of your pipeline.',
            chips: [`layer: ${layer.label}`],
            predicate: { kind: 'layer', layerAssignment: layer.value },
        })
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
                'relative overflow-hidden rounded-2xl flex flex-col',
                'bg-gradient-to-br from-accent-lineage/[0.08] via-canvas-elevated/30 to-purple-500/[0.06]',
            )}
        >
            {/* Decorative wash — adds depth without competing for attention */}
            <div className="pointer-events-none absolute -top-12 -right-12 w-40 h-40 rounded-full bg-accent-lineage/10 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-16 -left-12 w-44 h-44 rounded-full bg-purple-500/8 blur-3xl" />

            {/* Hero */}
            <div className="relative px-5 pt-5 pb-3">
                <div className="flex items-start gap-3">
                    <div className={cn(
                        'w-10 h-10 rounded-2xl flex items-center justify-center shrink-0',
                        'bg-gradient-to-br from-accent-lineage/35 to-cyan-500/20',
                        'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]',
                    )}>
                        <Sparkles className="w-5 h-5 text-accent-lineage" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-[15px] font-display font-semibold text-ink leading-tight tracking-tight">
                            Search this view
                        </div>
                        <p className="mt-1 text-[12px] text-ink-muted leading-snug">
                            Type a word below, pick an example, or paste DSL — your call.
                            The examples use your real data, so a click is a working query.
                        </p>
                    </div>
                </div>
            </div>

            {/* Quick search input — the most direct entry point */}
            <div className="relative px-5 pb-3">
                <div className={cn(
                    'group/qs flex items-center gap-2 px-3 h-10 rounded-xl',
                    'bg-canvas-base/60 border border-glass-border/60',
                    'focus-within:border-accent-lineage/70',
                    'focus-within:shadow-[0_0_0_3px_rgba(45,150,255,0.12)]',
                    'transition-all duration-150',
                )}>
                    <Search className="w-3.5 h-3.5 text-ink-muted shrink-0 group-focus-within/qs:text-accent-lineage transition-colors" />
                    <input
                        type="text"
                        value={quickValue}
                        onChange={(e) => setQuickValue(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault()
                                submitQuick()
                            }
                        }}
                        autoFocus
                        placeholder="Type to search by name across this view…"
                        className={cn(
                            'flex-1 min-w-0 bg-transparent border-0 outline-none',
                            'text-[13px] text-ink placeholder:text-ink-muted/60',
                        )}
                    />
                    <button
                        type="button"
                        onClick={submitQuick}
                        disabled={quickValue.trim().length === 0}
                        title="Search (Enter)"
                        className={cn(
                            'inline-flex items-center gap-1 px-2 h-7 rounded-md',
                            'text-[11px] font-semibold transition-colors',
                            quickValue.trim().length === 0
                                ? 'bg-glass/30 text-ink-muted cursor-not-allowed'
                                : 'bg-accent-lineage text-canvas-base hover:bg-accent-lineage/90',
                        )}
                    >
                        <CornerDownLeft className="w-3 h-3" />
                        Search
                    </button>
                </div>
                <div className="mt-1.5 px-1 text-[10.5px] text-ink-muted/70">
                    Press Enter to search · or pick an example below
                </div>
            </div>

            {/* Examples */}
            <div className="relative px-3 pb-3 flex flex-col gap-1.5">
                {examples.slice(0, 5).map((ex, i) => (
                    <ExampleCard key={i} index={i} example={ex} onSeed={onSeed} />
                ))}
            </div>

            {/* Recent searches */}
            {recentQueries.length > 0 && (
                <div className="relative px-3 pb-3">
                    <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted/70 flex items-center justify-between">
                        <span>Recent searches</span>
                        {recentQueries.length > 5 && (
                            <span className="text-ink-muted/60 normal-case tracking-normal">
                                Showing 5 of {recentQueries.length}
                            </span>
                        )}
                    </div>
                    <div className="flex flex-col gap-1">
                        {recentQueries.slice(0, 5).map((entry) => (
                            <RecentQueryRow
                                key={entry.timestamp}
                                entry={entry}
                                onLoad={() => onLoadRecent(entry)}
                                onTogglePin={() => onTogglePinRecent(entry.timestamp)}
                                onRemove={() => onRemoveRecent(entry.timestamp)}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* Footer — discovery telemetry + DSL escape hatch */}
            <div className={cn(
                'relative px-5 py-3 flex items-center justify-between gap-3',
                'border-t border-glass-border/40 bg-canvas-base/20',
            )}>
                <EmptyDiscoveryHint
                    loading={discoveryLoading}
                    error={discoveryError}
                    types={discoveredEntityTypes.length}
                    tags={discoveredTags.length}
                    keys={propertyKeyCount}
                    layers={discoveredLayers.length}
                />
                <button
                    type="button"
                    onClick={onUseCodeMode}
                    className={cn(
                        'inline-flex items-center gap-1.5 text-[11px] text-ink-muted',
                        'hover:text-accent-lineage transition-colors',
                    )}
                >
                    <FileCode className="w-3 h-3" />
                    Paste DSL instead
                </button>
            </div>
        </motion.div>
    )
}


function ExampleCard({
    index, example, onSeed,
}: {
    index: number
    example: {
        icon: typeof Search
        accent: string
        title: string
        description: string
        chips: string[]
        predicate: Predicate
    }
    onSeed: (p: Predicate) => void
}) {
    const Icon = example.icon
    return (
        <motion.button
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, delay: 0.04 * index }}
            type="button"
            onClick={() => onSeed(example.predicate)}
            className={cn(
                'group/ex relative rounded-xl p-3 text-left',
                'bg-canvas-base/40 hover:bg-canvas-base/70',
                'border border-glass-border/60 hover:border-accent-lineage/50',
                'transition-all duration-150',
                'hover:shadow-[0_4px_20px_-8px_rgba(45,150,255,0.35)]',
            )}
        >
            <div className="flex items-start gap-2.5">
                <div className={cn(
                    'w-8 h-8 rounded-xl flex items-center justify-center shrink-0',
                    'bg-glass/30 group-hover/ex:bg-glass/50 transition-colors',
                )}>
                    <Icon className={cn('w-3.5 h-3.5', example.accent)} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-[12.5px] font-semibold text-ink">
                            {example.title}
                        </span>
                        <ArrowRight className={cn(
                            'w-3.5 h-3.5 text-ink-muted/60 shrink-0',
                            'opacity-0 group-hover/ex:opacity-100 transition-all',
                            'group-hover/ex:text-accent-lineage',
                            '-translate-x-1 group-hover/ex:translate-x-0',
                        )} />
                    </div>
                    <p className="mt-0.5 text-[11px] text-ink-muted leading-snug">
                        {example.description}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                        {example.chips.map((chip, ci) => (
                            <span
                                key={ci}
                                className={cn(
                                    'inline-flex items-center px-1.5 py-0.5 rounded',
                                    'text-[10px] font-mono',
                                    'bg-accent-lineage/10 text-accent-lineage/90',
                                    'border border-accent-lineage/15',
                                )}
                            >
                                {chip}
                            </span>
                        ))}
                    </div>
                </div>
            </div>
        </motion.button>
    )
}


/**
 * One row in the Recent searches strip. Click to load (commits the
 * predicate into the draft via the parent's history-aware
 * commitDraft). Pin keeps the entry from being auto-evicted by the
 * 10-cap. × removes the entry.
 */
function RecentQueryRow({
    entry, onLoad, onTogglePin, onRemove,
}: {
    entry: RecentQueryEntry
    onLoad: () => void
    onTogglePin: () => void
    onRemove: () => void
}) {
    const label = entry.label || '(empty)'
    const truncated = label.length > 60 ? label.slice(0, 57) + '…' : label
    return (
        <div className={cn(
            'group/recent flex items-stretch gap-0 rounded-lg overflow-hidden',
            'bg-canvas-base/40 hover:bg-canvas-base/70',
            'border border-glass-border/60 hover:border-accent-lineage/40',
            'transition-colors',
        )}>
            <button
                type="button"
                onClick={onLoad}
                title={`Load: ${label}`}
                className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 text-left"
            >
                <Search className="w-3 h-3 text-ink-muted/70 shrink-0" />
                <span className="text-[11.5px] font-mono text-ink truncate">
                    {truncated}
                </span>
            </button>
            <button
                type="button"
                onClick={onTogglePin}
                title={entry.pinned ? 'Unpin (allow auto-eviction)' : 'Pin to keep this query'}
                aria-pressed={entry.pinned}
                className={cn(
                    'inline-flex items-center justify-center w-7 shrink-0',
                    'transition-colors',
                    entry.pinned
                        ? 'text-amber-400 hover:text-amber-300'
                        : 'text-ink-muted/40 hover:text-amber-400 opacity-0 group-hover/recent:opacity-100',
                )}
            >
                <Star
                    className="w-3 h-3"
                    fill={entry.pinned ? 'currentColor' : 'none'}
                />
            </button>
            <button
                type="button"
                onClick={onRemove}
                title="Remove from Recent"
                className={cn(
                    'inline-flex items-center justify-center w-6 shrink-0',
                    'text-ink-muted/40 hover:text-rose-400',
                    'opacity-0 group-hover/recent:opacity-100 transition-opacity',
                )}
            >
                <X className="w-3 h-3" />
            </button>
        </div>
    )
}


function EmptyDiscoveryHint({
    loading, error, types, tags, keys, layers,
}: {
    loading: boolean
    error: Error | null
    types: number
    tags: number
    keys: number
    layers: number
}) {
    if (loading) {
        return (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
                <Loader2 className="w-3 h-3 animate-spin" />
                Discovering what's in this view…
            </span>
        )
    }
    if (error) {
        return (
            <span
                className="inline-flex items-center gap-1.5 text-[11px] text-rose-300"
                title={error.message}
            >
                <AlertCircle className="w-3 h-3" />
                Discovery failed
            </span>
        )
    }
    const parts: string[] = []
    if (types > 0) parts.push(`${types} type${types === 1 ? '' : 's'}`)
    if (layers > 0) parts.push(`${layers} layer${layers === 1 ? '' : 's'}`)
    if (keys > 0) parts.push(`${keys} propert${keys === 1 ? 'y' : 'ies'}`)
    if (tags > 0) parts.push(`${tags} tag${tags === 1 ? '' : 's'}`)
    if (parts.length === 0) {
        return (
            <span className="text-[11px] text-ink-muted">
                Ready when you are
            </span>
        )
    }
    return (
        <span className="text-[11px] text-ink-muted tabular-nums">
            <span className="text-ink-muted/70">Queryable: </span>
            {parts.join(' · ')}
        </span>
    )
}


// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Run controls — Auto/Manual switch + Run button
// ---------------------------------------------------------------------------

/**
 * The Auto/Manual toggle controls whether edits dispatch automatically
 * after a debounce (default) or wait for an explicit Run click. Manual
 * mode is the relief valve for power users authoring a 5-tier filter
 * who don't want a backend round-trip on every chip add.
 *
 * The Run button is always rendered:
 *   * Manual mode: primary affordance; pulses when there are pending
 *     edits the user hasn't dispatched.
 *   * Auto mode: secondary "run now" shortcut that bypasses the
 *     250ms debounce — useful for impatient power users.
 */
/**
 * Two small icon buttons. Both disabled when the matching stack is
 * empty. Don't render anything when BOTH are disabled and we're in the
 * populated state — keeps the header from looking dead.
 */
function UndoRedoButtons({
    canUndo, canRedo, onUndo, onRedo,
}: {
    canUndo: boolean
    canRedo: boolean
    onUndo: () => void
    onRedo: () => void
}) {
    if (!canUndo && !canRedo) return null
    return (
        <div className="inline-flex items-center rounded-md bg-canvas-base/40 border border-glass-border/60 p-0.5">
            <button
                type="button"
                onClick={onUndo}
                disabled={!canUndo}
                title="Undo last structural change"
                aria-label="Undo"
                className={cn(
                    'inline-flex items-center justify-center w-6 h-6 rounded',
                    'transition-colors',
                    canUndo
                        ? 'text-ink-secondary hover:text-accent-lineage hover:bg-accent-lineage/10'
                        : 'text-ink-muted/40 cursor-not-allowed',
                )}
            >
                <Undo2 className="w-3.5 h-3.5" />
            </button>
            <button
                type="button"
                onClick={onRedo}
                disabled={!canRedo}
                title="Redo"
                aria-label="Redo"
                className={cn(
                    'inline-flex items-center justify-center w-6 h-6 rounded',
                    'transition-colors',
                    canRedo
                        ? 'text-ink-secondary hover:text-accent-lineage hover:bg-accent-lineage/10'
                        : 'text-ink-muted/40 cursor-not-allowed',
                )}
            >
                <Redo2 className="w-3.5 h-3.5" />
            </button>
        </div>
    )
}


function RunControls({
    runMode, onRunModeChange,
    canRun, hasPendingChanges, isRunning, onRunNow,
}: {
    runMode: 'auto' | 'manual'
    onRunModeChange: (next: 'auto' | 'manual') => void
    canRun: boolean
    hasPendingChanges: boolean
    isRunning: boolean
    onRunNow: () => void
}) {
    const pulse = runMode === 'manual' && hasPendingChanges && !isRunning
    const manualLabel = runMode === 'manual'
        ? 'Manual — only runs on click'
        : 'Auto — runs on every edit (250ms debounce)'

    return (
        <div className="inline-flex items-center gap-1">
            <div
                className="inline-flex rounded-md bg-canvas-base/40 border border-glass-border/60 p-0.5"
                title={manualLabel}
            >
                <ToggleBtn
                    active={runMode === 'auto'}
                    onClick={() => onRunModeChange('auto')}
                >
                    <Zap className="w-3 h-3" /> Auto
                </ToggleBtn>
                <ToggleBtn
                    active={runMode === 'manual'}
                    onClick={() => onRunModeChange('manual')}
                >
                    <Hand className="w-3 h-3" /> Manual
                </ToggleBtn>
            </div>
            <button
                type="button"
                onClick={onRunNow}
                disabled={!canRun || isRunning}
                title={
                    !canRun
                        ? 'Add at least one complete filter to run'
                        : hasPendingChanges
                            ? 'Run the current draft'
                            : 'Re-run the current draft'
                }
                className={cn(
                    'relative inline-flex items-center gap-1 px-2 h-6 rounded-md',
                    'text-[11px] font-semibold transition-colors',
                    !canRun || isRunning
                        ? 'bg-glass/30 text-ink-muted cursor-not-allowed'
                        : pulse
                            ? 'bg-accent-lineage text-canvas-base shadow-[0_0_0_2px_rgba(45,150,255,0.25)]'
                            : 'bg-accent-lineage/20 text-accent-lineage hover:bg-accent-lineage/30',
                )}
            >
                <Play className="w-3 h-3" />
                Run
                {pulse && (
                    <span className={cn(
                        'absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full',
                        'bg-amber-400 animate-pulse',
                    )} />
                )}
            </button>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Run-mode persistence
// ---------------------------------------------------------------------------

const RUN_MODE_KEY = 'synodic.advancedSearch.runMode'
type RunMode = 'auto' | 'manual'

function useRunMode(): [RunMode, (next: RunMode) => void] {
    const [mode, setMode] = useState<RunMode>(() => {
        // Manual is the default for safety — users authoring a
        // multi-tier filter shouldn't pay for a backend round-trip
        // on every chip add. Auto is opt-in, persisted per browser
        // for users who explicitly enable it.
        try {
            return localStorage.getItem(RUN_MODE_KEY) === 'auto'
                ? 'auto' : 'manual'
        } catch {
            return 'manual'
        }
    })
    const update = useCallback((next: RunMode) => {
        setMode(next)
        try { localStorage.setItem(RUN_MODE_KEY, next) } catch { /* ignore */ }
    }, [])
    return [mode, update]
}


// ---------------------------------------------------------------------------
// Runnable-predicate computation — shared by the auto-run effect and
// the manual Run button.
// ---------------------------------------------------------------------------

/**
 * Boil a draft predicate down to the predicate the backend should
 * actually run: drop incomplete rows, single-condition draft stays
 * un-wrapped, multi-condition draft becomes an AND group. Returns
 * ``null`` when there's nothing complete to run.
 *
 * The ``hash`` field is the JSON serialisation — used by the effect
 * and Run button to detect "the draft hasn't changed since the last
 * dispatch" (no need to re-fire).
 */


/**
 * Header rendered above the conditions list whenever 2+ filters exist.
 * Surfaces the root group operator (ALL = AND, ANY = OR) as a paired
 * pill toggle. Without this the user had no idea how their filters
 * combined — the DSL has always supported both ops, the UI just
 * hid it.
 */
function RootMatchHeader({
    op, onChange, disabled,
}: {
    op: RootGroupOp
    onChange: (next: RootGroupOp) => void
    disabled?: boolean
}) {
    return (
        <div className={cn(
            'flex items-center gap-2.5 mb-1 px-1',
            'text-[10.5px] font-semibold uppercase tracking-[0.12em]',
            'text-ink-muted',
        )}>
            <span>Match</span>
            <OperatorPill
                value={op}
                onChange={onChange}
                segments="three"
                size="md"
                disabled={disabled}
            />
            <span className="text-ink-muted/60 normal-case tracking-normal">
                {op === 'not'
                    ? 'inverts the entire query'
                    : 'of the filters below'}
            </span>
        </div>
    )
}


function ToggleBtn({
    active, onClick, children,
}: {
    active: boolean; onClick: () => void; children: ReactNode
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold',
                'transition-colors',
                active
                    ? 'bg-accent-lineage/20 text-accent-lineage'
                    : 'text-ink-muted hover:text-ink',
            )}
        >
            {children}
        </button>
    )
}


function DiscoveryTelemetry({
    loading, error, tags, keys, types,
}: {
    loading: boolean
    error: Error | null
    tags: number
    keys: number
    types: number
}) {
    if (loading) {
        return (
            <span className="inline-flex items-center gap-1 text-[10px] text-ink-muted">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading discovery…
            </span>
        )
    }
    if (error) {
        return (
            <span className="inline-flex items-center gap-1 text-[10px] text-rose-300" title={error.message}>
                <AlertCircle className="w-3 h-3" />
                Discovery failed
            </span>
        )
    }
    return (
        <span className="text-[10px] text-ink-muted tabular-nums">
            {types} types · {tags} tags · {keys} property keys
        </span>
    )
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function useEntityTypeNames(): string[] {
    const schema = useSchemaStore((s) => s.schema)
    if (!schema?.entityTypes) return []
    return schema.entityTypes.map((t) => t.id)
}


/**
 * Resolve layer options for the active view.
 *
 * Strategy:
 *   1. Sample DB-stored ``layer`` / ``layerAssignment`` property values
 *      (these are exactly what the BE will compare against). For each,
 *      enrich the label from the view config when possible.
 *   2. If discovery returns nothing, fall back to the view's reference-
 *      layout config — using ``layer.id`` as value (typical assignment
 *      writer) and ``layer.name`` as label.
 *
 * This handles both common conventions:
 *   - DB stores layer IDs → label is enriched from view config
 *   - DB stores layer names → label IS the value (visibly the same)
 */
function useViewLayerOptions(
    getValueSamples: (key: string) => unknown[],
): LayerOption[] {
    const activeView = useActiveView()
    return useMemo<LayerOption[]>(() => {
        const viewLayers = activeView?.layout?.referenceLayout?.layers ?? []
        const labelOf = new Map<string, string>()
        for (const l of viewLayers) {
            if (l.id) labelOf.set(l.id, l.name || l.id)
            if (l.name) labelOf.set(l.name, l.name)
        }

        const discovered = new Set<string>()
        for (const key of ['layer', 'layerAssignment']) {
            for (const v of getValueSamples(key)) {
                if (typeof v === 'string' && v) discovered.add(v)
            }
        }

        if (discovered.size > 0) {
            return Array.from(discovered)
                .sort()
                .map((value) => ({ value, label: labelOf.get(value) ?? value }))
        }

        return viewLayers
            .filter((l) => !!l.id)
            .map((l) => ({ value: l.id, label: l.name || l.id }))
            .sort((a, b) => a.label.localeCompare(b.label))
    }, [activeView, getValueSamples])
}
