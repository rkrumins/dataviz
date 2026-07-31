/**
 * PropertyMappingForm — shared, controlled editor for how a source's node
 * properties map onto the platform's model.
 *
 * Purely controlled, matching AggregationOverridesForm's contract: the parent
 * owns `value` and receives a fully-formed `onChange(next)` on every edit.
 * Only UI-only state lives here.
 *
 * Lives in `admin/shared/` so the data source's Mapping tab and the onboarding
 * wizards drive the same control rather than growing a third copy — the fate
 * that already befell the identity/name mapping.
 *
 * Every control carries a plain-English line and a definition on hover: these
 * are terms of art ("container", "separator", "collect unmapped") that nothing
 * else in the product defines, so the form has to define them itself.
 */
import { useEffect, useState } from 'react'
import { ArrowRight, Boxes, FolderTree, Plus, Trash2, TriangleAlert, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { HelpHint } from '@/components/ui/InfoTooltip'
import {
    FOLDER_SEPARATOR,
    type PropertyCollision,
    type PropertyMapping,
} from '@/services/propertyStorageService'

export interface PropertyMappingFormProps {
    value: PropertyMapping
    onChange: (next: PropertyMapping) => void
    disabled?: boolean
    /** Container keys actually seen in the graph, offered as one-click chips. */
    detectedContainerKeys?: string[]
    /** Reserved-key collisions found by the analyzer, offered as remap rows. */
    collisions?: PropertyCollision[]
}

const CONTAINER_PRESETS = ['properties', 'attributes', 'metadata', 'props']

const inputCls =
    'w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-glass-border ' +
    'text-xs text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 ' +
    'focus:ring-indigo-500/50 disabled:opacity-50'

const labelCls = 'flex items-center gap-1.5 text-xs font-semibold text-ink mb-1'
const helpCls = 'text-[11px] text-ink-muted mb-2 leading-relaxed'

function Chip({ label, active, onClick, disabled, detected }: {
    label: string; active: boolean; onClick: () => void
    disabled?: boolean; detected?: boolean
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={detected ? 'Found in this graph' : undefined}
            className={cn(
                'px-2 py-1 rounded-md text-[11px] font-mono border transition-colors disabled:opacity-50',
                'inline-flex items-center gap-1',
                active
                    ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30'
                    : 'bg-black/5 dark:bg-white/5 text-ink-muted border-transparent hover:text-ink',
            )}
        >
            {detected && !active && (
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500/70" />
            )}
            {label}
        </button>
    )
}

export function PropertyMappingForm({
    value, onChange, disabled, detectedContainerKeys = [], collisions = [],
}: PropertyMappingFormProps) {
    const [newOverrideField, setNewOverrideField] = useState('')
    const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null)

    // Both of these are DRAFTS. Committing on every keystroke means a trimmed
    // container key can never contain a space mid-edit, and a separator can
    // never be cleared to retype it. The committed value only ever moves when
    // the draft is meaningful; the blur handler snaps the draft back if not.
    const [containerDraft, setContainerDraft] = useState(value.containerKey ?? '')
    const [separatorDraft, setSeparatorDraft] = useState(value.separator)

    // Re-sync when the parent replaces the mapping wholesale (a report loads, a
    // reset, a different data source) — but not on our own committed edits,
    // which already match.
    useEffect(() => { setContainerDraft(value.containerKey ?? '') }, [value.containerKey])
    useEffect(() => { setSeparatorDraft(value.separator) }, [value.separator])

    const set = (patch: Partial<PropertyMapping>) => onChange({ ...value, ...patch })

    const setOverride = (field: string, path: string) =>
        set({ propertyOverrides: { ...value.propertyOverrides, [field]: path } })

    const removeOverride = (field: string) => {
        const next = { ...value.propertyOverrides }
        delete next[field]
        set({ propertyOverrides: next })
    }

    const addOverride = () => {
        const field = newOverrideField.trim()
        if (!field) return
        // Silently replacing an existing remap loses whatever path the user had
        // typed there, with no indication it happened.
        if (field in value.propertyOverrides) {
            setDuplicateWarning(field)
            return
        }
        setOverride(field, `source${value.separator}${field}`)
        setNewOverrideField('')
        setDuplicateWarning(null)
    }

    // Detected keys first (they're real), then the presets we didn't see.
    const containerChoices = [
        ...detectedContainerKeys,
        ...CONTAINER_PRESETS.filter(p => !detectedContainerKeys.includes(p)),
    ]
    const unmappedCollisions = collisions.filter(
        c => !(c.field in value.propertyOverrides),
    )
    const foldersDisabled = value.separator !== FOLDER_SEPARATOR

    return (
        <div className="space-y-5">
            {/* ── Container key ─────────────────────────────────────── */}
            <div>
                <label className={labelCls}>
                    <Boxes className="w-3.5 h-3.5 text-ink-muted" />
                    Property container
                    <HelpHint
                        label="the property container"
                        content={
                            <>
                                The single node property that holds all the others, as a
                                dictionary. Naming it here lets the platform read inside it —
                                and lets you unpack it so each property becomes its own
                                indexable field.
                                <span className="block mt-1.5 text-ink-muted">
                                    Wrong key? Nothing breaks — properties just keep rendering
                                    the way they do now.
                                </span>
                            </>
                        }
                    />
                </label>
                <p className={helpCls}>
                    The node property holding this source's nested property dictionary.
                    Leave blank if every property is already its own field.
                </p>
                <div className="flex flex-wrap gap-1.5 mb-2">
                    {containerChoices.map(key => (
                        <Chip
                            key={key}
                            label={key}
                            active={value.containerKey === key}
                            detected={detectedContainerKeys.includes(key)}
                            disabled={disabled}
                            onClick={() => set({ containerKey: key })}
                        />
                    ))}
                    <Chip
                        label="none"
                        active={!value.containerKey}
                        disabled={disabled}
                        onClick={() => set({ containerKey: null })}
                    />
                </div>
                <div className="relative">
                    <input
                        className={cn(inputCls, containerDraft && 'pr-8')}
                        value={containerDraft}
                        disabled={disabled}
                        placeholder="properties"
                        aria-label="Property container key"
                        onChange={e => {
                            setContainerDraft(e.target.value)
                            const trimmed = e.target.value.trim()
                            set({ containerKey: trimmed || null })
                        }}
                        onBlur={() => setContainerDraft(value.containerKey ?? '')}
                    />
                    {containerDraft && !disabled && (
                        <button
                            type="button"
                            onClick={() => { setContainerDraft(''); set({ containerKey: null }) }}
                            aria-label="Clear the container key"
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                        >
                            <X className="w-3 h-3" />
                        </button>
                    )}
                </div>
                {detectedContainerKeys.length > 0 && (
                    <p className="mt-1.5 text-[11px] text-ink-muted">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500/70 mr-1 align-middle" />
                        Dotted chips were found in this graph's own sample.
                    </p>
                )}
            </div>

            {/* ── Separator ─────────────────────────────────────────── */}
            <div>
                <label className={labelCls}>
                    <FolderTree className="w-3.5 h-3.5 text-ink-muted" />
                    Path separator
                    <HelpHint
                        label="the path separator"
                        content={
                            <>
                                Nested properties are flattened into one key each. This is the
                                character that joins the levels.
                                <span className="block mt-1.5">
                                    “{FOLDER_SEPARATOR}” is special: the properties panel reads
                                    it as a folder path and renders a tree. Any other character
                                    still works — the keys just display flat.
                                </span>
                            </>
                        }
                    />
                </label>
                <p className={helpCls}>
                    Joins a nested path into one key — <code className="font-mono">technical</code>
                    {' '}+ <code className="font-mono">format</code> becomes{' '}
                    <code className="font-mono text-ink">
                        technical{separatorDraft || value.separator}format
                    </code>.
                </p>
                <input
                    className={cn(inputCls, 'w-24')}
                    value={separatorDraft}
                    disabled={disabled}
                    maxLength={3}
                    aria-label="Path separator character"
                    onChange={e => {
                        setSeparatorDraft(e.target.value)
                        // An empty separator would collapse every path into one
                        // ambiguous key, so it is never committed — but it stays
                        // typeable, which is the only way to replace it.
                        if (e.target.value) set({ separator: e.target.value })
                    }}
                    onBlur={() => setSeparatorDraft(value.separator)}
                />
                {foldersDisabled && (
                    <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400 leading-relaxed">
                        Properties stay searchable, but only “{FOLDER_SEPARATOR}” renders as a
                        folder tree — with this separator they'll display as flat keys.
                    </p>
                )}
            </div>

            {/* ── Collect unmapped ──────────────────────────────────── */}
            <div>
                <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                        type="checkbox"
                        className="mt-0.5 accent-indigo-500"
                        checked={value.collectUnmapped}
                        disabled={disabled}
                        onChange={e => set({ collectUnmapped: e.target.checked })}
                    />
                    <span>
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                            Show the source's other fields as properties
                            <HelpHint
                                label="showing other fields"
                                content={
                                    <>
                                        Besides the container, a node usually carries loose
                                        top-level fields. On, they join the properties panel
                                        alongside the unpacked ones. Off, only what came out of
                                        the container is shown.
                                        <span className="block mt-1.5 text-ink-muted">
                                            Display only — turning it off hides nothing from the
                                            graph and deletes nothing.
                                        </span>
                                    </>
                                }
                            />
                        </span>
                        <span className="block text-[11px] text-ink-muted leading-relaxed mt-0.5">
                            On by default. Turn it off when a source carries internal fields
                            (<code className="font-mono">_id</code>,{' '}
                            <code className="font-mono">__typename</code>) that shouldn't appear
                            in the properties panel.
                        </span>
                    </span>
                </label>
            </div>

            {/* ── Reserved-key collisions ───────────────────────────── */}
            {(unmappedCollisions.length > 0
              || Object.keys(value.propertyOverrides).length > 0) && (
                <div>
                    <label className={labelCls}>
                        <TriangleAlert className="w-3.5 h-3.5 text-amber-500" />
                        Name collisions
                        <HelpHint
                            label="a name collision"
                            content={
                                <>
                                    The platform owns a handful of field names on every node
                                    (<code className="font-mono">urn</code>,{' '}
                                    <code className="font-mono">name</code>,{' '}
                                    <code className="font-mono">level</code>…). When your source
                                    uses one for its own data, the two can't share the slot.
                                    <span className="block mt-1.5">
                                        Remapping moves yours to a path of its own, so it survives
                                        and stays visible.
                                    </span>
                                </>
                            }
                        />
                    </label>
                    <p className={helpCls}>
                        These physical fields share a name the platform uses for its own.
                        Left alone they're hidden from the properties panel and dropped on
                        the next write. Remap one to keep it.
                    </p>

                    {/* Unresolved — stripe, not fill, matching DiagnosticsPanel. */}
                    {unmappedCollisions.map(c => (
                        <div
                            key={c.field}
                            className="flex items-center gap-2 py-1.5 pl-2.5 mb-1 rounded-r-md border-l-2 border-amber-500/60 bg-amber-500/[0.04] text-[11px]"
                        >
                            <code className="font-mono text-ink shrink-0 w-28 truncate">
                                {c.field}
                            </code>
                            <span className="text-ink-muted truncate flex-1 min-w-0" title={c.samples.map(String).join(', ')}>
                                {c.samples.length > 0
                                    ? c.samples.map(String).join(', ')
                                    : '—'}
                            </span>
                            <button
                                type="button"
                                disabled={disabled}
                                onClick={() => setOverride(c.field, c.suggested)}
                                className="shrink-0 flex items-center gap-1 px-2 py-1 mr-1 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 font-semibold hover:bg-amber-500/20 transition-colors disabled:opacity-50"
                            >
                                <Plus className="w-3 h-3" /> Keep as {c.suggested}
                            </button>
                        </div>
                    ))}

                    {/* Resolved — from → to, so the mapping reads as a mapping. */}
                    {Object.entries(value.propertyOverrides).map(([field, path]) => (
                        <div
                            key={field}
                            className={cn(
                                'flex items-center gap-2 py-1.5 pl-2.5 mb-1 rounded-r-md border-l-2',
                                duplicateWarning === field
                                    ? 'border-amber-500 bg-amber-500/10'
                                    : 'border-emerald-500/50 bg-emerald-500/[0.03]',
                            )}
                        >
                            <code className="font-mono text-[11px] text-ink shrink-0 w-28 truncate" title={field}>
                                {field}
                            </code>
                            <ArrowRight className="w-3 h-3 text-ink-muted shrink-0" />
                            <input
                                className={cn(inputCls, 'flex-1 min-w-0 py-1')}
                                value={path}
                                disabled={disabled}
                                aria-label={`Property path for ${field}`}
                                onChange={e => setOverride(field, e.target.value)}
                            />
                            <button
                                type="button"
                                disabled={disabled}
                                onClick={() => removeOverride(field)}
                                className="shrink-0 p-1 mr-1 rounded-md text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                                aria-label={`Remove the ${field} remap`}
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    ))}

                    <div className="flex items-center gap-2 pt-1.5">
                        <input
                            className={cn(inputCls, 'flex-1 min-w-0 py-1')}
                            value={newOverrideField}
                            disabled={disabled}
                            placeholder="Another field to keep…"
                            aria-label="Field to remap"
                            onChange={e => {
                                setNewOverrideField(e.target.value)
                                setDuplicateWarning(null)
                            }}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addOverride() } }}
                        />
                        <button
                            type="button"
                            disabled={disabled || !newOverrideField.trim()}
                            onClick={addOverride}
                            className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-black/5 dark:bg-white/5 text-[11px] font-semibold text-ink-muted hover:text-ink transition-colors disabled:opacity-40"
                        >
                            <Plus className="w-3 h-3" /> Add
                        </button>
                    </div>
                    {duplicateWarning && (
                        <p role="alert" className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                            <code className="font-mono">{duplicateWarning}</code> is already
                            remapped above — edit that row instead.
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}
