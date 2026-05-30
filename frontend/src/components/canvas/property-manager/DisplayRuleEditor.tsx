/**
 * DisplayRuleEditor — author one display rule: a tag (name + color) plus
 * the search criteria that selects which entities get the tag.
 *
 * The criteria builder REUSES the Advanced-Search visual builder at the
 * store-decoupled boundary: ``useBuilderReducer`` (local tree state) +
 * ``GroupRow`` (recursive renderer) + ``useDiscovery`` (property / value
 * / tag autocomplete). It deliberately does NOT use ``PredicateBuilder``,
 * which is wired to the singleton ``searchStore`` and would collide with
 * the live Advanced-Search panel.
 *
 * "Preview" evaluates the current predicate via ``evaluateDisplayRule``
 * (the same view-scoped ``searchAdvanced`` the engine uses) so the user
 * sees the match count before saving.
 */
import { Check, Loader2, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { cn, generateId } from '@/lib/utils'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import type { DisplayRuleConfig } from '@/types/schema'
import type { Predicate } from '@/types/search'

import { GroupRow } from '../search/builder/GroupRow'
import { useBuilderReducer } from '../search/builder/useBuilderReducer'
import { useDiscovery } from '../search/builder/useDiscovery'
import type { EditorContext } from '../search/builder/editors'
import { fieldClass } from '../search/builder/editors/shared'
import { evaluateDisplayRule } from '@/services/displayRuleEval'


/** Curated swatch palette — premium, legible-on-dark tag colors. */
const SWATCHES = [
    '#6366f1', // indigo
    '#06b6d4', // cyan
    '#10b981', // emerald
    '#f59e0b', // amber
    '#ef4444', // red
    '#ec4899', // pink
    '#8b5cf6', // violet
    '#14b8a6', // teal
]


export interface DisplayRuleEditorProps {
    viewId: string
    /** Entity types known to the active view (drives EntityType editor). */
    knownEntityTypes: string[]
    /** Layer names from the view config (drives Layer editor). */
    knownLayers: string[]
    /** When editing an existing rule; omitted for a new rule. */
    rule?: DisplayRuleConfig
    onSave: (rule: DisplayRuleConfig) => void
    onCancel: () => void
}


export function DisplayRuleEditor({
    viewId, knownEntityTypes, knownLayers, rule, onSave, onCancel,
}: DisplayRuleEditorProps) {
    const provider = useGraphProvider()
    const [name, setName] = useState(rule?.name ?? '')
    const [color, setColor] = useState(rule?.color ?? SWATCHES[0])
    const [previewCount, setPreviewCount] = useState<number | null>(null)
    const [isPreviewing, setIsPreviewing] = useState(false)
    const [previewError, setPreviewError] = useState<string | null>(null)

    const reducer = useBuilderReducer((rule?.predicate as Predicate) ?? undefined)

    const {
        allKeys, keysByEntityType, tagValues, getValueSamples,
        edgeTypes, keysByEdgeType, getEdgeValueSamples,
    } = useDiscovery(viewId)

    const ctx: EditorContext = useMemo(() => ({
        keysByEntityType, allKeys, knownEntityTypes, knownLayers,
        tagValues, getValueSamples, edgeTypes, keysByEdgeType, getEdgeValueSamples,
    }), [
        keysByEntityType, allKeys, knownEntityTypes, knownLayers,
        tagValues, getValueSamples, edgeTypes, keysByEdgeType, getEdgeValueSamples,
    ])

    const predicate = reducer.state.tree
    const isEmpty = predicate.children.length === 0
    const canSave = name.trim().length > 0 && !isEmpty && !reducer.hasErrors

    // Re-running the preview invalidates a previous count; clear it on any
    // tree edit so the user never reads a stale number as current.
    const treeKey = JSON.stringify(predicate)
    const [previewedKey, setPreviewedKey] = useState<string | null>(null)
    const previewIsStale = previewedKey !== null && previewedKey !== treeKey

    const handlePreview = async () => {
        if (isEmpty || reducer.hasErrors) return
        setIsPreviewing(true)
        setPreviewError(null)
        try {
            const urns = await evaluateDisplayRule(provider, viewId, predicate)
            setPreviewCount(urns.length)
            setPreviewedKey(treeKey)
        } catch (e) {
            setPreviewError((e as Error).message)
            setPreviewCount(null)
        } finally {
            setIsPreviewing(false)
        }
    }

    const handleSave = () => {
        if (!canSave) return
        onSave({
            // Empty id ⇒ a seeded "new" rule from the Properties tab; mint
            // a fresh id so the drawer's save path treats it as an add.
            id: rule?.id || generateId('rule'),
            name: name.trim(),
            color,
            predicate,
            enabled: rule?.enabled ?? true,
            createdAt: rule?.createdAt ?? new Date().toISOString(),
        })
    }

    return (
        <div className="flex flex-col gap-4">
            {/* Tag identity — name + color */}
            <div className="flex flex-col gap-2.5">
                <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                    Tag label
                </label>
                <div className="flex items-center gap-2">
                    {/* Live chip preview */}
                    <span
                        className="px-2 py-0.5 rounded-md text-xs font-medium shrink-0 max-w-[40%] truncate"
                        style={{ backgroundColor: `${color}26`, color }}
                        title={name || 'Tag preview'}
                    >
                        {name.trim() || 'Tag'}
                    </span>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g. PII, Needs owner, Gold-certified"
                        className={fieldClass}
                        autoFocus
                    />
                </div>
                <div className="flex items-center gap-1.5">
                    {SWATCHES.map((sw) => (
                        <button
                            key={sw}
                            type="button"
                            onClick={() => setColor(sw)}
                            aria-label={`Use color ${sw}`}
                            className={cn(
                                'w-6 h-6 rounded-lg transition-all',
                                color === sw
                                    ? 'ring-2 ring-offset-2 ring-offset-canvas-elevated scale-110'
                                    : 'hover:scale-105 opacity-80 hover:opacity-100',
                            )}
                            style={{ backgroundColor: sw, ...(color === sw ? { boxShadow: `0 0 0 2px ${sw}` } : {}) }}
                        />
                    ))}
                </div>
            </div>

            {/* Criteria builder — reused Advanced-Search tree */}
            <div className="flex flex-col gap-2">
                <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                    Apply this tag to entities where…
                </label>
                <GroupRow
                    path={[]}
                    group={predicate}
                    ctx={ctx}
                    issues={reducer.state.issues}
                    isRoot
                    onAddLeaf={reducer.addLeaf}
                    onAddGroup={reducer.addGroup}
                    onRemoveAt={reducer.removeAt}
                    onUpdateLeaf={reducer.updateLeaf}
                    onToggleGroupOp={reducer.toggleGroupOp}
                />
            </div>

            {/* Preview row */}
            <div className="flex items-center justify-between gap-2">
                <button
                    type="button"
                    onClick={handlePreview}
                    disabled={isEmpty || reducer.hasErrors || isPreviewing}
                    className={cn(
                        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                        (isEmpty || reducer.hasErrors)
                            ? 'text-ink-muted/40 cursor-not-allowed bg-glass/20'
                            : 'text-accent-lineage bg-accent-lineage/10 hover:bg-accent-lineage/20',
                    )}
                >
                    {isPreviewing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Preview matches
                </button>
                {previewError ? (
                    <span className="text-[11px] text-rose-400 truncate">{previewError}</span>
                ) : previewCount !== null ? (
                    <span className={cn(
                        'text-[11px] tabular-nums',
                        previewIsStale ? 'text-ink-muted/60' : 'text-ink-muted',
                    )}>
                        <span className="text-ink font-semibold">{previewCount}</span>{' '}
                        {previewCount === 1 ? 'entity matches' : 'entities match'}
                        {previewIsStale && ' (edited — re-preview)'}
                    </span>
                ) : null}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-1 border-t border-glass-border/50">
                <button
                    type="button"
                    onClick={onCancel}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-glass/40 hover:text-ink transition-colors"
                >
                    <X className="w-3.5 h-3.5" /> Cancel
                </button>
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={!canSave}
                    className={cn(
                        'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all',
                        canSave
                            ? 'bg-accent-lineage text-white hover:bg-accent-lineage/90 shadow-sm shadow-accent-lineage/30'
                            : 'bg-glass/30 text-ink-muted/40 cursor-not-allowed',
                    )}
                >
                    <Check className="w-3.5 h-3.5" /> {rule ? 'Save rule' : 'Create rule'}
                </button>
            </div>
        </div>
    )
}
