/**
 * The counts every filter menu shows beside its options — how many views each
 * choice would leave, given the other filters — for the Explorer and for a
 * workspace's Views tab alike.
 *
 * Two facet reads: the UNIVERSE (everything the reader can see, within the
 * surface's scope), which the menus take their options from, and the LIVE facets
 * for the current filters, which supply the numbers. With no filter set the
 * universe already is the live answer, so the second read is skipped.
 */
import { useMemo } from 'react'
import { useViewFacets } from '@/hooks/useViewFacets'
import { countMap } from './facetOptions'
import { isAnyFilterActive, type ViewFilterState } from './model'
import { resolveFilters, toQueryParams, type ResolveContext } from './params'
import { peopleFromFacets, type PersonOption } from './people'

export function useLiveFacets(state: ViewFilterState, ctx: ResolveContext) {
  const scope = useMemo(
    () => (ctx.scopeWorkspaceId ? { workspaceIds: [ctx.scopeWorkspaceId] } : undefined),
    [ctx.scopeWorkspaceId],
  )
  const universe = useViewFacets(scope)
  const active = isAnyFilterActive(state, { workspace: Boolean(ctx.scopeWorkspaceId) })
  const params = useMemo(() => toQueryParams(resolveFilters(state, ctx)), [state, ctx])
  const live = useViewFacets(params, { enabled: active })
  const source = active ? live.facets : universe.facets
  const ready = active ? !live.isLoading : !universe.isLoading

  return useMemo(() => {
    const livePeople = new Map((source.contributors ?? []).map(c => [c.userId, c]))
    // Everyone stays listed; their numbers follow the filters (0 when the
    // filtered facets no longer mention them).
    const people: PersonOption[] = peopleFromFacets(universe.facets).map(p => {
      const n = livePeople.get(p.userId)
      return ready && active
        ? {
            ...p,
            count: n?.count ?? 0,
            createdCount: n?.createdCount ?? 0,
            editedCount: n?.editedCount ?? 0,
            publishedCount: n?.publishedCount ?? 0,
          }
        : p
    })
    const counted = <T,>(rows: T[] | undefined, key: (r: T) => string, n: (r: T) => number) =>
      (ready ? countMap(rows, key, n) : null)
    return {
      universe: universe.facets,
      people,
      counts: {
        workspaces: counted(source.workspaces, w => w.id, w => w.count),
        dataSources: counted(source.dataSources, d => d.id, d => d.count),
        viewTypes: counted(source.viewTypes, v => v.value, v => v.count),
        tags: counted(source.tags, t => t.value, t => t.count),
        visibilities: counted(source.visibilities, v => v.value, v => v.count),
      },
      sourceKinds: ready ? (source.sourceKinds ?? null) : null,
      /** Newer counts are on their way; what's shown is the previous set. */
      pending: active && live.isRefreshing,
    }
  }, [universe.facets, source, ready, active, live.isRefreshing])
}
