/**
 * WorkspaceActivityFeed — "recent activity across all views" for the workspace
 * governance tab. Scoped by workspace_id; presentation comes from the shared
 * ActivityFeedList so it stays identical to the dashboard's feed.
 *
 * With a `limit` (the Overview's card) it opens on only the latest few, so the card never grows
 * by itself with every change made; the reader expands it in place, a few more at a time, and
 * folds it back. Either way, once everything loaded is showing, older changes are fetched a page
 * at a time, for as far back as the workspace goes.
 */
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { useWorkspaceViewActivityPages, WORKSPACE_ACTIVITY_PAGE } from '@/hooks/useViewActivity'
import { ActivityFeedList } from '@/components/views/ActivityFeedList'
import { cn } from '@/lib/utils'
import type { ViewActivityEntry } from '@/services/viewApiService'

/** How many more the Overview's card shows per click. */
const STEP = 10

const MORE_BUTTON = 'flex w-full items-center justify-center gap-1.5 rounded-xl border border-glass-border px-3 py-2 text-xs font-semibold text-ink-secondary transition-colors hover:bg-black/[0.03] hover:text-ink disabled:opacity-60 disabled:cursor-wait dark:hover:bg-white/[0.04]'

export function WorkspaceActivityFeed({ workspaceId, limit }: {
    workspaceId: string
    /** Open on only this many, the latest; the reader shows more from there. */
    limit?: number
}) {
    const q = useWorkspaceViewActivityPages(workspaceId)
    // Pages are fetched by offset, so a change made between two fetches can arrive twice.
    const entries = useMemo(() => {
        const seen = new Set<string>()
        return (q.data?.pages.flat() ?? []).filter((e: ViewActivityEntry) => !seen.has(e.id) && !!seen.add(e.id))
    }, [q.data])

    const step = limit !== undefined ? STEP : WORKSPACE_ACTIVITY_PAGE
    const [count, setCount] = useState(limit ?? WORKSPACE_ACTIVITY_PAGE)
    const shown = entries.slice(0, count)
    const hidden = entries.length - shown.length
    const canFetch = !!q.hasNextPage
    const fetching = q.isFetchingNextPage

    const showMore = () => {
        // Past what is loaded: fetch the next page; the list grows when it arrives.
        if (count + step > entries.length && canFetch && !fetching) void q.fetchNextPage()
        setCount(count + step)
    }
    const label = hidden >= step ? `Show ${step} more`
        : hidden > 0 && !canFetch ? `Show ${hidden} more`
        : 'Show older changes'

    return (
        <>
            <ActivityFeedList
                entries={shown}
                isLoading={q.isLoading}
                emptyText="No recent activity across this workspace’s views."
            />
            {(hidden > 0 || canFetch || (limit !== undefined && count > limit)) && (
                <div className="mt-1 flex items-center gap-2">
                    {(hidden > 0 || canFetch) && (
                        <button type="button" onClick={showMore} disabled={fetching} aria-busy={fetching || undefined}
                            className={MORE_BUTTON}>
                            {fetching
                                ? <><Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" aria-hidden /> Loading older changes…</>
                                : <>{label} <ChevronDown className="w-3.5 h-3.5 shrink-0" aria-hidden /></>}
                        </button>
                    )}
                    {limit !== undefined && count > limit && (
                        <button type="button" onClick={() => setCount(limit)}
                            className={cn(MORE_BUTTON, (hidden > 0 || canFetch) && 'w-auto shrink-0')}>
                            Show less <ChevronUp className="w-3.5 h-3.5 shrink-0" aria-hidden />
                        </button>
                    )}
                </div>
            )}
        </>
    )
}
