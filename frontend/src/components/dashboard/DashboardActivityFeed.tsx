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
 * RENDER CONTRACT — this section appears once and never un-appears.
 *
 * The first version rendered the section (header + skeleton) while `isLoading`,
 * then returned null once the request resolved empty. A failed request leaves
 * `data` undefined, which reads as "empty" — so ANY error made the whole section
 * flash in and vanish. That is exactly how a hard 404 on /views/me/feed hid as
 * "it randomly disappears" instead of surfacing as a broken endpoint.
 *
 * So: while loading we render NOTHING (a section that can still vanish must not
 * occupy layout yet), on error we render a quiet, honest failure with a retry —
 * never silence — and only a confirmed-empty feed collapses to nothing.
 */
import { Link } from 'react-router-dom'
import { Users, ArrowRight, RefreshCw, AlertCircle } from 'lucide-react'
import { useMyActivityFeed } from '@/hooks/useViewActivity'
import { ActivityFeedList } from '@/components/views/ActivityFeedList'

function SectionHeader() {
    return (
        <div className="flex items-center gap-2.5 mb-4">
            <div className="w-9 h-9 rounded-xl border border-glass-border bg-black/5 dark:bg-white/5 flex items-center justify-center">
                <Users className="w-4 h-4 text-ink-muted" />
            </div>
            <div className="flex items-baseline gap-2 flex-1 min-w-0">
                <h2 className="text-ink text-sm font-bold">Activity in your workspaces</h2>
                <span className="text-ink-muted text-xs">What your team has been working on</span>
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

export function DashboardActivityFeed() {
    const { data, isLoading, isError, refetch, isFetching } = useMyActivityFeed(12)

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

    const entries = data ?? []

    // Genuinely empty (a fresh instance, or nothing this user can see) — no box.
    if (entries.length === 0) return null

    return (
        <section className="px-4 md:px-0 mb-14">
            <SectionHeader />
            <div className="rounded-2xl border border-glass-border bg-canvas-elevated px-4 py-2">
                <ActivityFeedList
                    entries={entries}
                    emptyText="No activity in your workspaces yet."
                />
            </div>
        </section>
    )
}
