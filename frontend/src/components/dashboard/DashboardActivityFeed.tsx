/**
 * DashboardActivityFeed — "Activity in your workspaces".
 *
 * The question the dashboard never answered: what have my colleagues been doing?
 * Framed around PEOPLE and the business areas the user belongs to, not system
 * events — "Priya renamed Q3 Hierarchy", "Sam published new data to Orders".
 *
 * Backed by view_activity_log via /views/me/feed, which is access-scoped
 * server-side, so it shows activity only for views in the workspaces this user
 * is actually part of. It covers both channels: what people CHANGED (renames,
 * sharing, visibility) and when the underlying DATA was refreshed.
 *
 * ── Layout ─────────────────────────────────────────────────────────────────
 *
 * The feed used to be one full-bleed column, so on a wide screen each row was a
 * ~1700px rule with six words hugging the left edge and a timestamp marooned at
 * the right. Activity reads as a column, not a table: the timeline now takes a
 * readable two-thirds, and the reclaimed third carries a digest of the SAME
 * window — so the space does work instead of being empty.
 *
 * The digest is computed from the entries actually loaded and says so. It is not
 * a "this week" summary, because we did not load a week; claiming otherwise would
 * be the same class of lie as the fake "Jump Back In" list this page used to ship.
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
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Users, ArrowRight, RefreshCw, AlertCircle, Pencil, Database } from 'lucide-react'
import { useMyActivityFeed } from '@/hooks/useViewActivity'
import { ActivityFeedList } from '@/components/views/ActivityFeedList'
import { timeAgo } from '@/lib/timeAgo'
import type { ViewActivityEntry } from '@/services/viewApiService'

/** How many events to load. Also the window the digest describes. */
const FEED_LIMIT = 24

/** Data-channel actions — everything else is a person changing something. */
const DATA_ACTIONS = new Set(['data_changed'])

interface Digest {
    dataUpdates: number
    peopleChanges: number
    /** Views touched most in this window, busiest first. */
    busiest: { viewId: string; viewName: string; count: number }[]
    /** Oldest event in the window — bounds what the digest can honestly claim. */
    oldestAt: string | null
}

function buildDigest(entries: ViewActivityEntry[]): Digest {
    const byView = new Map<string, { viewId: string; viewName: string; count: number }>()
    let dataUpdates = 0
    let peopleChanges = 0

    for (const e of entries) {
        if (DATA_ACTIONS.has(e.action)) dataUpdates += 1
        else peopleChanges += 1

        if (!e.viewName) continue
        const seen = byView.get(e.viewId)
        if (seen) seen.count += 1
        else byView.set(e.viewId, { viewId: e.viewId, viewName: e.viewName, count: 1 })
    }

    return {
        dataUpdates,
        peopleChanges,
        busiest: [...byView.values()].sort((a, b) => b.count - a.count).slice(0, 3),
        // Entries arrive newest-first.
        oldestAt: entries.length > 0 ? entries[entries.length - 1].createdAt : null,
    }
}

function SectionHeader() {
    return (
        <div className="flex items-center gap-2.5 mb-4">
            <div className="w-9 h-9 rounded-xl border border-glass-border bg-black/5 dark:bg-white/5 flex items-center justify-center">
                <Users className="w-4 h-4 text-ink-muted" />
            </div>
            <div className="flex items-baseline gap-2 flex-1 min-w-0">
                <h2 className="text-ink text-sm font-bold">Activity in your workspaces</h2>
                <span className="text-ink-muted text-xs hidden sm:inline">What your team has been working on</span>
            </div>
            <Link
                to="/explorer?sort=recently-modified"
                className="group inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink transition-colors shrink-0"
            >
                See recently updated
                <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
        </div>
    )
}

function DigestCard({ digest }: { digest: Digest }) {
    const { dataUpdates, peopleChanges, busiest, oldestAt } = digest

    return (
        <aside className="rounded-2xl border border-glass-border bg-canvas-elevated p-5 flex flex-col gap-5 h-fit">
            <div>
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-ink-muted/70 mb-3">
                    In this activity
                </h3>

                <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] p-3">
                        <Pencil className="w-3.5 h-3.5 text-violet-500 mb-2" />
                        <div className="text-2xl font-black tracking-tight text-ink leading-none">
                            {peopleChanges}
                        </div>
                        <div className="text-[11px] text-ink-muted mt-1 leading-tight">
                            {peopleChanges === 1 ? 'change by a person' : 'changes by people'}
                        </div>
                    </div>

                    <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] p-3">
                        <Database className="w-3.5 h-3.5 text-blue-500 mb-2" />
                        <div className="text-2xl font-black tracking-tight text-ink leading-none">
                            {dataUpdates}
                        </div>
                        <div className="text-[11px] text-ink-muted mt-1 leading-tight">
                            {dataUpdates === 1 ? 'data update' : 'data updates'}
                        </div>
                    </div>
                </div>
            </div>

            {busiest.length > 0 && (
                <div>
                    <h3 className="text-[10px] font-bold uppercase tracking-wider text-ink-muted/70 mb-2.5">
                        Most active
                    </h3>
                    <ul className="space-y-1">
                        {busiest.map(v => (
                            <li key={v.viewId}>
                                <Link
                                    to={`/views/${v.viewId}`}
                                    className="group flex items-center gap-2 rounded-lg px-2 py-1.5 -mx-2 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
                                >
                                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink group-hover:text-accent-lineage transition-colors">
                                        {v.viewName}
                                    </span>
                                    <span className="shrink-0 text-[10px] font-bold text-ink-muted tabular-nums">
                                        {v.count}
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* Say exactly what the numbers above cover. They describe the events
                on screen — not a week, not "all time". */}
            {oldestAt && (
                <p className="text-[10px] text-ink-muted/60 leading-relaxed border-t border-glass-border pt-3">
                    Covers the latest {peopleChanges + dataUpdates} events, back to {timeAgo(oldestAt)}.
                </p>
            )}
        </aside>
    )
}

export function DashboardActivityFeed() {
    const { data, isLoading, isError, refetch, isFetching } = useMyActivityFeed(FEED_LIMIT)

    const entries = useMemo(() => data ?? [], [data])
    const digest = useMemo(() => buildDigest(entries), [entries])

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
                        <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
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
            <SectionHeader />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
                <div className="lg:col-span-2 rounded-2xl border border-glass-border bg-canvas-elevated px-5 py-2 max-h-[26rem] overflow-y-auto custom-scrollbar">
                    <ActivityFeedList
                        entries={entries}
                        emptyText="No activity in your workspaces yet."
                    />
                </div>

                <DigestCard digest={digest} />
            </div>
        </section>
    )
}
