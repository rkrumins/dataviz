/**
 * FunnelStrip — the activation funnel: signed up → active → opened → created.
 *
 * These stages ARE ordered, so they take the ordinal ramp (one hue, deepening
 * with depth) rather than categorical slots. Categorical colour here would say
 * "these are four different things" when the point is that they are four
 * points on one path.
 *
 * Labels sit ABOVE the bar, never inside it. A label set on a coloured fill has
 * to pick white or ink by the fill's luminance, and this ramp runs from a mid
 * indigo to near-black in light mode and to near-white in dark — there is no
 * single choice that clears contrast at both ends. Outside the mark, the text
 * wears ordinary ink tokens and is legible by construction.
 *
 * Each stage shows the drop from the previous one, because the interesting
 * number is never the count — it is where people stopped.
 */
import { ArrowDown } from 'lucide-react'

import { cn } from '@/lib/utils'
import { exact, percent } from '@/lib/formatMetric'
import { useChartTheme } from './chartTheme'

export interface FunnelStage {
    stage: string
    count: number
    rate: number | null
}

export function FunnelStrip({ stages, className }: { stages: FunnelStage[]; className?: string }) {
    const theme = useChartTheme()
    const top = stages[0]?.count ?? 0

    return (
        <ol className={cn('space-y-3', className)}>
            {stages.map((s, i) => {
                const share = top > 0 ? s.count / top : 0
                const previous = i > 0 ? stages[i - 1].count : null
                const dropped = previous !== null ? Math.max(0, previous - s.count) : null
                const color = theme.ramp[Math.min(i, theme.ramp.length - 1)]
                return (
                    <li key={s.stage}>
                        <div className="flex items-baseline justify-between gap-3 mb-1">
                            <span className="flex items-center gap-2 min-w-0">
                                <span
                                    aria-hidden
                                    className="w-2.5 h-2.5 rounded-[3px] shrink-0"
                                    style={{ backgroundColor: color }}
                                />
                                <span className="text-xs font-semibold text-ink truncate">
                                    {s.stage}
                                </span>
                            </span>
                            <span className="flex items-baseline gap-2 shrink-0">
                                <span className="text-sm font-bold text-ink tabular-nums">
                                    {exact(s.count)}
                                </span>
                                <span className="text-[11px] text-ink-muted tabular-nums w-10 text-right">
                                    {percent(s.rate)}
                                </span>
                            </span>
                        </div>
                        {/* The unfilled track is a lighter step of the same ramp,
                            so the state reads across the whole bar. */}
                        <div className="h-2.5 rounded-full bg-black/[0.05] dark:bg-white/[0.06] overflow-hidden">
                            <div
                                className="h-full rounded-full transition-[width] duration-500"
                                style={{
                                    width: `${Math.max(share * 100, s.count > 0 ? 1.5 : 0)}%`,
                                    backgroundColor: color,
                                }}
                            />
                        </div>
                        {dropped !== null && dropped > 0 && i < stages.length && (
                            <p className="flex items-center gap-1 pt-1.5 text-[10px] text-ink-muted">
                                <ArrowDown className="w-3 h-3" aria-hidden />
                                {exact(dropped)} dropped off before this step
                            </p>
                        )}
                    </li>
                )
            })}
        </ol>
    )
}
