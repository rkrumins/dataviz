/**
 * EdgeSetPicker — edge types picked by name: every relationship type the
 * ontology declares, each a card with its colour, what it connects ("◆ Data
 * job → ◆ Dataset") and whether this data source holds any — grouped by
 * kind (data flow, metadata, associations, structure), the ones this data
 * source holds first, and any the graph holds that the ontology doesn't
 * name. ``links``: a connection's, which never walks the hierarchy, so
 * containment types are left out.
 */
import { Check } from 'lucide-react'
import { type FC, useContext, useState } from 'react'

import { cn } from '@/lib/utils'

import { inputClass } from '../typed/fieldStyles'

import { EDGE_CATEGORY_LABELS, type EdgeCategory, type EdgeTypeOption, useEdgeTypeOptions } from './edgeTypeOptions'
import { RelationContext } from './relationContext'
import { TypeIcon } from './sentence/editors'
import { useTypeName } from './sentence/useTypeName'


/** Past this many types, a filter box comes first. */
const FILTER_FROM = 6

const CATEGORIES = Object.keys(EDGE_CATEGORY_LABELS) as EdgeCategory[]


export const EdgeSetPicker: FC<{
    value: string[]
    onChange: (types: string[]) => void
    links?: boolean
    disabled?: boolean
}> = ({ value, onChange, links = false, disabled }) => {
    const { edges } = useContext(RelationContext)
    const [filter, setFilter] = useState('')
    const all = useEdgeTypeOptions(edges?.edgeTypes)
    const options = links ? all.filter((o) => !o.containment) : all

    const picked = new Set(value.map((t) => t.toUpperCase()))
    const shown = filter.trim()
        ? options.filter((o) => `${o.name} ${o.id} ${o.ends}`.toLowerCase().includes(filter.trim().toLowerCase()))
        : options
    const groups = CATEGORIES.map((c) => [c, shown.filter((o) => o.category === c)] as const)
        .filter(([, items]) => items.length > 0)
    const toggle = (id: string) => onChange(picked.has(id.toUpperCase())
        ? value.filter((t) => t.toUpperCase() !== id.toUpperCase())
        : [...value, id])

    if (options.length === 0) {
        return (
            <p className="text-[11px] text-ink-muted">
                This data source names no edge types yet.
            </p>
        )
    }
    return (
        <div className="flex flex-col gap-2">
            {(options.length > FILTER_FROM || value.length > 0) && (
                <div className="flex items-center gap-2">
                    {options.length > FILTER_FROM && (
                        <input value={filter} onChange={(e) => setFilter(e.target.value)}
                               placeholder="Find an edge type…" aria-label="Find an edge type"
                               className={cn(inputClass, 'min-w-0 flex-1')} disabled={disabled} />
                    )}
                    {value.length > 0 && (
                        <span className="ml-auto shrink-0 text-[10.5px] font-medium text-accent-lineage">
                            {value.length} picked
                        </span>
                    )}
                </div>
            )}
            <div role="group" aria-label="Edge types" className="flex max-h-72 flex-col gap-2.5 overflow-y-auto pr-0.5">
                {groups.map(([category, items]) => (
                    <div key={category} className="flex flex-col gap-1">
                        {groups.length > 1 && (
                            <span className="px-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted/80">
                                {EDGE_CATEGORY_LABELS[category]}
                            </span>
                        )}
                        {items.map((o) => (
                            <EdgeTypeCard key={o.id} option={o} checked={picked.has(o.id.toUpperCase())}
                                          onToggle={() => toggle(o.id)} disabled={disabled} />
                        ))}
                    </div>
                ))}
            </div>
        </div>
    )
}


function EdgeTypeCard({ option: o, checked, onToggle, disabled }: {
    option: EdgeTypeOption
    checked: boolean
    onToggle: () => void
    disabled?: boolean
}) {
    return (
        <label className={cn(
            'flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors duration-150',
            'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent-lineage/40',
            checked ? 'border-accent-lineage/50 bg-accent-lineage/[0.07]'
                : 'border-glass-border/70 hover:border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.03]',
            disabled && 'pointer-events-none opacity-60',
        )}>
            <input type="checkbox" className="sr-only" checked={checked} onChange={onToggle} disabled={disabled} />
            <span aria-hidden className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                checked ? 'border-accent-lineage bg-accent-lineage text-white' : 'border-ink-muted/40 bg-canvas-elevated',
            )}>
                {checked && <Check className="h-3 w-3" strokeWidth={3} />}
            </span>
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white/60 dark:ring-black/30"
                  style={{ background: o.color ?? 'rgb(148 163 184)' }} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
                <span className="truncate text-[12.5px] font-medium text-ink">{o.name}</span>
                {(o.sources.length > 0 || o.targets.length > 0) && <Ends sources={o.sources} targets={o.targets} />}
            </span>
            {!o.seen && (
                <span className="shrink-0 rounded-full bg-black/[0.04] px-1.5 py-0.5 text-[9.5px] text-ink-muted dark:bg-white/[0.06]">
                    none here yet
                </span>
            )}
        </label>
    )
}


/** "◆ Data job → ◆ Dataset" — each end by its first type, its icon and colour. */
function Ends({ sources, targets }: { sources: string[]; targets: string[] }) {
    const typeName = useTypeName()
    const side = (types: string[]) => types.length === 0 ? <span>Anything</span> : (
        <span className="inline-flex min-w-0 items-center gap-1">
            <TypeIcon type={types[0]} className="h-3 w-3" />
            <span className="truncate">{typeName(types[0])}</span>
            {types.length > 1 && <span className="text-ink-muted/70">+{types.length - 1}</span>}
        </span>
    )
    return (
        <span className="flex min-w-0 items-center gap-1 text-[10.5px] text-ink-muted">
            {side(sources)}<span aria-hidden>{' → '}</span>{side(targets)}
        </span>
    )
}
