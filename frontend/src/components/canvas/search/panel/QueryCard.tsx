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
import { motion } from 'framer-motion'
import {
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
    Save as SaveIcon,
    SquarePen,
    Tags,
    Undo2,
    Redo2,
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
import {
    useCanRedo,
    useCanUndo,
    useDraftPredicate,
    useSearchStore,
    type RecentQueryEntry,
} from '@/store/searchStore'
import type { Predicate, SearchQuery } from '@/types/search'
import type { RunState } from '@/hooks/useAdvancedSearch'

import { useDiscovery } from '../builder/useDiscovery'
import { useEntityTypeNames, useViewLayerOptions } from './useOmniboxFacets'

import { isRowIncomplete } from './ConditionRow'
import { CreateRuleModal } from './CreateRuleModal'
import type { LayerOption } from './layerOptions'
import { appendCondition, topLevelConditions } from './predicateComposition'
import { parsePredicate, stringifyPredicate } from './predicateDsl'
import { buildRunnablePredicate } from './runnablePredicate'
import { SearchOmnibox } from './omnibox/SearchOmnibox'
import { SaveQueryDialog } from './SaveQueryDialog'
import { VisualQueryBuilder } from './VisualQueryBuilder'


export interface QueryCardProps {
    viewId: string
    isRunning: boolean
    /** Which draft the runner last dispatched, and how it went. Drives
     *  the "unrun changes" state. Owned by ``useAdvancedSearch`` so it
     *  survives this component unmounting (the Advanced drawer) and
     *  reflects failures rather than intentions. */
    runState: RunState | null
    /** Run the current draft. Called debounced from row edits. MUST be
     *  referentially stable — the auto-run debounce keys its timer on
     *  it. */
    onRun: (predicate: Predicate, options?: SearchQuery['options']) => void
    /** Open Advanced drawer (for OR/NOT/path authoring). */
    onOpenAdvanced: () => void
}


/**
 * Search page size. Also the point at which we stop claiming the canvas
 * spotlight is complete and start telling the user to refine.
 *
 * Was 5000 (the backend's CANDIDATE_CAP) on the theory that the panel wanted
 * every match URN in one round-trip. In practice a broad query ("name")
 * matches thousands of nodes, and shipping all of them — each with a full
 * ancestor spine — into a Set plus two rollup maps on every debounced
 * keystroke is itself what makes the panel feel like it's grinding. A result
 * set that large wants refining, not painting.
 */
const SEARCH_PAGE_SIZE = 1000

/**
 * Ask for hits AND aggregates in one round-trip.
 *
 * `results: 'both'` costs one extra MATCH + GROUP BY over the candidate set
 * the backend has already capped — it is the cheapest response mode it has —
 * and it buys the thing that makes a 600-match result comprehensible: an exact
 * per-container match count. "612 matches in 4 groups" is an answer the user
 * can act on; 612 rows is a pile.
 *
 * Crucially the bucket counts are computed server-side over the FULL candidate
 * set, so they stay exact even when the hit list itself is capped at
 * SEARCH_PAGE_SIZE. Further hits are pulled on demand via the cursor
 * (useAdvancedSearch.loadMore).
 *
 * NOTE on `by: 'parent'`: buckets group by IMMEDIATE parent, so a match that is
 * itself a root has no bucket. The buckets therefore need not sum to
 * candidateCount — don't render them as a partition of the total.
 */
const SEARCH_OPTIONS: SearchQuery['options'] = {
    results: 'both',
    pageSize: SEARCH_PAGE_SIZE,
    // 3 sample hits per bucket: AggregateBucketCard previews them as chips, which
    // is what makes a group card worth reading ("what's actually in here?").
    aggregations: [{ by: 'parent', maxBuckets: 200, sampleHitsPerBucket: 3 }],
    includeAncestorPath: true,
}


type ViewMode = 'visual' | 'code'


export const QueryCard: FC<QueryCardProps> = ({
    viewId, isRunning, runState, onRun, onOpenAdvanced,
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
    const saveDraftAsMineEntry = useSearchStore((s) => s.saveDraftAsMineEntry)
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
    // ─── Run mode (auto vs manual) + dispatch ──────────────────────
    // Auto: dispatch a debounced run on every complete draft change
    //       (snappy, original behaviour — the default).
    // Manual: only dispatch when the user clicks Run. Avoids the perf
    //       hit of round-tripping the backend on every chip add /
    //       row edit while composing a multi-tier filter.
    const [runMode, setRunMode] = useRunMode()

    const runnable = useMemo(() => buildRunnablePredicate(draftPredicate), [draftPredicate])
    // "Has the current draft been dispatched?" — answered by the RUNNER
    // (useAdvancedSearch), not by this component. QueryCard used to own
    // this as local state set optimistically at dispatch time, which
    // broke two ways: a run that aborted or errored left the identical
    // draft permanently un-rerunnable, and opening the Advanced drawer
    // unmounts this component, silently resetting it.
    const hasPendingChanges = runnable !== null && runnable.hash !== runState?.hash

    const dispatchRun = useCallback(() => {
        if (!runnable) return
        onRun(runnable.predicate, SEARCH_OPTIONS)
    }, [runnable, onRun])

    useEffect(() => {
        // Nothing complete — clear results so the canvas spotlight
        // doesn't lag behind the user's edits (applies to both modes).
        // Use ``clearSearchResults`` (not ``clear``) so the user's
        // undo stack survives — they should be able to undo back to a
        // populated draft even after the canvas has gone dim.
        if (runnable === null) {
            // ``queryHash`` is the "results are published" sentinel —
            // only clear when there's actually something to drop.
            if (useSearchStore.getState().queryHash !== null) clearSearchResults()
            return
        }
        // Manual mode: wait for the explicit Run click.
        if (runMode === 'manual') return
        // Auto mode: debounce and dispatch when the draft differs from
        // whatever the runner last picked up. A draft that already
        // failed keeps its hash in runState, so a broken query is
        // dispatched once, not in a retry loop — the Run button stays
        // available to force a retry.
        if (!hasPendingChanges) return
        const t = setTimeout(dispatchRun, 250)
        return () => clearTimeout(t)
    }, [runnable, runMode, hasPendingChanges, clearSearchResults, dispatchRun])

    // Top-level conditions drive the header summary + the empty-hero
    // gate. The row mutation handlers themselves now live inside
    // VisualQueryBuilder (shared with the rule editor); QueryCard only
    // needs the count here.
    const conditions = useMemo(
        () => (draftPredicate ? topLevelConditions(draftPredicate) : []),
        [draftPredicate],
    )

    const handleClearAll = useCallback(() => {
        commitDraft(null)
    }, [commitDraft])

    // Save the current draft into the user's Mine library. Builds a
    // synthetic ``RecentQueryEntry`` from the live predicate +
    // ``stringifyPredicate`` so SaveQueryDialog can show the DSL
    // preview the same way it does for promote-from-recent. On
    // confirm, ``saveDraftAsMineEntry`` persists a pinned + named
    // entry that appears in the Library popover's Mine tab. The
    // dialog itself uses ``createPortal`` so it escapes the
    // panel's framer-motion stacking context.
    const [saveTargetEntry, setSaveTargetEntry] =
        useState<RecentQueryEntry | null>(null)
    const handleOpenSave = useCallback(() => {
        if (!draftPredicate) return
        setSaveTargetEntry({
            viewId,
            predicate: draftPredicate,
            label: stringifyPredicate(draftPredicate),
            timestamp: Date.now(),
            pinned: true,
            source: 'mine',
        })
    }, [draftPredicate, viewId])

    // Omnibox selection → append the chosen filter as a row. Uses
    // ``commitDraft`` (not ``seedDraftPredicate``) so adding a filter
    // is undoable, and ``appendCondition`` so it composes with whatever
    // is already there instead of replacing it.
    // Autofocus target for a row the omnibox just appended. Cleared on
    // a timeout once the row has mounted and taken focus — the same
    // mechanism VisualQueryBuilder uses for its own palette.
    const [freshRowKind, setFreshRowKind] = useState<string | null>(null)
    useEffect(() => {
        if (!freshRowKind) return
        const t = setTimeout(() => setFreshRowKind(null), 150)
        return () => clearTimeout(t)
    }, [freshRowKind])

    const handleAddFromOmnibox = useCallback((
        predicate: Predicate, complete: boolean,
    ) => {
        commitDraft(appendCondition(useSearchStore.getState().draftPredicate, predicate))
        // An incomplete row (e.g. "Name contains…" picked from the
        // browse tiles) is a prompt, not an answer — send the user
        // straight to its editor rather than leaving a dashed,
        // unexplained card sitting there.
        if (!complete) setFreshRowKind(predicate.kind ?? null)
    }, [commitDraft])

    // Text escalated from the canvas header's quick search. That path
    // stashes the typed string and calls "open the panel" — which is a
    // no-op when the panel is already open, so the old consumer (a
    // mount-only effect on the empty hero) never ran: the second
    // escalation appeared to do nothing, and the stale seed resurfaced
    // later when the hero next mounted. Subscribing to the store means
    // a seed is taken whenever one arrives, open or not. The nonce
    // remounts the omnibox so a repeat escalation actually lands.
    const pendingSeed = useSearchStore((s) => s.pendingSearchSeed)
    const [seed, setSeed] = useState<{ text: string; nonce: number }>(
        { text: '', nonce: 0 },
    )
    useEffect(() => {
        if (!pendingSeed) return
        const taken = useSearchStore.getState().consumePendingSearchSeed()
        if (taken) setSeed((prev) => ({ text: taken, nonce: prev.nonce + 1 }))
    }, [pendingSeed])

    // Property-value samples, flattened across every discovered key so
    // the omnibox can match a bare token against values as well as
    // names. The corpus is bounded server-side (20 values per key, 64
    // keys per label), so a linear scan is cheaper than any index.
    const valueSamples = useMemo(() => {
        const out: { key: string; value: string; lc: string }[] = []
        for (const key of discovery.allKeys) {
            for (const raw of discovery.getValueSamples(key)) {
                if (typeof raw !== 'string' && typeof raw !== 'number') continue
                const value = String(raw)
                if (!value) continue
                out.push({ key, value, lc: value.toLowerCase() })
            }
        }
        return out
    }, [discovery])

    // Create a display rule from the current query — opens the shared
    // DisplayRuleEditor (in a portal modal) seeded with the runnable
    // predicate so the criteria are pre-filled. Enabled whenever the
    // query is runnable (same gate as Save).
    const [ruleModalOpen, setRuleModalOpen] = useState(false)
    const handleOpenCreateRule = useCallback(() => {
        if (runnable) setRuleModalOpen(true)
    }, [runnable])

    // One omnibox instance, rendered in both states — as the hero when
    // nothing is composed, and as the compact "add another filter" bar
    // beneath the rows once something is. Before this, the empty state
    // mounted a name-only quick search and did NOT mount the builder,
    // so the whole filter palette was unreachable from a cold start and
    // reaching a property filter meant composing a text search and then
    // deleting it.
    // ─── Header summary ────────────────────────────────────────────
    const completeCount = conditions.filter((c) => !isRowIncomplete(c)).length
    const incompleteCount = conditions.length - completeCount

    // Empty state in Visual mode gets its own premium hero treatment —
    // no QUERY header chrome, no run controls (nothing to act on), just
    // a confident "start here" surface with example-led onboarding.
    const isEmptyVisual = mode === 'visual' && conditions.length === 0
    const showHeader = !isEmptyVisual

    const omnibox = (
        <SearchOmnibox
            key={`omnibox-${seed.nonce}`}
            variant={isEmptyVisual ? 'hero' : 'inline'}
            onAdd={handleAddFromOmnibox}
            onBrowseAll={onOpenAdvanced}
            entityTypes={knownEntityTypes}
            tagValues={discovery.tagValues}
            propertyKeys={discovery.allKeys}
            valueSamples={valueSamples}
            layers={discoveredLayers}
            initialQuery={seed.text}
            discoveryLoading={discovery.isInitialLoading}
            disabled={isRunning}
        />
    )

    return (
        <div
            data-search-panel-content
            className={cn(
                'rounded-2xl border border-glass-border bg-canvas-base/30',
                'flex flex-col',
            )}
        >
            {/* Unified header — title + actions in one bordered
                region. Previously the title strip and ActionFooter
                were two separate surfaces (title above body, footer
                below); per user feedback we merged them so the entire
                "manage this query" UI reads as one premium block at
                the top of the card. Body sits cleanly below.
                Two rows internally so the layout breathes:
                  Row 1 — Title · filter status               · Visual│Code
                  Row 2 — [↺ Back] [↶][↷] [Auto│Manual]          [🗑] [▷ Run]
            */}
            {showHeader && (
                <div className={cn(
                    'flex flex-col border-b border-glass-border/60',
                    'bg-black/[0.015] dark:bg-white/[0.02]',
                )}>
                    {/* Row 1 — title + editor mode */}
                    <div className="flex items-center gap-2 px-3 py-2">
                        <div className="flex items-baseline gap-1.5 min-w-0 flex-1">
                            <span className="text-[11.5px] font-display font-semibold text-ink leading-tight">
                                Query
                            </span>
                            {conditions.length > 0 ? (
                                <span className="text-[11px] text-ink-muted/85 tabular-nums truncate">
                                    · {completeCount}
                                    {' '}filter{completeCount === 1 ? '' : 's'}
                                    {incompleteCount > 0 && (
                                        <span className="text-amber-500 dark:text-amber-400/90 font-medium">
                                            {' '}· {incompleteCount} incomplete
                                        </span>
                                    )}
                                </span>
                            ) : (
                                <span className="text-[11px] text-ink-muted/80 italic truncate">
                                    · Code mode · paste DSL
                                </span>
                            )}
                        </div>
                        <div className={cn(
                            'inline-flex rounded-md p-0.5 shrink-0',
                            'bg-black/[0.04] dark:bg-white/[0.04]',
                            'border border-black/[0.08] dark:border-white/[0.06]',
                        )}>
                            <ToggleBtn active={mode === 'visual'} onClick={() => setMode('visual')}>
                                <Eye className="w-3 h-3" /> Visual
                            </ToggleBtn>
                            <ToggleBtn active={mode === 'code'} onClick={() => setMode('code')}>
                                <Code2 className="w-3 h-3" /> Code
                            </ToggleBtn>
                        </div>
                    </div>

                    {/* Row 2 — action toolbar (skipped in empty hero) */}
                    {conditions.length > 0 && (
                        <HeaderActions
                            canUndo={canUndo}
                            canRedo={canRedo}
                            onUndo={undo}
                            onRedo={redo}
                            canClear={true}
                            onClear={handleClearAll}
                            canSave={runnable !== null}
                            onSave={handleOpenSave}
                            canCreateRule={runnable !== null}
                            onCreateRule={handleOpenCreateRule}
                            runMode={runMode}
                            onRunModeChange={setRunMode}
                            canRun={runnable !== null}
                            hasPendingChanges={hasPendingChanges}
                            isRunning={isRunning}
                            onRunNow={dispatchRun}
                        />
                    )}
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
                            omnibox={omnibox}
                            onSeed={(p) => commitDraft(p)}
                            onUseCodeMode={() => setMode('code')}
                            discoveredEntityTypes={knownEntityTypes}
                            discoveredTags={discovery.tagValues}
                            discoveredLayers={discoveredLayers}
                            discoveryLoading={discovery.isInitialLoading}
                            discoveryError={discovery.error}
                            propertyKeyCount={discovery.allKeys.length}
                        />
                    ) : (
                        <>
                            <VisualQueryBuilder
                                predicate={draftPredicate}
                                onSeed={seedDraftPredicate}
                                onCommit={commitDraft}
                                discovery={{
                                    allKeys: discovery.allKeys,
                                    keysByEntityType: discovery.keysByEntityType,
                                    tagValues: discovery.tagValues,
                                    getValueSamples: discovery.getValueSamples,
                                }}
                                knownEntityTypes={knownEntityTypes}
                                discoveredLayers={discoveredLayers}
                                isRunning={isRunning}
                                discoveryLoading={discovery.isInitialLoading}
                                discoveryError={discovery.error}
                                freshKind={freshRowKind}
                                onSubmit={dispatchRun}
                                onOpenAdvanced={onOpenAdvanced}
                                onOpenCode={handleOpenCode}
                                enableRowSelection
                            />
                            {/* Same surface, compact: the omnibox is how
                                you add the 2nd filter as well as the 1st,
                                so there's one thing to learn. */}
                            {omnibox}
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

            {/* Save-query dialog — mounts via createPortal so it
                escapes the panel's framer-motion stacking context
                (see SaveQueryDialog doc). State is local to QueryCard
                because the Save button is the only trigger. */}
            {saveTargetEntry && (
                <SaveQueryDialog
                    entry={saveTargetEntry}
                    onCancel={() => setSaveTargetEntry(null)}
                    onSave={(name, description) => {
                        saveDraftAsMineEntry({
                            viewId: saveTargetEntry.viewId,
                            predicate: saveTargetEntry.predicate,
                            label: saveTargetEntry.label,
                            name,
                            description,
                        })
                        setSaveTargetEntry(null)
                    }}
                />
            )}

            {/* Create-display-rule modal — hosts the shared
                DisplayRuleEditor seeded with the current query so the
                user can tag every match with one click. Portal-mounted
                (inside CreateRuleModal) for the same stacking reason as
                SaveQueryDialog. */}
            {ruleModalOpen && runnable && (
                <CreateRuleModal
                    viewId={viewId}
                    seedPredicate={runnable.predicate}
                    knownEntityTypes={knownEntityTypes}
                    knownLayers={discoveredLayers.map((o) => o.label)}
                    onClose={() => setRuleModalOpen(false)}
                />
            )}
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
    omnibox, onSeed, onUseCodeMode,
    discoveredEntityTypes, discoveredTags, discoveredLayers,
    discoveryLoading, discoveryError, propertyKeyCount,
}: {
    /** The SearchOmnibox, owned by QueryCard so the same instance can
     *  also render beneath the rows once the query is non-empty. */
    omnibox: ReactNode
    onSeed: (p: Predicate) => void
    onUseCodeMode: () => void
    discoveredEntityTypes: string[]
    discoveredTags: string[]
    discoveredLayers: LayerOption[]
    discoveryLoading: boolean
    discoveryError: Error | null
    propertyKeyCount: number
}) {
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
                            Type anything — a name, a tag, a type, a property, a
                            value — and pick what you meant. Or browse by category.
                            Everything offered comes from your real data.
                        </p>
                    </div>
                </div>
            </div>

            {/* The omnibox is the entry point: one input that reads
                what you type against tags, entity types, property
                keys, sampled property VALUES, layers and lineage
                shape at once. It replaced a name-only quick search,
                which was why reaching a property filter used to mean
                composing a text search and then deleting it. */}
            <div className="relative px-5 pb-3">
                {omnibox}
            </div>

            {/* Examples — the teaching surface. The omnibox above is
                the fast path; these explain, in a sentence each, what a
                query of that shape actually does. Trimmed to three now
                that the omnibox carries its own "start with something
                real" list. Recents live in the header's Library. */}
            <div className="relative px-3 pb-3">
                <div className="flex flex-col gap-1.5">
                    {examples.slice(0, 3).map((ex, i) => (
                        <ExampleCard key={i} index={i} example={ex} onSeed={onSeed} />
                    ))}
                </div>
            </div>

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
 * HeaderActions — action toolbar rendered as the second row of the
 * unified QueryCard header. Three groups, separated visually so each
 * reads as a distinct concern:
 *
 *   [↺ Back] [↶][↷]   ·   [Auto │ Manual]   ·   [🗑]  [▷ Run]
 *    history          ·    dispatch mode    ·   destructive + primary
 *
 * The old design had this toolbar as a separate "ActionFooter" below
 * the body. User feedback pushed for one cohesive header surface; this
 * sits inside the header card, sharing its bordered region. Subtle
 * top divider visually separates Row 1 (title + Visual/Code) from
 * Row 2 (this) without splitting the card.
 */
function HeaderActions({
    canUndo, canRedo, onUndo, onRedo,
    canClear, onClear,
    canSave, onSave,
    canCreateRule, onCreateRule,
    runMode, onRunModeChange,
    canRun, hasPendingChanges, isRunning, onRunNow,
}: {
    canUndo: boolean
    canRedo: boolean
    onUndo: () => void
    onRedo: () => void
    canClear: boolean
    onClear: () => void
    canSave: boolean
    onSave: () => void
    canCreateRule: boolean
    onCreateRule: () => void
    runMode: 'auto' | 'manual'
    onRunModeChange: (next: 'auto' | 'manual') => void
    canRun: boolean
    hasPendingChanges: boolean
    isRunning: boolean
    onRunNow: () => void
}) {
    return (
        <div className={cn(
            'flex items-center gap-2 gap-y-2 flex-wrap',
            'px-3 pb-2 pt-1.5',
            'border-t border-slate-200/70 dark:border-glass-border/40',
        )}>
            {/* LEFT — secondary utilities (history + mode) */}
            <div className="flex items-center gap-1 flex-nowrap shrink-0">
                <UndoRedoButtons
                    canUndo={canUndo}
                    canRedo={canRedo}
                    onUndo={onUndo}
                    onRedo={onRedo}
                />
            </div>
            <div className="shrink-0">
                <RunModeToggle
                    runMode={runMode}
                    onRunModeChange={onRunModeChange}
                />
            </div>

            {/* RIGHT — workflow + primary CTA. ``ml-auto`` anchors the
                cluster to the trailing edge of the row. Order within
                the cluster follows form-button convention: workflow
                actions (New, Save) sit just left of the primary CTA
                (Run) which is always the rightmost element so the
                user's mouse naturally lands on the "Go" action.
                ``gap-2`` between the workflow icons and Run gives
                Run its own visual breathing room. */}
            <div className="flex items-center gap-2 ml-auto flex-nowrap shrink-0">
                <div className="flex items-center gap-1 flex-nowrap">
                    <NewQueryButton
                        onClear={onClear}
                        disabled={!canClear || isRunning}
                    />
                    <SaveQueryButton
                        onSave={onSave}
                        disabled={!canSave || isRunning}
                    />
                    <CreateRuleButton
                        onCreateRule={onCreateRule}
                        disabled={!canCreateRule || isRunning}
                    />
                </div>
                <RunButton
                    runMode={runMode}
                    canRun={canRun}
                    hasPendingChanges={hasPendingChanges}
                    isRunning={isRunning}
                    onRunNow={onRunNow}
                />
            </div>
        </div>
    )
}


/**
 * "New query" — discards the current draft and resets the panel to
 * the empty hero so the user can start fresh without manually
 * deleting filters. Renamed from "Clear all" per user feedback:
 * users couldn't discover the action by intent ("I want to start a
 * new search") because the previous trash icon read as destructive
 * cleanup rather than a workflow step.
 *
 * Icon: ``SquarePen`` — the same "compose new" affordance Linear /
 * Notion / Slack use for "create a new note / message". Reads
 * intuitively as "start writing something new" rather than the
 * generic "+" which is too ambiguous next to the existing "+ Add
 * filter" button inside the body.
 */
function NewQueryButton({
    onClear, disabled,
}: {
    onClear: () => void
    disabled?: boolean
}) {
    return (
        <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            title="New query (clears current filters)"
            aria-label="New query"
            className={cn(
                'inline-flex items-center gap-1 px-2 h-7 rounded-md',
                'text-[11px] font-medium border transition-colors',
                disabled
                    ? cn(
                        'border-transparent text-ink-muted/40 cursor-not-allowed',
                    )
                    : cn(
                        'border-slate-200 dark:border-glass-border/60',
                        'text-ink-secondary hover:text-accent-lineage',
                        'hover:bg-accent-lineage/10 hover:border-accent-lineage/40',
                    ),
            )}
        >
            <SquarePen className="w-3.5 h-3.5" />
            New
        </button>
    )
}


/**
 * "Save query" — persists the current draft into the user's Mine
 * library via the SaveQueryDialog. Opens the dialog with a synthetic
 * RecentQueryEntry built from the live draft + its DSL stringify;
 * on confirm, the store action ``saveDraftAsMineEntry`` creates a
 * pinned, named entry that shows up in the Library popover's Mine
 * tab. Disabled when there's no runnable draft (nothing to save).
 *
 * Icon: ``Save`` — the universal floppy-disk save glyph. Recognised
 * across business users regardless of technical background; far
 * less ambiguous than the previous ``BookmarkPlus`` which read as
 * "add bookmark" rather than "save to library".
 */
function SaveQueryButton({
    onSave, disabled,
}: {
    onSave: () => void
    disabled?: boolean
}) {
    return (
        <button
            type="button"
            onClick={onSave}
            disabled={disabled}
            title={disabled
                ? 'Add at least one complete filter to save'
                : 'Save this query to your library'}
            aria-label="Save query"
            className={cn(
                'inline-flex items-center gap-1 px-2 h-7 rounded-md',
                'text-[11px] font-medium border transition-colors',
                disabled
                    ? cn(
                        'border-transparent text-ink-muted/40 cursor-not-allowed',
                    )
                    : cn(
                        'border-slate-200 dark:border-glass-border/60',
                        'text-ink-secondary hover:text-amber-500',
                        'hover:bg-amber-500/10 hover:border-amber-400/40',
                    ),
            )}
        >
            <SaveIcon className="w-3.5 h-3.5" />
            Save
        </button>
    )
}


/**
 * "Create rule" — turn the current query into a Property Manager
 * display rule (tags every match with a colored chip on the canvas).
 * Opens the shared DisplayRuleEditor seeded with the query. Disabled
 * when there's no runnable draft (same gate as Save).
 */
function CreateRuleButton({
    onCreateRule, disabled,
}: {
    onCreateRule: () => void
    disabled?: boolean
}) {
    return (
        <button
            type="button"
            onClick={onCreateRule}
            disabled={disabled}
            title={disabled
                ? 'Add at least one complete filter to tag matches'
                : 'Create a display rule from this query'}
            aria-label="Create display rule"
            className={cn(
                'inline-flex items-center gap-1 px-2 h-7 rounded-md',
                'text-[11px] font-medium border transition-colors',
                disabled
                    ? cn(
                        'border-transparent text-ink-muted/40 cursor-not-allowed',
                    )
                    : cn(
                        'border-slate-200 dark:border-glass-border/60',
                        'text-ink-secondary hover:text-accent-lineage',
                        'hover:bg-accent-lineage/10 hover:border-accent-lineage/40',
                    ),
            )}
        >
            <Tags className="w-3.5 h-3.5" />
            Tag
        </button>
    )
}


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


/**
 * RunModeToggle — Auto/Manual segmented control. Split out from the
 * old combined ``RunControls`` so the HeaderActions layout can place
 * the mode toggle in the mid-left action cluster while the primary
 * Run CTA anchors to the far right (where users instinctively look
 * for the "Go" action — same affordance as a form's Submit button).
 */
function RunModeToggle({
    runMode, onRunModeChange,
}: {
    runMode: 'auto' | 'manual'
    onRunModeChange: (next: 'auto' | 'manual') => void
}) {
    const manualLabel = runMode === 'manual'
        ? 'Manual — only runs on click'
        : 'Auto — runs on every edit (250ms debounce)'
    return (
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
    )
}


/**
 * RunButton — primary CTA. Sits at the far right of the action
 * toolbar so it follows the standard form-action convention
 * (primary action on the right; cancel/secondary on the left).
 * Uses the ContextViewHeader primary-action palette (subtle accent
 * gradient + accent text + accent border), not a solid coloured
 * button — reads as the primary action without shouting. Pulse
 * state intensifies the gradient and adds an amber dot when
 * Manual mode has pending edits.
 */
function RunButton({
    runMode, canRun, hasPendingChanges, isRunning, onRunNow,
}: {
    runMode: 'auto' | 'manual'
    canRun: boolean
    hasPendingChanges: boolean
    isRunning: boolean
    onRunNow: () => void
}) {
    const pulse = runMode === 'manual' && hasPendingChanges && !isRunning
    return (
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
                'relative inline-flex items-center gap-1.5 px-3 h-7 rounded-lg',
                'text-[12px] font-semibold transition-all duration-200',
                'border',
                !canRun || isRunning
                    ? cn(
                        'bg-black/[0.04] border-black/[0.10]',
                        'text-ink-muted/60 cursor-not-allowed',
                        'dark:bg-white/[0.04] dark:border-white/[0.08]',
                    )
                    : pulse
                        ? cn(
                            'bg-gradient-to-r from-accent-lineage/25 to-accent-lineage/15',
                            'text-accent-lineage border-accent-lineage/50',
                            'shadow-sm shadow-accent-lineage/20',
                            'hover:from-accent-lineage/35 hover:to-accent-lineage/20',
                        )
                        : cn(
                            'bg-gradient-to-r from-accent-lineage/15 to-accent-lineage/[0.08]',
                            'text-accent-lineage border-accent-lineage/35',
                            'shadow-sm shadow-accent-lineage/10',
                            'hover:from-accent-lineage/20 hover:to-accent-lineage/[0.12]',
                            'hover:border-accent-lineage/50',
                        ),
            )}
        >
            {isRunning ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2.4} />
            ) : (
                <Play className="w-3.5 h-3.5" strokeWidth={2.4} fill="currentColor" />
            )}
            Run
            {pulse && (
                <span className={cn(
                    'absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full',
                    'bg-amber-400 ring-2 ring-amber-400/30 animate-pulse',
                )} />
            )}
        </button>
    )
}


// ---------------------------------------------------------------------------
// Run-mode persistence
// ---------------------------------------------------------------------------

const RUN_MODE_KEY = 'synodic.advancedSearch.runMode'
type RunMode = 'auto' | 'manual'

function useRunMode(): [RunMode, (next: RunMode) => void] {
    const [mode, setMode] = useState<RunMode>(() => {
        // Auto is the default: a filter you edit should show you its
        // results. Manual used to be the default "for safety", but a
        // business user who tweaks a value and sees nothing happen
        // concludes the panel is broken, not that they need to find a
        // Run button — and the 250ms debounce already covers the
        // round-trip cost that motivated it. Manual stays one click
        // away for power users composing a multi-tier filter, and is
        // persisted per browser.
        try {
            return localStorage.getItem(RUN_MODE_KEY) === 'manual'
                ? 'manual' : 'auto'
        } catch {
            return 'auto'
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


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

