import { useMemo } from 'react'
import { useWorkspacesStore } from '@/store/workspaces'
import { viewTypeLabel } from '@/lib/viewUtils'
import type { FilterLookups } from './dimensions'
import { ME } from './model'
import type { PersonOption } from './people'

/** The names a filter chip shows, from what the page already has: the member's
 *  workspaces (and their data sources) and the people facet. */
export function useFilterLookups(
  people: PersonOption[], today: string, currentUserId?: string | null,
): FilterLookups {
  const workspaces = useWorkspacesStore(s => s.workspaces)
  return useMemo(() => {
    const workspaceNames = new Map(workspaces.map(w => [w.id, w.name]))
    const dataSourceNames = new Map(
      workspaces.flatMap(w => (w.dataSources ?? []).map(d => [d.id, d.label ?? d.id] as const)),
    )
    const personNames = new Map(people.map(p => [p.userId, p.displayName]))
    return {
      today,
      workspaceName: id => workspaceNames.get(id),
      dataSourceName: id => dataSourceNames.get(id),
      // `me` names you, so a "You" chip can still show your initials.
      personName: id => personNames.get(id === ME ? (currentUserId ?? '') : id),
      viewTypeLabel: t => viewTypeLabel(t),
    }
  }, [workspaces, people, today, currentUserId])
}
