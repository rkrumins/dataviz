/**
 * What a view is made from, as the Explorer says it: a query (a view whose members are kept up
 * to date, or kept as a snapshot) or a search inside another view (a subset).
 *
 * Read from the view's own config, which the list carries, so a card asks the server nothing and
 * carries no count. Only the preview of the one view it shows reads how that view stands now —
 * its members, layer by layer, and the name of the view it is a subset of — on the keys the view's
 * own header chips read, so opening the view after its preview asks again for nothing.
 */
import { useQuery } from '@tanstack/react-query'

import { MEMBERSHIP_QUERY_KEY, getMembershipStatus } from '@/services/liveViewsApi'
import { SEARCH_VIEW_QUERY_KEY, getSearchStatus } from '@/services/searchViewsApi'
import type { View } from '@/services/viewApiService'
import { useFeature } from '@/store/features'
import type { MembershipStatus } from '@/types/membership'
import { isSubsetConfig, type SearchViewStatus } from '@/types/searchView'

export type MadeFrom =
  | { kind: 'query'; mode: 'live' | 'snapshot' }
  | { kind: 'subset' }

export function madeFromOf(config: Record<string, unknown> | null | undefined): MadeFrom | null {
  const membership = config?.membership as { mode?: unknown } | null | undefined
  if (membership && typeof membership === 'object') {
    return { kind: 'query', mode: membership.mode === 'snapshot' ? 'snapshot' : 'live' }
  }
  return isSubsetConfig(config) ? { kind: 'subset' } : null
}

/** The badge's word, and what it means. */
export function madeFromWords(madeFrom: MadeFrom): { label: string; tip: string; detail: string } {
  if (madeFrom.kind === 'subset') {
    return {
      label: 'Subset',
      tip: 'A subset of another view',
      detail: 'It shows the matches of a search inside another view.',
    }
  }
  return madeFrom.mode === 'live'
    ? { label: 'Auto-updating', tip: 'Made from a query', detail: 'Its members follow the data: what newly matches arrives, what stops matching leaves.' }
    : { label: 'Snapshot', tip: 'Made from a query', detail: 'A snapshot: its members stay as they were when it was saved.' }
}

const members = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'member' : 'members'}`

/** "Auto-updating · 1,234 members" — led by "Subset of Payments · " for one that follows a view;
 *  while its first members are still being worked out, it says so instead of "0 members". */
export function membershipLine(status: MembershipStatus): string {
  const of = status.follows
    ? (status.follows.available && status.follows.name ? `Subset of ${status.follows.name} · ` : 'Subset · ')
    : ''
  const count = status.counts?.members ?? status.keys
  const held = status.status === 'updating' && !count ? 'working out its members' : members(count)
  return `${of}${status.mode === 'live' ? 'Auto-updating' : 'Snapshot'} · ${held}`
}

/** What a layer of a view made from a query holds, in place of the types it has none of. */
export function layerMembersText(status: MembershipStatus | undefined, layerId: string): string {
  const n = status?.counts?.perLayer?.[layerId]
  return typeof n === 'number' ? members(n) : 'Placed by its query'
}

/** How the one view a preview shows stands now. A view only in a draft has nothing to read yet. */
export function useMadeFromStatus(view: View, madeFrom: MadeFrom): {
  membership?: MembershipStatus
  search?: SearchViewStatus
} {
  const membershipOn = useFeature('viewMembershipEnabled')
  const searchOn = useFeature('searchViewsEnabled')
  const live = !view.draftBranchId
  const { data: membership } = useQuery({
    queryKey: [MEMBERSHIP_QUERY_KEY, view.id],
    queryFn: () => getMembershipStatus(view.id),
    enabled: live && membershipOn && madeFrom.kind === 'query',
    staleTime: 15_000,
  })
  const { data: search } = useQuery({
    queryKey: [SEARCH_VIEW_QUERY_KEY, view.id],
    queryFn: () => getSearchStatus(view.id),
    enabled: live && searchOn && madeFrom.kind === 'subset',
    staleTime: 15_000,
  })
  return { membership, search }
}
