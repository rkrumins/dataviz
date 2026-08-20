/**
 * DataSourceHistoryPage — the full counts-history view for one data source.
 *
 * `DataSourceProfile` answers "what is this data source". This answers "what
 * has been happening to it", which is a different enough question to deserve
 * its own frame: the profile is single-column and drawer-safe by design, and
 * the chart, the label ledger and the change ledger all want the width.
 *
 * Two scopes on the same page rather than two pages. "This source" and "all
 * sources on this provider" are the same question at two altitudes, and a
 * reader who notices a drop here immediately wants to know whether the
 * provider as a whole moved — a separate route would make that a navigation
 * instead of a toggle.
 *
 * All state is in the URL (`?window=&from=&to=&scope=&mode=`), matching the
 * app's deep-linkable-tab convention: a drop worth telling someone about is
 * worth sending them the exact view of it.
 */
import { createElement, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
    AlertTriangle, ArrowLeft, BarChart3, GitCompare, History, Layers, Loader2, Spline,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { PageContainer } from '@/components/layout/PageContainer'
import { useDataSourceProfile } from '@/hooks/useDataSourceProfile'
import {
    DEFAULT_HISTORY_WINDOW, resolveWindow, useCountHistory, useProviderHistory,
    type HistoryWindowKey,
} from '@/hooks/useCountHistory'
import { getProviderLogo } from '@/components/admin/ProviderLogos'
import { formatUtc } from '@/lib/timeAgo'
import { CountTimeline, TimelineLegend, type TimelineMode } from '@/components/insights/history/CountTimeline'
import { LabelLedger } from '@/components/insights/history/LabelLedger'
import { ChangeLedger } from '@/components/insights/history/ChangeLedger'
import { CoverageStrip } from '@/components/insights/history/CoverageStrip'
import { HistoryWindowSelector } from '@/components/insights/history/HistoryWindowSelector'
import {
    axisLabel, compactNum, formatPct, seriesColor, signedNum,
} from '@/components/insights/history/shared'
import { DeltaChip } from '@/components/insights/history/DeltaChip'
import type { HistorySummary, ProviderHistoryPayload } from '@/types/insights'

type Scope = 'source' | 'provider'

const MODES: Array<{ key: TimelineMode; label: string; icon: typeof BarChart3; hint: string }> = [
    { key: 'composition', label: 'Composition', icon: Layers, hint: 'Stacked by label — shows what appeared or vanished' },
    { key: 'total', label: 'Total', icon: BarChart3, hint: 'One line — shows whether it is growing' },
    { key: 'compare', label: 'Compare', icon: GitCompare, hint: 'One chart per label, each on its own scale' },
]

export function DataSourceHistoryPage() {
    const { catalogId = '' } = useParams()
    const [params, setParams] = useSearchParams()
    useDocumentTitle('Data Source History')

    const windowKey = (params.get('window') as HistoryWindowKey) || DEFAULT_HISTORY_WINDOW
    const custom = { from: params.get('from') || undefined, to: params.get('to') || undefined }
    const scope: Scope = params.get('scope') === 'provider' ? 'provider' : 'source'
    const mode = (params.get('mode') as TimelineMode) || 'composition'
    const [highlightAt, setHighlightAt] = useState<string | null>(null)

    const range = useMemo(
        () => resolveWindow(windowKey, custom),
        // The custom object is rebuilt each render; its VALUES are the input.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [windowKey, custom.from, custom.to],
    )

    const { item, provider } = useDataSourceProfile(catalogId)
    // The catalog id is what this route carries and what people share. History
    // is keyed on the workspace data source that observes the graph, and the
    // backend resolves one from the other — see `_resolve_history_scope`. A
    // `?ds=` param wins when present, which is how the profile card links to
    // the exact source the reader was already looking at.
    const historyScopeId = params.get('ds') || catalogId

    const sourceQuery = useCountHistory(historyScopeId, range, {
        enabled: scope === 'source' && Boolean(historyScopeId),
    })
    const providerQuery = useProviderHistory(item?.providerId, range, {
        enabled: scope === 'provider' && Boolean(item?.providerId),
    })

    const payload = sourceQuery.data?.data
    const providerPayload = providerQuery.data?.data
    const isLoading = scope === 'source' ? sourceQuery.isLoading : providerQuery.isLoading

    const setParam = (next: Record<string, string | undefined>) => {
        const merged = new URLSearchParams(params)
        for (const [key, value] of Object.entries(next)) {
            if (value == null || value === '') merged.delete(key)
            else merged.set(key, value)
        }
        setParams(merged, { replace: true })
    }

    const summary = payload?.summary

    return (
        <div className="absolute inset-0 overflow-y-auto">
            <PageContainer className="py-8 animate-in fade-in duration-500">
                <Link
                    to={`/datasources/${catalogId}`}
                    className="mb-6 inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-ink transition-colors"
                >
                    <ArrowLeft className="w-3.5 h-3.5" /> {item?.name || 'Data source'}
                </Link>

                {/* ── Hero ───────────────────────────────────────── */}
                <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20 shrink-0">
                            <History className="w-6 h-6 text-white" />
                        </div>
                        <div className="min-w-0">
                            <h1 className="text-3xl font-bold tracking-tight text-ink truncate">
                                History
                            </h1>
                            <p className="text-sm text-ink-muted mt-1 flex items-center gap-1.5 min-w-0">
                                {/* `createElement` rather than binding the
                                    result to a capitalised const: this is a
                                    lookup in a fixed table, not a component
                                    built during render, and the binding is
                                    what makes it look like the latter. */}
                                {createElement(
                                    getProviderLogo(provider?.providerType ?? 'falkordb'),
                                    { className: 'w-3.5 h-3.5 shrink-0' },
                                )}
                                <span className="truncate">
                                    {item?.name || catalogId}
                                    {provider ? ` · ${provider.name}` : ''}
                                </span>
                            </p>
                        </div>
                    </div>

                    <HistoryWindowSelector
                        value={windowKey}
                        custom={custom}
                        retentionDays={summary?.retention_days ?? providerPayload?.retention_days}
                        onChange={(next, nextCustom) => setParam({
                            window: next, from: nextCustom.from, to: nextCustom.to,
                        })}
                    />
                </div>

                {/* ── Scope switch ───────────────────────────────── */}
                <div
                    role="group"
                    aria-label="History scope"
                    className="inline-flex items-center gap-1 p-1 rounded-xl border border-glass-border bg-canvas-elevated mb-5"
                >
                    {([
                        { key: 'source' as Scope, label: 'This data source' },
                        { key: 'provider' as Scope, label: provider ? `All on ${provider.name}` : 'All on provider' },
                    ]).map((option) => (
                        <button
                            key={option.key}
                            type="button"
                            onClick={() => setParam({ scope: option.key })}
                            aria-pressed={scope === option.key}
                            className={cn(
                                'px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors',
                                'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                scope === option.key
                                    ? 'bg-indigo-500 text-white shadow-sm'
                                    : 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5',
                            )}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>

                {isLoading ? (
                    <HistorySkeleton />
                ) : scope === 'provider' ? (
                    <ProviderScope payload={providerPayload} />
                ) : !payload || payload.points.length === 0 ? (
                    <EmptyState
                        title="No history yet"
                        message="Counts are captured whenever they change, plus an hourly checkpoint. The first snapshot will appear shortly after the next collection."
                    />
                ) : (
                    <>
                        {/* ── KPI strip ───────────────────────────── */}
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
                            <KpiTile
                                label="Entities now" value={summary!.node_last}
                                delta={summary!.node_delta} pct={summary!.node_pct_change}
                                tint="bg-indigo-500/10 text-indigo-500" icon={Layers}
                            />
                            <KpiTile
                                label="Relationships now" value={summary!.edge_last}
                                delta={summary!.edge_delta} pct={summary!.edge_pct_change}
                                tint="bg-violet-500/10 text-violet-500" icon={Spline}
                            />
                            <KpiTile
                                label="Changes recorded" value={summary!.changed_snapshots}
                                tint="bg-emerald-500/10 text-emerald-500" icon={History}
                            />
                            <DropTile summary={summary!} onSelect={setHighlightAt} />
                        </div>

                        <CoverageStrip
                            className="mb-5"
                            coverageFrom={summary!.coverage_from}
                            requestedFrom={payload.from}
                            requestedTo={payload.to}
                            retentionDays={summary!.retention_days}
                            snapshots={summary!.snapshots}
                            changed={summary!.changed_snapshots}
                        />

                        {/* ── The chart ───────────────────────────── */}
                        <motion.section
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                            className="rounded-2xl border border-glass-border bg-canvas-elevated p-5 mb-5"
                        >
                            <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
                                <div className="min-w-0">
                                    <h2 className="text-sm font-bold text-ink">Entities over time</h2>
                                    <p className="text-xs text-ink-muted mt-0.5">
                                        {payload.points.length} observation
                                        {payload.points.length === 1 ? '' : 's'} ·{' '}
                                        {payload.grain === 'raw'
                                            ? 'every recorded change'
                                            : `bucketed by ${payload.grain}`}
                                    </p>
                                </div>
                                <div
                                    role="group"
                                    aria-label="Chart mode"
                                    className="flex items-center gap-1 p-1 rounded-xl border border-glass-border bg-canvas"
                                >
                                    {MODES.map((m) => (
                                        <button
                                            key={m.key}
                                            type="button"
                                            title={m.hint}
                                            onClick={() => setParam({ mode: m.key })}
                                            aria-pressed={mode === m.key}
                                            className={cn(
                                                'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg',
                                                'text-xs font-semibold transition-colors outline-none',
                                                'focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                                mode === m.key
                                                    ? 'bg-indigo-500 text-white shadow-sm'
                                                    : 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5',
                                            )}
                                        >
                                            <m.icon className="w-3.5 h-3.5" />{m.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <CountTimeline
                                points={payload.points}
                                grain={payload.grain}
                                mode={mode}
                                onDropSelect={setHighlightAt}
                            />

                            {mode !== 'compare' && (
                                <TimelineLegend points={payload.points} className="mt-4" />
                            )}
                        </motion.section>

                        {/* ── Ledgers ─────────────────────────────── */}
                        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                            <section className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
                                <div className="px-5 pt-5 pb-3">
                                    <h2 className="text-sm font-bold text-ink">Counts by type</h2>
                                    <p className="text-xs text-ink-muted mt-0.5">
                                        Sorted so labels that appeared or disappeared come first.
                                    </p>
                                </div>
                                <LabelLedger labels={payload.labels} />
                            </section>

                            <section className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
                                <div className="px-5 pt-5 pb-1">
                                    <h2 className="text-sm font-bold text-ink">Change ledger</h2>
                                    <p className="text-xs text-ink-muted mt-0.5">
                                        Only observations where something moved.
                                    </p>
                                </div>
                                <ChangeLedger points={payload.points} highlightAt={highlightAt} />
                            </section>
                        </div>
                    </>
                )}
            </PageContainer>
        </div>
    )
}

function KpiTile({ label, value, delta, pct, tint, icon: Icon }: {
    label: string
    value: number
    delta?: number
    pct?: number | null
    tint: string
    icon: typeof BarChart3
}) {
    return (
        <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-4 min-w-0">
            <div className="flex items-center gap-2 mb-2">
                <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0', tint)}>
                    <Icon className="w-4 h-4" />
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted truncate">
                    {label}
                </span>
            </div>
            <p className="text-2xl font-black text-ink leading-none tabular-nums">
                {compactNum(value)}
            </p>
            {delta != null && (
                <div className="mt-2 flex items-center gap-1.5">
                    <DeltaChip value={delta} />
                    {formatPct(pct) && (
                        <span className="text-[11px] font-semibold text-ink-muted tabular-nums">
                            {formatPct(pct)}
                        </span>
                    )}
                </div>
            )}
        </div>
    )
}

/** The largest drop, promoted to a tile of its own.
 *
 *  It is the single thing most people open this page to find, and leaving it
 *  as something you notice on the chart makes finding it a matter of luck. */
function DropTile({ summary, onSelect }: {
    summary: HistorySummary
    onSelect: (at: string) => void
}) {
    const drop = summary.largest_drop
    if (!drop) {
        return (
            <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-4 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                    <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-emerald-500/10 text-emerald-500">
                        <AlertTriangle className="w-4 h-4" />
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted truncate">
                        Largest drop
                    </span>
                </div>
                <p className="text-sm font-bold text-ink leading-tight">None</p>
                <p className="text-[11px] text-ink-muted mt-1">
                    Nothing was lost in this window.
                </p>
            </div>
        )
    }
    return (
        <button
            type="button"
            onClick={() => onSelect(drop.at)}
            className={cn(
                'rounded-2xl border border-red-500/25 bg-red-500/[0.04] p-4 min-w-0 text-left',
                'hover:bg-red-500/[0.08] transition-colors outline-none',
                'focus-visible:ring-2 focus-visible:ring-red-500/50',
            )}
        >
            <div className="flex items-center gap-2 mb-2">
                <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-red-500/15 text-red-500">
                    <AlertTriangle className="w-4 h-4" />
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted truncate">
                    Largest drop
                </span>
            </div>
            <p className="text-2xl font-black text-red-600 dark:text-red-400 leading-none tabular-nums">
                {signedNum(drop.delta)}
            </p>
            <p className="text-[11px] text-ink-muted mt-1.5 truncate">
                {drop.label ? `${drop.label} · ` : ''}{formatUtc(drop.at)}
            </p>
        </button>
    )
}

/** Provider rollup — the same chart shape, series-per-source instead of
 *  series-per-label. */
function ProviderScope({ payload }: { payload?: ProviderHistoryPayload | null }) {
    if (!payload || !payload.totals.length) {
        return (
            <EmptyState
                title="No provider history yet"
                message="Once any data source on this provider has been observed twice, its rollup appears here."
            />
        )
    }

    const last = payload.totals[payload.totals.length - 1]
    const first = payload.totals[0]

    return (
        <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
                <KpiTile
                    label="Entities across provider" value={last.node_count}
                    delta={last.node_count - first.node_count}
                    tint="bg-indigo-500/10 text-indigo-500" icon={Layers}
                />
                <KpiTile
                    label="Relationships" value={last.edge_count}
                    delta={last.edge_count - first.edge_count}
                    tint="bg-violet-500/10 text-violet-500" icon={Spline}
                />
                <KpiTile
                    label="Data sources" value={last.sources}
                    tint="bg-emerald-500/10 text-emerald-500" icon={BarChart3}
                />
                <KpiTile
                    label="Buckets" value={payload.totals.length}
                    tint="bg-cyan-500/10 text-cyan-500" icon={History}
                />
            </div>

            <section className="rounded-2xl border border-glass-border bg-canvas-elevated p-5 mb-5">
                <h2 className="text-sm font-bold text-ink mb-1">Entities across every onboarded source</h2>
                <p className="text-xs text-ink-muted mb-4">
                    Bucketed by {payload.grain}. A source not observed in a bucket carries its
                    last known value forward — it did not drop to zero.
                </p>
                <ProviderTotalsChart payload={payload} />
            </section>

            <section className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
                <div className="px-5 pt-5 pb-3">
                    <h2 className="text-sm font-bold text-ink">By data source</h2>
                </div>
                <div className="divide-y divide-glass-border">
                    {payload.sources.map((source, i) => {
                        const points = source.points
                        const start = points[0]?.node_count ?? 0
                        const end = points[points.length - 1]?.node_count ?? 0
                        return (
                            <div key={source.data_source_id} className="flex items-center gap-3 px-5 py-3 min-w-0">
                                <span
                                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                                    style={{ backgroundColor: seriesColor(i) }}
                                />
                                <span className="text-sm font-semibold text-ink truncate flex-1 min-w-0">
                                    {source.name}
                                </span>
                                <span className="text-sm text-ink-secondary tabular-nums shrink-0">
                                    {compactNum(end)}
                                </span>
                                <DeltaChip value={end - start} className="shrink-0" />
                            </div>
                        )
                    })}
                </div>
            </section>
        </>
    )
}

/** Stacked totals across a provider's sources. Deliberately a small, separate
 *  renderer rather than a mode of `CountTimeline`: the input shape is
 *  series-per-source and there are no per-label deltas, drop markers or
 *  min/max bands to draw. */
function ProviderTotalsChart({ payload }: { payload: ProviderHistoryPayload }) {
    const width = 1000
    const height = 220
    const pad = { top: 12, right: 12, bottom: 26, left: 48 }
    const innerW = width - pad.left - pad.right
    const innerH = height - pad.top - pad.bottom
    const buckets = payload.totals.map((t) => t.at)
    if (buckets.length < 2) return null

    const stepX = innerW / (buckets.length - 1)
    const max = Math.max(...payload.totals.map((t) => t.node_count), 1)
    const x = (i: number) => pad.left + i * stepX
    const y = (v: number) => pad.top + innerH * (1 - v / max)

    const running = new Array(buckets.length).fill(0)
    const bands = payload.sources.map((source, i) => {
        const upper = source.points.map((p, idx) => running[idx] + p.node_count)
        const top = upper.map((v, idx) => `${x(idx).toFixed(1)},${y(v).toFixed(1)}`)
        const bottom = running.map((v, idx) => `${x(idx).toFixed(1)},${y(v).toFixed(1)}`).reverse()
        for (let idx = 0; idx < running.length; idx += 1) running[idx] = upper[idx]
        return { id: source.data_source_id, color: seriesColor(i), path: `M${top.join('L')}L${bottom.join('L')}Z` }
    })

    const tickEvery = Math.max(1, Math.ceil(buckets.length / 6))

    return (
        <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full h-auto"
            role="img"
            aria-label={`Provider entity totals: ${compactNum(payload.totals[0].node_count)} to ${compactNum(payload.totals[payload.totals.length - 1].node_count)}`}
        >
            {[0, 0.5, 1].map((f) => (
                <g key={f}>
                    <line
                        x1={pad.left} x2={width - pad.right} y1={y(max * f)} y2={y(max * f)}
                        className="stroke-black/[0.07] dark:stroke-white/[0.07]" strokeWidth="1"
                    />
                    <text
                        x={pad.left - 8} y={y(max * f) + 3.5} textAnchor="end"
                        className="fill-ink-muted text-[10px] tabular-nums"
                    >
                        {compactNum(max * f)}
                    </text>
                </g>
            ))}
            {bands.map((band) => (
                <path
                    key={band.id} d={band.path} fill={band.color} fillOpacity={0.72}
                    stroke={band.color} strokeWidth="1" strokeOpacity={0.9}
                />
            ))}
            {buckets.map((bucket, i) => (
                i % tickEvery === 0 || i === buckets.length - 1 ? (
                    <text
                        key={bucket} x={x(i)} y={height - 8}
                        textAnchor={i === 0 ? 'start' : i === buckets.length - 1 ? 'end' : 'middle'}
                        className="fill-ink-muted text-[10px]"
                    >
                        {axisLabel(bucket, payload.grain)}
                    </text>
                ) : null
            ))}
        </svg>
    )
}

function EmptyState({ title, message }: { title: string; message: string }) {
    return (
        <div className="rounded-2xl border border-glass-border bg-canvas-elevated px-6 py-12 text-center">
            <History className="w-6 h-6 text-ink-muted mx-auto mb-3" />
            <p className="text-sm font-bold text-ink">{title}</p>
            <p className="text-xs text-ink-muted mt-1.5 max-w-md mx-auto">{message}</p>
        </div>
    )
}

function HistorySkeleton() {
    return (
        <div className="animate-pulse">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
                {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-24 rounded-2xl border border-glass-border bg-canvas-elevated" />
                ))}
            </div>
            <div className="h-10 rounded-xl border border-glass-border bg-canvas-elevated mb-5" />
            <div className="h-80 rounded-2xl border border-glass-border bg-canvas-elevated mb-5 flex items-center justify-center">
                <Loader2 className="w-5 h-5 animate-spin text-ink-muted" />
            </div>
        </div>
    )
}
