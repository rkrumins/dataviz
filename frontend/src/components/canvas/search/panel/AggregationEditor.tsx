/**
 * Editor for one ``AggregationSpec``.
 *
 * Authoring contract: lets the user pick "group by what?" and (where
 * applicable) constrain the ancestor scope or property key. Only one
 * spec at a time — the OptionsPanel wraps this in a tiny list editor
 * for the (rare) multi-aggregate case.
 *
 * `by='tag'` is intentionally NOT offered: tag aggregation is deferred
 * with the tag-storage refactor (W1).
 */
import { type FC, useMemo } from 'react'

import { cn } from '@/lib/utils'
import type { AggregationKind, AggregationSpec } from '@/types/search'

import { UnifiedPicker } from '../builder/editors/UnifiedPicker'


/** Aggregation kinds offered in the dropdown. ``tag`` is omitted: tag
 *  aggregation is deferred along with the tag-storage refactor. */
const AGGREGATION_KINDS: Array<{
    value: AggregationKind
    label: string
    hint: string
    /** True when the kind needs an `ancestorEntityTypes` chip picker. */
    needsAncestorTypes?: boolean
    /** True when the kind needs a `propertyKey` text field. */
    needsPropertyKey?: boolean
}> = [
    { value: 'entityType',    label: 'Entity type',
      hint: 'Count matches per entity type (dataset, schemaField, …).' },
    { value: 'ancestorType',  label: 'Ancestor type',
      hint: 'Roll matches up to their nearest containing ancestor of a chosen type (e.g. domain).',
      needsAncestorTypes: true },
    { value: 'ancestorLevel', label: 'Ancestor level',
      hint: 'Roll matches up to ancestors at a fixed containment depth.' },
    { value: 'parent',        label: 'Immediate parent',
      hint: 'Group matches by their direct containing parent.' },
    { value: 'property',      label: 'Property value',
      hint: 'Group by the value of a property key (e.g. layerAssignment).',
      needsPropertyKey: true },
]


export interface AggregationEditorProps {
    value: AggregationSpec
    /** Set of entity types known in the current view — used to populate
     *  the `ancestorEntityTypes` picker. */
    knownEntityTypes: string[]
    /** All property keys discovered in the current view — populates the
     *  `propertyKey` picker for `by='property'`. */
    knownPropertyKeys: string[]
    onChange: (next: AggregationSpec) => void
}


export const AggregationEditor: FC<AggregationEditorProps> = ({
    value, knownEntityTypes, knownPropertyKeys, onChange,
}) => {
    const by = value.by ?? 'entityType'
    const meta = useMemo(
        () => AGGREGATION_KINDS.find((k) => k.value === by) ?? AGGREGATION_KINDS[0],
        [by],
    )

    return (
        <div className="flex flex-col gap-2.5">
            <label className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                    Group by
                </span>
                <select
                    value={by}
                    onChange={(e) => {
                        const nextBy = e.target.value as AggregationKind
                        onChange({
                            by: nextBy,
                            maxBuckets: value.maxBuckets ?? 50,
                            // Drop fields that don't apply to the new kind to
                            // keep the JSON tidy.
                            ancestorEntityTypes:
                                AGGREGATION_KINDS.find((k) => k.value === nextBy)?.needsAncestorTypes
                                    ? (value.ancestorEntityTypes ?? [])
                                    : undefined,
                            propertyKey:
                                AGGREGATION_KINDS.find((k) => k.value === nextBy)?.needsPropertyKey
                                    ? (value.propertyKey ?? '')
                                    : undefined,
                        })
                    }}
                    className={cn(
                        "w-full px-2.5 py-1.5 rounded-lg",
                        "bg-canvas-base/40 border border-glass-border",
                        "text-sm text-ink",
                        "focus:outline-none focus:ring-2 focus:ring-accent-lineage/40",
                    )}
                >
                    {AGGREGATION_KINDS.map((k) => (
                        <option key={k.value} value={k.value}>
                            {k.label}
                        </option>
                    ))}
                </select>
                <span className="text-[10.5px] text-ink-muted leading-snug">
                    {meta.hint}
                </span>
            </label>

            {meta.needsAncestorTypes && (
                <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                        Ancestor entity types
                    </span>
                    <UnifiedPicker
                        multiple
                        value={value.ancestorEntityTypes ?? []}
                        options={knownEntityTypes}
                        onChange={(next) => onChange({ ...value, ancestorEntityTypes: next })}
                        placeholder="e.g. domain, container"
                        size="sm"
                    />
                    <span className="text-[10.5px] text-ink-muted leading-snug">
                        Roll matches up to the nearest ancestor of any of these types.
                        Leave empty to roll up to the first non-leaf ancestor.
                    </span>
                </label>
            )}

            {meta.needsPropertyKey && (
                <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                        Property key
                    </span>
                    <UnifiedPicker
                        value={value.propertyKey ?? ''}
                        options={knownPropertyKeys}
                        onChange={(next) => onChange({ ...value, propertyKey: next })}
                        placeholder="e.g. layerAssignment"
                        size="sm"
                        mono
                    />
                </label>
            )}

            <label className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                    Max buckets
                </span>
                <input
                    type="number"
                    min={1}
                    max={500}
                    value={value.maxBuckets ?? 50}
                    onChange={(e) => onChange({
                        ...value,
                        maxBuckets: Math.max(1, Math.min(500, Number(e.target.value) || 50)),
                    })}
                    className={cn(
                        "w-20 px-2 py-1 rounded-md tabular-nums",
                        "bg-canvas-base/40 border border-glass-border",
                        "text-xs text-ink text-right",
                        "focus:outline-none focus:ring-2 focus:ring-accent-lineage/40",
                    )}
                />
            </label>
        </div>
    )
}
