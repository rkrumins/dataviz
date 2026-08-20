/**
 * KpiCard — a stat tile: label · value · delta vs the previous period · trend.
 *
 * The value uses PROPORTIONAL figures, not `tabular-nums`. Equal-width digits
 * are for columns that must align vertically; at display size they make a
 * number like `121` look loose. Tabular belongs in the table twin, not here.
 *
 * The delta's colour encodes direction × whether up is good — a falling
 * time-to-value is progress, a falling active-user count is not — so callers
 * pass `higherIsBetter` rather than the tile assuming green-means-up.
 *
 * A delta of `null` renders as nothing at all. The previous period having no
 * base is not a "+100%"; inventing one would be the most-read number on the
 * page being fiction.
 */
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Sparkline, type SparklineTone } from '@/components/ui/Sparkline'
import { compact, exact, signedPercent } from '@/lib/formatMetric'

export interface KpiCardProps {
    label: string
    value: number | string
    /** Percent change against the previous window; `null` when incomparable. */
    changePct?: number | null
    /** Names the comparison, e.g. "vs previous 30 days". */
    comparisonLabel?: string
    /** Secondary line under the value. */
    sub?: string
    icon?: React.ComponentType<{ className?: string }>
    trend?: number[]
    trendTone?: SparklineTone
    higherIsBetter?: boolean
    accent?: 'indigo' | 'amber' | 'cyan' | 'pink' | 'violet' | 'emerald'
    onClick?: () => void
    className?: string
}

const ACCENTS = {
    indigo: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
    amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    cyan: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20',
    pink: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/20',
    violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
    emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
} as const

export function KpiCard({
    label, value, changePct, comparisonLabel, sub, icon: Icon,
    trend, trendTone = 'indigo', higherIsBetter = true, accent = 'indigo',
    onClick, className,
}: KpiCardProps) {
    const delta = signedPercent(changePct ?? null)
    const good = changePct == null || changePct === 0
        ? null
        : (changePct > 0) === higherIsBetter
    const Tag = onClick ? 'button' : 'div'

    return (
        <Tag
            {...(onClick ? { type: 'button' as const, onClick } : {})}
            className={cn(
                'group relative overflow-hidden rounded-2xl border border-glass-border bg-canvas-elevated p-4 text-left shadow-sm transition-all',
                onClick && 'hover:border-indigo-500/30 hover:shadow-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                className,
            )}
        >
            <div className="flex items-start justify-between gap-3 mb-3">
                {Icon && (
                    <span className={cn(
                        'w-8 h-8 rounded-xl border flex items-center justify-center shrink-0',
                        ACCENTS[accent],
                    )}>
                        <Icon className="w-4 h-4" />
                    </span>
                )}
                {trend && trend.length >= 3 && (
                    <Sparkline
                        points={trend}
                        tone={trendTone}
                        label={label}
                        width={72}
                        height={22}
                        className="shrink-0"
                    />
                )}
            </div>

            <p className="text-2xl font-bold text-ink leading-none">
                {typeof value === 'number' ? compact(value) : value}
            </p>
            <p className="mt-1.5 text-xs font-medium text-ink-secondary">{label}</p>

            <div className="mt-2 flex items-center gap-1.5 min-h-[18px]">
                {delta ? (
                    <>
                        <span className={cn(
                            'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-bold',
                            good === null && 'bg-black/5 dark:bg-white/5 text-ink-muted',
                            good === true && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                            good === false && 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                        )}>
                            {changePct === 0
                                ? <Minus className="w-3 h-3" aria-hidden />
                                : (changePct ?? 0) > 0
                                    ? <ArrowUpRight className="w-3 h-3" aria-hidden />
                                    : <ArrowDownRight className="w-3 h-3" aria-hidden />}
                            {delta}
                        </span>
                        {comparisonLabel && (
                            <span className="text-[10px] text-ink-muted truncate">{comparisonLabel}</span>
                        )}
                    </>
                ) : (
                    sub && <span className="text-[10px] text-ink-muted truncate">{sub}</span>
                )}
            </div>
            {delta && sub && (
                <p className="mt-1 text-[10px] text-ink-muted truncate">{sub}</p>
            )}
        </Tag>
    )
}

/**
 * HeroFigure — the one number a view leads with. Exactly one per view.
 *
 * Same sans as everything else: a display or serif face here reads as off-brand
 * decoration rather than as data.
 */
export function HeroFigure({
    label, value, changePct, comparisonLabel, sub, higherIsBetter = true,
}: {
    label: string
    value: number
    changePct?: number | null
    comparisonLabel?: string
    sub?: string
    higherIsBetter?: boolean
}) {
    const delta = signedPercent(changePct ?? null)
    const good = changePct == null || changePct === 0
        ? null
        : (changePct > 0) === higherIsBetter

    return (
        <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                {label}
            </p>
            <div className="mt-1 flex items-end gap-3 flex-wrap">
                <span
                    className="text-5xl font-bold leading-none text-ink"
                    title={exact(value)}
                >
                    {compact(value)}
                </span>
                {delta && (
                    <span className={cn(
                        'mb-1 inline-flex items-center gap-0.5 rounded-lg px-2 py-1 text-xs font-bold',
                        good === null && 'bg-black/5 dark:bg-white/5 text-ink-muted',
                        good === true && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                        good === false && 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                    )}>
                        {(changePct ?? 0) > 0
                            ? <ArrowUpRight className="w-3.5 h-3.5" aria-hidden />
                            : <ArrowDownRight className="w-3.5 h-3.5" aria-hidden />}
                        {delta}
                    </span>
                )}
            </div>
            <p className="mt-1.5 text-xs text-ink-muted">
                {sub}
                {delta && comparisonLabel ? ` · ${comparisonLabel}` : ''}
            </p>
        </div>
    )
}
