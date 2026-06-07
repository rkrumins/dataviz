/**
 * PropertyOperationDialog — author one bulk property operation (create /
 * update / remove a property across a matched set of entities) and stage
 * it in-session. NO backend write happens — the op is recorded in
 * ``propertyDraftStore`` and surfaced optimistically over the catalogue.
 *
 * The target set is defined with the SAME flat-filter builder as Advanced
 * Search (``VisualQueryBuilder``) bound to local predicate state; a live
 * match count previews how many entities the op will touch.
 *
 * Portal-mounted (mirrors CreateRuleModal / SaveQueryDialog) so the
 * ``fixed inset-0`` overlay escapes the drawer's framer-motion transform.
 */
import { motion } from 'framer-motion'
import { AlertTriangle, Database, Loader2, Trash2, X } from 'lucide-react'
import {
    type FC, useEffect, useMemo, useState,
} from 'react'
import { createPortal } from 'react-dom'

import { useToast } from '@/components/ui/toast'
import { useAffectedSample, useValueDistribution } from '@/hooks/usePropertyInsights'
import { cn, generateId } from '@/lib/utils'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { countMatches, countPropertyUsageWithinTarget } from '@/services/propertyInsights'
import {
    usePropertyDraftStore,
    type PropertyOpKind,
    type PropertyValueType,
} from '@/store/propertyDraftStore'
import type { Predicate } from '@/types/search'

import { fieldClass } from '../search/builder/editors/shared'
import { isRowIncomplete } from '../search/panel/ConditionRow'
import { topLevelConditions } from '../search/panel/predicateComposition'
import { useDiscovery } from '../search/builder/useDiscovery'
import { VisualQueryBuilder } from '../search/panel/VisualQueryBuilder'


export type PropertyDialogMode = 'create' | 'update' | 'remove'

export interface PropertyOperationDialogProps {
    viewId: string
    mode: PropertyDialogMode
    /** Preset key for update / remove. */
    initialKey?: string
    knownEntityTypes: string[]
    knownLayers: string[]
    onClose: () => void
}

const OP_LABELS: Record<PropertyOpKind, string> = {
    set: 'Set value',
    fillEmpty: 'Fill if empty',
    rename: 'Rename key',
    remove: 'Remove',
}

const VALUE_TYPES: PropertyValueType[] = ['string', 'number', 'boolean']

const PREVIEW_DEBOUNCE_MS = 400


export const PropertyOperationDialog: FC<PropertyOperationDialogProps> = ({
    viewId, mode, initialKey = '', knownEntityTypes, knownLayers, onClose,
}) => {
    const provider = useGraphProvider()
    const { showToast } = useToast()
    const addOp = usePropertyDraftStore((s) => s.addOp)
    const { allKeys, keysByEntityType, tagValues, getValueSamples } = useDiscovery(viewId)

    const [key, setKey] = useState(initialKey)
    const [kind, setKind] = useState<PropertyOpKind>(mode === 'remove' ? 'remove' : 'set')
    const [newKey, setNewKey] = useState('')
    const [valueType, setValueType] = useState<PropertyValueType>('string')
    const [valueText, setValueText] = useState('')
    const [boolValue, setBoolValue] = useState(true)
    // Target set: seed update/remove with "has this property"; create starts blank.
    const [predicate, setPredicate] = useState<Predicate | null>(
        mode === 'create' || !initialKey
            ? null
            : ({ kind: 'hasProperty', key: initialKey, negate: false } as Predicate),
    )

    const [count, setCount] = useState<number | null>(null)
    const [counting, setCounting] = useState(false)
    // For a Set op: how many of the targeted entities already carry the key
    // (those values get overwritten). Drives the overwrite guidance.
    const [alreadySet, setAlreadySet] = useState<number | null>(null)

    const allowedKinds: PropertyOpKind[] = mode === 'remove'
        ? ['remove']
        : mode === 'create'
            ? ['set', 'fillEmpty']
            : ['set', 'fillEmpty', 'rename', 'remove']

    const discoveredLayers = useMemo(
        () => knownLayers.map((l) => ({ value: l, label: l })),
        [knownLayers],
    )

    const conditions = useMemo(() => topLevelConditions(predicate), [predicate])
    const predicateReady = conditions.length > 0 && !conditions.some((c) => isRowIncomplete(c))

    // ── Live match-count preview (debounced) ─────────────────────────
    const predicateKey = JSON.stringify(predicate)
    useEffect(() => {
        if (!predicateReady) { setCount(null); return }
        const controller = new AbortController()
        setCounting(true)
        const t = setTimeout(() => {
            countMatches(provider, viewId, predicate as Predicate, controller.signal)
                .then((n) => { if (!controller.signal.aborted) setCount(n) })
                .catch(() => { if (!controller.signal.aborted) setCount(null) })
                .finally(() => { if (!controller.signal.aborted) setCounting(false) })
        }, PREVIEW_DEBOUNCE_MS)
        return () => { controller.abort(); clearTimeout(t) }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider, viewId, predicateKey, predicateReady])

    const trimmedKey = key.trim()
    const trimmedNewKey = newKey.trim()
    const needsValue = kind === 'set' || kind === 'fillEmpty'
    const valueReady = !needsValue
        || valueType === 'boolean'
        || valueText.trim().length > 0
    const renameReady = kind !== 'rename' || (trimmedNewKey.length > 0 && trimmedNewKey !== trimmedKey)
    const canApply = trimmedKey.length > 0 && predicateReady && valueReady && renameReady

    const coercedValue = (): string | number | boolean | undefined => {
        if (!needsValue) return undefined
        if (valueType === 'boolean') return boolValue
        if (valueType === 'number') {
            const n = Number(valueText)
            return Number.isFinite(n) ? n : valueText
        }
        return valueText
    }

    // Existing values to suggest as quick-picks (known keys only).
    const dist = useValueDistribution(viewId, trimmedKey, needsValue && trimmedKey.length > 0)
    const valueSuggestions = dist.data?.values.slice(0, 8) ?? []

    // A sample of the entities this op will touch.
    const affected = useAffectedSample(viewId, predicate, predicateReady)

    // Overwrite guidance for Set: how many targets already have the key.
    useEffect(() => {
        if (kind !== 'set' || !predicateReady || !predicate || !trimmedKey) { setAlreadySet(null); return }
        const controller = new AbortController()
        const t = setTimeout(() => {
            countPropertyUsageWithinTarget(provider, viewId, trimmedKey, predicate, controller.signal)
                .then((n) => { if (!controller.signal.aborted) setAlreadySet(n) })
                .catch(() => { if (!controller.signal.aborted) setAlreadySet(null) })
        }, PREVIEW_DEBOUNCE_MS)
        return () => { controller.abort(); clearTimeout(t) }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider, viewId, predicateKey, predicateReady, kind, trimmedKey])

    // Plain function (not memoised) so it always reads the latest field
    // state — a stale-closure here silently staged the wrong value.
    const handleApply = () => {
        if (!canApply || !predicate) return
        const targetCount = count ?? 0
        addOp({
            id: generateId('propop'),
            kind,
            key: trimmedKey,
            newKey: kind === 'rename' ? trimmedNewKey : undefined,
            value: coercedValue(),
            valueType: needsValue ? valueType : undefined,
            predicate,
            targetCount,
            createdAt: new Date().toISOString(),
        })
        const verb = kind === 'remove' ? 'Remove' : kind === 'rename' ? 'Rename' : 'Set'
        showToast(
            'success',
            `Staged: ${verb} “${trimmedKey}”${kind === 'rename' ? ` → “${trimmedNewKey}”` : ''} on ${targetCount} ${targetCount === 1 ? 'entity' : 'entities'} — not yet saved`,
        )
        onClose()
    }

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { e.preventDefault(); onClose() }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleApply() }
    }

    const title = mode === 'create' ? 'New property'
        : mode === 'remove' ? 'Remove property'
            : 'Update property'

    if (typeof document === 'undefined') return null
    return createPortal(
        <div
            className="fixed inset-0 z-[80] flex items-center justify-center p-4"
            onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
            onKeyDown={onKeyDown}
        >
            <div className="absolute inset-0 bg-black/50" aria-hidden />
            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.15 }}
                className={cn(
                    'relative w-full max-w-lg rounded-2xl overflow-hidden flex flex-col max-h-[88vh]',
                    'bg-canvas-elevated border border-slate-200 dark:border-glass-border',
                    'shadow-2xl shadow-black/40',
                )}
                role="dialog"
                aria-modal="true"
            >
                {/* Header */}
                <div className="flex items-center gap-3 px-5 py-4 shrink-0 border-b border-slate-200 dark:border-glass-border/60">
                    <div className={cn(
                        'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                        mode === 'remove' ? 'bg-rose-500/15' : 'bg-accent-lineage/15',
                    )}>
                        {mode === 'remove'
                            ? <Trash2 className="w-5 h-5 text-rose-400" />
                            : <Database className="w-5 h-5 text-accent-lineage" />}
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-[15px] font-display font-bold text-ink leading-tight">{title}</h3>
                        <p className="text-[11.5px] text-ink-muted mt-0.5">
                            Apply to every entity matched by the criteria below. Staged in-session — not saved to the graph.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Cancel"
                        className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Body */}
                <div data-search-panel-content className="px-5 py-4 overflow-y-auto custom-scrollbar flex flex-col gap-4">
                    {/* Key */}
                    <label className="flex flex-col gap-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                            Property key
                        </span>
                        <input
                            type="text"
                            value={key}
                            onChange={(e) => setKey(e.target.value)}
                            disabled={mode !== 'create'}
                            placeholder="e.g. owner, certified, retentionDays"
                            className={cn(fieldClass, 'font-mono', mode !== 'create' && 'opacity-70 cursor-not-allowed')}
                            autoFocus={mode === 'create'}
                        />
                    </label>

                    {/* Operation */}
                    {allowedKinds.length > 1 && (
                        <div className="flex flex-col gap-1.5">
                            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                                Operation
                            </span>
                            <div className="inline-flex flex-wrap gap-1 p-1 rounded-xl bg-canvas-base/40 border border-glass-border/40">
                                {allowedKinds.map((k) => (
                                    <button
                                        key={k}
                                        type="button"
                                        onClick={() => setKind(k)}
                                        className={cn(
                                            'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all',
                                            kind === k
                                                ? (k === 'remove' ? 'bg-rose-500/20 text-rose-300' : 'bg-accent-lineage/20 text-accent-lineage shadow-sm')
                                                : 'text-ink-muted hover:text-ink hover:bg-glass/30',
                                        )}
                                    >
                                        {OP_LABELS[k]}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Value (set / fillEmpty) */}
                    {needsValue && (
                        <div className="flex flex-col gap-1.5">
                            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                                Value
                            </span>
                            <div className="flex items-center gap-2">
                                <select
                                    value={valueType}
                                    onChange={(e) => setValueType(e.target.value as PropertyValueType)}
                                    className={cn(fieldClass, 'w-28 shrink-0')}
                                >
                                    {VALUE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                                </select>
                                {valueType === 'boolean' ? (
                                    <button
                                        type="button"
                                        onClick={() => setBoolValue((v) => !v)}
                                        className={cn(
                                            'flex-1 px-3 py-2 rounded-lg text-[13px] font-mono text-left border transition-colors',
                                            boolValue
                                                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                                                : 'bg-glass/30 border-glass-border text-ink-muted',
                                        )}
                                    >
                                        {String(boolValue)}
                                    </button>
                                ) : (
                                    <input
                                        type={valueType === 'number' ? 'number' : 'text'}
                                        value={valueText}
                                        onChange={(e) => setValueText(e.target.value)}
                                        placeholder={valueType === 'number' ? '0' : 'value…'}
                                        className={cn(fieldClass, 'flex-1 font-mono')}
                                    />
                                )}
                            </div>
                            {/* Existing-value quick picks */}
                            {valueType === 'string' && valueSuggestions.length > 0 && (
                                <div className="flex flex-wrap items-center gap-1">
                                    <span className="text-[10px] text-ink-muted/70 mr-0.5">Existing:</span>
                                    {valueSuggestions.map((s) => (
                                        <button
                                            key={s.value}
                                            type="button"
                                            onClick={() => setValueText(s.value)}
                                            title={`${s.count} ${s.count === 1 ? 'entity' : 'entities'}`}
                                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-glass/40 text-ink-muted hover:bg-accent-lineage/15 hover:text-accent-lineage transition-colors"
                                        >
                                            {s.value || '∅'}
                                            <span className="tabular-nums opacity-60">{s.count}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* New key (rename) */}
                    {kind === 'rename' && (
                        <label className="flex flex-col gap-1.5">
                            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                                Rename to
                            </span>
                            <input
                                type="text"
                                value={newKey}
                                onChange={(e) => setNewKey(e.target.value)}
                                placeholder="new property key…"
                                className={cn(fieldClass, 'font-mono')}
                            />
                        </label>
                    )}

                    {/* Target criteria */}
                    <div className="flex flex-col gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                            Apply to entities where…
                        </span>
                        <VisualQueryBuilder
                            predicate={predicate}
                            onSeed={setPredicate}
                            onCommit={setPredicate}
                            discovery={{ allKeys, keysByEntityType, tagValues, getValueSamples }}
                            knownEntityTypes={knownEntityTypes}
                            discoveredLayers={discoveredLayers}
                        />
                    </div>

                    {/* Impact preview */}
                    {predicateReady && (
                        <div className="flex flex-col gap-2 rounded-xl border border-glass-border/60 bg-canvas-base/20 p-2.5">
                            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">Impact</span>
                            {/* Overwrite warning for Set */}
                            {kind === 'set' && alreadySet !== null && alreadySet > 0 && (
                                <div className="flex items-start gap-1.5 text-[11px] text-amber-300">
                                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                                    <span><span className="font-semibold tabular-nums">{alreadySet}</span> of {count ?? '…'} already have <span className="font-mono">{trimmedKey}</span> — its value will be overwritten. Use <span className="font-semibold">Fill if empty</span> to keep existing values.</span>
                                </div>
                            )}
                            {/* Affected sample */}
                            {affected.loading ? (
                                <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted"><Loader2 className="w-3 h-3 animate-spin" /> Loading affected entities…</span>
                            ) : affected.data && affected.data.entities.length > 0 ? (
                                <div className="flex flex-col gap-1">
                                    <span className="text-[11px] text-ink-muted">Affects e.g.</span>
                                    <div className="flex flex-wrap gap-1">
                                        {affected.data.entities.map((e) => (
                                            <span key={e.urn} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] bg-glass/40 max-w-[160px]" title={`${e.displayName} · ${e.entityType}`}>
                                                <span className="truncate text-ink">{e.displayName}</span>
                                                {e.entityType && <span className="text-ink-muted/70 shrink-0">{e.entityType}</span>}
                                            </span>
                                        ))}
                                        {affected.data.truncated && <span className="text-[10px] text-ink-muted/70 self-center">+ more</span>}
                                    </div>
                                </div>
                            ) : affected.data ? (
                                <span className="text-[11px] text-ink-muted/60">No entities match yet.</span>
                            ) : null}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between gap-2 px-5 py-3.5 shrink-0 border-t border-slate-200 dark:border-glass-border/60 bg-black/[0.02] dark:bg-white/[0.02]">
                    <div className="text-[11.5px] text-ink-muted tabular-nums min-w-0 truncate">
                        {!predicateReady ? (
                            <span className="text-ink-muted/60">Add a condition to target entities</span>
                        ) : counting ? (
                            'Counting matches…'
                        ) : count !== null ? (
                            <><span className="text-ink font-semibold">{count}</span> {count === 1 ? 'entity' : 'entities'} affected</>
                        ) : null}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            type="button"
                            onClick={onClose}
                            className="inline-flex items-center px-3.5 h-8 rounded-lg text-[12px] font-medium text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={handleApply}
                            disabled={!canApply}
                            title={canApply ? 'Stage operation (⌘/Ctrl + Enter)' : undefined}
                            className={cn(
                                'inline-flex items-center gap-1.5 px-3.5 h-8 rounded-lg text-[12px] font-semibold transition-colors',
                                canApply
                                    ? (kind === 'remove'
                                        ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-sm shadow-rose-600/30'
                                        : 'bg-accent-lineage hover:bg-accent-lineage/90 text-white shadow-sm shadow-accent-lineage/30')
                                    : 'bg-slate-100 dark:bg-white/5 text-slate-400 dark:text-ink-muted/60 cursor-not-allowed',
                            )}
                        >
                            Stage change
                        </button>
                    </div>
                </div>
            </motion.div>
        </div>,
        document.body,
    )
}
