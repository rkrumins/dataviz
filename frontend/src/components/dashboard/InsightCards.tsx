import { useState } from 'react'
import { motion } from 'framer-motion'
import { Monitor, BookOpen, Boxes, Database } from 'lucide-react'
import { Sparkline } from '@/components/ui/Sparkline'
import { cn } from '@/lib/utils'
import { compact } from '@/lib/formatMetric'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { WorkspaceSummary, WorkspaceSummaryTrend } from '@/services/workspaceService'
import { CARD_THEMES } from './dashboard-constants'
import { InsightSheet, type InsightKind } from './InsightSheet'
import { changePhrase, cumulativeByDay, seriesDelta } from './insightTrend'

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
 *
 * Each card also says how its number moved over the summary's trend window
 * (a sparkline and "+3 in 30 days"), and opens a sheet with what is behind it.
 */
export function InsightCards({ summary, trend, ontologies }: {
    summary?: WorkspaceSummary
    trend?: WorkspaceSummaryTrend
    /** Every semantic layer the caller can read. */
    ontologies: readonly OntologyDefinitionResponse[]
}) {
    const [sheet, setSheet] = useState<InsightKind | null>(null)
    const totals = summary?.totals
    const pending = totals?.pendingDataSources ?? 0
    const days = trend?.days.length ?? 0
    const published = ontologies.filter(o => o.isPublished).length
    const layerSeries = trend ? cumulativeByDay(ontologies.map(o => o.createdAt), trend.days) : undefined
    const entities = trend ? seriesDelta(trend.nodes) : null

    const cards: {
        kind: InsightKind; label: string; sublabel: string; value: string
        icon: typeof Monitor; series?: readonly (number | null)[]; change: string | null
    }[] = [
        {
            kind: 'views',
            label: 'Context Views',
            sublabel: 'Views you can open',
            value: totals ? compact(totals.views) : '—',
            icon: Monitor,
            series: trend?.views,
            change: trend ? changePhrase(seriesDelta(trend.views), days) : null,
        },
        {
            kind: 'layers',
            label: 'Semantic Layers',
            sublabel: `${compact(published)} published`,
            value: compact(ontologies.length),
            icon: BookOpen,
            series: layerSeries,
            change: layerSeries ? changePhrase(seriesDelta(layerSeries), days) : null,
        },
        {
            kind: 'workspaces',
            label: 'Workspaces',
            sublabel: summary?.coverage === 'all' ? 'Every business area' : 'Business areas you work in',
            value: totals ? compact(totals.workspaces) : '—',
            icon: Boxes,
            series: trend?.workspaces,
            change: trend ? changePhrase(seriesDelta(trend.workspaces), days) : null,
        },
        {
            kind: 'sources',
            label: 'Data Sources',
            sublabel: !totals
                ? 'Connected data'
                : pending > 0
                    ? `Counting ${pending} source${pending === 1 ? '' : 's'}…`
                    : `${compact(totals.nodes)} entities · ${compact(totals.edges)} relationships`,
            value: totals ? compact(totals.dataSources) : '—',
            icon: Database,
            series: trend?.nodes,
            change: entities && entities.pct !== null && entities.change !== 0
                ? `${entities.change > 0 ? '▲' : '▼'} ${Math.abs(entities.pct * 100).toFixed(1)}% entities in ${days} days`
                : null,
        },
    ]

    return (
        <>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 px-4 md:px-0 mb-14">
                {cards.map((c, i) => {
                    const t = CARD_THEMES[i]
                    const points = (c.series ?? []).filter((v): v is number => v !== null)
                    const rising = c.change !== null && !c.change.startsWith('−') && !c.change.startsWith('▼')
                    return (
                        <motion.button
                            key={c.label}
                            type="button"
                            onClick={() => setSheet(c.kind)}
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
                                <div className="flex items-start justify-between gap-2 mb-4">
                                    <div className={cn('w-9 h-9 rounded-xl border flex items-center justify-center', t.iconBg)}>
                                        <c.icon className="w-4 h-4" />
                                    </div>
                                    <Sparkline points={points} width={72} height={24} tone={rising ? 'emerald' : 'slate'} className="mt-1" />
                                </div>
                                <div className="mt-auto">
                                    <div className={cn('text-3xl font-black tracking-tight leading-none mb-1 tabular-nums', t.valueCls)}>
                                        {c.value}
                                    </div>
                                    <div className="text-sm font-semibold text-ink">{c.label}</div>
                                    <div className="text-xs text-ink-muted mt-0.5">{c.sublabel}</div>
                                    {c.change && (
                                        <div className={cn(
                                            'text-[11px] font-semibold mt-1.5 tabular-nums',
                                            rising ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-muted',
                                        )}>
                                            {c.change}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </motion.button>
                    )
                })}
            </div>
            <InsightSheet
                kind={sheet}
                onClose={() => setSheet(null)}
                summary={summary}
                trend={trend}
                ontologies={ontologies}
            />
        </>
    )
}
