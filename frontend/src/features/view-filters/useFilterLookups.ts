import { useMemo } from 'react'
import { useWorkspacesStore } from '@/store/workspaces'
import { viewTypeLabel } from '@/lib/viewUtils'
import type { ViewFacetsResponse } from '@/services/viewApiService'
import type { FilterLookups } from './dimensions'
import { ME } from './model'
import type { PersonOption } from './people'

/** The names a filter chip shows, from what the page already has: the member's
 *  workspaces (and their data sources), the people facet, and — for a workspace or
 *  source the reader can read views in without being a member — the facets' names,
 *  so a chip never shows a raw id. */
export function useFilterLookups(
  people: PersonOption[], today: string, currentUserId?: string | null,
  facets?: Pick<ViewFacetsResponse, 'workspaces' | 'dataSources'> | null,
): FilterLookups {
  const workspaces = useWorkspacesStore(s => s.workspaces)
  return useMemo(() => {
    const workspaceNames = new Map([
      ...(facets?.workspaces ?? []).map(w => [w.id, w.name] as const),
      ...workspaces.map(w => [w.id, w.name] as const),
    ])
    const dataSourceNames = new Map([
      ...(facets?.dataSources ?? []).map(d => [d.id, d.name] as const),
      ...workspaces.flatMap(w => (w.dataSources ?? []).map(d => [d.id, d.label ?? d.id] as const)),
    ])
    const personNames = new Map(people.map(p => [p.userId, p.displayName]))
    return {
      today,
      workspaceName: id => workspaceNames.get(id),
      dataSourceName: id => dataSourceNames.get(id),
      // `me` names you, so a "You" chip can still show your initials.
      personName: id => personNames.get(id === ME ? (currentUserId ?? '') : id),
      viewTypeLabel: t => viewTypeLabel(t),
    }
  }, [workspaces, people, today, currentUserId, facets])
}
