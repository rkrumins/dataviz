/**
 * VisualQueryBuilder — the store-agnostic flat-filter builder shared by
 * the Advanced-Search QueryCard and the Property Manager's
 * DisplayRuleEditor.
 *
 *   ⊕ Match  ALL │ ANY │ NOT  of the filters below
 *   ┌─ ConditionRow ─────────────────────────── ⋯ × ┐
 *   │ ⌕ Text in name…  [ name ▾ ] [ contains ▾ ]     │
 *   │                  [ customer                  ]  │
 *   └─────────────────────────────────────────────────┘
 *   + Add filter…                       12 tags · 37 keys
 *
 * Everything here is driven by props — a ``predicate`` + two write
 * callbacks (``onSeed`` for transient value edits, ``onCommit`` for
 * structural add/remove/wrap/duplicate/root-op changes). The QueryCard
 * wires those to ``seedDraftPredicate`` / ``commitDraft`` (preserving its
 * undo/redo semantics exactly); the rule editor wires both to a local
 * ``setState``. This is the single source of truth for "build a query
 * visually" so the two surfaces can never drift.
 */
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, AlertCircle, Loader2 } from 'lucide-react'
import { type FC, useCallback, useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'

import { AddFilterPalette } from './AddFilterPalette'
import { OperatorPill } from './builder-atoms/OperatorPill'
import { RowJoiner } from './builder-atoms/RowJoiner'
import type { OpTone } from './builder-atoms/tones'
import { ConditionRow } from './ConditionRow'
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
import { WhatThisMeansDisclosure } from './WhatThisMeansDisclosure'


export interface VisualQueryBuilderProps {
    predicate: Predicate | null
    /** Transient per-keystroke value edits — caller should NOT push undo
     *  history for these (matches QueryCard's ``seedDraftPredicate``). */
    onSeed: (next: Predicate | null) => void
    /** Structural changes (add / remove / wrap / duplicate / root-op) —
     *  caller may push undo history (QueryCard's ``commitDraft``). */
    onCommit: (next: Predicate | null) => void
    discovery: {
        allKeys: string[]
        keysByEntityType: Record<string, string[]>
        tagValues: string[]
        getValueSamples: (key: string) => unknown[]
    }
    counts: { entityTypes: number; tags: number; propertyKeys: number; layers: number }
    samples?: {
        entityTypes?: ReadonlyArray<string>
        tags?: ReadonlyArray<string>
        propertyKeys?: ReadonlyArray<string>
        layers?: ReadonlyArray<string>
    }
    knownEntityTypes: string[]
    discoveredLayers: LayerOption[]
    isRunning?: boolean
    discoveryLoading?: boolean
    discoveryError?: Error | null
    /** Enter inside a scalar value field fires this (QueryCard wires it
     *  to its Run dispatch). */
    onSubmit?: () => void
    /** Omit to hide the row "Open Advanced" handoff + any advanced
     *  palette entries (the rule editor has no Advanced drawer). */
    onOpenAdvanced?: () => void
    /** Omit to hide the code-only palette entries (path, withinHops). */
    onOpenCode?: (kind: 'path' | 'withinHops') => void
    /** When true (QueryCard), rows participate in the global bulk-select
     *  store; omit (rule editor) for plain, non-selectable rows. */
    enableRowSelection?: boolean
}


export const VisualQueryBuilder: FC<VisualQueryBuilderProps> = ({
    predicate, onSeed, onCommit, discovery, counts, samples,
    knownEntityTypes, discoveredLayers, isRunning = false,
    discoveryLoading = false, discoveryError = null,
    onSubmit, onOpenAdvanced, onOpenCode, enableRowSelection = false,
}) => {
    // ``onOpenAdvanced`` is required by ConditionRow / NestedGroupCard
    // (depth-cap + group hand-off). When the host omits it, substitute a
    // no-op so those children render without crashing; the palette's
    // advanced entries are separately hidden by AddFilterPalette.
    const openAdvanced = onOpenAdvanced ?? NOOP

    // Identifies the most recently inserted condition kind so the new
    // row's first editor gets autofocus on mount. Cleared on a timeout
    // so subsequent edits don't re-trigger focus.
    const [freshKind, setFreshKind] = useState<string | null>(null)

    const conditions = useMemo(
        () => (predicate ? topLevelConditions(predicate) : []),
        [predicate],
    )
    const activeEntityTypes = useMemo<string[]>(() => {
        const et = conditions.find((c) => c.kind === 'entityType')
        return et && et.kind === 'entityType' ? et.values : []
    }, [conditions])

    const currentRootOp = rootGroupOp(predicate)

    const handleRowChange = useCallback((index: number, next: Predicate) => {
        // Index-based replace preserves the root group op and tolerates
        // duplicate kinds. Value edits seed (no history).
        onSeed(replaceConditionAt(predicate, index, next))
    }, [predicate, onSeed])

    const handleRowRemove = useCallback((index: number) => {
        onCommit(removeConditionAt(predicate, index))
    }, [predicate, onCommit])

    const handleAddOne = useCallback((p: Predicate) => {
        onCommit(appendCondition(predicate, p))
        setFreshKind(p.kind ?? null)
        setTimeout(() => setFreshKind(null), 150)
    }, [predicate, onCommit])

    const handleAddMany = useCallback((preds: Predicate[]) => {
        let next = predicate
        for (const p of preds) next = appendCondition(next, p)
        onCommit(next)
        const last = preds[preds.length - 1]
        if (last) {
            setFreshKind(last.kind ?? null)
            setTimeout(() => setFreshKind(null), 150)
        }
    }, [predicate, onCommit])

    const handleRootOpChange = useCallback((op: RootGroupOp) => {
        onCommit(setRootGroupOp(predicate, op))
    }, [predicate, onCommit])

    const handleRowWrap = useCallback((index: number, op: OpTone) => {
        onCommit(wrapConditionAt(predicate, index, op))
    }, [predicate, onCommit])

    const handleRowDuplicate = useCallback((index: number) => {
        onCommit(duplicateConditionAt(predicate, index))
    }, [predicate, onCommit])

    const sharedDiscovery = {
        allKeys: discovery.allKeys,
        keysByEntityType: discovery.keysByEntityType,
        tagValues: discovery.tagValues,
        getValueSamples: discovery.getValueSamples,
    }

    return (
        <>
            <WhatThisMeansDisclosure predicate={predicate} />
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
                                onOpenAdvanced={openAdvanced}
                                onSubmit={onSubmit}
                                disabled={isRunning}
                                discovery={sharedDiscovery}
                                knownEntityTypes={knownEntityTypes}
                                activeEntityTypes={activeEntityTypes}
                                discoveredLayers={discoveredLayers}
                                parentPath={enableRowSelection ? '' : undefined}
                                index={enableRowSelection ? i : undefined}
                            />
                        ) : (
                            <ConditionRow
                                value={cond}
                                discovery={sharedDiscovery}
                                knownEntityTypes={knownEntityTypes}
                                activeEntityTypes={activeEntityTypes}
                                discoveredLayers={discoveredLayers}
                                isRunning={isRunning}
                                autoFocus={cond.kind === freshKind}
                                onChange={(next) => handleRowChange(i, next)}
                                onRemove={() => handleRowRemove(i)}
                                onWrap={(w) => handleRowWrap(i, w)}
                                onDuplicate={() => handleRowDuplicate(i)}
                                onOpenAdvanced={openAdvanced}
                                onSubmit={onSubmit}
                                parentPath={enableRowSelection ? '' : undefined}
                                index={enableRowSelection ? i : undefined}
                            />
                        )}
                    </motion.div>
                ))}
            </AnimatePresence>
            <ExpensiveQueryNotice predicate={predicate} />
            <div className="flex items-center gap-2 pt-1 flex-wrap">
                <AddFilterPalette
                    counts={counts}
                    samples={samples}
                    onAdd={handleAddOne}
                    onAddMany={handleAddMany}
                    onOpenAdvanced={onOpenAdvanced}
                    onOpenCode={onOpenCode}
                    disabled={isRunning}
                />
                <DiscoveryTelemetry
                    loading={discoveryLoading}
                    error={discoveryError}
                    tags={counts.tags}
                    keys={counts.propertyKeys}
                    types={counts.entityTypes}
                />
            </div>
        </>
    )
}


const NOOP = () => { /* no Advanced drawer in this context */ }


// ---------------------------------------------------------------------------
// Root-op header (shown when 2+ filters exist)
// ---------------------------------------------------------------------------

/**
 * Surfaces the root group operator (ALL = AND, ANY = OR, NOT = invert)
 * as a paired pill toggle above the conditions list.
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


// ---------------------------------------------------------------------------
// Expensive-query warning
// ---------------------------------------------------------------------------

/**
 * Inspect the current draft for predicate shapes that historically
 * cost the FalkorDB planner the most: topology probes (isOrphan /
 * isRoot / isLeaf) without any narrowing leaf next to them, plus
 * empty predicates. Surfaces a visible warning so the user knows the
 * query may be slow BEFORE they run / save it.
 */
function detectExpensiveShape(p: Predicate | null): string | null {
    if (!p) return null
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
// Discovery telemetry chip
// ---------------------------------------------------------------------------

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
