/**
 * AdminTelemetry — product-usage analytics for the admin console.
 *
 * Backs `/admin/telemetry`. Visualises three usage signals over a
 * trailing day-window: "was this helpful?" votes, product-tour
 * engagement, and — the headline insight — searches that returned
 * nothing ("content gaps"), which tell the team what docs to write.
 *
 * Visual language mirrors AdminOverview: gradient hero, KPI strip,
 * table, and matching loading skeletons.
 */
import { useState } from 'react'
import { AlertCircle, BarChart3, Search, ThumbsUp, MessageSquare, Compass, FileQuestion } from 'lucide-react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { PageContainer } from '@/components/layout/PageContainer'
import { useAdminTelemetry } from '@/hooks/useAdminTelemetry'
import type { HelpfulByPage } from '@/services/telemetryAdminService'

const DAY_WINDOWS = [7, 30, 90] as const

function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
}

/** Split a `docs:<slug>` / `guide:<slug>` page key into a link + label.
 *  Unknown prefixes fall back to a plain, unlinked label. */
function pageLink(page: string): { to: string | null; label: string } {
    const idx = page.indexOf(':')
    if (idx === -1) return { to: null, label: page }
    const prefix = page.slice(0, idx)
    const slug = page.slice(idx + 1)
    if (prefix === 'docs') return { to: `/docs/${slug}`, label: slug }
    if (prefix === 'guide') return { to: `/guide/${slug}`, label: slug }
    return { to: null, label: page }
}

export function AdminTelemetry() {
    // days is view state; the hook keys its cache on it. Default 30.
    const [days, setDays] = useState(30)
    const { data, isLoading, isFetching, error } = useAdminTelemetry(days)

    if (isLoading) return <TelemetrySkeleton />

    if (error || !data) {
        return (
            <PageContainer gutter="shell" className="py-8">
                <Header days={days} setDays={setDays} isFetching={isFetching} />
                <div className="border border-glass-border rounded-xl bg-canvas-elevated p-8 flex flex-col items-center text-center">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-rose-500/20 to-rose-500/0 border border-rose-500/20 flex items-center justify-center mb-4">
                        <AlertCircle className="w-6 h-6 text-rose-500" />
                    </div>
                    <h2 className="text-base font-bold text-ink mb-1">Couldn't load telemetry</h2>
                    <p className="text-sm text-ink-muted max-w-sm">
                        {error?.message ?? 'The usage summary is unavailable right now. Try again in a moment.'}
                    </p>
                </div>
            </PageContainer>
        )
    }

    const { helpful, contentGaps, tours, totalEvents } = data
    // `funnel` is a newer field — tolerate a backend that predates it so the
    // panel renders (empty funnel) instead of crashing.
    const funnel = tours.funnel ?? []
    const scorePct = helpful.total > 0 ? Math.round(helpful.score * 100) : null

    const kpis = [
        {
            key: 'score',
            label: 'Helpful score',
            icon: ThumbsUp,
            gradient: 'from-emerald-500/20 to-emerald-500/0',
            accent: 'text-emerald-600 dark:text-emerald-400',
            iconBg: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
            value: scorePct === null ? '—' : `${scorePct}%`,
            sub: `${compactNum(helpful.yes)} 👍 · ${compactNum(helpful.no)} 👎`,
        },
        {
            key: 'votes',
            label: 'Feedback votes',
            icon: MessageSquare,
            gradient: 'from-indigo-500/20 to-indigo-500/0',
            accent: 'text-indigo-600 dark:text-indigo-400',
            iconBg: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
            value: compactNum(helpful.total),
            sub: `${compactNum(totalEvents)} events total`,
        },
        {
            key: 'tours',
            label: 'Tours completed',
            icon: Compass,
            gradient: 'from-violet-500/20 to-violet-500/0',
            accent: 'text-violet-600 dark:text-violet-400',
            iconBg: 'bg-violet-500/10 text-violet-500 border-violet-500/20',
            value: compactNum(tours.completed),
            sub: `${compactNum(tours.skipped)} skipped`,
        },
        {
            key: 'gaps',
            label: 'Content gaps',
            icon: FileQuestion,
            gradient: 'from-amber-500/20 to-amber-500/0',
            accent: 'text-amber-600 dark:text-amber-400',
            iconBg: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
            value: compactNum(contentGaps.length),
            sub: 'zero-result searches',
        },
    ]

    const byPage: HelpfulByPage[] = [...helpful.byPage].sort(
        (a, b) => (b.yes + b.no) - (a.yes + a.no),
    )
    const maxGap = contentGaps.reduce((m, g) => Math.max(m, g.count), 0)

    return (
        <PageContainer gutter="shell" className="py-8 animate-in fade-in duration-500">
            <Header days={days} setDays={setDays} isFetching={isFetching} />

            {/* KPI Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                {kpis.map(kpi => {
                    const Icon = kpi.icon
                    return (
                        <div key={kpi.key} className={cn(
                            "relative overflow-hidden border border-glass-border rounded-xl p-5 bg-canvas-elevated",
                            "hover:shadow-lg transition-all duration-200",
                        )}>
                            <div className={cn("absolute inset-0 bg-gradient-to-br", kpi.gradient)} />
                            <div className="relative">
                                <div className={cn("w-9 h-9 rounded-lg border flex items-center justify-center mb-3", kpi.iconBg)}>
                                    <Icon className="w-4.5 h-4.5" />
                                </div>
                                <p className={cn("text-2xl font-bold", kpi.accent)}>{kpi.value}</p>
                                <p className="text-xs text-ink-muted mt-1">{kpi.label}</p>
                                <p className="text-[11px] text-ink-muted/80 mt-0.5">{kpi.sub}</p>
                            </div>
                        </div>
                    )
                })}
            </div>

            {/* Headline: content gaps — the primary insight. */}
            <section className="mb-8">
                <div className="flex items-center gap-2 mb-3">
                    <Search className="w-4 h-4 text-amber-500" />
                    <h2 className="text-sm font-bold text-ink">Content gaps — searches that found nothing</h2>
                </div>
                <div className="border border-amber-500/20 rounded-xl bg-gradient-to-br from-amber-500/[0.06] to-transparent overflow-hidden">
                    {contentGaps.length === 0 ? (
                        <div className="px-5 py-10 text-center">
                            <p className="text-sm text-ink-muted">No content gaps in this window — nice.</p>
                        </div>
                    ) : (
                        <ul>
                            {contentGaps.map((gap, i) => (
                                <li
                                    key={gap.query}
                                    className={cn(
                                        "flex items-center gap-4 px-5 py-3 border-b last:border-b-0 border-amber-500/10",
                                        i % 2 === 0 && "bg-black/[0.01] dark:bg-white/[0.01]",
                                    )}
                                >
                                    <span className="w-5 shrink-0 text-xs font-bold text-amber-500/70 tabular-nums">{i + 1}</span>
                                    <span className="flex-1 min-w-0 text-sm font-medium text-ink truncate" title={gap.query}>
                                        {gap.query}
                                    </span>
                                    {/* Volume bar — relative to the top gap. */}
                                    <span className="hidden sm:block w-32 h-1.5 rounded-full bg-amber-500/10 overflow-hidden" aria-hidden="true">
                                        <span
                                            className="block h-full rounded-full bg-amber-500/60"
                                            style={{ width: `${maxGap > 0 ? (gap.count / maxGap) * 100 : 0}%` }}
                                        />
                                    </span>
                                    <span className="w-16 shrink-0 text-right text-sm font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                                        {compactNum(gap.count)}
                                        <span className="text-[10px] font-medium text-ink-muted ml-1">hits</span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </section>

            {/* Tour funnel — completion rate and where users bail. */}
            <section className="mb-8">
                <div className="flex items-center gap-2 mb-3">
                    <Compass className="w-4 h-4 text-violet-500" />
                    <h2 className="text-sm font-bold text-ink">Tour funnel — completion &amp; drop-off</h2>
                </div>
                <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden shadow-sm">
                    {funnel.length === 0 ? (
                        <div className="px-5 py-10 text-center">
                            <p className="text-sm text-ink-muted">No tour activity in this window yet.</p>
                        </div>
                    ) : (
                        <ul>
                            {funnel.map((t) => {
                                const rate = t.completionRate == null ? null : Math.round(t.completionRate * 100)
                                const topDrop = t.dropoff.length
                                    ? t.dropoff.reduce((a, b) => (b.count > a.count ? b : a))
                                    : null
                                return (
                                    <li key={t.tourId} className="px-5 py-3.5 border-b last:border-b-0 border-glass-border">
                                        <div className="flex items-center gap-4">
                                            <span className="flex-1 min-w-0 text-sm font-semibold text-ink truncate">{t.tourId}</span>
                                            <span className="text-xs text-ink-muted tabular-nums">{compactNum(t.starts)} starts</span>
                                            <span className="w-14 text-right text-sm font-bold tabular-nums text-violet-600 dark:text-violet-400">
                                                {rate === null ? '—' : `${rate}%`}
                                            </span>
                                        </div>
                                        <div className="mt-2 h-1.5 rounded-full bg-violet-500/10 overflow-hidden" aria-hidden="true">
                                            <div className="h-full rounded-full bg-violet-500/60" style={{ width: `${rate ?? 0}%` }} />
                                        </div>
                                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-muted">
                                            <span>{compactNum(t.completed)} completed · {compactNum(t.skipped)} skipped</span>
                                            {topDrop && (
                                                <span className="text-amber-600 dark:text-amber-400">
                                                    Most drop-off at step {topDrop.step + 1} ({compactNum(topDrop.count)})
                                                </span>
                                            )}
                                        </div>
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                </div>
            </section>

            {/* Helpful by page. */}
            <section>
                <div className="flex items-center gap-2 mb-3">
                    <ThumbsUp className="w-4 h-4 text-emerald-500" />
                    <h2 className="text-sm font-bold text-ink">Helpful by page</h2>
                </div>
                <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden shadow-sm">
                    {byPage.length === 0 ? (
                        <div className="px-5 py-10 text-center">
                            <p className="text-sm text-ink-muted">No page feedback in this window yet.</p>
                        </div>
                    ) : (
                        <table className="w-full">
                            <thead className="bg-black/5 dark:bg-white/5">
                                <tr className="border-b border-glass-border">
                                    <th className="text-left text-xs font-semibold text-ink-muted uppercase tracking-wider px-5 py-3">Page</th>
                                    <th className="text-right text-xs font-semibold text-ink-muted uppercase tracking-wider px-5 py-3">👍</th>
                                    <th className="text-right text-xs font-semibold text-ink-muted uppercase tracking-wider px-5 py-3">👎</th>
                                </tr>
                            </thead>
                            <tbody>
                                {byPage.map((row, i) => {
                                    const { to, label } = pageLink(row.page)
                                    return (
                                        <tr
                                            key={row.page}
                                            className={cn(
                                                "border-b last:border-b-0 border-glass-border",
                                                i % 2 === 0 && "bg-black/[0.01] dark:bg-white/[0.01]",
                                            )}
                                        >
                                            <td className="px-5 py-3">
                                                {to ? (
                                                    <Link
                                                        to={to}
                                                        className="text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:underline underline-offset-2"
                                                    >
                                                        {label}
                                                    </Link>
                                                ) : (
                                                    <span className="text-sm font-semibold text-ink">{label}</span>
                                                )}
                                            </td>
                                            <td className="px-5 py-3 text-right text-sm font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{row.yes}</td>
                                            <td className="px-5 py-3 text-right text-sm font-bold text-rose-500 tabular-nums">{row.no}</td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            </section>
        </PageContainer>
    )
}

// ── Header ───────────────────────────────────────────────────────────

interface HeaderProps {
    days: number
    setDays: (d: number) => void
    isFetching: boolean
}

function Header({ days, setDays, isFetching }: HeaderProps) {
    return (
        <div className="flex items-start justify-between mb-10 gap-4">
            <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                    <BarChart3 className="w-6 h-6 text-white" />
                </div>
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-ink flex items-center gap-2">
                        Telemetry
                        {isFetching && (
                            <span className="inline-block w-3.5 h-3.5 border-2 border-indigo-500/40 border-t-indigo-500 rounded-full animate-spin" aria-label="Refreshing" />
                        )}
                    </h1>
                    <p className="text-sm text-ink-muted mt-1">
                        Product-usage signals: feedback, content gaps, and tour engagement.
                    </p>
                </div>
            </div>

            {/* Day-window selector */}
            <div
                role="group"
                aria-label="Time window"
                className="flex items-center gap-1 p-1 rounded-xl border border-glass-border bg-canvas-elevated"
            >
                {DAY_WINDOWS.map(w => (
                    <button
                        key={w}
                        onClick={() => setDays(w)}
                        aria-pressed={days === w}
                        className={cn(
                            "px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50",
                            days === w
                                ? "bg-indigo-500 text-white shadow-sm"
                                : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5",
                        )}
                    >
                        {w}d
                    </button>
                ))}
            </div>
        </div>
    )
}

// ── Loading skeleton (mirrors AdminOverview) ─────────────────────────

function TelemetrySkeleton() {
    return (
        <PageContainer gutter="shell" className="py-8 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex items-center justify-between mb-10">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-black/5 dark:bg-white/10 animate-pulse" />
                    <div className="space-y-2">
                        <div className="h-8 w-40 rounded-lg bg-black/5 dark:bg-white/10 animate-pulse" />
                        <div className="h-4 w-72 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                    </div>
                </div>
                <div className="h-9 w-40 rounded-xl bg-black/5 dark:bg-white/10 animate-pulse" />
            </div>

            {/* KPI cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                {[1, 2, 3, 4].map(i => (
                    <div key={i} className="border border-glass-border rounded-xl p-5 bg-canvas-elevated">
                        <div className="w-9 h-9 rounded-lg bg-black/5 dark:bg-white/10 animate-pulse mb-3" />
                        <div className="h-7 w-16 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                        <div className="h-3 w-20 rounded bg-black/5 dark:bg-white/10 animate-pulse mt-2" />
                    </div>
                ))}
            </div>

            {/* Headline list */}
            <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden shadow-sm mb-8">
                <div className="px-5 py-3 border-b border-glass-border bg-black/5 dark:bg-white/5">
                    <div className="h-4 w-64 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                </div>
                {[1, 2, 3, 4].map(i => (
                    <div key={i} className="flex items-center justify-between px-5 py-3 border-b last:border-b-0 border-glass-border">
                        <div className="h-4 w-56 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                        <div className="h-4 w-10 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                    </div>
                ))}
            </div>

            {/* Table */}
            <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden shadow-sm">
                <div className="px-5 py-3 border-b border-glass-border bg-black/5 dark:bg-white/5">
                    <div className="h-4 w-32 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                </div>
                {[1, 2, 3].map(i => (
                    <div key={i} className="flex items-center justify-between px-5 py-3 border-b last:border-b-0 border-glass-border">
                        <div className="h-4 w-40 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                        <div className="flex items-center gap-8">
                            <div className="h-4 w-8 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                            <div className="h-4 w-8 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                        </div>
                    </div>
                ))}
            </div>
        </PageContainer>
    )
}
