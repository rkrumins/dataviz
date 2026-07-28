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
 */
import { useState } from 'react'
import { Boxes, FolderTree, Plus, Trash2, TriangleAlert } from 'lucide-react'

import { cn } from '@/lib/utils'
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

function Chip({ label, active, onClick, disabled }: {
    label: string; active: boolean; onClick: () => void; disabled?: boolean
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                'px-2 py-1 rounded-md text-[11px] font-mono border transition-colors disabled:opacity-50',
                active
                    ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30'
                    : 'bg-black/5 dark:bg-white/5 text-ink-muted border-transparent hover:text-ink',
            )}
        >
            {label}
        </button>
    )
}

export function PropertyMappingForm({
    value, onChange, disabled, detectedContainerKeys = [], collisions = [],
}: PropertyMappingFormProps) {
    const [newOverrideField, setNewOverrideField] = useState('')

    const set = (patch: Partial<PropertyMapping>) => onChange({ ...value, ...patch })

    const setOverride = (field: string, path: string) =>
        set({ propertyOverrides: { ...value.propertyOverrides, [field]: path } })

    const removeOverride = (field: string) => {
        const next = { ...value.propertyOverrides }
        delete next[field]
        set({ propertyOverrides: next })
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
                <label className="flex items-center gap-1.5 text-xs font-semibold text-ink mb-1">
                    <Boxes className="w-3.5 h-3.5 text-ink-muted" />
                    Property container
                </label>
                <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                    The node property holding this source's nested property dictionary.
                    Leave blank if every property is already its own field.
                </p>
                <div className="flex flex-wrap gap-1.5 mb-2">
                    {containerChoices.map(key => (
                        <Chip
                            key={key}
                            label={key}
                            active={value.containerKey === key}
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
                <input
                    className={inputCls}
                    value={value.containerKey ?? ''}
                    disabled={disabled}
                    placeholder="properties"
                    onChange={e => set({ containerKey: e.target.value.trim() || null })}
                />
            </div>

            {/* ── Separator ─────────────────────────────────────────── */}
            <div>
                <label className="flex items-center gap-1.5 text-xs font-semibold text-ink mb-1">
                    <FolderTree className="w-3.5 h-3.5 text-ink-muted" />
                    Path separator
                </label>
                <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                    Joins a nested path into one key — <code className="font-mono">technical</code>
                    {' '}+ <code className="font-mono">format</code> becomes{' '}
                    <code className="font-mono">technical{value.separator}format</code>.
                </p>
                <input
                    className={cn(inputCls, 'w-24')}
                    value={value.separator}
                    disabled={disabled}
                    maxLength={3}
                    onChange={e => set({ separator: e.target.value || FOLDER_SEPARATOR })}
                />
                {foldersDisabled && (
                    <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400 leading-relaxed">
                        Properties stay searchable, but only “{FOLDER_SEPARATOR}” renders as a
                        folder tree — with this separator they'll display as flat keys.
                    </p>
                )}
            </div>

            {/* ── Collect unmapped ──────────────────────────────────── */}
            <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                    type="checkbox"
                    className="mt-0.5 accent-indigo-500"
                    checked={value.collectUnmapped}
                    disabled={disabled}
                    onChange={e => set({ collectUnmapped: e.target.checked })}
                />
                <span>
                    <span className="block text-xs font-semibold text-ink">
                        Show the source's other fields as properties
                    </span>
                    <span className="block text-[11px] text-ink-muted leading-relaxed mt-0.5">
                        On by default. Turn it off when a source carries internal fields
                        (<code className="font-mono">_id</code>,{' '}
                        <code className="font-mono">__typename</code>) that shouldn't appear
                        in the properties panel.
                    </span>
                </span>
            </label>

            {/* ── Reserved-key collisions ───────────────────────────── */}
            {(unmappedCollisions.length > 0
              || Object.keys(value.propertyOverrides).length > 0) && (
                <div>
                    <label className="flex items-center gap-1.5 text-xs font-semibold text-ink mb-1">
                        <TriangleAlert className="w-3.5 h-3.5 text-amber-500" />
                        Name collisions
                    </label>
                    <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                        These physical fields share a name the platform uses for its own.
                        Left alone they're hidden from the properties panel and dropped on
                        the next write. Remap one to keep it.
                    </p>

                    {unmappedCollisions.map(c => (
                        <div
                            key={c.field}
                            className="flex items-center gap-2 py-1.5 text-[11px]"
                        >
                            <code className="font-mono text-ink shrink-0 w-28 truncate">
                                {c.field}
                            </code>
                            <span className="text-ink-muted truncate flex-1" title={c.samples.map(String).join(', ')}>
                                {c.samples.length > 0
                                    ? c.samples.map(String).join(', ')
                                    : '—'}
                            </span>
                            <button
                                type="button"
                                disabled={disabled}
                                onClick={() => setOverride(c.field, c.suggested)}
                                className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 font-semibold hover:bg-amber-500/20 transition-colors disabled:opacity-50"
                            >
                                <Plus className="w-3 h-3" /> Keep as {c.suggested}
                            </button>
                        </div>
                    ))}

                    {Object.entries(value.propertyOverrides).map(([field, path]) => (
                        <div key={field} className="flex items-center gap-2 py-1.5">
                            <code className="font-mono text-[11px] text-ink shrink-0 w-28 truncate">
                                {field}
                            </code>
                            <span className="text-ink-muted text-[11px]">→</span>
                            <input
                                className={cn(inputCls, 'flex-1 py-1')}
                                value={path}
                                disabled={disabled}
                                onChange={e => setOverride(field, e.target.value)}
                            />
                            <button
                                type="button"
                                disabled={disabled}
                                onClick={() => removeOverride(field)}
                                className="shrink-0 p-1 rounded-md text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                                aria-label={`Remove the ${field} remap`}
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    ))}

                    <div className="flex items-center gap-2 pt-1.5">
                        <input
                            className={cn(inputCls, 'flex-1 py-1')}
                            value={newOverrideField}
                            disabled={disabled}
                            placeholder="Another field to keep…"
                            onChange={e => setNewOverrideField(e.target.value)}
                        />
                        <button
                            type="button"
                            disabled={disabled || !newOverrideField.trim()}
                            onClick={() => {
                                const field = newOverrideField.trim()
                                setOverride(field, `source${value.separator}${field}`)
                                setNewOverrideField('')
                            }}
                            className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-black/5 dark:bg-white/5 text-[11px] font-semibold text-ink-muted hover:text-ink transition-colors disabled:opacity-40"
                        >
                            <Plus className="w-3 h-3" /> Add
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}
