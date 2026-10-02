/**
 * Root component for the visual predicate builder.
 *
 * Renders:
 *   1. A header with title + "Reset" affordance.
 *   2. The root GroupRow, which recursively renders the whole tree.
 *   3. The CandidateCountHint, debounced against the current tree.
 *   4. A primary "Run search" button (gradient, matches TemplateForm).
 *
 * The reducer state and discovery context are owned here; consumers
 * (SearchMapPanel) pass `viewId` and the run callback. An optional
 * `seed` prop pre-populates the tree when arriving from a template's
 * "Customize" handoff.
 */
import { motion } from 'framer-motion'
import {
    Boxes,
    RotateCcw,
    SlidersHorizontal,
    Tag,
    Unplug,
} from 'lucide-react'
import { type FC, useMemo, useEffect, useRef, type ComponentType } from 'react'

import { cn } from '@/lib/utils'
import {
    useSearchStore,
    useDraftPredicate,
    useDraftRevision,
} from '@/store/searchStore'
import type { Predicate } from '@/types/search'

import { GroupRow } from './GroupRow'
import { useBuilderReducer } from './useBuilderReducer'
import { useDiscovery } from './useDiscovery'
import type { EditorContext } from './editors'


/** Starter-chip catalogue for the empty-state hero. Each chip seeds
 *  the tree with a one-shot predicate via the reducer's `loadSeed`.
 *  Kept small (4 entries) so the user is not overwhelmed by choices —
 *  the full picker is one click away inside the AND group. */
interface StarterChip {
    label: string
    description: string
    icon: ComponentType<{ className?: string; strokeWidth?: number }>
    /** Tinted background used when the chip is hovered. */
    accent: string
    seed: () => Predicate
}

const STARTER_CHIPS: StarterChip[] = [
    {
        label: 'Find datasets',
        description: 'Start with everything classified as a dataset.',
        icon: Boxes,
        accent: 'from-blue-500/15 to-cyan-500/10 border-blue-500/30',
        seed: () => ({ kind: 'entityType', op: 'in', values: ['dataset'] }),
    },
    {
        label: 'Find PII',
        description: 'Anything tagged PII or GDPR.',
        icon: Tag,
        accent: 'from-fuchsia-500/15 to-purple-500/10 border-fuchsia-500/30',
        seed: () => ({ kind: 'tag', op: 'hasAny', values: ['PII', 'GDPR'] }),
    },
    {
        label: 'Find disconnected nodes',
        description: 'No incoming or outgoing lineage edges.',
        icon: Unplug,
        accent: 'from-amber-500/15 to-orange-500/10 border-amber-500/30',
        seed: () => ({ kind: 'isOrphan', edgeClass: 'lineage' }),
    },
    {
        label: 'Filter by property',
        description: 'Where a property matches a value.',
        icon: SlidersHorizontal,
        accent: 'from-emerald-500/15 to-green-500/10 border-emerald-500/30',
        seed: () => ({ kind: 'property', key: '', op: 'eq', value: '' }),
    },
]


export interface PredicateBuilderProps {
    /** Required — every search is bound to a view. */
    viewId: string
    /** Optional pre-populated tree (from a template's Customize action). */
    seed?: Predicate
    /** Entity types visible in the current view (drives EntityTypeEditor suggestions). */
    knownEntityTypes?: string[]
    /** Available layer names from the view config (drives LayerEditor select). */
    knownLayers?: string[]
    /** Reflects whether a query is currently in flight. The builder uses
     *  this only to disable inline affordances; the Run button now lives
     *  in QueryFooter at the panel-shell level. */
    isRunning: boolean
    /** No-op stub kept for callsite compatibility. The new persistent-
     *  workspace layout has no "back" navigation — the builder is always
     *  the canonical workspace tab. */
    onBack: () => void
    /** Legacy callback kept for callsite compatibility. Run is driven by
     *  QueryFooter via the predicate published to the store; this is no
     *  longer invoked from inside the builder. */
    onRun: (predicate: Predicate) => void
}


export const PredicateBuilder: FC<PredicateBuilderProps> = ({
    viewId, seed, knownEntityTypes = [], knownLayers = [], isRunning,
}) => {
    void isRunning  // retained on prop surface; the new QueryFooter owns the running indicator
    // Source-of-truth integration:
    // The store's ``draftPredicate`` is the canonical authoring state
    // shared between the visual builder and (post-W0.9) the JSON
    // editor. The builder owns its own reducer tree for path-aware
    // operations (addLeaf / removeAt / etc.), and:
    //   - mirrors its tree to the store on every change (so the JSON
    //     editor sees the latest), AND
    //   - subscribes to store-side ``draftRevision`` bumps so it can
    //     ``loadSeed`` when an EXTERNAL writer (template seed, JSON
    //     editor commit) replaces the predicate.
    // The legacy ``seed`` prop is still accepted for callers that
    // pre-populate via the old contract; it is treated as the initial
    // store seed.
    const draftPredicate = useDraftPredicate()
    const draftRevision = useDraftRevision()
    const seedDraftPredicate = useSearchStore((s) => s.seedDraftPredicate)
    const syncDraftFromBuilder = useSearchStore((s) => s.syncDraftFromBuilder)

    // Initial seed: prefer the explicit prop if given, otherwise fall
    // back to whatever the store currently holds. Either way the
    // reducer initialises with that value.
    const initialSeed = seed ?? draftPredicate ?? undefined
    const reducer = useBuilderReducer(initialSeed)

    // If the parent passes a NEW ``seed`` prop, treat that as a store
    // write — keeps callers like SearchMapPanel using the old contract
    // working until they're migrated to write directly via
    // ``seedDraftPredicate``.
    const lastSeenSeed = useRef<Predicate | undefined>(seed)
    useEffect(() => {
        if (seed && seed !== lastSeenSeed.current) {
            lastSeenSeed.current = seed
            seedDraftPredicate(seed)
        }
    }, [seed, seedDraftPredicate])

    // When ``draftRevision`` bumps from an external write, reload the
    // reducer tree to match. ``lastAppliedRevision`` lets the builder
    // ignore its own writes (which never bump revision but the effect
    // still fires).
    const lastAppliedRevision = useRef(draftRevision)
    useEffect(() => {
        if (draftRevision === lastAppliedRevision.current) return
        lastAppliedRevision.current = draftRevision
        if (draftPredicate) reducer.loadSeed(draftPredicate)
        else reducer.reset()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draftRevision])

    // Mirror reducer state → store on every change. This is the
    // "store knows the current predicate" promise that lets the JSON
    // editor read the live state.
    useEffect(() => {
        syncDraftFromBuilder(reducer.state.tree)
    }, [reducer.state.tree, syncDraftFromBuilder])

    // Mirror validation issues → store on every change so the panel
    // shell's QueryFooter can gate Run without re-deriving them.
    const setBuilderValidation = useSearchStore((s) => s.setBuilderValidation)
    useEffect(() => {
        setBuilderValidation(reducer.state.issues)
    }, [reducer.state.issues, setBuilderValidation])

    const {
        allKeys,
        keysByEntityType,
        tagValues,
        getValueSamples,
        edgeTypes,
        keysByEdgeType,
        getEdgeValueSamples,
        isInitialLoading: discoveryLoading,
        error: discoveryError,
        unavailable: discoveryUnavailable,
    } = useDiscovery(viewId)

    const ctx: EditorContext = useMemo(() => ({
        keysByEntityType,
        allKeys,
        knownEntityTypes,
        knownLayers,
        tagValues,
        getValueSamples,
        edgeTypes,
        keysByEdgeType,
        getEdgeValueSamples,
    }), [
        keysByEntityType, allKeys, knownEntityTypes, knownLayers,
        tagValues, getValueSamples, edgeTypes, keysByEdgeType, getEdgeValueSamples,
    ])

    const isEmpty = reducer.state.tree.children.length === 0

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-col gap-3"
        >
            {/* Discovery status: tells the user up-front whether the
                property-key / tag autocomplete is empty because it's
                still loading, errored, or genuinely returned nothing.
                Without this banner the user sees empty dropdowns and
                has no idea why. */}
            <DiscoveryStatusBanner
                loading={discoveryLoading}
                error={discoveryError}
                unavailable={discoveryUnavailable}
                keyCount={allKeys.length}
                tagCount={tagValues.length}
                edgeTypeCount={edgeTypes.length}
            />

            {/* Reset affordance — only shown when there's something to reset.
                The legacy "All questions" back-link is gone; tab navigation
                in the workspace shell replaces it. */}
            {!isEmpty && (
                <div className="flex items-center justify-end">
                    <button
                        type="button"
                        onClick={reducer.reset}
                        className={cn(
                            "inline-flex items-center gap-1.5 px-2 py-1 rounded-lg",
                            "text-[11px] font-medium text-ink-muted",
                            "hover:bg-glass/30 hover:text-ink",
                            "transition-colors",
                        )}
                    >
                        <RotateCcw className="w-3 h-3" strokeWidth={2.5} />
                        Reset
                    </button>
                </div>
            )}

            {isEmpty ? (
                /* Empty-state hero: brief explainer + one-click starter
                   chips. Clicking a chip seeds the tree; the next render
                   shows the regular builder layout (summary + tree). */
                <div className="flex flex-col gap-4">
                    <div className={cn(
                        "rounded-2xl p-5",
                        "bg-gradient-to-br from-accent-lineage/[0.08] via-canvas-elevated/40 to-purple-500/[0.04]",
                        "border border-accent-lineage/25",
                    )}>
                        <div className="text-base font-display font-semibold text-ink leading-tight">
                            Build your own query
                        </div>
                        <p className="mt-1.5 text-xs text-ink-muted leading-snug">
                            Pick a starting point below. You can add more conditions and combine
                            them with AND / OR / NOT after.
                        </p>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                        {STARTER_CHIPS.map((chip) => {
                            const Icon = chip.icon
                            return (
                                <button
                                    key={chip.label}
                                    type="button"
                                    onClick={() => reducer.loadSeed(chip.seed())}
                                    className={cn(
                                        "group relative text-left rounded-xl p-3.5",
                                        "bg-gradient-to-br border transition-all",
                                        chip.accent,
                                        "hover:brightness-110 hover:shadow-md hover:-translate-y-0.5",
                                        "focus:outline-none focus:ring-2 focus:ring-accent-lineage/40",
                                    )}
                                >
                                    <Icon className="w-5 h-5 text-ink mb-2" strokeWidth={1.8} />
                                    <div className="text-sm font-medium text-ink leading-tight">
                                        {chip.label}
                                    </div>
                                    <p className="mt-1 text-[10.5px] text-ink-muted leading-snug">
                                        {chip.description}
                                    </p>
                                </button>
                            )
                        })}
                    </div>

                    <div className={cn(
                        "rounded-lg px-3 py-2",
                        "bg-glass/30 border border-glass-border/60",
                        "text-[11px] text-ink-muted leading-snug",
                    )}>
                        <span className="font-medium text-ink">Tip:</span>{' '}
                        Each row in your query matches a node by one facet — a property value,
                        tag, edge count, entity type, layer, or text. Rows are AND-ed by default;
                        wrap them in OR or NOT groups to compose more complex conditions.
                    </div>
                </div>
            ) : (
                /* Non-empty: the recursive tree IS the canonical view of
                   the query. The status bar below combines compile
                   feedback + an opt-in "show technical details" panel
                   that exposes the executed Cypher for power users. */
                <>
                    <GroupRow
                        path={[]}
                        group={reducer.state.tree}
                        ctx={ctx}
                        issues={reducer.state.issues}
                        isRoot
                        onAddLeaf={reducer.addLeaf}
                        onAddGroup={reducer.addGroup}
                        onRemoveAt={reducer.removeAt}
                        onUpdateLeaf={reducer.updateLeaf}
                        onToggleGroupOp={reducer.toggleGroupOp}
                    />

                </>
            )}
        </motion.div>
    )
}


/**
 * Surface the state of the /search/discover call so the user knows
 * whether empty property-key / tag / value dropdowns are because:
 *   - discovery is still loading,
 *   - it errored (network / backend),
 *   - or it genuinely returned no queryable properties for this data
 *     source.
 *
 * Without this banner the editors silently show empty pickers and the
 * user has no idea autocomplete is offline.
 *
 * The one state it says NOTHING about is `unavailable` — discovery
 * refused to this caller (a share link; the sample spans the whole data
 * source, not the one view they hold). Every arm above is something the
 * reader can act on: wait, report, or type free text knowing why. A
 * refusal is none of those. It would stand on every open, for the life
 * of the link, over a builder that works perfectly well without
 * autocomplete.
 */
function DiscoveryStatusBanner({
    loading, error, unavailable, keyCount, tagCount, edgeTypeCount,
}: {
    loading: boolean
    error: Error | null
    unavailable: boolean
    keyCount: number
    tagCount: number
    edgeTypeCount: number
}) {
    if (unavailable) return null
    if (loading) {
        return (
            <div className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-lg',
                'text-[10.5px] text-ink-muted',
                'bg-canvas-base/30 border border-glass-border/40',
            )}>
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                Loading property keys, tags, and value samples for this data source…
            </div>
        )
    }
    if (error) {
        return (
            <div className={cn(
                'flex items-start gap-2 px-3 py-2 rounded-lg',
                'text-[10.5px] text-rose-300',
                'bg-rose-500/10 border border-rose-500/30',
            )}>
                <span className="w-2 h-2 mt-1 rounded-full bg-rose-400 shrink-0" />
                <span>
                    Discovery failed — autocomplete will be empty.{' '}
                    <span className="opacity-80">{error.message}</span>
                </span>
            </div>
        )
    }
    if (keyCount === 0 && tagCount === 0 && edgeTypeCount === 0) {
        return (
            <div className={cn(
                'flex items-start gap-2 px-3 py-2 rounded-lg',
                'text-[10.5px] text-amber-200/90',
                'bg-amber-500/10 border border-amber-500/30',
            )}>
                <span className="w-2 h-2 mt-1 rounded-full bg-amber-400 shrink-0" />
                <span>
                    No queryable properties, tags, or edge types were discovered for this
                    data source. Property pickers will fall back to free-text entry.
                </span>
            </div>
        )
    }
    return (
        <div className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-lg',
            'text-[10.5px] text-ink-muted/85',
            'bg-canvas-base/20 border border-glass-border/30',
        )}>
            <span className="w-2 h-2 rounded-full bg-emerald-400/70" />
            <span>
                Auto-fill ready: <span className="text-ink tabular-nums">{keyCount}</span> property keys ·{' '}
                <span className="text-ink tabular-nums">{tagCount}</span> tags ·{' '}
                <span className="text-ink tabular-nums">{edgeTypeCount}</span> edge types
            </span>
        </div>
    )
}
