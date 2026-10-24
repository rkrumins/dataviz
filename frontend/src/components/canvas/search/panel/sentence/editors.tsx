/**
 * The small editors a sentence's tokens open, for the parts the Form cards
 * have no single control for: which types, which lineage shape, how a
 * group combines. Everything else opens Form's own editor for the clause.
 */
import { useMemo } from 'react'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { Segmented } from '@/components/ui/Segmented'
import { useEntityVisual } from '@/hooks/useEntityVisual'
import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'

import { UnifiedPicker, type PickerOption } from '../../builder/editors/UnifiedPicker'
import { FILTER_CATEGORIES, ICON_TONES } from '../vocabulary/filterKinds'

import { useTypeName } from './useTypeName'


export function TypeIcon({ type, className }: { type: string; className?: string }) {
    const visual = useEntityVisual(type)
    return <DynamicIcon name={visual.icon} className={cn('w-3.5 h-3.5 shrink-0', className)}
                        style={{ color: visual.color }} />
}


export function TypePicker({ value, onChange, types, autoFocus }: {
    value: readonly string[]
    onChange: (next: string[]) => void
    /** The types to offer, most common first. */
    types: readonly string[]
    autoFocus?: boolean
}) {
    const typeName = useTypeName()
    const options = useMemo<PickerOption[]>(() => types.map((t) => ({
        value: t, label: typeName(t), description: t !== typeName(t) ? t : undefined,
        icon: <TypeIcon type={t} />,
    })), [types, typeName])
    return (
        <UnifiedPicker multiple portal value={value} onChange={onChange} options={options}
                       placeholder="Pick one or more types…" autoFocus={autoFocus} allowFreeText={false} />
    )
}


const SHAPES = FILTER_CATEGORIES.find((c) => c.label === 'Graph shape')?.entries ?? []

/** One of the lineage shapes, swapped in place. */
export function ShapePicker({ value, onPick }: { value: string | undefined; onPick: (p: Predicate) => void }) {
    return (
        <div role="listbox" aria-label="Lineage shape" className="flex flex-col gap-0.5">
            {SHAPES.map((s) => {
                const p = s.build!()
                const on = p.kind === value
                const tone = ICON_TONES[s.tone]
                return (
                    <button key={s.id} type="button" role="option" aria-selected={on}
                            onClick={() => onPick(p)}
                            className={cn(
                                'flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                                on ? 'bg-accent-lineage/10' : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]',
                            )}>
                        <span className={cn('mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border', tone.container)}>
                            <s.icon className={cn('h-3.5 w-3.5', tone.icon)} />
                        </span>
                        <span className="flex flex-col">
                            <span className="text-sm text-ink">{s.label}</span>
                            <span className="text-xs text-ink-muted">{s.description}</span>
                        </span>
                    </button>
                )
            })}
        </div>
    )
}


const COMBINE = [
    { op: 'and' as const, label: 'All of them', hint: 'Every condition must hold.' },
    { op: 'or' as const, label: 'Any of them', hint: 'One condition holding is enough.' },
]

/** How the listed clauses combine: every one, or any one. */
export function CombinePicker({ value, onPick }: { value: 'and' | 'or'; onPick: (op: 'and' | 'or') => void }) {
    return (
        <div role="listbox" aria-label="How the conditions combine" className="flex flex-col gap-0.5">
            {COMBINE.map((o) => (
                <button key={o.op} type="button" role="option" aria-selected={o.op === value}
                        onClick={() => onPick(o.op)}
                        className={cn(
                            'flex items-baseline gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                            o.op === value ? 'bg-accent-lineage/10' : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]',
                        )}>
                    <span className="w-6 shrink-0 text-sm font-medium text-accent-lineage">{o.op}</span>
                    <span className="flex flex-col">
                        <span className="text-sm text-ink">{o.label}</span>
                        <span className="text-xs text-ink-muted">{o.hint}</span>
                    </span>
                </button>
            ))}
        </div>
    )
}


const GROUP_OPS = [
    { value: 'and' as const, label: 'All' },
    { value: 'or' as const, label: 'Any' },
    { value: 'not' as const, label: 'None' },
]

export function GroupOpPicker({ value, onChange }: {
    value: 'and' | 'or' | 'not'
    onChange: (op: 'and' | 'or' | 'not') => void
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <Segmented options={GROUP_OPS} value={value} onChange={onChange} label="How these combine" />
            <p className="text-xs text-ink-muted">
                {value === 'and' ? 'Every condition below must hold.'
                    : value === 'or' ? 'At least one condition below must hold.'
                        : 'None of the conditions below may hold.'}
            </p>
        </div>
    )
}
