/**
 * Drill-scope breadcrumb. Renders only when the user has drilled into
 * at least one aggregate bucket — i.e. `scope.length > 1`. The root
 * frame is implicit (visible in PanelHeader's "scope" subtitle).
 */
import { motion } from 'framer-motion'
import { ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

import type { ScopeFrame } from '@/hooks/useAdvancedSearch'


export interface ScopeStripProps {
    scope: ScopeFrame[]
    onPop: (toIndex: number) => void
}


export function ScopeStrip({ scope, onPop }: ScopeStripProps) {
    if (scope.length <= 1) return null
    return (
        <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            transition={{ duration: 0.2 }}
            className={cn(
                "shrink-0 px-4 py-2",
                "border-b border-glass-border/60",
                "bg-gradient-to-r from-accent-lineage/[0.04] via-transparent to-accent-lineage/[0.04]",
            )}
        >
            <div className="flex items-center gap-1 flex-wrap">
                <span className="text-[9px] uppercase tracking-[0.12em] font-semibold text-ink-muted/70 mr-1">
                    Drilled
                </span>
                {scope.map((frame, i) => {
                    const isLast = i === scope.length - 1
                    return (
                        <span
                            key={`${frame.urn}-${i}`}
                            className="inline-flex items-center gap-1"
                        >
                            {i > 0 && (
                                <ChevronRight className="w-3 h-3 text-ink-muted/50" strokeWidth={2.5} />
                            )}
                            <button
                                onClick={() => onPop(i)}
                                disabled={isLast}
                                className={cn(
                                    "px-2 py-0.5 rounded-md text-[10.5px] font-medium transition-all duration-150",
                                    isLast
                                        ? "bg-accent-lineage/20 text-accent-lineage cursor-default"
                                        : "bg-glass/40 text-ink-secondary hover:bg-glass/70 hover:text-ink",
                                )}
                            >
                                {frame.label}
                            </button>
                        </span>
                    )
                })}
            </div>
        </motion.div>
    )
}
