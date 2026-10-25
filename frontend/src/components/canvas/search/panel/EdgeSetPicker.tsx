/**
 * EdgeSetPicker — edge types picked by name: every relationship type the
 * ontology declares, each with what it connects ("Data job → Dataset"),
 * the ones this data source holds first, and any the graph holds that the
 * ontology doesn't name. ``links``: a connection's, which never walks the
 * hierarchy, so containment types are left out.
 */
import { type FC, useContext, useState } from 'react'

import { cn } from '@/lib/utils'

import { inputClass } from '../typed/fieldStyles'

import { useEdgeTypeOptions } from './edgeTypeOptions'
import { RelationContext } from './relationContext'


/** Past this many types, a filter box comes first. */
const FILTER_FROM = 8


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
        <div className="flex flex-col gap-1.5">
            {options.length > FILTER_FROM && (
                <input value={filter} onChange={(e) => setFilter(e.target.value)}
                       placeholder="Find an edge type…" aria-label="Find an edge type"
                       className={cn(inputClass, 'w-full')} disabled={disabled} />
            )}
            <div role="group" aria-label="Edge types"
                 className="flex flex-col max-h-56 overflow-y-auto rounded-md border border-glass-border/70">
                {shown.map((o) => (
                    <label key={o.id}
                           className={cn('flex items-start gap-2 px-2 py-1.5 cursor-pointer',
                               'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
                               !o.seen && 'opacity-70')}>
                        <input type="checkbox" className="mt-0.5" checked={picked.has(o.id.toUpperCase())}
                               onChange={() => toggle(o.id)} disabled={disabled} />
                        <span className="flex flex-col leading-tight min-w-0">
                            <span className="text-[12px] text-ink">{o.name}</span>
                            <span className="text-[10.5px] text-ink-muted truncate">
                                {[o.ends, o.seen ? '' : 'none in this data source yet'].filter(Boolean).join(' · ')}
                            </span>
                        </span>
                    </label>
                ))}
            </div>
        </div>
    )
}

