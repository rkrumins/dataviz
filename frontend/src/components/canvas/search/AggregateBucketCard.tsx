/**
 * Premium card render for one SearchAggregateBucket.
 *
 * The "orient before drill" data point — the matchCount is the
 * headline. Renders:
 *
 *   ┌─────────────────────────────────────────┐
 *   │  [icon]  Customers                      │
 *   │   ████████████████████░░░░       482    │  ← display-font count
 *   │                                          │
 *   │  customer_id · email · phone_number     │  ← sample chips
 *   │                          [Drill in →]   │
 *   └─────────────────────────────────────────┘
 *
 * The share-of-total bar fills from 0 → its actual percentage with a
 * 600ms ease-out on entry, giving the moment-of-arrival the feel of
 * a calibrated analytics tool, not a generic search panel.
 */
import { motion } from 'framer-motion'
import { ChevronRight } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import { type FC, useMemo } from 'react'

import { cn } from '@/lib/utils'
import type { SearchAggregateBucket } from '@/types/search'


/** Lucide icon name per entity-type. Defaults to `Box`. */
const ENTITY_TYPE_ICONS: Record<string, string> = {
    domain: 'Globe',
    dataPlatform: 'Database',
    container: 'Folder',
    schema: 'FolderTree',
    dataset: 'Table2',
    schemaField: 'Hash',
    pipeline: 'Workflow',
    dataFlow: 'GitBranch',
    app: 'AppWindow',
    system: 'Cpu',
}

function entityIcon(type: string): FC<{ className?: string }> {
    const name = ENTITY_TYPE_ICONS[type] ?? 'Box'
    const Component = (LucideIcons as unknown as Record<
        string, FC<{ className?: string }>
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
    const IconComp = useMemo(
        () => entityIcon(bucket.ancestorEntityType),
        [bucket.ancestorEntityType],
    )
    const share = grandTotal > 0
        ? Math.min(1, bucket.matchCount / grandTotal)
        : 0
    const sharePct = Math.round(share * 100)
    const formattedCount = formatCount(bucket.matchCount)
    const sampleNames = bucket.sampleHits
        .slice(0, 5)
        .map((h) => h.node.displayName)

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
                duration: 0.24,
                delay: Math.min(index * 0.04, 0.4),
                ease: [0.22, 1, 0.36, 1],
            }}
            whileHover={{ y: -1 }}
            className={cn(
                "group relative rounded-xl border border-glass-border",
                "bg-canvas-elevated/80 backdrop-blur-sm",
                "p-4 transition-shadow duration-200",
                "hover:shadow-node-hover hover:border-accent-lineage/40",
                onDrill && "cursor-pointer",
            )}
            onClick={onDrill}
        >
            {/* Row 1: icon + label + count */}
            <div className="flex items-baseline gap-3">
                <div
                    className={cn(
                        "shrink-0 w-9 h-9 rounded-lg flex items-center justify-center",
                        "bg-accent-lineage/10 text-accent-lineage",
                        "self-center",
                    )}
                >
                    <IconComp className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-3">
                        <div className="min-w-0">
                            <div className="font-medium text-sm text-ink truncate">
                                {bucket.ancestorDisplayName || '(unnamed)'}
                            </div>
                            <div className="text-2xs uppercase tracking-wider text-ink-muted mt-0.5">
                                {bucket.ancestorEntityType || 'aggregate'}
                            </div>
                        </div>
                        <div
                            className={cn(
                                "font-display tabular-nums",
                                "text-3xl leading-none text-ink",
                                "drop-shadow-sm",
                            )}
                            title={`${bucket.matchCount.toLocaleString()} matches`}
                        >
                            {formattedCount}
                        </div>
                    </div>
                </div>
            </div>

            {/* Share-of-total bar */}
            <div className="mt-3 relative h-1.5 rounded-full bg-glass/40 overflow-hidden">
                <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${sharePct}%` }}
                    transition={{
                        duration: 0.6,
                        delay: 0.1 + Math.min(index * 0.04, 0.4),
                        ease: [0.22, 1, 0.36, 1],
                    }}
                    className={cn(
                        "absolute inset-y-0 left-0 rounded-full",
                        "bg-gradient-to-r from-accent-lineage/60 to-accent-lineage",
                    )}
                />
            </div>
            <div className="mt-1.5 flex items-baseline justify-between text-2xs">
                <span className="text-ink-muted">
                    {sharePct}% of matches
                </span>
            </div>

            {/* Sample-hit chips */}
            {sampleNames.length > 0 && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{
                        delay: 0.4 + Math.min(index * 0.04, 0.4),
                        duration: 0.3,
                    }}
                    className="mt-3 flex flex-wrap gap-1.5"
                >
                    {sampleNames.map((name) => (
                        <span
                            key={name}
                            className={cn(
                                "inline-flex items-center px-2 py-0.5 rounded-md",
                                "text-2xs font-mono",
                                "bg-glass/30 text-ink-secondary",
                                "border border-glass-border/60",
                                "truncate max-w-[12rem]",
                            )}
                            title={name}
                        >
                            {name}
                        </span>
                    ))}
                    {bucket.matchCount > sampleNames.length && (
                        <span className="inline-flex items-center px-2 py-0.5 text-2xs text-ink-muted">
                            +{(bucket.matchCount - sampleNames.length).toLocaleString()} more
                        </span>
                    )}
                </motion.div>
            )}

            {/* Drill affordance — visible on hover, always tab-reachable */}
            {onDrill && (
                <div
                    className={cn(
                        "absolute bottom-3 right-3",
                        "flex items-center gap-1 text-2xs font-medium",
                        "text-accent-lineage opacity-0 -translate-x-1",
                        "transition-all duration-200",
                        "group-hover:opacity-100 group-hover:translate-x-0",
                    )}
                >
                    Drill in
                    <ChevronRight className="w-3 h-3" />
                </div>
            )}
        </motion.div>
    )
}


/** Format a count with smart abbreviation for big numbers: 1.2K, 482, 12M. */
function formatCount(n: number): string {
    if (n < 1000) return n.toString()
    if (n < 1_000_000) {
        const v = n / 1000
        return v >= 10 ? `${Math.round(v)}K` : `${v.toFixed(1)}K`
    }
    const v = n / 1_000_000
    return v >= 10 ? `${Math.round(v)}M` : `${v.toFixed(1)}M`
}
