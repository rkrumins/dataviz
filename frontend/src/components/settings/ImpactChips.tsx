/**
 * ImpactChips — what a choice or a change does, dimension by dimension: "+ Read speed",
 * "− Memory", "= Cost". The verdict is an icon and a word as well as a colour; a tap, a click or
 * Enter on a chip opens the registry's sentence for it (`MetricInfo`), on a phone too.
 */
import { Circle } from 'lucide-react'
import { MetricInfo } from '@/components/analytics/MetricInfo'
import { cn } from '@/lib/utils'
import type { Impact } from './impacts'
import { VERDICT_META } from './meta'
import type { DimensionInfo } from './types'

export function ImpactChips({ impacts, dimensions, label = 'What it changes', hideSame = false, className }: {
    impacts: Impact[]
    dimensions: DimensionInfo[]
    /** The list's accessible name. */
    label?: string
    /** Leave out dimensions it doesn't change. */
    hideSame?: boolean
    className?: string
}) {
    const shown = hideSame ? impacts.filter((i) => i.verdict !== 'same') : impacts
    if (shown.length === 0) return null
    const name = (d: string) => dimensions.find((x) => x.id === d)?.label ?? d
    return (
        <ul aria-label={label} className={cn('flex flex-wrap gap-1.5', className)}>
            {shown.map((i) => {
                const meta = i.verdict ? VERDICT_META[i.verdict] : null
                const Icon = meta?.icon ?? Circle
                return (
                    <li key={i.dimension}>
                        <MetricInfo definition={{ title: name(i.dimension), what: i.text }}>
                            <span
                                className={cn(
                                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4',
                                    meta?.chip ?? 'border border-glass-border/80 text-ink-secondary',
                                )}
                            >
                                <Icon className="w-3 h-3" aria-hidden />
                                {name(i.dimension)}
                                <span className="sr-only">: {meta ? meta.label : 'changes'}</span>
                            </span>
                        </MetricInfo>
                    </li>
                )
            })}
        </ul>
    )
}
