/**
 * DashboardActivityFeed — "Activity in your workspaces".
 *
 * The question the dashboard never answered: what have my colleagues been doing?
 * Framed around PEOPLE and the business areas the user belongs to, not system
 * events — "Priya renamed Q3 Hierarchy", "Sam published new data to Orders".
 *
 * Backed by view_activity_log via /views/me/feed, which is access-scoped
 * server-side, so it shows activity only for views in the workspaces this user
 * is actually part of. It covers two channels, and the filter makes that
 * explicit: what PEOPLE changed (renames, sharing, visibility) and when the
 * DATA behind a view was refreshed. Those are different questions — "who edited
 * this?" and "is this current?" — and users arrive with one or the other.
 *
 * ── Layout ─────────────────────────────────────────────────────────────────
 *
 * The feed used to be one full-bleed column, so on a wide screen each row was a
 * ~1700px rule with six words hugging the left edge and a timestamp marooned at
 * the right. Activity reads as a column, not a table: the timeline takes a
 * readable two-thirds, and the reclaimed third summarises the SAME window.
 *
 * ── Saying what the numbers mean ───────────────────────────────────────────
 *
 * The summary was headed "In this activity", which means nothing. It now states
 * its own scope in a sentence — "the 24 most recent events, back to 8h ago" —
 * because these counts describe the window we LOADED, not all time and not a
 * week. Labelling them "this week" would be the same class of lie as the fake
 * "Jump Back In" list this page used to ship.
 *
 * ── Render contract: this section appears once and never un-appears ─────────
 *
 * The first version rendered header + skeleton while `isLoading`, then returned
 * null once the request resolved empty. A failed request leaves `data` undefined,
 * which reads as "empty" — so ANY error made the section flash in and vanish.
 * That is how a hard 404 on /views/me/feed hid as "it randomly disappears"
 * instead of surfacing as a broken endpoint. So: while loading we occupy no
 * layout, on error we render a quiet failure with a retry — never silence — and
 * only a confirmed-empty feed collapses to nothing.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Users, ArrowRight, RefreshCw, AlertCircle, Pencil, Database } from 'lucide-react'
import { useMyActivityFeed, MY_FEED_LIMIT } from '@/hooks/useViewActivity'
import { ActivityFeedList } from '@/components/views/ActivityFeedList'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import type { ViewActivityEntry } from '@/services/viewApiService'

/** The data channel. Everything else is a person changing something. */
const DATA_ACTIONS = new Set(['data_changed'])

const isDataEvent = (e: ViewActivityEntry) => DATA_ACTIONS.has(e.action)

type Channel = 'all' | 'people' | 'data'

interface Summary {
    total: number
    dataUpdates: number
    peopleChanges: number
    /** Views touched most in this window, busiest first. */
    busiest: { viewId: string; viewName: string; count: number }[]
    /** Oldest event loaded — bounds what the summary can honestly claim. */
    oldestAt: string | null
}

function summarise(entries: ViewActivityEntry[]): Summary {
    const byView = new Map<string, { viewId: string; viewName: string; count: number }>()
    let dataUpdates = 0
    let peopleChanges = 0

    for (const e of entries) {
        if (isDataEvent(e)) dataUpdates += 1
        else peopleChanges += 1

        if (!e.viewName) continue
        const seen = byView.get(e.viewId)
        if (seen) seen.count += 1
        else byView.set(e.viewId, { viewId: e.viewId, viewName: e.viewName, count: 1 })
    }

    return {
        total: entries.length,
        dataUpdates,
        peopleChanges,
        busiest: [...byView.values()].sort((a, b) => b.count - a.count).slice(0, 4),
        // Entries arrive newest-first.
        oldestAt: entries.length > 0 ? entries[entries.length - 1].createdAt : null,
    }
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function ChannelFilter({ value, onChange, summary }: {
    value: Channel
    onChange: (c: Channel) => void
    summary: Summary
}) {
    const tabs: { id: Channel; label: string; count: number }[] = [
        { id: 'all', label: 'Everything', count: summary.total },
        { id: 'people', label: 'People', count: summary.peopleChanges },
        { id: 'data', label: 'Data', count: summary.dataUpdates },
    ]

    return (
        <div className="flex items-center gap-0.5 p-0.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border">
            {tabs.map(tab => {
                const active = tab.id === value
                return (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => onChange(tab.id)}
                        disabled={tab.count === 0}
                        className={cn(
                            'relative px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                            active ? 'text-ink' : 'text-ink-muted hover:text-ink',
                        )}
                    >
                        {active && (
                            <motion.span
                                layoutId="activity-channel-pill"
                                className="absolute inset-0 rounded-lg bg-canvas-elevated shadow-sm border border-glass-border"
                                transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                            />
                        )}
                        <span className="relative flex items-center gap-1.5">
                            {tab.label}
                            <span className="tabular-nums opacity-60">{tab.count}</span>
                        </span>
                    </button>
                )
            })}
        </div>
    )
}

function StatTile({ icon: Icon, value, label, accent }: {
    icon: React.ElementType
    value: number
    label: string
    accent: 'violet' | 'blue'
}) {
    const theme = accent === 'violet'
        ? 'from-violet-500/10 to-violet-500/[0.02] border-violet-500/20 text-violet-500'
        : 'from-blue-500/10 to-blue-500/[0.02] border-blue-500/20 text-blue-500'

    return (
        <div className={cn('rounded-xl border bg-gradient-to-br p-3.5', theme)}>
            <Icon className="w-4 h-4 mb-2.5" />
            <div className="text-2xl font-black tracking-tight text-ink leading-none">{value}</div>
            <div className="text-[11px] text-ink-muted mt-1 leading-tight">{label}</div>
        </div>
    )
}

function SummaryCard({ summary }: { summary: Summary }) {
    const { total, dataUpdates, peopleChanges, busiest, oldestAt } = summary
    const busiestMax = busiest[0]?.count ?? 1

    return (
        <aside className="rounded-2xl border border-glass-border bg-canvas-elevated p-5 flex flex-col gap-5 h-fit">
            <div>
                <h3 className="text-sm font-bold text-ink">What's been happening</h3>
                {/* Say the scope in words. These counts describe the events we
                    loaded — not all time, and not "this week". */}
                <p className="text-[11px] text-ink-muted mt-1 leading-relaxed">
                    The {total} most recent {total === 1 ? 'event' : 'events'}
                    {oldestAt && <>, back to {timeAgo(oldestAt)}</>}.
                </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <StatTile
                    icon={Pencil}
                    accent="violet"
                    value={peopleChanges}
                    label={peopleChanges === 1 ? 'change by a person' : 'changes by people'}
                />
                <StatTile
                    icon={Database}
                    accent="blue"
                    value={dataUpdates}
                    label={dataUpdates === 1 ? 'data refresh' : 'data refreshes'}
                />
            </div>

            {busiest.length > 0 && (
                <div>
                    <h4 className="text-[11px] font-bold text-ink mb-2.5">Busiest views</h4>
                    <ul className="space-y-1.5">
                        {busiest.map(v => (
                            <li key={v.viewId}>
                                <Link
                                    to={`/views/${v.viewId}`}
                                    className="group block rounded-lg px-2 py-1.5 -mx-2 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
                                >
                                    <span className="flex items-center gap-2">
                                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink group-hover:text-accent-lineage transition-colors">
                                            {v.viewName}
                                        </span>
                                        <span className="shrink-0 text-[10px] font-bold text-ink-muted tabular-nums">
                                            {v.count}
                                        </span>
                                    </span>
                                    {/* Relative weight — makes "busiest" legible at a glance. */}
                                    <span className="mt-1.5 block h-1 rounded-full bg-black/5 dark:bg-white/10 overflow-hidden">
                                        <span
                                            className="block h-full rounded-full bg-gradient-to-r from-accent-lineage to-violet-500"
                                            style={{ width: `${Math.round((v.count / busiestMax) * 100)}%` }}
                                        />
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </aside>
    )
}

function SectionHeader({ children }: { children?: React.ReactNode }) {
    return (
        <div className="flex items-center gap-3 mb-4 flex-wrap">
            <div className="w-9 h-9 rounded-xl border border-glass-border bg-black/5 dark:bg-white/5 flex items-center justify-center shrink-0">
                <Users className="w-4 h-4 text-ink-muted" />
            </div>
            <div className="flex items-baseline gap-2 min-w-0">
                <h2 className="text-ink text-sm font-bold whitespace-nowrap">Activity in your workspaces</h2>
                <span className="text-ink-muted text-xs hidden lg:inline">What your team has been working on</span>
            </div>

            <div className="flex items-center gap-3 ml-auto">
                {children}
                <Link
                    to="/explorer?sort=recently-modified"
                    className="group inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink transition-colors shrink-0"
                >
                    <span className="hidden sm:inline">See recently updated</span>
                    <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                </Link>
            </div>
        </div>
    )
}

// ── Section ────────────────────────────────────────────────────────────────

export function DashboardActivityFeed() {
    const { data, isLoading, isError, refetch, isFetching } = useMyActivityFeed(MY_FEED_LIMIT)
    const [channel, setChannel] = useState<Channel>('all')

    const entries = useMemo(() => data ?? [], [data])
    const summary = useMemo(() => summarise(entries), [entries])

    const visible = useMemo(() => {
        if (channel === 'data') return entries.filter(isDataEvent)
        if (channel === 'people') return entries.filter(e => !isDataEvent(e))
        return entries
    }, [entries, channel])

    // Loading: occupy no layout. Rendering a skeleton here is what produced the
    // appear-then-disappear flash, because the section can still resolve to
    // nothing. It fades in when it has something to say.
    if (isLoading) return null

    // Error: say so. Silently hiding a broken feed is how the 404 stayed hidden.
    if (isError) {
        return (
            <section className="px-4 md:px-0 mb-14">
                <SectionHeader />
                <div className="rounded-2xl border border-glass-border bg-canvas-elevated px-4 py-6 flex items-center justify-center gap-3">
                    <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                    <p className="text-xs text-ink-muted">Couldn't load your team's activity.</p>
                    <button
                        type="button"
                        onClick={() => refetch()}
                        disabled={isFetching}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink hover:text-accent-lineage transition-colors disabled:opacity-50"
                    >
                        <RefreshCw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} />
                        Retry
                    </button>
                </div>
            </section>
        )
    }

    // Genuinely empty (a fresh instance, or nothing this user can see) — no box.
    if (entries.length === 0) return null

    return (
        <section className="px-4 md:px-0 mb-14">
            <SectionHeader>
                <ChannelFilter value={channel} onChange={setChannel} summary={summary} />
            </SectionHeader>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
                <div className="lg:col-span-2 rounded-2xl border border-glass-border bg-canvas-elevated px-5 py-2 max-h-[27rem] overflow-y-auto custom-scrollbar">
                    <ActivityFeedList
                        entries={visible}
                        emptyText={
                            channel === 'data'
                                ? 'No data refreshes in this window.'
                                : 'No changes by people in this window.'
                        }
                    />
                </div>

                <SummaryCard summary={summary} />
            </div>
        </section>
    )
}
