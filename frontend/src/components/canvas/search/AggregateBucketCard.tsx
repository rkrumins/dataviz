/**
 * Premium card render for one SearchAggregateBucket.
 *
 * Visual treatment matches the canvas's existing node/layer-card
 * language: gradient entity-type icon container with colored shadow,
 * display-font headline count with a count-up animation on entry, a
 * gradient share-of-total bar, sample-hit chips, and a hover-revealed
 * drill affordance. Each bucket card is the unit of orient-before-drill.
 *
 * Layout (all sub-elements are stacked vertically with deliberate spacing):
 *
 *   ┌─────────────────────────────────────────────┐
 *   │  ┌──┐                                  →  │  icon + drill arrow
 *   │  │🌐│  Customers                            │
 *   │  └──┘  DOMAIN                               │
 *   │                                             │
 *   │  482                                        │  display-font count
 *   │  matches · 38.7% of total                   │  subtitle
 *   │                                             │
 *   │  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰░░░░                  │  gradient bar
 *   │                                             │
 *   │  customer_id · email · phone_number  +479  │  sample chips
 *   └─────────────────────────────────────────────┘
 */
import { motion, animate, useMotionValue, useTransform } from 'framer-motion'
import { ChevronRight } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import { type FC, useEffect, useMemo } from 'react'

import { cn } from '@/lib/utils'
import type { SearchAggregateBucket } from '@/types/search'


/** Per entity-type, the gradient + accent color used for the icon
 * container, the share-bar gradient, and the hover-glow shadow.
 * Mirrors the canvas's layer-color language so domains read as
 * business / containers as technical / etc., without needing the
 * view's per-layer config (which we don't have for arbitrary
 * ancestor URNs).
 */
interface EntityTypeStyle {
    icon: string                  // lucide icon name
    iconBg: string                // gradient classes for icon container
    iconText: string              // icon color
    shadowColor: string           // shadow on hover (dark mode)
    barGradient: string           // share bar fill gradient
    accentText: string            // entity-type label color
}

const ENTITY_STYLES: Record<string, EntityTypeStyle> = {
    domain: {
        icon: 'Globe',
        iconBg: 'from-amber-500/25 to-orange-500/20',
        iconText: 'text-amber-600 dark:text-amber-400',
        shadowColor: 'dark:shadow-amber-500/20',
        barGradient: 'from-amber-500/60 via-amber-500 to-orange-500',
        accentText: 'text-amber-700 dark:text-amber-300',
    },
    dataPlatform: {
        icon: 'Database',
        iconBg: 'from-accent-lineage/25 to-cyan-500/20',
        iconText: 'text-accent-lineage',
        shadowColor: 'dark:shadow-accent-lineage/20',
        barGradient: 'from-accent-lineage/60 via-accent-lineage to-cyan-400',
        accentText: 'text-accent-lineage',
    },
    container: {
        icon: 'Folder',
        iconBg: 'from-purple-500/25 to-violet-500/20',
        iconText: 'text-purple-600 dark:text-purple-400',
        shadowColor: 'dark:shadow-purple-500/20',
        barGradient: 'from-purple-500/60 via-purple-500 to-violet-500',
        accentText: 'text-purple-700 dark:text-purple-300',
    },
    schema: {
        icon: 'FolderTree',
        iconBg: 'from-violet-500/25 to-fuchsia-500/20',
        iconText: 'text-violet-600 dark:text-violet-400',
        shadowColor: 'dark:shadow-violet-500/20',
        barGradient: 'from-violet-500/60 via-violet-500 to-fuchsia-500',
        accentText: 'text-violet-700 dark:text-violet-300',
    },
    dataset: {
        icon: 'Table2',
        iconBg: 'from-emerald-500/25 to-teal-500/20',
        iconText: 'text-emerald-600 dark:text-emerald-400',
        shadowColor: 'dark:shadow-emerald-500/20',
        barGradient: 'from-emerald-500/60 via-emerald-500 to-teal-500',
        accentText: 'text-emerald-700 dark:text-emerald-300',
    },
    schemaField: {
        icon: 'Hash',
        iconBg: 'from-sky-500/25 to-blue-500/20',
        iconText: 'text-sky-600 dark:text-sky-400',
        shadowColor: 'dark:shadow-sky-500/20',
        barGradient: 'from-sky-500/60 via-sky-500 to-blue-500',
        accentText: 'text-sky-700 dark:text-sky-300',
    },
    pipeline: {
        icon: 'Workflow',
        iconBg: 'from-rose-500/25 to-pink-500/20',
        iconText: 'text-rose-600 dark:text-rose-400',
        shadowColor: 'dark:shadow-rose-500/20',
        barGradient: 'from-rose-500/60 via-rose-500 to-pink-500',
        accentText: 'text-rose-700 dark:text-rose-300',
    },
    dataFlow: {
        icon: 'GitBranch',
        iconBg: 'from-indigo-500/25 to-blue-500/20',
        iconText: 'text-indigo-600 dark:text-indigo-400',
        shadowColor: 'dark:shadow-indigo-500/20',
        barGradient: 'from-indigo-500/60 via-indigo-500 to-blue-500',
        accentText: 'text-indigo-700 dark:text-indigo-300',
    },
}

const DEFAULT_STYLE: EntityTypeStyle = {
    icon: 'Box',
    iconBg: 'from-accent-lineage/20 to-purple-500/15',
    iconText: 'text-accent-lineage',
    shadowColor: 'dark:shadow-accent-lineage/15',
    barGradient: 'from-accent-lineage/50 via-accent-lineage to-accent-lineage/80',
    accentText: 'text-ink-secondary',
}


function styleFor(type: string): EntityTypeStyle {
    return ENTITY_STYLES[type] ?? DEFAULT_STYLE
}


function lucideIcon(name: string): FC<{ className?: string; strokeWidth?: number }> {
    const Component = (LucideIcons as unknown as Record<
        string, FC<{ className?: string; strokeWidth?: number }>
    >)[name]
    return Component ?? LucideIcons.Box
}


export interface AggregateBucketCardProps {
    bucket: SearchAggregateBucket
    /** Total of all matchCounts in the same response — drives the share bar. */
    grandTotal: number
    /** Stagger index for the entry animation (0, 1, 2, ...). */
    index: number
    /** Click handler — typically calls `useAdvancedSearch.drillInto(bucket)`. */
    onDrill?: () => void
}

export const AggregateBucketCard: FC<AggregateBucketCardProps> = ({
    bucket, grandTotal, index, onDrill,
}) => {
    const style = useMemo(
        () => styleFor(bucket.ancestorEntityType),
        [bucket.ancestorEntityType],
    )
    const IconComp = useMemo(() => lucideIcon(style.icon), [style.icon])

    const share = grandTotal > 0
        ? Math.min(1, bucket.matchCount / grandTotal)
        : 0
    const sharePct = Math.round(share * 1000) / 10  // one decimal
    const sampleNames = bucket.sampleHits.slice(0, 4).map((h) => h.node.displayName)
    // Tight stagger cap so a 50-bucket response settles in ~150ms total,
    // not 2 seconds. The choreography should feel responsive, not slow.
    const staggerDelay = Math.min(index * 0.012, 0.15)

    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
                duration: 0.18,
                delay: staggerDelay,
                ease: [0.22, 1, 0.36, 1],
            }}
            whileHover={{ y: -2 }}
            className={cn(
                "group relative overflow-hidden",
                "rounded-2xl",
                // Solid card surface that sits cleanly on the glass-panel
                // backdrop — both light and dark mode.
                "border border-black/[0.08] dark:border-white/[0.08]",
                "bg-canvas-elevated dark:bg-canvas-elevated/95",
                "p-5",
                "shadow-sm transition-all duration-200",
                "hover:shadow-md dark:hover:shadow-xl",
                "hover:border-accent-lineage/30",
                style.shadowColor && `hover:${style.shadowColor}`,
                onDrill && "cursor-pointer",
            )}
            onClick={onDrill}
        >
            {/* Row 1: icon + label + drill arrow */}
            <div className="relative flex items-start gap-3">
                <div className={cn(
                    "shrink-0 w-11 h-11 rounded-xl flex items-center justify-center",
                    "bg-gradient-to-br shadow-lg",
                    style.iconBg,
                    style.shadowColor,
                )}>
                    <IconComp className={cn("w-5 h-5", style.iconText)} strokeWidth={2} />
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                    <div className="text-[15px] font-display font-semibold text-ink truncate leading-tight">
                        {bucket.ancestorDisplayName || '(unnamed)'}
                    </div>
                    <div className={cn(
                        "mt-1 text-[10px] uppercase tracking-[0.12em] font-medium",
                        style.accentText,
                    )}>
                        {bucket.ancestorEntityType || 'aggregate'}
                    </div>
                </div>
                {onDrill && (
                    <div className={cn(
                        "shrink-0 w-7 h-7 rounded-lg flex items-center justify-center",
                        "bg-glass/30 text-ink-muted",
                        "opacity-0 -translate-x-1",
                        "group-hover:opacity-100 group-hover:translate-x-0",
                        "group-hover:bg-accent-lineage/15 group-hover:text-accent-lineage",
                        "transition-all duration-200",
                    )}>
                        <ChevronRight className="w-4 h-4" strokeWidth={2.5} />
                    </div>
                )}
            </div>

            {/* Row 2: BIG count + subtitle */}
            <div className="relative mt-4">
                <div className="flex items-baseline gap-3">
                    <AnimatedCount
                        value={bucket.matchCount}
                        delay={staggerDelay + 0.02}
                        className={cn(
                            "font-display font-semibold tabular-nums",
                            "text-[40px] leading-none text-ink tracking-tight",
                        )}
                    />
                    <span className="text-xs text-ink-muted">
                        {bucket.matchCount === 1 ? 'match' : 'matches'}
                    </span>
                </div>
                <div className="mt-1.5 text-xs text-ink-muted">
                    <span className={cn("font-medium", style.accentText)}>
                        {sharePct}%
                    </span>
                    {' '}of total
                </div>
            </div>

            {/* Row 3: share bar — single layer, tight transition, CSS only.
                Was two stacked motion.divs (~280ms total) — collapsed to one
                CSS transition that fires on mount, no framer-motion overhead. */}
            <div className="relative mt-4 h-2 rounded-full bg-glass/30 overflow-hidden">
                <div
                    className={cn(
                        "absolute inset-y-0 left-0 rounded-full",
                        "bg-gradient-to-r",
                        style.barGradient,
                        "shadow-sm",
                        "transition-[width] duration-300 ease-out",
                    )}
                    style={{
                        width: `${Math.max(2, share * 100)}%`,
                        transitionDelay: `${staggerDelay * 1000 + 60}ms`,
                    }}
                />
            </div>

            {/* Row 4: sample-hit chips — no entry delay; the parent card
                fade handles it. */}
            {sampleNames.length > 0 && (
                <div className="relative mt-4 flex flex-wrap gap-1.5">
                    {sampleNames.map((name) => (
                        <span
                            key={name}
                            className={cn(
                                "inline-flex items-center px-2 py-1 rounded-md",
                                "text-[10.5px] font-mono",
                                "bg-glass/40 text-ink-secondary",
                                "border border-glass-border/60",
                                "truncate max-w-[11rem]",
                            )}
                            title={name}
                        >
                            {name}
                        </span>
                    ))}
                    {bucket.matchCount > sampleNames.length && (
                        <span className="inline-flex items-center px-1.5 py-1 text-[10.5px] text-ink-muted font-medium">
                            +{formatCount(bucket.matchCount - sampleNames.length)} more
                        </span>
                    )}
                </div>
            )}
        </motion.div>
    )
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tween from 0 → `value` over ~0.3s (was 0.9s). Short enough that the
 * count never feels like it's lagging the response, long enough to read
 * as deliberate calibration rather than a hard switch. For values below
 * 100 we skip the animation entirely — the difference is imperceptible
 * and it saves a frame per render.
 */
function AnimatedCount({
    value, delay = 0, className,
}: { value: number; delay?: number; className?: string }) {
    const motionValue = useMotionValue(value < 100 ? value : 0)
    const display = useTransform(motionValue, (latest) =>
        formatCount(Math.round(latest)),
    )

    useEffect(() => {
        if (value < 100) {
            motionValue.set(value)
            return
        }
        const controls = animate(motionValue, value, {
            duration: 0.3,
            delay,
            ease: [0.22, 1, 0.36, 1],
        })
        return () => controls.stop()
    }, [value, delay, motionValue])

    return (
        <motion.span className={className} title={value.toLocaleString()}>
            {display}
        </motion.span>
    )
}


/** Smart-abbreviate a count for the headline: 482, 1.2K, 12M, 1.2B. */
function formatCount(n: number): string {
    if (n < 1000) return n.toString()
    if (n < 1_000_000) {
        const v = n / 1000
        return v >= 10 ? `${Math.round(v)}K` : `${v.toFixed(1)}K`
    }
    if (n < 1_000_000_000) {
        const v = n / 1_000_000
        return v >= 10 ? `${Math.round(v)}M` : `${v.toFixed(1)}M`
    }
    const v = n / 1_000_000_000
    return v >= 10 ? `${Math.round(v)}B` : `${v.toFixed(1)}B`
}
