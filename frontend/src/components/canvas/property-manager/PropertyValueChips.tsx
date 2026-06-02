/**
 * PropertyValueChips — premium, readable presentation primitives for the
 * Properties catalogue: a type tile (icon + tone by inferred value type),
 * sample-value chips with inline "+N" expand, and entity-type pills with
 * overflow. Replaces the faint low-contrast value text with legible,
 * scannable chips. Pure + presentational.
 */
import { Braces } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils'

import { entityTypeStyle } from './entityTypeStyles'
import { typeMeta, type ValueType } from './propertyValueTypes'


/** A premium type-toned icon tile (gradient) that anchors each property row. */
export function TypeTile({ type, accent }: { type: ValueType; accent?: 'emerald' | 'rose' }) {
    const meta = typeMeta(type)
    const Icon = accent ? Braces : meta.Icon
    const tile = accent === 'emerald'
        ? 'bg-gradient-to-br from-emerald-500/25 to-teal-500/15 border-emerald-500/20 text-emerald-500 dark:text-emerald-400'
        : accent === 'rose'
            ? 'bg-gradient-to-br from-rose-500/25 to-pink-500/15 border-rose-500/20 text-rose-500 dark:text-rose-400'
            : meta.tile
    return (
        <div
            className={cn(
                'shrink-0 w-8 h-8 rounded-xl border flex items-center justify-center',
                'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]',
                tile,
            )}
            title={accent ? undefined : meta.label}
        >
            <Icon className="w-4 h-4" strokeWidth={2} />
        </div>
    )
}


/**
 * Readable sample-value chips with an inline "+N" expand. Clicks
 * stopPropagation so expanding values never toggles an enclosing row.
 */
export function SampleValueChips({
    values, max = 4, onValueClick,
}: {
    values: string[]
    max?: number
    /** When set, each chip becomes a button that searches for the value
     *  (stops propagation so it doesn't toggle an enclosing card). */
    onValueClick?: (value: string) => void
}) {
    const [expanded, setExpanded] = useState(false)
    if (values.length === 0) return null
    const shown = expanded ? values : values.slice(0, max)
    const rest = values.length - max
    const chipBase = 'inline-flex items-center px-2 py-[3px] rounded-md text-[10.5px] font-mono bg-black/[0.04] dark:bg-white/[0.05] text-ink-secondary max-w-[170px] truncate transition-colors'
    return (
        <div className="flex flex-wrap items-center gap-1">
            {shown.map((v, i) => (onValueClick ? (
                <button
                    key={`${v}-${i}`}
                    type="button"
                    title={`Search ${v} in Advanced Search`}
                    onClick={(e) => { e.stopPropagation(); onValueClick(v) }}
                    className={cn(chipBase, 'hover:bg-accent-lineage/15 hover:text-accent-lineage cursor-pointer')}
                >
                    {v}
                </button>
            ) : (
                <span
                    key={`${v}-${i}`}
                    title={v}
                    className={cn(chipBase, 'hover:bg-black/[0.07] dark:hover:bg-white/[0.08]')}
                >
                    {v}
                </span>
            )))}
            {!expanded && rest > 0 && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setExpanded(true) }}
                    className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold tabular-nums bg-glass/50 text-ink-muted hover:text-ink transition-colors"
                    title="Show all sample values"
                >
                    +{rest}
                </button>
            )}
            {expanded && values.length > max && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setExpanded(false) }}
                    className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-medium text-ink-muted hover:text-ink transition-colors"
                >
                    Show less
                </button>
            )}
        </div>
    )
}


/** Entity-type pills with a "+N" overflow (the "used by" surface). */
export function EntityTypeChips({ types, max = 3 }: { types: string[]; max?: number }) {
    if (types.length === 0) return null
    const shown = types.slice(0, max)
    const rest = types.length - max
    return (
        <span className="inline-flex flex-wrap items-center gap-1">
            {shown.map((t) => (
                <span
                    key={t}
                    title={t}
                    className={cn(
                        'inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-medium border max-w-[120px] truncate',
                        entityTypeStyle(t).chip,
                    )}
                >
                    {t}
                </span>
            ))}
            {rest > 0 && (
                <span className="text-[10px] text-ink-muted/70 tabular-nums" title={types.join(', ')}>
                    +{rest}
                </span>
            )}
        </span>
    )
}
