/**
 * PropertyInsightCharts — premium data-viz primitives for the expanded
 * property insights: a count-up number, animated ranked horizontal bars,
 * and a coverage gauge. Replaces the old plain right-aligned number list.
 *
 * Mirrors the animated-count + gradient-share-bar patterns from
 * `canvas/search/AggregateBucketCard.tsx` (those helpers are internal to
 * that file) and reuses `CoverageRing` from the onboarding wizard.
 */
import { animate, motion, useMotionValue, useTransform } from 'framer-motion'
import { useEffect } from 'react'

import { cn } from '@/lib/utils'
import { CoverageRing, coverageColor } from '@/components/admin/AssetOnboardingWizard/steps/CoverageVisuals'

import { entityTypeStyle } from './entityTypeStyles'


const EASE = [0.22, 1, 0.36, 1] as const


/** Count-up to ``value`` with thousands separators. */
export function AnimatedNumber({ value, className }: { value: number; className?: string }) {
    const mv = useMotionValue(0)
    const display = useTransform(mv, (latest) => Math.round(latest).toLocaleString())
    useEffect(() => {
        const controls = animate(mv, value, { duration: 0.8, ease: EASE })
        return () => controls.stop()
    }, [value, mv])
    return <motion.span className={className} title={value.toLocaleString()}>{display}</motion.span>
}


export interface RankedItem { label: string; count: number }

/**
 * Animated ranked horizontal bars: label · gradient fill (width ∝ count) ·
 * count · optional %. When ``colorByEntityType`` the fill is tinted by the
 * label's entity-type identity; otherwise the accent gradient.
 */
export function RankedValueBars({
    items, total, limit = 6, colorByEntityType = false, showPct = true,
}: {
    items: RankedItem[]
    total: number
    limit?: number
    colorByEntityType?: boolean
    showPct?: boolean
}) {
    const shown = items.slice(0, limit)
    const max = Math.max(...shown.map((i) => i.count), 1)
    return (
        <div className="flex flex-col gap-1.5">
            {shown.map((it, idx) => {
                const w = Math.max(3, (it.count / max) * 100)
                const grad = colorByEntityType
                    ? entityTypeStyle(it.label).bar
                    : 'from-accent-lineage/70 to-accent-lineage'
                const pct = total > 0 ? Math.round((it.count / total) * 100) : 0
                return (
                    <div key={`${it.label}-${idx}`} className="flex items-center gap-2 text-[11px]">
                        <span className="w-24 shrink-0 truncate font-mono text-ink-secondary" title={it.label || '∅'}>
                            {it.label || '∅'}
                        </span>
                        <div className="flex-1 h-2 rounded-full bg-black/[0.05] dark:bg-white/[0.06] overflow-hidden">
                            <motion.div
                                initial={{ width: 0 }}
                                animate={{ width: `${w}%` }}
                                transition={{ duration: 0.6, delay: Math.min(idx * 0.05, 0.3), ease: EASE }}
                                className={cn('h-full rounded-full bg-gradient-to-r shadow-sm', grad)}
                            />
                        </div>
                        <span className="w-12 shrink-0 text-right tabular-nums text-ink font-medium">
                            {it.count.toLocaleString()}
                        </span>
                        {showPct && (
                            <span className="w-9 shrink-0 text-right tabular-nums text-ink-muted/70">{pct}%</span>
                        )}
                    </div>
                )
            })}
        </div>
    )
}


/**
 * Coverage gauge for a property: a ring (share of the view that carries
 * the key) + an animated headline count + a per-entity-type ranked bar set.
 */
export function UsageGauge({
    total, viewTotal, byEntityType,
}: {
    total: number
    viewTotal: number
    byEntityType: { type: string; count: number }[]
}) {
    const pct = viewTotal > 0 ? Math.min(100, Math.round((total / viewTotal) * 100)) : 100
    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
                <CoverageRing percent={pct} size={56} stroke={5} color={coverageColor(pct)} />
                <div className="min-w-0">
                    <div className="flex items-baseline gap-1.5">
                        <AnimatedNumber value={total} className="text-[20px] font-bold text-ink tabular-nums leading-none" />
                        <span className="text-[11px] text-ink-muted">
                            {total === 1 ? 'entity uses this' : 'entities use this'}
                        </span>
                    </div>
                    {viewTotal > 0 && (
                        <div className="mt-1 text-[10.5px] text-ink-muted/70">
                            {pct}% of {viewTotal.toLocaleString()} in this view
                        </div>
                    )}
                </div>
            </div>
            {byEntityType.length > 0 && (
                <RankedValueBars
                    items={byEntityType.map((b) => ({ label: b.type, count: b.count }))}
                    total={total}
                    colorByEntityType
                    showPct={false}
                />
            )}
        </div>
    )
}
