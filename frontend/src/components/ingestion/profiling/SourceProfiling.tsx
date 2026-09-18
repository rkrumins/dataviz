/**
 * One data source's profile, with a time axis.
 *
 * This is the whole per-source surface, and it is a COMPONENT rather than a
 * page on purpose: it renders identically in the Ingestion drawer, in the
 * workspace drawer and on the routable data source page, and because opening
 * it never navigates anywhere, "back" cannot land you somewhere you did not
 * come from. That was the previous version's most-reported problem, and no
 * amount of breadcrumb work fixes it as well as not leaving does.
 *
 * The current profile and its history are one surface here. Splitting the
 * point-in-time counts into an "Overview" tab and their movement into a
 * "History" page is what made the feature read as bolted on — they are the
 * same four numbers, and the only difference is whether you are looking at
 * "now" or "since".
 */
import { useMemo, useState } from 'react'
import {
    Activity, Boxes, Download, KeyRound, Loader2, ShieldCheck, Spline,
    TrendingDown, TriangleAlert,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { exact } from '@/lib/formatMetric'
import { KpiCard } from '@/components/analytics/KpiCard'
import { PROPERTY_NAME_CEILING, propertyNameBand } from '@/components/admin/PropertyNameBudget'
import { profilingService } from '@/services/profilingService'
import {
    DEFAULT_WINDOW, PROFILING_WINDOWS, type ProfilingWindowKey,
    useProfilingFindings, useProfilingObservations, useProfilingSeries,
} from '@/hooks/useProfiling'
import { useCanReadProfiling } from '@/hooks/useProfilingAccess'
import type { ProfilingBreakdown, SeriesMetric } from '@/types/profiling'
import { OverlayPanel } from './OverlayPanel'
import { ChangeLedger } from './ChangeLedger'
import { FindingsBand } from './FindingsBand'
import { ProfilingChart, type BreakdownView } from './ProfilingChart'
import { SeriesVerdict } from './Verdict'
import { Segmented } from './BoardFilters'
import { TypeLedger } from './TypeLedger'
import { UtcChip } from './UtcChip'
import { formatBucket, formatDay, signed } from './shared'

interface Props {
    dataSourceId: string
    sourceName?: string
    className?: string
}

export function SourceProfiling({
    dataSourceId, sourceName, className,
}: Props) {
    const canRead = useCanReadProfiling()
    const [window, setWindow] = useState<ProfilingWindowKey>(DEFAULT_WINDOW)
    const [metric, setMetric] = useState<SeriesMetric>('total')
    const [breakdown, setBreakdown] = useState<ProfilingBreakdown>('none')
    const [view, setView] = useState<BreakdownView>('stacked')
    const [focusedType, setFocusedType] = useState<string | null>(null)
    const [onlyNotable, setOnlyNotable] = useState(false)

    const seriesQuery = useMemo(() => ({
        scope: 'source' as const,
        id: dataSourceId,
        window,
        metric,
        breakdown,
        // A trellis draws every type as its own panel, so folding the tail
        // into "Other" costs exactly the types someone opened it to compare.
        top: view === 'trellis' ? 20 : undefined,
        compare: true,
    }), [dataSourceId, window, metric, breakdown, view])

    const series = useProfilingSeries(seriesQuery, { enabled: canRead })
    // Fetched here as well as in the band: React Query dedupes the request,
    // and the chart needs the same findings to mark them on its axis.
    const findings = useProfilingFindings(
        { id: dataSourceId, openOnly: false, limit: 50 },
        { enabled: canRead },
    )
    const ledger = useProfilingObservations(
        { id: dataSourceId, window, onlyNotable, limit: 50 },
        { enabled: canRead },
    )

    if (!canRead) return null

    // Five states, five treatments. The previous version collapsed loading,
    // empty, error, partial and permission-limited into one sentence about
    // history starting soon — so a 500 and a brand-new source were reported
    // identically, and neither was true.
    if (series.isLoading) {
        return (
            <div className={cn('flex items-center gap-2 py-8 text-sm text-ink-muted', className)}>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                Reading this source's profile…
            </div>
        )
    }

    if (series.isError) {
        return (
            <div className={cn(
                'rounded-2xl border border-rose-500/30 bg-rose-500/[0.05] px-4 py-4',
                className,
            )}>
                <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <TriangleAlert className="w-4 h-4 text-rose-600 dark:text-rose-400" aria-hidden />
                    The profile could not be read
                </p>
                <p className="text-xs text-ink-secondary mt-1">
                    {series.error?.message || 'The request failed.'} Nothing has been lost —
                    profiling records are durable, and this is a read.
                </p>
                <button
                    type="button"
                    onClick={() => series.refetch()}
                    className="mt-3 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                    Try again
                </button>
            </div>
        )
    }

    const payload = series.data
    if (!payload) return null

    const nodes = payload.totals.nodes ?? []
    const edges = payload.totals.edges ?? []
    const nodeNow = nodes.at(-1) ?? 0
    const edgeNow = edges.at(-1) ?? 0
    const nodeMove = nodeNow - (nodes[0] ?? 0)
    const edgeMove = edgeNow - (edges[0] ?? 0)
    const windowLabel = PROFILING_WINDOWS.find((w) => w.key === window)?.label ?? window
    const largestDrop = worstDrop(payload.buckets, nodes)

    // The overlay inside the Relationships total. The tile keeps meaning what
    // it meant — raw + rollup, the number people have been reading — and this
    // line accounts for the gap against the relationship-type table below,
    // which strips the rollup because it is not the customer's data.
    //
    // Absent on a backend that predates the measure, and omitted at zero: a
    // source with no rollup has nothing to say here, and "of which 0" reads
    // as a fault on the many sources that legitimately have none.
    const aggregated = payload.totals.aggregated ?? []
    const aggNow = aggregated.at(-1) ?? 0
    const overlaySub = aggNow
        ? `of which ${exact(aggNow)} aggregated`
        : (edgeMove ? undefined : 'unchanged')

    // The attribute-name ceiling. Sparse by nature — the series draws no
    // point for a bucket it could not measure — so take the last MEASURED
    // reading rather than `.at(-1)`, which is null whenever the most recent
    // capture happened to miss it.
    const propertyKeys = payload.totals.property_keys ?? []
    const propertyKeysNow = [...propertyKeys].reverse().find((v) => v != null) ?? null

    const exportHref = profilingService.exportUrl({
        // The drawn measure reaches the file. Without it the export claimed
        // to be "always the drawn values" while hardcoding total.
        scope: 'source', id: dataSourceId, window, breakdown, metric,
    })

    return (
        <div className={cn('space-y-5', className)}>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Segmented
                    label="Time window"
                    options={PROFILING_WINDOWS}
                    value={window}
                    onChange={setWindow}
                />
                <UtcChip className="ml-auto" />
                {payload.buckets.length > 0 && (
                    <a
                        href={exportHref}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-lg border border-glass-border',
                            'px-2.5 py-1.5 text-xs font-semibold text-ink-secondary',
                            'hover:text-ink hover:bg-canvas transition-colors',
                        )}
                    >
                        <Download className="w-3.5 h-3.5" aria-hidden /> Export
                    </a>
                )}
            </div>

            <SeriesVerdict series={payload} sourceName={sourceName} />
            <FindingsBand dataSourceId={dataSourceId} />

            {/*
              The profile itself — the same numbers the Overview shows, now
              with what they DID beside what they ARE. `KpiCard` rather than a
              bespoke tile: same trend, same delta colouring and same
              higher-is-better semantics as every other stat in the product.
            */}
            {/* Two up from the narrowest drawer, four across a page. The
                surface renders at ~440px, ~670px and full width, so every
                grid here is a min-width breakpoint rather than a host flag. */}
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
                {/*
                  A zero delta gets NO chip. Passing changePct={0} renders
                  "— 0.0%" beside the comparison AND the sub line beneath it,
                  which says "nothing changed" twice and overflows the slot —
                  the clipped "over 30 …" and "nothing was lost in th…" in the
                  drawer were both this, not a card that is too narrow.
                */}
                <KpiCard
                    label="Entities"
                    value={exact(nodeNow)}
                    icon={Boxes}
                    accent="indigo"
                    trend={nodes}
                    trendTone={nodeMove < 0 ? 'red' : 'indigo'}
                    changePct={nodeMove ? pctChange(nodes) : null}
                    comparisonLabel={`vs ${windowLabel} ago`}
                    sub={nodeMove ? undefined : 'unchanged'}
                />
                <KpiCard
                    label="Relationships"
                    value={exact(edgeNow)}
                    icon={Spline}
                    accent="cyan"
                    trend={edges}
                    trendTone={edgeMove < 0 ? 'red' : 'emerald'}
                    changePct={edgeMove ? pctChange(edges) : null}
                    comparisonLabel={`vs ${windowLabel} ago`}
                    sub={overlaySub}
                />
                <KpiCard
                    label="Observations"
                    value={exact(payload.buckets.length)}
                    icon={Activity}
                    accent="violet"
                    sub={{ raw: 'every capture', hour: 'by hour', day: 'by day' }[payload.grain]}
                />
                {propertyKeysNow != null && (
                    <KpiCard
                        label="Property names"
                        value={exact(propertyKeysNow)}
                        icon={KeyRound}
                        accent={propertyNameBand(propertyKeysNow).accent}
                        // The ceiling is the point: the raw count says nothing
                        // about runway, and the names are never freed.
                        sub={`${Math.round((propertyKeysNow / PROPERTY_NAME_CEILING) * 100)}% of ${PROPERTY_NAME_CEILING.toLocaleString()}`}
                    />
                )}
                <KpiCard
                    label="Largest drop"
                    value={largestDrop ? signed(largestDrop.delta) : 'None'}
                    icon={largestDrop ? TrendingDown : ShieldCheck}
                    accent={largestDrop ? 'amber' : 'emerald'}
                    // The tile that earns its place only when it has bad news:
                    // "nothing lost" is the answer people come looking for as
                    // often as the number is.
                    sub={largestDrop ? formatBucket(largestDrop.at) : 'nothing lost'}
                />
            </div>

            {/* Between the tiles and the chart: the chart shows the overlay's
                history, this says whether the current level is right and where
                to act. */}
            <OverlayPanel dataSourceId={dataSourceId} />

            <ProfilingChart
                payload={payload}
                findings={findings.data?.alerts}
                metric={metric}
                breakdown={breakdown}
                view={view}
                onMetric={(next) => {
                    setMetric(next)
                    setFocusedType(null)
                    // A breakdown implies its own measure server-side, so
                    // leaving one set would silently draw relationship types
                    // instead of the overlay the user just asked for.
                    if (next === 'aggregated' || next === 'property_keys') setBreakdown('none')
                }}
                onBreakdown={(next) => { setBreakdown(next); setFocusedType(null) }}
                onView={setView}
                focusedType={focusedType}
                onFocusType={setFocusedType}
                compare
                isStale={series.isFetching}
            />

            <TypeLedger scope="source" id={dataSourceId} window={window} />

            <Coverage payload={payload} />

            {ledger.data && (
                <ChangeLedger
                    payload={ledger.data}
                    onlyNotable={onlyNotable}
                    onOnlyNotable={setOnlyNotable}
                    windowLabel={`Last ${windowLabel.toLowerCase()}`}
                />
            )}
        </div>
    )
}

/**
 * Where the record begins, stated rather than implied.
 *
 * A window that reaches further back than the data does is the normal state of
 * a young source, and a chart cannot tell that apart from data loss. Saying it
 * plainly is the difference between "this is new" and "something ate our
 * history".
 */
function Coverage({ payload }: { payload: { coverage_from: string | null; from: string; buckets: string[] } }) {
    if (!payload.coverage_from) return null
    const begins = new Date(payload.coverage_from)
    const requested = new Date(payload.from)
    if (Number.isNaN(begins.getTime())) return null

    const partial = begins > requested
    return (
        <p className="text-xs text-ink-muted">
            {partial ? (
                <>
                    This source's record begins {formatDay(payload.coverage_from)} — earlier
                    than that is not missing, it was never observed.
                </>
            ) : (
                <>The window is fully covered, from {formatDay(payload.from)}.</>
            )}
        </p>
    )
}


/** Percent change across a series, or null when there is no base to compare
 *  against. A previous value of zero is not a "+100%" — inventing one would
 *  make the most-read number on the tile fiction. */
function pctChange(values: number[]): number | null {
    const first = values[0]
    const last = values.at(-1)
    if (first === undefined || last === undefined || !first) return null
    return ((last - first) / first) * 100
}

/** The steepest single fall in the window, if there was one.
 *
 *  Computed from the drawn series rather than read from a summary field, so
 *  the tile and the chart can never disagree about whether anything was lost.
 */
function worstDrop(
    buckets: string[], values: number[],
): { at: string; delta: number } | null {
    let worst: { at: string; delta: number } | null = null
    for (let i = 1; i < values.length; i += 1) {
        const delta = values[i] - values[i - 1]
        if (delta < 0 && (!worst || delta < worst.delta)) {
            worst = { at: buckets[i], delta }
        }
    }
    return worst
}
