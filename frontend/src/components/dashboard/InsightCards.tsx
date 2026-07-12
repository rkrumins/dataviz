import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { Monitor, BookOpen, Boxes, Component } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DashboardStats } from '@/hooks/useDashboardData'
import { CARD_THEMES } from './dashboard-constants'

/**
 * InsightCards — the dashboard's at-a-glance numbers, framed for the person who
 * uses this day to day (building and browsing views) rather than for an operator.
 *
 * Two things were wrong before:
 *   1. They were `cursor-pointer` with a hover-lift but NO onClick — they looked
 *      interactive and did nothing. Each is now a real click-through.
 *   2. The view count came from a client-side store, not the authoritative
 *      catalog stat.
 *
 * Framing: leads with what a business user actually reasons about — the views
 * they explore, the SEMANTIC LAYER (the shared business meaning of the data),
 * the workspaces/business areas they belong to, and how much data is covered.
 * "Nodes in all graphs" and pipeline internals are an operator's vocabulary.
 */
export function InsightCards({ stats, viewsCount, semanticLayersCount }: {
    stats: DashboardStats
    /** Authoritative catalog total (useViewStats), not schemaStore.views.length. */
    viewsCount: number
    /** Published semantic layers — the business vocabulary over the data. */
    semanticLayersCount: number
}) {
    const navigate = useNavigate()

    const cards = [
        {
            label: 'Context Views',
            sublabel: 'Browse and build views',
            value: viewsCount,
            icon: Monitor,
            to: '/explorer',
        },
        {
            label: 'Semantic Layers',
            sublabel: 'Shared business meaning',
            value: semanticLayersCount,
            icon: BookOpen,
            to: '/schema',
        },
        {
            label: 'Workspaces',
            sublabel: 'Business areas you work in',
            value: stats.totalWorkspaces,
            icon: Boxes,
            to: '/workspaces',
        },
        {
            label: 'Data Assets',
            sublabel: 'Objects across your connected data',
            value: new Intl.NumberFormat().format(stats.totalEntities),
            icon: Component,
            to: '/workspaces',
        },
    ]

    return (
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 px-4 md:px-0 mb-14">
            {cards.map((c, i) => {
                const t = CARD_THEMES[i]
                return (
                    <motion.button
                        key={c.label}
                        type="button"
                        onClick={() => navigate(c.to)}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.03, duration: 0.2, ease: 'easeOut' }}
                        className={cn(
                            'relative glass-panel rounded-2xl border border-glass-border p-5 text-left cursor-pointer overflow-hidden group',
                            'hover:-translate-y-1 hover:shadow-xl transition-all duration-300',
                            t.border,
                        )}
                    >
                        <div className={cn('absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none', t.gradient)} />
                        <div className="relative z-10 flex flex-col h-full">
                            <div className={cn('w-9 h-9 rounded-xl border flex items-center justify-center mb-4', t.iconBg)}>
                                <c.icon className="w-4 h-4" />
                            </div>
                            <div className="mt-auto">
                                <div className={cn('text-3xl font-black tracking-tight leading-none mb-1', t.valueCls)}>
                                    {c.value}
                                </div>
                                <div className="text-sm font-semibold text-ink">{c.label}</div>
                                <div className="text-xs text-ink-muted mt-0.5">{c.sublabel}</div>
                            </div>
                        </div>
                    </motion.button>
                )
            })}
        </div>
    )
}
