/**
 * InsightSheet — what is behind an at-a-glance number.
 *
 * A Dashboard card answers "how many"; this answers "which, and is it moving".
 * Clicking a card opens it: the sources ranked by size with how each is doing
 * (and a refresh for whoever runs them), the views people favour or touched
 * last, the workspaces by size, the semantic layers by recency. Every figure is
 * the summary's — the same numbers as the card, the Workspaces page and the
 * admin overview — with the page it came from one click away.
 *
 * House drawer shape: an always-rendered Backdrop and an aside that only
 * animates IN (an exit animation on a portal can strand a click-blocker).
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
    ArrowRight, BookOpen, Boxes, Clock, Database, Heart, History, Loader2, Monitor, RefreshCw, X,
} from 'lucide-react'
import { TimeSeriesChart } from '@/components/analytics/charts/TimeSeriesChart'
import { Backdrop } from '@/components/ui/Backdrop'
import { HoverTip } from '@/components/ui/HoverTip'
import { useAppNotifications } from '@/components/ui/notifications'
import { useCountUp } from '@/hooks/useCountUp'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useRecentViews } from '@/hooks/useRecentViews'
import { WORKSPACE_SUMMARY_KEY } from '@/hooks/useWorkspaceSummary'
import { compact, exact, shortDate } from '@/lib/formatMetric'
import { MOTION } from '@/lib/motion'
import { timeAgo } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'
import { DynamicIcon, resolveViewIcon, viewTypeMeta } from '@/lib/viewUtils'
import { freshnessService } from '@/services/freshnessService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { listPopularViews, listViews } from '@/services/viewApiService'
import type { WorkspaceSummary, WorkspaceSummaryTrend } from '@/services/workspaceService'
import { useAuthStore } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'
import { changePhrase, seriesDelta } from './insightTrend'

export type InsightKind = 'views' | 'layers' | 'workspaces' | 'sources'

const HEAD: Record<InsightKind, { title: string; icon: typeof Monitor; to: string; open: string }> = {
    views: { title: 'Context Views', icon: Monitor, to: '/explorer', open: 'Open Explorer' },
    layers: { title: 'Semantic Layers', icon: BookOpen, to: '/schema', open: 'Open Semantic Layers' },
    workspaces: { title: 'Workspaces', icon: Boxes, to: '/workspaces', open: 'Open Workspaces' },
    sources: { title: 'Data Sources', icon: Database, to: '/workspaces', open: 'Open Workspaces' },
}

export function InsightSheet({ kind, onClose, summary, trend, ontologies }: {
    kind: InsightKind | null
    onClose: () => void
    summary?: WorkspaceSummary
    trend?: WorkspaceSummaryTrend
    ontologies: readonly OntologyDefinitionResponse[]
}) {
    const open = kind !== null
    const ref = useModalA11y(open, onClose)
    const head = kind ? HEAD[kind] : null

    return createPortal(
        <>
            <Backdrop open={open} onClick={onClose} zClassName="z-[60]" />
            {kind && head && (
                <motion.aside
                    ref={ref}
                    role="dialog"
                    aria-modal="true"
                    aria-label={head.title}
                    tabIndex={-1}
                    initial={{ x: 480 }}
                    animate={{ x: 0 }}
                    transition={MOTION.drawerSlide}
                    className="fixed right-0 top-0 h-full w-[480px] max-w-[92vw] z-[61] bg-canvas border-l border-glass-border shadow-2xl flex flex-col focus:outline-none"
                >
                    <header className="flex items-start gap-3 px-6 pt-6 pb-4 border-b border-glass-border">
                        <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-500 flex items-center justify-center shrink-0">
                            <head.icon className="w-5 h-5" aria-hidden />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-lg font-bold text-ink">{head.title}</h2>
                            <SheetFigure kind={kind} summary={summary} ontologies={ontologies} />
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Close"
                            className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </header>
                    <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-5">
                        {kind === 'sources' && <SourcesBody summary={summary} trend={trend} />}
                        {kind === 'views' && <ViewsBody onNavigate={onClose} />}
                        {kind === 'workspaces' && <WorkspacesBody summary={summary} trend={trend} onNavigate={onClose} />}
                        {kind === 'layers' && <LayersBody ontologies={ontologies} onNavigate={onClose} />}
                    </div>
                    <footer className="px-6 py-4 border-t border-glass-border">
                        <Link
                            to={head.to}
                            onClick={onClose}
                            className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                            {head.open} <ArrowRight className="w-4 h-4" aria-hidden />
                        </Link>
                    </footer>
                </motion.aside>
            )}
        </>,
        document.body,
    )
}

/** The card's number again, counting up, with what it means. */
function SheetFigure({ kind, summary, ontologies }: {
    kind: InsightKind
    summary?: WorkspaceSummary
    ontologies: readonly OntologyDefinitionResponse[]
}) {
    const t = summary?.totals
    const [value, meaning] = {
        views: [t?.views ?? 0, 'views you can open'],
        layers: [ontologies.length, `semantic layers · ${ontologies.filter(o => o.isPublished).length} published`],
        workspaces: [t?.workspaces ?? 0, summary?.coverage === 'all' ? 'workspaces — every business area' : 'workspaces you work in'],
        sources: [t?.dataSources ?? 0, t ? `sources · ${compact(t.nodes)} entities · ${compact(t.edges)} relationships` : 'sources'],
    }[kind] as [number, string]
    const shown = useCountUp(value, { from: 0 })
    return (
        <p className="text-sm text-ink-muted mt-0.5">
            <span className="text-2xl font-black text-ink tabular-nums mr-1.5 align-middle">{exact(shown)}</span>
            {meaning}
        </p>
    )
}

function Bar({ share }: { share: number }) {
    return (
        <div className="h-1.5 rounded-full bg-black/5 dark:bg-white/10 overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: `${Math.max(2, share * 100)}%` }} />
        </div>
    )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
    return <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-3">{children}</h3>
}

function TrendChart({ trend, measure }: { trend: WorkspaceSummaryTrend; measure: 'nodes' | 'edges' }) {
    const values = trend[measure]
    const start = values.findIndex(v => v !== null)
    if (start < 0 || values.length - start < 3) return null
    const days = trend.days.slice(start)
    return (
        <TimeSeriesChart
            buckets={days}
            axisLabels={days.map(d => shortDate(d))}
            series={[{
                key: measure,
                label: measure === 'nodes' ? 'Entities' : 'Relationships',
                values: values.slice(start) as number[],
                slot: measure === 'nodes' ? 0 : 1,
                area: true,
            }]}
            height={150}
        />
    )
}

function SourcesBody({ summary, trend }: { summary?: WorkspaceSummary; trend?: WorkspaceSummaryTrend }) {
    const workspaces = useWorkspacesStore(s => s.workspaces)
    const can = useAuthStore(s => s.can)
    const queryClient = useQueryClient()
    const { notify } = useAppNotifications()
    const [measure, setMeasure] = useState<'nodes' | 'edges'>('nodes')
    const [refreshing, setRefreshing] = useState<string | null>(null)

    const rows = (summary?.workspaces ?? []).flatMap(w => {
        const ws = workspaces.find(x => x.id === w.id)
        return Object.entries(w.sources).map(([dsId, s]) => {
            const ds = ws?.dataSources.find(d => d.id === dsId)
            return {
                key: `${w.id}/${dsId}`, wsId: w.id, wsName: w.name, dsId,
                name: ds?.label || ds?.graphName || dsId,
                paused: ds ? !ds.isActive : false,
                ...s,
            }
        })
    }).sort((a, b) => b.nodes - a.nodes)
    const max = Math.max(1, ...rows.map(r => r.nodes))
    const delta = trend ? seriesDelta(trend[measure]) : null

    const refresh = async (dsId: string, name: string) => {
        setRefreshing(dsId)
        try {
            await freshnessService.refreshSource(dsId, { scope: 'read-caches', reason: 'Refreshed from the Dashboard' })
            notify('success', `Refreshing the numbers for ${name}`)
            await queryClient.invalidateQueries({ queryKey: WORKSPACE_SUMMARY_KEY })
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            setRefreshing(null)
        }
    }

    return (
        <div className="space-y-6">
            {trend && (
                <section>
                    <div className="flex items-center justify-between mb-2">
                        <SectionTitle>Last {trend.days.length} days</SectionTitle>
                        <div className="flex items-center bg-black/5 dark:bg-white/5 rounded-lg p-0.5 -mt-3">
                            {(['nodes', 'edges'] as const).map(m => (
                                <button
                                    key={m}
                                    type="button"
                                    aria-pressed={measure === m}
                                    onClick={() => setMeasure(m)}
                                    className={cn(
                                        'px-2 py-1 rounded-md text-[11px] font-semibold transition-colors',
                                        measure === m ? 'bg-white dark:bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                                    )}
                                >
                                    {m === 'nodes' ? 'Entities' : 'Relationships'}
                                </button>
                            ))}
                        </div>
                    </div>
                    <TrendChart trend={trend} measure={measure} />
                    {delta && (
                        <p className="text-xs text-ink-muted mt-2">
                            {delta.pct === null || delta.change === 0
                                ? (changePhrase(delta, trend.days.length) ?? 'No change')
                                : `${delta.change > 0 ? '▲' : '▼'} ${Math.abs(delta.pct * 100).toFixed(1)}% in ${trend.days.length} days`}
                            {' '}— each graph counted once, however many workspaces use it.
                        </p>
                    )}
                </section>
            )}
            <section>
                <SectionTitle>By size</SectionTitle>
                {rows.length === 0 ? (
                    <p className="text-sm text-ink-muted">No data sources yet.</p>
                ) : (
                    <ul className="space-y-3">
                        {rows.map(r => (
                            <li key={r.key} className="rounded-xl border border-glass-border px-3.5 py-3">
                                <div className="flex items-center gap-2">
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-semibold text-ink truncate">{r.name}</p>
                                        <p className="text-[11px] text-ink-muted truncate">{r.wsName} · {exact(r.views)} view{r.views === 1 ? '' : 's'}</p>
                                    </div>
                                    {r.pending ? (
                                        <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">Counting…</span>
                                    ) : r.paused ? (
                                        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Paused</span>
                                    ) : null}
                                    {can('workspace:datasource:manage', r.wsId) && (
                                        <HoverTip label={`Measure ${r.name} again`}>
                                            <button
                                                type="button"
                                                aria-label={`Refresh the numbers for ${r.name}`}
                                                disabled={refreshing === r.dsId}
                                                onClick={() => void refresh(r.dsId, r.name)}
                                                className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                                            >
                                                {refreshing === r.dsId
                                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                    : <RefreshCw className="w-3.5 h-3.5" />}
                                            </button>
                                        </HoverTip>
                                    )}
                                </div>
                                <div className="mt-2 flex items-center gap-3">
                                    <div className="flex-1"><Bar share={r.nodes / max} /></div>
                                    <span className="text-[11px] text-ink-secondary tabular-nums whitespace-nowrap">
                                        {compact(r.nodes)} entities · {compact(r.edges)} rel.
                                    </span>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
                {(summary?.totals.sharedGraphs ?? 0) > 0 && (
                    <p className="text-[11px] text-ink-muted mt-3">
                        A graph used by several workspaces appears under each, and is counted once in the totals.
                    </p>
                )}
            </section>
        </div>
    )
}

type ViewTab = 'popular' | 'updated' | 'recent'

const VIEW_TABS: { id: ViewTab; label: string; icon: typeof Heart }[] = [
    { id: 'popular', label: 'Most favourited', icon: Heart },
    { id: 'updated', label: 'Recently updated', icon: Clock },
    { id: 'recent', label: 'You opened', icon: History },
]

function ViewsBody({ onNavigate }: { onNavigate: () => void }) {
    const [tab, setTab] = useState<ViewTab>('popular')
    const popular = useQuery({
        queryKey: ['dashboard', 'views', 'popular'],
        queryFn: () => listPopularViews(8),
        enabled: tab === 'popular',
        staleTime: 60_000,
    })
    const updated = useQuery({
        queryKey: ['dashboard', 'views', 'updated'],
        queryFn: () => listViews({ sort: 'updated', limit: 8 }),
        enabled: tab === 'updated',
        staleTime: 60_000,
    })
    const { recent } = useRecentViews()

    const rows = tab === 'popular'
        ? popular.data?.map(v => ({ id: v.id, name: v.name, viewType: v.viewType, icon: v.config?.icon, where: v.workspaceName, meta: `♥ ${exact(v.favouriteCount ?? 0)}` }))
        : tab === 'updated'
            ? updated.data?.items.map(v => ({ id: v.id, name: v.name, viewType: v.viewType, icon: v.config?.icon, where: v.workspaceName, meta: `Updated ${timeAgo(v.updatedAt)}` }))
            : recent.map(v => ({ id: v.viewId, name: v.viewName, viewType: v.viewType, icon: v.icon, where: v.workspaceName, meta: `Opened ${timeAgo(v.visitedAt)}` }))
    const loading = (tab === 'popular' && popular.isLoading) || (tab === 'updated' && updated.isLoading)

    return (
        <div>
            <div role="tablist" aria-label="Which views" className="flex items-center gap-1 mb-4 bg-black/5 dark:bg-white/5 rounded-xl p-1">
                {VIEW_TABS.map(t => (
                    <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === t.id}
                        onClick={() => setTab(t.id)}
                        className={cn(
                            'flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors',
                            tab === t.id ? 'bg-white dark:bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                        )}
                    >
                        <t.icon className="w-3.5 h-3.5" aria-hidden /> {t.label}
                    </button>
                ))}
            </div>
            {loading ? (
                <div className="flex items-center justify-center py-10 text-xs text-ink-muted">
                    <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…
                </div>
            ) : !rows?.length ? (
                <p className="text-sm text-ink-muted py-6 text-center">
                    {tab === 'popular' ? 'No one has favourited a view yet.' : tab === 'updated' ? 'No views yet.' : 'Views you open show up here.'}
                </p>
            ) : (
                <ul className="space-y-1.5">
                    {rows.map(r => {
                        const meta = viewTypeMeta(r.viewType)
                        return (
                            <li key={r.id}>
                                <Link
                                    to={`/views/${r.id}`}
                                    onClick={onNavigate}
                                    className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
                                >
                                    <span className={cn('w-8 h-8 rounded-lg border flex items-center justify-center shrink-0', meta.iconBg)}>
                                        <DynamicIcon name={resolveViewIcon({ icon: r.icon, viewType: r.viewType })} className="w-4 h-4" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm font-semibold text-ink truncate">{r.name}</span>
                                        <span className="block text-[11px] text-ink-muted truncate">{[meta.label, r.where].filter(Boolean).join(' · ')}</span>
                                    </span>
                                    <span className="text-[11px] text-ink-muted whitespace-nowrap">{r.meta}</span>
                                </Link>
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>
    )
}

function WorkspacesBody({ summary, trend, onNavigate }: {
    summary?: WorkspaceSummary
    trend?: WorkspaceSummaryTrend
    onNavigate: () => void
}) {
    const rows = [...(summary?.workspaces ?? [])].sort((a, b) => b.nodes - a.nodes || a.name.localeCompare(b.name))
    const max = Math.max(1, ...rows.map(r => r.nodes))
    const added = trend ? changePhrase(seriesDelta(trend.workspaces), trend.days.length) : null
    return (
        <section>
            <SectionTitle>By size{added ? ` · ${added}` : ''}</SectionTitle>
            {rows.length === 0 ? (
                <p className="text-sm text-ink-muted">No workspaces yet.</p>
            ) : (
                <ul className="space-y-2">
                    {rows.map(w => (
                        <li key={w.id}>
                            <Link
                                to={`/workspaces/${w.id}`}
                                onClick={onNavigate}
                                className="block rounded-xl border border-glass-border px-3.5 py-3 hover:border-indigo-500/30 transition-colors"
                            >
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-semibold text-ink truncate flex-1">{w.name}</span>
                                    {w.isDefault && <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-500">Default</span>}
                                </div>
                                <p className="text-[11px] text-ink-muted mt-0.5">
                                    {exact(w.dataSources)} source{w.dataSources === 1 ? '' : 's'} · {exact(w.views)} view{w.views === 1 ? '' : 's'} · {compact(w.nodes)} entities
                                </p>
                                <div className="mt-2"><Bar share={w.nodes / max} /></div>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    )
}

function LayersBody({ ontologies, onNavigate }: {
    ontologies: readonly OntologyDefinitionResponse[]
    onNavigate: () => void
}) {
    const rows = [...ontologies].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return (
        <section>
            <SectionTitle>Most recently changed</SectionTitle>
            {rows.length === 0 ? (
                <p className="text-sm text-ink-muted">No semantic layers you can read yet.</p>
            ) : (
                <ul className="space-y-2">
                    {rows.map(o => {
                        const types = Object.keys(o.entityTypeDefinitions ?? {}).length
                        return (
                            <li key={o.id}>
                                <Link
                                    to={`/schema/${o.id}`}
                                    onClick={onNavigate}
                                    className="flex items-center gap-3 rounded-xl border border-glass-border px-3.5 py-3 hover:border-indigo-500/30 transition-colors"
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm font-semibold text-ink truncate">{o.name}</span>
                                        <span className="block text-[11px] text-ink-muted">
                                            {exact(types)} entity type{types === 1 ? '' : 's'} · v{o.version} · updated {timeAgo(o.updatedAt)}
                                        </span>
                                    </span>
                                    <span className={cn(
                                        'text-[10px] font-semibold uppercase tracking-wide',
                                        o.isPublished ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-muted',
                                    )}>
                                        {o.isPublished ? 'Published' : 'Draft'}
                                    </span>
                                </Link>
                            </li>
                        )
                    })}
                </ul>
            )}
        </section>
    )
}
