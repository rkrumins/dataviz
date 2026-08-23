/**
 * Order a loaded page of views by how much they are opened.
 *
 * NOT SERVER-SORTED, and it cannot be. Opens live in the product-event log and
 * views live in the catalogue; this repo bans cross-domain JOINs, so there is
 * no `ORDER BY opens` for the list endpoint to run. The ranking is applied
 * here from the usage the page has already fetched for its cards — the same
 * shape as `likes-asc`, `type-az` and `owner-az`, which are also finished on
 * the client after the server returns.
 *
 * WHAT THAT MEANS IN PRACTICE: this ranks what is LOADED. With infinite scroll
 * the ordering re-applies as more arrives, so it converges as you scroll, and
 * for a catalogue smaller than one usage batch it is simply correct. A
 * catalogue large enough for that to mislead wants a server-side ranking
 * endpoint instead, which is a different piece of work.
 *
 * Views with no usage yet sort last rather than as zero: absent is "we have
 * not been told", and putting an unknown above a genuine zero would be a
 * ranking built on a loading state.
 */
import { useMemo } from 'react'

import type { View } from '@/services/viewApiService'
import type { ViewUsage } from '@/services/contentInsightsService'
import type { SortOption } from '@/hooks/useExplorerViews'

export function useOpensOrdering(
    views: View[],
    usage: Record<string, ViewUsage> | undefined,
    sort: SortOption,
): View[] {
    return useMemo(() => {
        if (sort !== 'most-opened') return views
        return [...views].sort((a, b) => {
            const ua = usage?.[a.id]
            const ub = usage?.[b.id]
            if (!ua && !ub) return a.name.localeCompare(b.name)
            if (!ua) return 1
            if (!ub) return -1
            // People break an opens tie: between two views opened the same
            // number of times, the one more people reached for is the more
            // useful answer to "what does this team actually use".
            return ub.opens - ua.opens
                || ub.uniqueViewers - ua.uniqueViewers
                || a.name.localeCompare(b.name)
        })
    }, [views, usage, sort])
}
