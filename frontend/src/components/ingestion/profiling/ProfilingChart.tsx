/**
 * The chart, and the two controls that decide what it draws.
 *
 * METRIC and BREAKDOWN are orthogonal on purpose, and the payload is
 * series-major so they can be. "Relationships, broken down by relationship
 * type" is a composition of two independent choices, not a fourth chart.
 *
 * The mark follows the question rather than a preference: a total or one
 * measure is a LINE (a reader compares heights over time), a breakdown is a
 * STACKED AREA (a reader compares shares, and the stack is the only mark where
 * the parts visibly sum to the whole).
 */
import { useMemo } from 'react'
import { ArrowLeft } from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact } from '@/lib/formatMetric'
import { ChartFrame } from '@/components/analytics/charts/ChartFrame'
import { ChartTable } from '@/components/analytics/charts/ChartTable'
import { StackedAreaChart } from '@/components/analytics/charts/StackedAreaChart'
import { TypeTrellis } from './TypeTrellis'
import { TimeSeriesChart } from '@/components/analytics/charts/TimeSeriesChart'
import { useChartTheme } from '@/components/analytics/charts/chartTheme'
import type {
    Finding, ProfilingBreakdown, ProfilingMetric, SeriesPayload,
} from '@/types/profiling'
import { ControlGroup } from './BoardFilters'
import { TIME_ZONE_NOTE, axisLabels, formatBucketUtc } from './shared'

const METRICS: { key: ProfilingMetric; label: string }[] = [
    { key: 'total', label: 'Everything' },
    { key: 'nodes', label: 'Entities' },
    { key: 'edges', label: 'Relationships' },
]

/**
 * How a breakdown is drawn. Only offered once there IS a breakdown — a view
 * control that does nothing until another control is set is a control that
 * teaches people to ignore controls.
 */
export type BreakdownView = 'stacked' | 'share' | 'trellis'

const VIEWS: { key: BreakdownView; label: string }[] = [
    { key: 'stacked', label: 'Stacked' },
    { key: 'share', label: 'Share' },
    { key: 'trellis', label: 'Compare' },
]

const BREAKDOWNS: { key: ProfilingBreakdown; label: string }[] = [
    { key: 'none', label: 'Nothing' },
    { key: 'entity_type', label: 'Entity type' },
    { key: 'edge_type', label: 'Relationship type' },
]

interface Props {
    payload: SeriesPayload
    /**
     * Findings to mark on the timeline.
     *
     * The chart shows the drop; the findings band says it was reported. Until
     * they share an axis, "was this the incident we alerted on" needs two
     * screens and a mental join on timestamps.
     */
    findings?: Finding[]
    metric: ProfilingMetric
    breakdown: ProfilingBreakdown
    view: BreakdownView
    onMetric: (next: ProfilingMetric) => void
    onBreakdown: (next: ProfilingBreakdown) => void
    onView: (next: BreakdownView) => void
    /** When set, one type is drawn alone at full size. */
    focusedType?: string | null
    onFocusType?: (key: string | null) => void
    compare?: boolean
    title?: string
    action?: React.ReactNode
    isStale?: boolean
}

export function ProfilingChart({
    payload, findings, metric, breakdown, view, onMetric, onBreakdown, onView,
    focusedType, onFocusType, compare, title = 'Counts over time',
    action, isStale,
}: Props) {
    const theme = useChartTheme()
    const hasBreakdown = breakdown !== 'none'
    const typeSeries = useMemo(
        () => (payload.series ?? []).filter((s) => s.kind === 'type'),
        [payload.series],
    )
    const focused = focusedType
        ? typeSeries.find((s) => s.key === focusedType) ?? null
        : null
    // A focused type is drawn as a line, not as a band of one — a stack with a
    // single member is a bar chart pretending to be a composition.
    const stacked = hasBreakdown && !focused && view !== 'trellis'

    const drawn = useMemo(
        () => (focused ? [focused] : payload.series ?? []),
        [focused, payload.series],
    )

    const legend = useMemo(
        () => drawn.map((s) => {
            // Colour follows the ENTITY: its index in the full payload, not
            // its position in whatever subset is drawn. Focusing a type must
            // not repaint it.
            const slot = (payload.series ?? []).findIndex((x) => x.key === s.key)
            return {
                key: s.key,
                label: s.label,
                color: s.key === '__other__'
                    ? theme.neutralMark
                    : theme.series[Math.max(0, slot) % theme.series.length],
                shape: (stacked ? 'area' : 'line') as 'area' | 'line',
            }
        }),
        [drawn, payload.series, stacked, theme],
    )

    const table = useMemo(() => (
        <ChartTable
            rowLabel="Bucket"
            rows={(payload.buckets ?? []).map(formatBucketUtc)}
            columns={drawn.map((s) => ({
                key: s.key, label: s.label, values: s.points.map((p) => p.v),
            }))}
            caption={`${title} — tabular twin`}
        />
    ), [payload.buckets, drawn, title])

    /**
     * Height follows the data.
     *
     * A fixed 220px plot holding two points is mostly empty canvas, and empty
     * canvas reads as missing data rather than as a short series. Tall enough
     * to be a chart, short enough not to imply there is more of it.
     */
    const plotHeight = Math.round(
        Math.min(240, Math.max(120, payload.buckets.length * 14 + 90)),
    )

    const ticks = useMemo(() => axisLabels(payload.buckets), [payload.buckets])

    /**
     * Findings snapped to the bucket that contains them.
     *
     * A finding is stamped with the instant it was OBSERVED, which almost
     * never equals a bucket boundary. Annotations are matched by label, so an
     * unsnapped mark simply never draws — silently, which is the worst way for
     * a forensic mark to fail. Nearest-bucket is the honest placement: the
     * chart's resolution is the bucket, and claiming finer would be a
     * precision the series does not have.
     */
    const findingMarks = useMemo(() => {
        if (!findings?.length || !payload.buckets.length) return []
        const times = payload.buckets.map((b) => {
            const padded = b.length <= 10
                ? `${b}T00:00:00Z`
                : b.length <= 13 ? `${b}:00:00Z` : b
            return new Date(padded).getTime()
        })
        return findings.flatMap((f) => {
            const at = new Date(f.observed_at ?? f.detected_at).getTime()
            if (Number.isNaN(at)) return []
            let best = 0
            for (let i = 1; i < times.length; i += 1) {
                if (Math.abs(times[i] - at) < Math.abs(times[best] - at)) best = i
            }
            const noun = f.metric === 'edges' ? 'relationships' : 'entities'
            return [{
                bucket: formatBucketUtc(payload.buckets[best]),
                title: f.finding === 'type_gone' && f.subject_type
                    ? `${f.subject_type} gone · ${f.severity}`
                    : f.finding === 'silent'
                        ? `Stopped reporting · ${f.severity}`
                        : `${f.delta < 0 ? '−' : '+'}${compact(Math.abs(f.delta))} ${noun} · ${f.severity}`,
            }]
        })
    }, [findings, payload.buckets])

    const grainWord = { raw: 'every observation', hour: 'by hour', day: 'by day' }[payload.grain]
    const subtitle = [
        `${payload.buckets.length} ${payload.buckets.length === 1 ? 'point' : 'points'}, ${grainWord}`,
        view === 'share' && hasBreakdown && !focused && 'share of the total, not counts',
        payload.sources_observed > 1 && `${payload.sources_observed} sources`,
        payload.truncated && 'window trimmed to the most recent observations',
        payload.grain !== 'day' && TIME_ZONE_NOTE,
    ].filter(Boolean).join(' · ')

    return (
        <ChartFrame
            title={title}
            subtitle={subtitle}
            series={legend}
            table={table}
            isStale={isStale}
            isEmpty={!payload.buckets.length}
            emptyLabel="Nothing recorded in this window"
            ghostLabel={compare && !stacked ? 'Previous window' : undefined}
            action={action}
            toolbar={
                <>
                    <ControlGroup
                        label="Show" options={METRICS}
                        value={metric} onChange={onMetric}
                    />
                    <ControlGroup
                        label="Split by" options={BREAKDOWNS}
                        value={breakdown} onChange={onBreakdown}
                    />
                    {/* Only once there IS a split. A view control that does
                        nothing until another control is set teaches people to
                        ignore controls. */}
                    {hasBreakdown && !focused && (
                        <ControlGroup
                            label="As" options={VIEWS}
                            value={view} onChange={onView}
                        />
                    )}
                </>
            }
        >
            {focused && (
                <button
                    type="button"
                    onClick={() => onFocusType?.(null)}
                    className={cn(
                        'mb-3 inline-flex items-center gap-1.5 rounded-lg border border-glass-border',
                        'px-2.5 py-1.5 text-xs font-semibold text-ink-secondary',
                        'hover:text-ink hover:bg-canvas transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                    )}
                >
                    <ArrowLeft className="w-3.5 h-3.5" aria-hidden />
                    All {breakdown === 'edge_type' ? 'relationship' : 'entity'} types
                    <span className="text-ink-muted font-normal">
                        · showing {focused.label}
                    </span>
                </button>
            )}
        
            {hasBreakdown && !focused && view === 'trellis' ? (
                <TypeTrellis
                    buckets={payload.buckets}
                    series={typeSeries}
                    onFocus={onFocusType ? (key) => onFocusType(key) : undefined}
                />
            ) : stacked ? (
                <StackedAreaChart
                    buckets={payload.buckets}
                    series={payload.series.map((s, i) => ({
                        key: s.key,
                        label: s.label,
                        values: s.points.map((p) => p.v),
                        slot: i,
                        residual: s.key === '__other__',
                    }))}
                    share={view === 'share'}
                    height={plotHeight + 20}
                    formatBucket={formatBucketUtc}
                    axisLabels={ticks}
                />
            ) : (
                <TimeSeriesChart
                    buckets={payload.buckets.map(formatBucketUtc)}
                    axisLabels={ticks}
                    series={drawn.map((s) => ({
                        key: s.key,
                        label: s.label,
                        values: s.points.map((p) => p.v),
                        slot: Math.max(0, (payload.series ?? []).findIndex((x) => x.key === s.key)),
                        area: drawn.length === 1,
                        previous: compare
                            ? payload.previous?.series
                                .find((p) => p.key === s.key)?.points
                                .map((p) => p.v)
                            : undefined,
                    }))}
                    height={plotHeight}
                    annotations={[
                        ...(payload.vanished_types ?? []).map((v) => ({
                            // Anchored at the end of the window: the series no
                            // longer carries this type at all, so there is no
                            // bucket of its own to point at — what matters is
                            // that it is gone by now.
                            bucket: formatBucketUtc(payload.buckets.at(-1) ?? ''),
                            title: `${v.type} gone (peaked at ${compact(v.peak)})`,
                        })),
                        ...findingMarks,
                    ]}
                />
            )}
        </ChartFrame>
    )
}
