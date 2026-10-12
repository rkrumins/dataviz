/**
 * What the estate is actually made of.
 *
 * The table below answers "tell me about workspace X". Nobody arrives with
 * that question — they arrive wanting to know whether the tenancy is a handful
 * of busy places or a long tail of abandoned ones, and a sortable list of rows
 * cannot answer that no matter how you sort it.
 *
 * HONEST ABOUT WHAT IT CAN SEE. Bands are computed over the workspaces this
 * reader is shown, which for most people is a subset. Describing two of ten
 * workspaces as "the estate" would be a confident lie, so the header says how
 * much of it is in view and the bands are labelled as covering that much.
 */
import { Boxes, Layers, MoonStar, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { exact } from '@/lib/formatMetric'
import type { WorkspaceAnalyticsRow } from '@/services/analyticsService'
import { useChartTheme } from './charts/chartTheme'

/** Bands are ordered, so the ramp is one hue getting darker — never six hues,
 *  which would double-encode an ordered scale as unordered categories. */
interface Band { label: string; test: (r: WorkspaceAnalyticsRow) => boolean }

const SIZE_BANDS: Band[] = [
    { label: 'Empty', test: (r) => (r.views ?? 0) === 0 },
    { label: '1–10 views', test: (r) => (r.views ?? 0) >= 1 && (r.views ?? 0) <= 10 },
    { label: '11–50', test: (r) => (r.views ?? 0) > 10 && (r.views ?? 0) <= 50 },
    { label: '51–200', test: (r) => (r.views ?? 0) > 50 && (r.views ?? 0) <= 200 },
    { label: '200+', test: (r) => (r.views ?? 0) > 200 },
]

const TEAM_BANDS: Band[] = [
    { label: 'Nobody', test: (r) => (r.members ?? 0) === 0 },
    { label: 'One person', test: (r) => (r.members ?? 0) === 1 },
    { label: '2–5', test: (r) => (r.members ?? 0) >= 2 && (r.members ?? 0) <= 5 },
    { label: '6–20', test: (r) => (r.members ?? 0) > 5 && (r.members ?? 0) <= 20 },
    { label: '20+', test: (r) => (r.members ?? 0) > 20 },
]

export function WorkspaceEstate({ rows, className }: {
    rows: WorkspaceAnalyticsRow[]
    className?: string
}) {
    const theme = useChartTheme()
    if (rows.length === 0) return null

    const visible = rows.filter((r) => !r.redacted)
    const locked = rows.length - visible.length
    const dormant = visible.filter((r) => r.dormant).length
    const soloRun = visible.filter((r) => (r.activeUsers ?? 0) === 1).length
    const noSources = visible.filter((r) => (r.dataSources ?? 0) === 0).length

    return (
        <section
            aria-label="What the estate is made of"
            className={cn(
                'rounded-2xl border border-glass-border bg-canvas-elevated p-5 shadow-sm',
                className,
            )}
        >
            <header className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2 className="text-sm font-bold text-ink">What the estate is made of</h2>
                <p className="text-[11px] text-ink-muted">
                    {locked > 0
                        ? `${exact(rows.length)} workspaces · ${exact(visible.length)} you can see`
                        : `All ${exact(rows.length)} workspaces`}
                </p>
            </header>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Figure
                    icon={Boxes} accent="indigo"
                    value={rows.length} label="Workspaces"
                    sub={locked > 0
                        ? `${exact(locked)} you are not a member of`
                        : 'All of them open to you'}
                />
                <Figure
                    icon={Users} accent="cyan"
                    value={visible.length} label="Yours to open"
                    sub={visible.length === rows.length
                        ? 'Every workspace on the platform'
                        : `${Math.round((visible.length / rows.length) * 100)}% of the estate`}
                />
                <Figure
                    icon={MoonStar} accent={dormant ? 'amber' : 'emerald'}
                    value={dormant} label="Gone quiet"
                    sub={dormant
                        ? 'No activity at all in this range'
                        : 'Everything you can see is in use'}
                />
                <Figure
                    icon={Layers} accent={noSources ? 'amber' : 'emerald'}
                    value={noSources} label="No data source"
                    sub={noSources
                        ? 'A workspace with nothing connected holds no lineage'
                        : 'Every one has something connected'}
                />
            </div>

            {visible.length > 0 && (
                <div className="mt-5 grid gap-5 sm:grid-cols-2">
                    <BandBar
                        title="How big they are" caption="By saved views"
                        bands={SIZE_BANDS} rows={visible} colour={theme.series[0]}
                    />
                    <BandBar
                        title="How many people are in them" caption="By members"
                        bands={TEAM_BANDS} rows={visible} colour={theme.series[2]}
                    />
                </div>
            )}

            {soloRun > 0 && visible.length > 1 && (
                <p className="mt-4 border-t border-glass-border pt-3 text-[11px] leading-relaxed text-ink-muted">
                    <strong className="font-semibold text-ink-secondary">
                        {exact(soloRun)} of {exact(visible.length)}
                    </strong>{' '}
                    had exactly one active person in this range. A workspace one person
                    keeps alive is a workspace that leaves when they do.
                </p>
            )}
        </section>
    )
}

const ACCENTS = {
    indigo: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
    cyan: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20',
    amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
} as const

function Figure({ icon: Icon, accent, value, label, sub }: {
    icon: React.ComponentType<{ className?: string }>
    accent: keyof typeof ACCENTS
    value: number
    label: string
    sub: string
}) {
    return (
        <div className="rounded-xl border border-glass-border p-3.5">
            <span aria-hidden className={cn(
                'mb-2.5 flex h-8 w-8 items-center justify-center rounded-lg border',
                ACCENTS[accent],
            )}>
                <Icon className="h-3.5 w-3.5" />
            </span>
            <p className="text-xl font-bold leading-none text-ink">{exact(value)}</p>
            <p className="mt-1 text-xs font-semibold text-ink-secondary">{label}</p>
            <p className="mt-1 text-[11px] leading-snug text-ink-muted">{sub}</p>
        </div>
    )
}

/**
 * One ordered distribution. A single hue darkening across the bands, because
 * these are steps on a scale rather than unrelated categories — giving each
 * band its own colour would say they are unordered, which is the opposite of
 * what a size band means.
 */
function BandBar({ title, caption, bands, rows, colour }: {
    title: string
    caption: string
    bands: Band[]
    rows: WorkspaceAnalyticsRow[]
    colour: string
}) {
    const counts = bands.map((b) => rows.filter(b.test).length)
    const total = counts.reduce((a, c) => a + c, 0) || 1

    return (
        <div>
            <p className="text-xs font-semibold text-ink">{title}</p>
            <p className="mb-2.5 text-[11px] text-ink-muted">{caption}</p>
            <div className="flex h-2 gap-[2px] overflow-hidden rounded-full">
                {counts.map((n, i) => n > 0 && (
                    <span
                        key={bands[i].label}
                        title={`${bands[i].label}: ${n}`}
                        style={{
                            width: `${(n / total) * 100}%`,
                            backgroundColor: colour,
                            // Ordered ramp: later bands sit darker.
                            opacity: 0.3 + (i / Math.max(1, bands.length - 1)) * 0.7,
                        }}
                    />
                ))}
            </div>
            <ul className="mt-2.5 grid gap-1">
                {counts.map((n, i) => n > 0 && (
                    <li key={bands[i].label} className="flex items-center gap-2 text-[11px]">
                        <span
                            aria-hidden
                            className="h-2 w-2 shrink-0 rounded-[2px]"
                            style={{
                                backgroundColor: colour,
                                opacity: 0.3 + (i / Math.max(1, bands.length - 1)) * 0.7,
                            }}
                        />
                        <span className="flex-1 truncate text-ink-secondary">{bands[i].label}</span>
                        <span className="font-semibold tabular-nums text-ink">{n}</span>
                    </li>
                ))}
            </ul>
        </div>
    )
}
