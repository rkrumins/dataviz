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

import { typeMeta, type ValueType } from './propertyValueTypes'


/** A small type-toned icon tile that anchors each property row. */
export function TypeTile({ type, accent }: { type: ValueType; accent?: 'emerald' | 'rose' }) {
    const meta = typeMeta(type)
    const Icon = accent ? Braces : meta.Icon
    const tile = accent === 'emerald'
        ? 'bg-emerald-500/12 border-emerald-500/25 text-emerald-400'
        : accent === 'rose'
            ? 'bg-rose-500/12 border-rose-500/25 text-rose-400'
            : meta.tile
    return (
        <div
            className={cn('shrink-0 w-7 h-7 rounded-lg border flex items-center justify-center', tile)}
            title={accent ? undefined : meta.label}
        >
            <Icon className="w-3.5 h-3.5" />
        </div>
    )
}


/**
 * Readable sample-value chips with an inline "+N" expand. Clicks
 * stopPropagation so expanding values never toggles an enclosing row.
 */
export function SampleValueChips({ values, max = 4 }: { values: string[]; max?: number }) {
    const [expanded, setExpanded] = useState(false)
    if (values.length === 0) return null
    const shown = expanded ? values : values.slice(0, max)
    const rest = values.length - max
    return (
        <div className="flex flex-wrap items-center gap-1">
            {shown.map((v, i) => (
                <span
                    key={`${v}-${i}`}
                    title={v}
                    className="inline-flex items-center px-2 py-0.5 rounded-md text-[10.5px] font-mono bg-canvas-elevated/70 border border-glass-border/70 text-ink-secondary max-w-[170px] truncate"
                >
                    {v}
                </span>
            ))}
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
                    className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] bg-glass/40 text-ink-secondary border border-glass-border/60 max-w-[120px] truncate"
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
