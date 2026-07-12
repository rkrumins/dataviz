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
 */
import { Link } from 'react-router-dom'
import { Users, ArrowRight } from 'lucide-react'
import { useMyActivityFeed } from '@/hooks/useViewActivity'
import { ActivityFeedList } from '@/components/views/ActivityFeedList'

export function DashboardActivityFeed() {
    const { data, isLoading } = useMyActivityFeed(12)

    // Nothing has happened yet — don't show an empty box on a fresh instance.
    if (!isLoading && (data ?? []).length === 0) return null

    return (
        <section className="px-4 md:px-0 mb-14">
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

            <div className="rounded-2xl border border-glass-border bg-canvas-elevated px-4 py-2">
                <ActivityFeedList
                    entries={data ?? []}
                    isLoading={isLoading}
                    emptyText="No activity in your workspaces yet."
                    skeletonRows={5}
                />
            </div>
        </section>
    )
}
