/**
 * EdgeShapeEditors — the bodies of the rows that count an entity's edges.
 * A graph shape ("No upstream lineage", "Nothing links into it") picks the
 * edges it counts; an edge count picks how many, which way and through
 * which edges:
 *
 *   THROUGH  [Lineage ▾]
 *   [more than ▾] [5]  [Either way ▾]  edges through  [Any link ▾]
 *
 * Picking "These edge types…" opens the picker under the row.
 */
import type { FC, ReactNode } from 'react'

import { cn } from '@/lib/utils'
import type {
    DegreePredicate,
    HasIncomingPredicate,
    HasOutgoingPredicate,
    IsLeafPredicate,
    IsOrphanPredicate,
    IsRootPredicate,
    Predicate,
} from '@/types/search'

import { inputClass } from '../typed/fieldStyles'

import { EdgeSetPicker } from './EdgeSetPicker'
import { OperatorMenu } from './OperatorMenu'
import {
    DEGREE_DIRECTION_OPTIONS,
    DEGREE_OP_WORDS,
    EDGE_SET_OPTIONS,
    edgeSetOf,
    withEdgeSet,
} from './vocabulary/edgeWords'


type Counted = IsRootPredicate | IsLeafPredicate | IsOrphanPredicate | HasIncomingPredicate
    | HasOutgoingPredicate | DegreePredicate

const OP_OPTIONS = (Object.keys(DEGREE_OP_WORDS) as Array<keyof typeof DEGREE_OP_WORDS>)
    .map((value) => ({ value, label: DEGREE_OP_WORDS[value] }))


/** ``lead``, then which edges are counted — and, for edge types, the
 *  picker under them. */
const Counting: FC<{
    value: Counted
    onChange: (next: Predicate) => void
    disabled?: boolean
    lead: ReactNode
}> = ({ value, onChange, disabled, lead }) => {
    const set = edgeSetOf(value)
    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-muted">
                {lead}
                <OperatorMenu value={set} onChange={(next) => onChange(withEdgeSet(value, next))}
                              options={EDGE_SET_OPTIONS} ariaLabel="Through which edges" disabled={disabled} />
            </div>
            {set === 'types' && (
                <EdgeSetPicker value={value.edgeTypes ?? []} disabled={disabled}
                               onChange={(edgeTypes) => onChange({ ...value, edgeTypes })} />
            )}
        </div>
    )
}


/** A graph shape's body: the edges it counts. */
export const EdgeSetField: FC<{
    value: Counted
    onChange: (next: Predicate) => void
    disabled?: boolean
}> = (props) => (
    <Counting {...props}
              lead={<span className="text-[10px] font-mono uppercase tracking-[0.14em]">Through</span>} />
)


/** An edge count: how many, which way, through which edges. */
export const EdgeCountEditor: FC<{
    value: DegreePredicate
    onChange: (next: Predicate) => void
    disabled?: boolean
}> = ({ value, onChange, disabled }) => (
    <Counting value={value} onChange={onChange} disabled={disabled} lead={<>
        <OperatorMenu value={value.op ?? 'eq'} onChange={(op) => onChange({ ...value, op })}
                      options={OP_OPTIONS} ariaLabel="How many edges" disabled={disabled} />
        <input type="number" min={0} value={value.value} aria-label="Number of edges"
               onChange={(e) => onChange({ ...value, value: Math.max(0, Math.round(Number(e.target.value)) || 0) })}
               className={cn(inputClass, 'w-20')} disabled={disabled} />
        <OperatorMenu value={value.direction ?? 'both'} onChange={(direction) => onChange({ ...value, direction })}
                      options={DEGREE_DIRECTION_OPTIONS} ariaLabel="Which way" disabled={disabled} />
        <span>edges through</span>
    </>} />
)
