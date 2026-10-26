/**
 * FacetChips — the types the matches come in, as chips that change the
 * query: one narrows it to that type, its × leaves the type out. Both
 * are a change of shape, undone like any other.
 */
import { X } from 'lucide-react'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { HoverTip } from '@/components/ui/HoverTip'
import { useEntityTypeLabel, useEntityVisual } from '@/hooks/useEntityVisual'
import type { Predicate } from '@/types/search'

import { listedClauses, withSubject } from '../sentence/clauseModel'

import { excludingType, type TypeFacet } from './useTypeFacet'


export function FacetChips({ facets, draft, onRefine }: {
    facets: readonly TypeFacet[]
    draft: Predicate | null
    onRefine: (next: Predicate) => void
}) {
    const subject = listedClauses(draft).subject
    return (
        <div role="group" aria-label="Narrow by type" className="mx-1 mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 text-2xs uppercase tracking-wider text-ink-muted">Narrow to</span>
            {facets.map((f) => {
                const active = subject?.types.length === 1 && subject.types[0] === f.type
                return (
                    <FacetChip key={f.type} facet={f} active={active}
                               onNarrow={() => {
                                   const next = withSubject(draft, active ? [] : [f.type])
                                   if (next) onRefine(next)
                               }}
                               onExclude={() => onRefine(excludingType(draft, f.type))} />
                )
            })}
        </div>
    )
}


function FacetChip({ facet, active, onNarrow, onExclude }: {
    facet: TypeFacet
    active: boolean
    onNarrow: () => void
    onExclude: () => void
}) {
    const visual = useEntityVisual(facet.type)
    const label = useEntityTypeLabel(facet.type) ?? facet.type
    const count = `${facet.count.count.toLocaleString()}${facet.count.complete ? '' : '+'}`
    return (
        <span className="group/facet inline-flex items-center rounded-full border transition-colors"
              style={{ borderColor: `${visual.color}${active ? '99' : '33'}`,
                  backgroundColor: `${visual.color}${active ? '26' : '12'}` }}>
            <button type="button" onClick={onNarrow} aria-pressed={active}
                    aria-label={`${active ? 'All types again, not only' : 'Narrow to'} ${label}: ${count}`}
                    className="inline-flex items-center gap-1.5 rounded-full py-0.5 pl-1.5 pr-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                    style={{ color: visual.color }}>
                <DynamicIcon name={visual.icon} className="h-3 w-3 shrink-0" />
                <span className="max-w-[8rem] truncate">{label}</span>
                <span className="text-2xs tabular-nums opacity-80">{count}</span>
            </button>
            <HoverTip label={`Leave ${label} out of the query`} className="inline-flex">
                <button type="button" onClick={onExclude} aria-label={`Leave out ${label}`}
                        className="mr-1 rounded-full p-0.5 text-ink-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 group-hover/facet:opacity-100">
                    <X className="h-3 w-3" />
                </button>
            </HoverTip>
        </span>
    )
}
