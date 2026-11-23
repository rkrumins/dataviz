/**
 * WorkspaceActivityFeed — "recent activity across all views" for the workspace
 * governance tab. Scoped by workspace_id; presentation comes from the shared
 * ActivityFeedList so it stays identical to the dashboard's feed.
 *
 * With a `limit` (the Overview's card) it shows only the latest few, and says how
 * many more there are, so the card never grows with every change made.
 */
import { ArrowRight } from 'lucide-react'
import { useWorkspaceViewActivity } from '@/hooks/useViewActivity'
import { ActivityFeedList } from '@/components/views/ActivityFeedList'

export function WorkspaceActivityFeed({ workspaceId, limit, onSeeAll }: {
    workspaceId: string
    /** Show at most this many, the latest. */
    limit?: number
    /** Where the rest are: shown under a list cut at `limit`. */
    onSeeAll?: () => void
}) {
    const { data, isLoading } = useWorkspaceViewActivity(workspaceId)
    const entries = data ?? []
    const shown = limit !== undefined ? entries.slice(0, limit) : entries
    const more = entries.length - shown.length

    return (
        <>
            <ActivityFeedList
                entries={shown}
                isLoading={isLoading}
                emptyText="No recent activity across this workspace’s views."
            />
            {more > 0 && onSeeAll && (
                <button type="button" onClick={onSeeAll}
                    className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-xl border border-glass-border px-3 py-2 text-xs font-semibold text-ink-secondary transition-colors hover:bg-black/[0.03] hover:text-ink dark:hover:bg-white/[0.04]">
                    {more === 1 ? 'See 1 more change' : `See ${more} more changes`}
                    <ArrowRight className="w-3.5 h-3.5 shrink-0" aria-hidden />
                </button>
            )}
        </>
    )
}
