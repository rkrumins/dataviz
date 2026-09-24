/**
 * DisplayRuleEditor — author one display rule: a tag (name + color +
 * optional icon) plus the search criteria that selects which entities get
 * the tag.
 *
 * The criteria builder REUSES the Advanced-Search flat-filter builder
 * verbatim via the store-decoupled ``VisualQueryBuilder`` — the exact
 * same "Add filter" palette + ConditionRow cards + "What this means"
 * summary the Advanced-Search QueryCard renders — driven by local
 * predicate state instead of the singleton ``searchStore``. This keeps
 * the two surfaces pixel-identical and prevents drift.
 *
 * Premium UX:
 *   - live preview-as-you-build (debounced match count) + an explicit
 *     refresh affordance,
 *   - colour + Lucide-icon picker so chips can carry an icon,
 *   - duplicate-name guard, inline validation,
 *   - keyboard support (Esc cancels, ⌘/Ctrl+Enter saves).
 */
import { Check, Loader2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { cn, generateId } from '@/lib/utils'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { countRules } from '@/services/ruleCounts'
import type { DisplayRuleConfig } from '@/types/schema'
import type { Predicate } from '@/types/search'

import { useDiscovery } from '../search/builder/useDiscovery'
import { fieldClass } from '../search/builder/editors/shared'
import { isRowIncomplete } from '../search/panel/ConditionRow'
import { topLevelConditions } from '../search/panel/predicateComposition'
import { VisualQueryBuilder } from '../search/panel/VisualQueryBuilder'


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

/** Small, business-friendly Lucide icon set for tag chips. */
const ICON_CHOICES = [
    'Tag', 'ShieldCheck', 'AlertTriangle', 'Star', 'Flag', 'Lock',
    'Eye', 'Database', 'Users', 'Sparkles', 'CircleDot', 'Bookmark',
]

/** Debounce (ms) for live preview-as-you-build. */
const PREVIEW_DEBOUNCE_MS = 500


export interface DisplayRuleEditorProps {
    viewId: string
    /** Entity types known to the active view (drives EntityType editor). */
    knownEntityTypes: string[]
    /** Layer names from the view config (drives Layer editor). */
    knownLayers: string[]
    /** When editing an existing rule; omitted for a new rule. */
    rule?: DisplayRuleConfig
    /** Names already in use by OTHER enabled rules — drives the
     *  duplicate-name guard. */
    existingNames?: string[]
    /** Save the rule. A promise that rejects keeps the editor open with the
     *  reason shown (the server refused it: a taken name, say). */
    onSave: (rule: DisplayRuleConfig) => void | Promise<void>
    onCancel: () => void
}


export function DisplayRuleEditor({
    viewId, knownEntityTypes, knownLayers, rule, existingNames = [], onSave, onCancel,
}: DisplayRuleEditorProps) {
    const provider = useGraphProvider()
    const [name, setName] = useState(rule?.name ?? '')
    const [color, setColor] = useState(rule?.color ?? SWATCHES[0])
    const [icon, setIcon] = useState<string | undefined>(rule?.icon)
    const [previewCount, setPreviewCount] = useState<number | null>(null)
    // False while the count is still reading the view: the number so far.
    const [previewExact, setPreviewExact] = useState(true)
    const [isPreviewing, setIsPreviewing] = useState(false)
    const [previewError, setPreviewError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)
    // Empty id ⇒ a seeded "new" rule from the Properties tab (or the
    // Advanced-Search "Create rule" flow). Minted once, so a save retried
    // after a lost answer replaces the rule rather than adding it twice.
    const [ruleId] = useState(() => rule?.id || generateId('rule'))

    // Local predicate state seeded from the rule. The flat-filter
    // VisualQueryBuilder mutates it via onSeed/onCommit; we don't need
    // undo history here, so both write straight to setState.
    const [predicate, setPredicate] = useState<Predicate | null>(
        (rule?.predicate as Predicate | null) ?? null,
    )

    const {
        allKeys, keysByEntityType, tagValues, getValueSamples, suggestValues,
    } = useDiscovery(viewId)

    // Layer names → picker options. Memoised so the builder's row props stay
    // referentially stable across keystrokes.
    const layerOptions = useMemo(
        () => knownLayers.map((l) => ({ value: l, label: l })),
        [knownLayers],
    )

    const conditions = useMemo(() => topLevelConditions(predicate), [predicate])
    const isEmpty = conditions.length === 0
    // No backend Cypher exists for an incomplete row (empty value /
    // missing key); block preview + save until every row is complete.
    const hasIncomplete = conditions.some((c) => isRowIncomplete(c))

    // Duplicate-name guard — case-insensitive against OTHER rules.
    const trimmedName = name.trim()
    const isDuplicate = useMemo(
        () => existingNames.some((n) => n.toLowerCase() === trimmedName.toLowerCase()),
        [existingNames, trimmedName],
    )
    const canSave = trimmedName.length > 0 && !isEmpty && !hasIncomplete && !isDuplicate && !saving

    // ── Live preview-as-you-build ────────────────────────────────────
    // Count the predicate's matches in the view (debounced) whenever it
    // changes, exactly — the count shows what it has found while it reads a
    // large view. The explicit "Refresh" button forces an immediate re-run.
    const treeKey = JSON.stringify(predicate)
    const runPreview = useMemo(() => {
        return async (signal?: AbortSignal) => {
            if (!predicate || isEmpty || hasIncomplete
                || !(provider instanceof RemoteGraphProvider)) {
                setPreviewCount(null)
                return
            }
            setIsPreviewing(true)
            setPreviewError(null)
            // Never show the last criteria's count as this one's.
            setPreviewCount(null)
            try {
                const counts = await countRules(provider, viewId, [{ id: 'preview', predicate }], {
                    signal,
                    onUpdate: (update) => {
                        const c = update.get('preview')
                        if (signal?.aborted || !c) return
                        setPreviewCount(c.count)
                        setPreviewExact(c.complete)
                        setPreviewError(c.error ?? null)
                    },
                })
                if (signal?.aborted) return
                const final = counts.get('preview')
                setPreviewCount(final?.count ?? 0)
                setPreviewExact(true)
                if (final?.error) setPreviewError(final.error)
            } catch (e) {
                if (signal?.aborted) return
                setPreviewError((e as Error).message)
                setPreviewCount(null)
            } finally {
                if (!signal?.aborted) setIsPreviewing(false)
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider, viewId, treeKey, isEmpty, hasIncomplete])

    useEffect(() => {
        const controller = new AbortController()
        const t = setTimeout(() => void runPreview(controller.signal), PREVIEW_DEBOUNCE_MS)
        return () => { controller.abort(); clearTimeout(t) }
    }, [runPreview])

    const handleSave = async () => {
        if (!canSave || !predicate) return
        setSaving(true)
        setSaveError(null)
        try {
            await onSave({
                id: ruleId,
                name: trimmedName,
                color,
                icon,
                // Strip the FE-only ``uiScope`` hint that the flat builder
                // attaches to ``descendantOf`` rows so it never leaks into
                // the persisted blueprint.
                predicate: stripUiScope(predicate),
                enabled: rule?.enabled ?? true,
                createdAt: rule?.createdAt ?? new Date().toISOString(),
            })
        } catch (e) {
            setSaveError((e as Error).message)
        } finally {
            setSaving(false)
        }
    }

    // Keyboard: Esc cancels, ⌘/Ctrl+Enter saves.
    const rootRef = useRef<HTMLDivElement>(null)
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleSave() }
    }

    return (
        <div ref={rootRef} onKeyDown={onKeyDown} className="flex flex-col gap-4">
            {/* Tag identity — name + color + icon */}
            <div className="flex flex-col gap-2.5">
                <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                    Tag label
                </label>
                <div className="flex items-center gap-2">
                    {/* Live chip preview */}
                    <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium shrink-0 max-w-[42%] truncate"
                        style={{ backgroundColor: `${color}26`, color }}
                        title={trimmedName || 'Tag preview'}
                    >
                        {icon && <DynamicIcon name={icon} className="w-3 h-3 shrink-0" />}
                        <span className="truncate">{trimmedName || 'Tag'}</span>
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
                {isDuplicate && (
                    <span className="text-[11px] text-amber-400">
                        A rule named “{trimmedName}” already exists — pick a unique name.
                    </span>
                )}
                {/* Colour swatches */}
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
                {/* Icon picker */}
                <div className="flex items-center gap-1 flex-wrap">
                    <button
                        type="button"
                        onClick={() => setIcon(undefined)}
                        title="No icon"
                        className={cn(
                            'w-7 h-7 rounded-lg flex items-center justify-center text-[10px] transition-all',
                            !icon ? 'ring-2 ring-accent-lineage/60 text-ink' : 'text-ink-muted hover:bg-glass/40',
                        )}
                    >
                        None
                    </button>
                    {ICON_CHOICES.map((ic) => (
                        <button
                            key={ic}
                            type="button"
                            onClick={() => setIcon(ic)}
                            aria-label={`Use icon ${ic}`}
                            className={cn(
                                'w-7 h-7 rounded-lg flex items-center justify-center transition-all',
                                icon === ic
                                    ? 'ring-2 ring-accent-lineage/60'
                                    : 'hover:bg-glass/40',
                            )}
                            style={icon === ic ? { color } : undefined}
                        >
                            <DynamicIcon name={ic} className="w-3.5 h-3.5" />
                        </button>
                    ))}
                </div>
            </div>

            {/* Criteria builder — the SAME flat-filter builder as the
                Advanced-Search panel, driven by local predicate state. */}
            <div className="flex flex-col gap-2">
                <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                    Apply this tag to entities where…
                </label>
                <VisualQueryBuilder
                    predicate={predicate}
                    onSeed={setPredicate}
                    onCommit={setPredicate}
                    discovery={{ allKeys, keysByEntityType, tagValues, getValueSamples, suggestValues }}
                    knownEntityTypes={knownEntityTypes}
                    discoveredLayers={layerOptions}
                    onSubmit={() => void runPreview()}
                />
            </div>

            {/* Live preview row */}
            <div className="flex items-center justify-between gap-2 min-h-[28px]">
                <div className="text-[11px] text-ink-muted tabular-nums flex items-center gap-1.5">
                    {isPreviewing && previewCount === null ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Previewing…</>
                    ) : previewError ? (
                        <span className="text-rose-400 truncate max-w-[220px]">{previewError}</span>
                    ) : previewCount !== null ? (
                        <>
                            <span
                                className="inline-block w-2 h-2 rounded-full"
                                style={{ backgroundColor: color }}
                            />
                            <span className="text-ink font-semibold">{previewCount.toLocaleString()}</span>
                            {!previewExact
                                ? 'found so far…'
                                : previewCount === 1 ? 'entity will be tagged' : 'entities will be tagged'}
                            {isPreviewing && <Loader2 className="w-3 h-3 animate-spin" />}
                        </>
                    ) : isEmpty ? (
                        <span className="text-ink-muted/60">Add a condition to preview matches</span>
                    ) : null}
                </div>
                <button
                    type="button"
                    onClick={() => void runPreview()}
                    disabled={isEmpty || hasIncomplete || isPreviewing}
                    className={cn(
                        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors shrink-0',
                        (isEmpty || hasIncomplete)
                            ? 'text-ink-muted/40 cursor-not-allowed'
                            : 'text-accent-lineage hover:bg-accent-lineage/15',
                    )}
                >
                    Refresh
                </button>
            </div>

            {saveError && (
                <p role="alert" className="text-[11px] text-rose-400 leading-snug">
                    Couldn't save the rule — {saveError}
                </p>
            )}

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
                    onClick={() => void handleSave()}
                    disabled={!canSave}
                    title={canSave ? 'Save (⌘/Ctrl + Enter)' : undefined}
                    className={cn(
                        'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all',
                        canSave
                            ? 'bg-accent-lineage text-white hover:bg-accent-lineage/90 shadow-sm shadow-accent-lineage/30'
                            : 'bg-glass/30 text-ink-muted/40 cursor-not-allowed',
                    )}
                >
                    <Check className="w-3.5 h-3.5" /> {saving ? 'Saving…' : rule ? 'Save rule' : 'Create rule'}
                </button>
            </div>
        </div>
    )
}


/**
 * Recursively drop the FE-only ``uiScope`` hint that the flat builder
 * attaches to ``descendantOf`` rows (it routes the roots-only vs
 * any-node picker). The wire / persisted predicate should be plain
 * ``descendantOf`` so the saved blueprint carries no UI-only fields.
 */
function stripUiScope(p: Predicate): Predicate {
    if (p.kind === 'group') {
        return { ...p, children: p.children.map(stripUiScope) }
    }
    if (p.kind === 'descendantOf') {
        const rest = { ...p } as Predicate & { uiScope?: unknown }
        delete rest.uiScope
        return rest as Predicate
    }
    return p
}
