import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { Monitor, BookOpen, Boxes, Database } from 'lucide-react'
import { cn } from '@/lib/utils'
import { compact } from '@/lib/formatMetric'
import type { WorkspaceSummary } from '@/services/workspaceService'
import { CARD_THEMES } from './dashboard-constants'

/**
 * InsightCards — the dashboard's at-a-glance numbers, framed for the person who
 * uses this day to day (building and browsing views) rather than for an operator.
 *
 * Every figure comes from the workspace summary — the same server-side numbers
 * Administration → Global Overview and the Workspaces page show — so the three
 * can no longer disagree. They used to be added up here from a workspace list
 * loaded once at sign-in, which went stale the moment anything changed.
 *
 * The fourth card was "Data Assets", which was really the node count (Admin's
 * "Total Nodes") under a name Ingestion uses for catalog items. It now counts
 * data sources, with the entities and relationships they hold underneath —
 * the same figures, and the same words, as the admin overview.
 */
export function InsightCards({ summary, semanticLayers }: {
    summary?: WorkspaceSummary
    /** Every semantic layer the caller can read, and how many are published. */
    semanticLayers: { total: number; published: number }
}) {
    const navigate = useNavigate()
    const totals = summary?.totals
    const pending = totals?.pendingDataSources ?? 0

    const cards = [
        {
            label: 'Context Views',
            sublabel: 'Views you can open',
            value: totals ? compact(totals.views) : '—',
            icon: Monitor,
            to: '/explorer',
        },
        {
            label: 'Semantic Layers',
            sublabel: `${compact(semanticLayers.published)} published`,
            value: compact(semanticLayers.total),
            icon: BookOpen,
            to: '/schema',
        },
        {
            label: 'Workspaces',
            sublabel: summary?.coverage === 'all' ? 'Every business area' : 'Business areas you work in',
            value: totals ? compact(totals.workspaces) : '—',
            icon: Boxes,
            to: '/workspaces',
        },
        {
            label: 'Data Sources',
            sublabel: !totals
                ? 'Connected data'
                : pending > 0
                    ? `Counting ${pending} source${pending === 1 ? '' : 's'}…`
                    : `${compact(totals.nodes)} entities · ${compact(totals.edges)} relationships`,
            value: totals ? compact(totals.dataSources) : '—',
            icon: Database,
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
                                <div className={cn('text-3xl font-black tracking-tight leading-none mb-1 tabular-nums', t.valueCls)}>
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
