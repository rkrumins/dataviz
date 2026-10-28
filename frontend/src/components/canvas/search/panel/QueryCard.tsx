/**
 * QueryCard — the single Query Lens that holds the entire active query.
 *
 *   ╭─ Form · Sentence · Code · Cypher ─ New  Save  Tag ─╮
 *   │ Find  Entities │ Connections     ↶ ↷   Auto  ▶ Run │
 *   ├────────────────────────────────────────────────────┤
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
 * The header (QueryHeader) is there in every editor and every state.
 * Switching editors does NOT lose state — Form, Sentence and Code all
 * write the same draft, and Cypher shows the Cypher that draft runs as.
 *
 * Discovery telemetry shows next to the Add-filter button as a passive
 * chip ("12 tags · 37 keys · 4 types") so the user sees what
 * autocomplete will offer without opening anything.
 */
import { motion } from 'framer-motion'
import {
    Loader2,
    AlertCircle,
    Sparkles,
    X,
} from 'lucide-react'
import {
    type FC,
    type ReactNode,
    useCallback,
    useEffect,
    useMemo,
    useState,
} from 'react'

import { DocsLink } from '@/components/help/DocsLink'
import { cn } from '@/lib/utils'
import { useGraphProviderIfAvailable } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSchemaStore } from '@/store/schema'
import { useLibraryCanEdit, useViewLibraryStore } from '@/store/viewLibraryStore'
import {
    useCanRedo,
    useCanUndo,
    useDraftPredicate,
    useSearchStore,
    type RecentQueryEntry,
} from '@/store/searchStore'
import type { EdgesPredicate, Predicate, SearchQuery } from '@/types/search'
import type { RunState } from '@/hooks/useAdvancedSearch'

import { useDiscovery } from '../builder/useDiscovery'
import { SEARCH_OPTIONS } from '../searchOptions'

import { isRowIncomplete } from './ConditionRow'
import { CreateRuleModal } from './CreateRuleModal'
import { entityTypesInView, useViewLayerOptions, type LayerOption } from './layerOptions'
import { AddFilterPalette } from './AddFilterPalette'
import { AskBar } from './ask/AskBar'
import { useAskVocabulary } from './ask/useAskVocabulary'
import { useEditorMode } from './builderMode'
import { CypherView } from './CypherView'
import { isNativeResult } from './native/nativeCells'
import { ConnectionBuilder } from './ConnectionBuilder'
import { ConnectionSentence } from './ConnectionSentence'
import { CodeMode } from './dsl/CodeMode'
import type { DslVocabulary } from './dsl/dslLanguage'
import { useEdgeTypeOptions } from './edgeTypeOptions'
import { namePathFor, searchEntitiesByName } from './entityNames'
import { findModeOf, NO_RULE_FOR_CONNECTIONS, queryLabel, toConnections, toEntities, type FindMode } from './findMode'
import { appendCondition, topLevelConditions } from './predicateComposition'
import { buildRunnablePredicate } from './runnablePredicate'
import { SearchOmnibox } from './omnibox/SearchOmnibox'
import { QueryHeader } from './QueryHeader'
import { SaveQueryDialog } from './SaveQueryDialog'
import { RelationProvider } from './RelationshipEditor'
import { RecipeGallery } from './recipes/RecipeGallery'
import type { Recipe } from './recipes/recipes'
import { useRecipes } from './recipes/useRecipes'
import { SentenceBuilder } from './sentence/SentenceBuilder'
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
    /** Start from a recipe: one ready to run runs; one with something to
     *  fill in opens for it. */
    onPickRecipe: (recipe: Recipe) => void
}


export const QueryCard: FC<QueryCardProps> = ({
    viewId, isRunning, runState, onRun, onPickRecipe,
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
    const saveViewQuery = useViewLibraryStore((s) => s.saveQuery)
    const canSaveToView = useLibraryCanEdit()
    // clearSearchResults wipes match URNs / ancestor maps but leaves
    // draft + history alone — needed by the auto-run effect so an
    // empty draft doesn't destroy the history stack the user just
    // pushed by clicking "Clear all".
    const clearSearchResults = useSearchStore((s) => s.clearSearchResults)
    const discovery = useDiscovery(viewId)
    // What a relationship row's edge filter offers: the discovered edge keys.
    const edgeDiscovery = useMemo(() => ({
        edgeTypes: discovery.edgeTypes,
        keysByEdgeType: discovery.keysByEdgeType,
        getEdgeValueSamples: discovery.getEdgeValueSamples,
        edgeKeyStoredAs: discovery.edgeKeyStoredAs,
    }), [discovery.edgeTypes, discovery.keysByEdgeType, discovery.getEdgeValueSamples,
        discovery.edgeKeyStoredAs])
    const knownEntityTypes = useEntityTypeNames()
    // What the omnibox, the Ask examples and the recipes offer: the types this
    // view's data holds, most common first — every "Everything of type …"
    // returns something. The ontology's full list until discovery answers.
    const presentEntityTypes = useMemo(
        () => entityTypesInView(discovery.discovery?.labels, knownEntityTypes),
        [discovery.discovery, knownEntityTypes],
    )
    // Layers are a VIEW concept, not an entity property — the
    // ``layerAssignment`` values entities carry, named from the view's
    // reference-layout config, or else the view's configured layers.
    const discoveredLayers = useViewLayerOptions(discovery.getValueSamples)
    const askVocabulary = useAskVocabulary(discovery, discoveredLayers)
    const recipes = useRecipes(presentEntityTypes, discovery.tagValues, discovery.allKeys, discoveredLayers)
    const inStudio = useSearchStore((s) => s.studioOpen)
    // What Code mode's editor completes from: the view's own types, tags,
    // layers and keys, values and names from the server as they're typed.
    const provider = useGraphProviderIfAvailable()
    const remote = provider instanceof RemoteGraphProvider ? provider : null
    const edgeTypeOptions = useEdgeTypeOptions(discovery.edgeTypes)
    const vocabulary = useMemo<DslVocabulary>(() => ({
        entityTypes: presentEntityTypes,
        tags: discovery.tagValues,
        layers: discoveredLayers.map((l) => l.value),
        propertyKeys: discovery.allKeys,
        edgeKeys: [...new Set(Object.values(discovery.keysByEdgeType).flat())].sort(),
        edgeTypes: edgeTypeOptions.map((o) => ({
            id: o.id, detail: [o.name, o.ends].filter(Boolean).join(' · '), containment: o.containment,
        })),
        suggestValues: discovery.suggestValues,
        names: remote ? {
            search: (word, signal) => searchEntitiesByName(remote, viewId, word, { signal }),
            pathFor: (entity) => namePathFor(remote, viewId, entity),
        } : undefined,
    }), [presentEntityTypes, discovery.tagValues, discoveredLayers, discovery.allKeys,
        discovery.keysByEdgeType, edgeTypeOptions, discovery.suggestValues, remote, viewId])

    const [mode, setMode] = useEditorMode()

    // Entities or Connections: the draft's own kind. Switching rewrites the
    // draft as one undo step, and says what it left out.
    const findMode = findModeOf(draftPredicate)
    const connections = draftPredicate?.kind === 'edges' ? draftPredicate : null
    const [switchNotice, setSwitchNotice] = useState<{ text: string; draft: Predicate | null } | null>(null)
    const handleFindMode = useCallback((next: FindMode) => {
        const current = useSearchStore.getState().draftPredicate
        if (findModeOf(current) === next) return
        const switched = next === 'connections'
            ? toConnections(current)
            : toEntities(current as EdgesPredicate)
        commitDraft(switched.next)
        setSwitchNotice(switched.dropped.length ? {
            text: `Left out: ${joinedAnd(switched.dropped)}${next === 'connections'
                ? ' — a connection is one edge' : ''}. Undo brings ${switched.dropped.length === 1
                ? 'it' : 'them'} back.`,
            draft: switched.next,
        } : null)
    }, [commitDraft])

    // "Edit in Code" from the Form or the Sentence: Code mode, with that
    // condition selected. Leaving Code mode forgets it.
    const [codeFocus, setCodeFocus] = useState<Predicate | null>(null)
    if (mode !== 'code' && codeFocus) setCodeFocus(null)
    const editInCode = useCallback((target?: Predicate) => {
        setCodeFocus(target ?? null)
        setMode('code')
    }, [setMode])
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

    // A question applied is a change of shape, and runs at once: Auto runs
    // the committed draft itself, Manual is told to.
    const handleAsk = useCallback((result: Predicate) => {
        commitDraft(result, 'ask')
        if (runMode !== 'manual') return
        const next = buildRunnablePredicate(result)
        if (next) onRun(next.predicate, SEARCH_OPTIONS)
    }, [commitDraft, runMode, onRun])

    useEffect(() => {
        // Nothing complete — clear results so the canvas spotlight
        // doesn't lag behind the user's edits (applies to both modes).
        // Use ``clearSearchResults`` (not ``clear``) so the user's
        // undo stack survives — they should be able to undo back to a
        // populated draft even after the canvas has gone dim.
        if (runnable === null) {
            // ``queryHash`` is the "results are published" sentinel —
            // only clear when there's actually something to drop, and
            // never a native query's highlight, which no draft produced.
            const published = useSearchStore.getState().queryHash
            if (published !== null && !isNativeResult(published)) clearSearchResults()
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
    // ``queryLabel`` so SaveQueryDialog can show the DSL
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
            label: queryLabel(draftPredicate),
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

    // The empty hero's way to every kind of filter: the palette the rows
    // end with once something is composed, fed the way VisualQueryBuilder
    // feeds it.
    const paletteCounts = useMemo(() => ({
        entityTypes: knownEntityTypes.length,
        tags: discovery.tagValues.length,
        propertyKeys: discovery.allKeys.length,
        layers: discoveredLayers.length,
    }), [knownEntityTypes, discovery.tagValues, discovery.allKeys, discoveredLayers])
    const paletteSamples = useMemo(() => ({
        entityTypes: knownEntityTypes.slice(0, 8),
        tags: discovery.tagValues.slice(0, 8),
        propertyKeys: discovery.allKeys.slice(0, 8),
        layers: discoveredLayers.slice(0, 8).map((o) => o.label),
    }), [knownEntityTypes, discovery.tagValues, discovery.allKeys, discoveredLayers])
    const handleAddFromPalette = useCallback((predicate: Predicate) => {
        handleAddFromOmnibox(predicate, !isRowIncomplete(predicate))
    }, [handleAddFromOmnibox])
    const handleAddManyFromPalette = useCallback((predicates: Predicate[]) => {
        let next = useSearchStore.getState().draftPredicate
        for (const p of predicates) next = appendCondition(next, p)
        commitDraft(next)
        const last = predicates[predicates.length - 1]
        if (last && isRowIncomplete(last)) setFreshRowKind(last.kind ?? null)
    }, [commitDraft])

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

    // ─── Header summary ────────────────────────────────────────────
    // The filters still to fill in. A Connections search counts the
    // conditions of its two ends.
    const summarised = connections
        ? [...topLevelConditions(connections.sourceWhere ?? null), ...topLevelConditions(connections.targetWhere ?? null)]
        : conditions
    const incompleteCount = summarised.filter(isRowIncomplete).length

    // An empty Form or Sentence opens on a "start here" body — the ways in —
    // under the same header as ever, so the other editors stay a click away.
    const pointing = mode === 'sentence' || mode === 'form'
    const isEmptyVisual = pointing && conditions.length === 0

    // Form is built from filters, as it always was: the empty card opens
    // on "add a filter" (the omnibox), which stays beneath the rows after,
    // with the Ask bar a step below as the other way in. Sentence leads
    // with the Ask bar.
    const askBar = (variant: 'hero' | 'compact', examples = variant === 'hero') => (
        <AskBar viewId={viewId} vocabulary={askVocabulary} draft={draftPredicate} onAsk={handleAsk}
                presentTypes={presentEntityTypes} variant={variant} examples={examples} disabled={isRunning} />
    )

    const omnibox = (
        <SearchOmnibox
            variant={isEmptyVisual ? 'hero' : 'inline'}
            onAdd={handleAddFromOmnibox}
            entityTypes={presentEntityTypes}
            tagValues={discovery.tagValues}
            propertyKeys={discovery.allKeys}
            valueSamples={valueSamples}
            layers={discoveredLayers}
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
            {/* The header, in every editor and state: the editors, what
                to find, history, and the actions on the query. */}
            <QueryHeader
                mode={mode}
                onModeChange={setMode}
                findMode={findMode}
                onFindModeChange={handleFindMode}
                incomplete={incompleteCount}
                canUndo={canUndo}
                canRedo={canRedo}
                onUndo={undo}
                onRedo={redo}
                canClear={draftPredicate !== null}
                onClear={handleClearAll}
                canSave={runnable !== null}
                onSave={handleOpenSave}
                canCreateRule={runnable !== null && !connections}
                ruleRefusal={connections ? NO_RULE_FOR_CONNECTIONS : undefined}
                onCreateRule={handleOpenCreateRule}
                runMode={runMode}
                onRunModeChange={setRunMode}
                canRun={runnable !== null}
                hasPendingChanges={hasPendingChanges}
                isRunning={isRunning}
                onRunNow={dispatchRun}
            />

            {/* Body — Form / Sentence / Code / Cypher */}
            <div className="flex flex-col gap-2 p-2.5">
                {switchNotice && switchNotice.draft === draftPredicate && (
                    <SwitchNotice text={switchNotice.text} onDismiss={() => setSwitchNotice(null)} />
                )}
                {pointing ? (
                    isEmptyVisual ? (
                        <EmptyStart
                            byFilters={mode === 'form'}
                            entry={mode === 'form' ? omnibox : askBar('hero')}
                            orAsk={mode === 'form' ? askBar('compact', true) : null}
                            palette={
                                <AddFilterPalette
                                    counts={paletteCounts}
                                    samples={paletteSamples}
                                    onAdd={handleAddFromPalette}
                                    onAddMany={handleAddManyFromPalette}
                                    disabled={isRunning}
                                />
                            }
                            // Search Studio shows every recipe beside the card.
                            recipes={inStudio ? null : (
                                <RecipeGallery viewId={viewId} recipes={recipes} variant="starters"
                                               onPick={onPickRecipe} />
                            )}
                            discoveredEntityTypes={presentEntityTypes}
                            discoveredTags={discovery.tagValues}
                            discoveredLayers={discoveredLayers}
                            discoveryLoading={discovery.isInitialLoading}
                            discoveryError={discovery.error}
                            propertyKeyCount={discovery.allKeys.length}
                        />
                    ) : connections && mode === 'sentence' ? (
                        <RelationProvider viewId={viewId} edges={edgeDiscovery}>
                            {askBar('compact')}
                            <ConnectionSentence
                                viewId={viewId}
                                value={connections}
                                onSeed={seedDraftPredicate}
                                onCommit={commitDraft}
                                discovery={{
                                    allKeys: discovery.allKeys,
                                    keysByEntityType: discovery.keysByEntityType,
                                    tagValues: discovery.tagValues,
                                    getValueSamples: discovery.getValueSamples,
                                    suggestValues: discovery.suggestValues,
                                }}
                                knownEntityTypes={knownEntityTypes}
                                presentEntityTypes={presentEntityTypes}
                                discoveredLayers={discoveredLayers}
                                isRunning={isRunning}
                                onSubmit={dispatchRun}
                                onEditInCode={() => setMode('code')}
                            />
                        </RelationProvider>
                    ) : connections ? (
                        <RelationProvider viewId={viewId} edges={edgeDiscovery}>
                            <ConnectionBuilder
                                value={connections}
                                onSeed={seedDraftPredicate}
                                onCommit={commitDraft}
                                viewId={viewId}
                                discovery={{
                                    allKeys: discovery.allKeys,
                                    keysByEntityType: discovery.keysByEntityType,
                                    tagValues: discovery.tagValues,
                                    getValueSamples: discovery.getValueSamples,
                                    suggestValues: discovery.suggestValues,
                                }}
                                knownEntityTypes={knownEntityTypes}
                                discoveredLayers={discoveredLayers}
                                isRunning={isRunning}
                                onSubmit={dispatchRun}
                            />
                            {askBar('compact')}
                        </RelationProvider>
                    ) : mode === 'sentence' ? (
                        <RelationProvider viewId={viewId} edges={edgeDiscovery}>
                            {askBar('compact')}
                            <SentenceBuilder
                                viewId={viewId}
                                predicate={draftPredicate}
                                onSeed={seedDraftPredicate}
                                onCommit={commitDraft}
                                discovery={{
                                    allKeys: discovery.allKeys,
                                    keysByEntityType: discovery.keysByEntityType,
                                    tagValues: discovery.tagValues,
                                    getValueSamples: discovery.getValueSamples,
                                    suggestValues: discovery.suggestValues,
                                }}
                                knownEntityTypes={knownEntityTypes}
                                presentEntityTypes={presentEntityTypes}
                                discoveredLayers={discoveredLayers}
                                isRunning={isRunning}
                                onSubmit={dispatchRun}
                                onEditInCode={editInCode}
                            />
                        </RelationProvider>
                    ) : (
                        <>
                            <RelationProvider viewId={viewId} edges={edgeDiscovery}>
                                <VisualQueryBuilder
                                    predicate={draftPredicate}
                                    onSeed={seedDraftPredicate}
                                    onCommit={commitDraft}
                                    discovery={{
                                        allKeys: discovery.allKeys,
                                        keysByEntityType: discovery.keysByEntityType,
                                        tagValues: discovery.tagValues,
                                        getValueSamples: discovery.getValueSamples,
                                        suggestValues: discovery.suggestValues,
                                    }}
                                    knownEntityTypes={knownEntityTypes}
                                    discoveredLayers={discoveredLayers}
                                    isRunning={isRunning}
                                    discoveryLoading={discovery.isInitialLoading}
                                    discoveryError={discovery.error}
                                    freshKind={freshRowKind}
                                    onSubmit={dispatchRun}
                                    onEditInCode={editInCode}
                                    enableRowSelection
                                />
                            </RelationProvider>
                            {/* Same surface, compact: the omnibox is how
                                you add the 2nd filter as well as the 1st,
                                so there's one thing to learn. */}
                            {omnibox}
                            {askBar('compact')}
                        </>
                    )
                ) : mode === 'code' ? (
                    <CodeMode
                        draft={draftPredicate}
                        isRunning={isRunning}
                        onCommit={commitDraft}
                        vocabulary={vocabulary}
                        onOpenCypher={() => setMode('cypher')}
                        focus={codeFocus}
                    />
                ) : (
                    <CypherView viewId={viewId} />
                )}
            </div>

            {/* Save-query dialog — mounts via createPortal so it
                escapes the panel's framer-motion stacking context
                (see SaveQueryDialog doc). State is local to QueryCard
                because the Save button is the only trigger. */}
            {saveTargetEntry && (
                <SaveQueryDialog
                    entry={saveTargetEntry}
                    canSaveToView={canSaveToView}
                    onCancel={() => setSaveTargetEntry(null)}
                    onSave={async (name, description, destination) => {
                        if (destination === 'view') {
                            await saveViewQuery({ name, description, predicate: saveTargetEntry.predicate })
                        } else {
                            saveDraftAsMineEntry({
                                viewId: saveTargetEntry.viewId,
                                predicate: saveTargetEntry.predicate,
                                label: saveTargetEntry.label,
                                name,
                                description,
                            })
                        }
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
// The empty Form or Sentence — where a search starts
// ---------------------------------------------------------------------------

/**
 * The body of an empty Form or Sentence, under the card's header: a line
 * on how to start, the way in — "add a filter" in Form, the Ask bar in
 * Sentence — recipes to start from (in the view's own words, each with how
 * many it finds), and what the view holds to search.
 */
function EmptyStart({
    byFilters, entry, orAsk, palette, recipes,
    discoveredEntityTypes, discoveredTags, discoveredLayers,
    discoveryLoading, discoveryError, propertyKeyCount,
}: {
    /** Built from filters (Form), or asked in plain words (Sentence). */
    byFilters: boolean
    /** The way in: "add a filter", or the Ask bar. */
    entry: ReactNode
    /** In Form, the Ask bar as the other way in. */
    orAsk: ReactNode
    /** Every kind of filter, by category — the "+ Add filter" palette. */
    palette: ReactNode
    /** Recipes to start from. */
    recipes: ReactNode
    discoveredEntityTypes: string[]
    discoveredTags: string[]
    discoveredLayers: LayerOption[]
    discoveryLoading: boolean
    discoveryError: Error | null
    propertyKeyCount: number
}) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
                'relative overflow-hidden rounded-xl flex flex-col',
                'bg-gradient-to-br from-accent-lineage/[0.07] via-canvas-elevated/30 to-purple-500/[0.05]',
                'ring-1 ring-inset ring-accent-lineage/[0.08]',
            )}
        >
            {/* Decorative wash — adds depth without competing for attention */}
            <div className="pointer-events-none absolute -top-12 -right-12 w-40 h-40 rounded-full bg-accent-lineage/10 blur-3xl" />

            <div className="relative flex items-start gap-2.5 px-4 pt-3.5 pb-2.5">
                <div className={cn(
                    'w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
                    'bg-gradient-to-br from-accent-lineage/30 to-cyan-500/15',
                    'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]',
                )}>
                    <Sparkles className="w-3.5 h-3.5 text-accent-lineage" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                        <div className="text-[13px] font-display font-semibold text-ink leading-tight">
                            {byFilters ? 'Start with a filter' : 'Ask about this view'}
                        </div>
                        <DocsLink slug="advanced-search" newTab label="Guide" className="text-[11px] font-medium" />
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-ink-muted leading-snug">
                        {byFilters
                            ? 'What it is, how it connects, what it\'s tagged — matches show as you go.'
                            : 'In plain words — see what it reads as before anything changes.'}
                    </p>
                </div>
            </div>

            {/* The way in — "add a filter" in Form, a question in plain
                words in Sentence — then every kind of filter. In Form the
                Ask bar follows, as the other way in. */}
            <div className="relative px-4 pb-3 flex flex-col gap-2">
                {entry}
                <div>{palette}</div>
                {orAsk}
            </div>

            {/* Recipes — questions people come here with, ready to run
                against this view. The Ask bar above is the fast path;
                recents live in the header's Library. */}
            {recipes && <div className="relative px-2.5 pb-2.5">{recipes}</div>}

            <div className="relative px-4 py-2.5 border-t border-glass-border/40 bg-canvas-base/20">
                <EmptyDiscoveryHint
                    loading={discoveryLoading}
                    error={discoveryError}
                    types={discoveredEntityTypes.length}
                    tags={discoveredTags.length}
                    keys={propertyKeyCount}
                    layers={discoveredLayers.length}
                />
            </div>
        </motion.div>
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


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** What a switch between Entities and Connections left out, until the next
 *  change or dismissed. */
function SwitchNotice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
    return (
        <div role="status" className={cn(
            'flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[11.5px] leading-snug',
            'border-amber-400/40 bg-amber-500/[0.08] text-amber-900 dark:text-amber-100',
        )}>
            <span className="flex-1 min-w-0">{text}</span>
            <button type="button" onClick={onDismiss} aria-label="Dismiss"
                    className="shrink-0 rounded p-0.5 text-amber-800/70 hover:text-amber-900 dark:text-amber-100/70 dark:hover:text-amber-100">
                <X className="w-3 h-3" />
            </button>
        </div>
    )
}

/** Names as a list reads: "A", "A and B", "A, B and C". */
function joinedAnd(items: string[]): string {
    return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function useEntityTypeNames(): string[] {
    const schema = useSchemaStore((s) => s.schema)
    if (!schema?.entityTypes) return []
    return schema.entityTypes.map((t) => t.id)
}


