import { useMemo } from 'react'
import { useWorkspacesStore } from '@/store/workspaces'
import { viewTypeLabel } from '@/lib/viewUtils'
import type { ViewFacetsResponse } from '@/services/viewApiService'
import type { PersonOption } from './people'
import { matchOne, type TokenResolver } from './tokens'

/**
 * What typed token values can name — the people, types, tags, workspaces and
 * sources the reader can see — and how a value is matched to one of them (see
 * `matchOne`: exact first, then a unique prefix, then a unique substring).
 * The candidate lists also feed the search box's suggestions.
 */
export function useTokenResolver(universe: ViewFacetsResponse, people: PersonOption[]) {
  const workspaces = useWorkspacesStore(s => s.workspaces)
  return useMemo(() => {
    const workspaceList = new Map(workspaces.map(w => [w.id, w.name]))
    for (const w of universe.workspaces ?? []) if (!workspaceList.has(w.id)) workspaceList.set(w.id, w.name)
    const sourceList = new Map<string, string>()
    for (const w of workspaces) for (const d of w.dataSources ?? []) sourceList.set(d.id, d.label ?? d.id)
    for (const d of universe.dataSources ?? []) if (!sourceList.has(d.id)) sourceList.set(d.id, d.name)

    const candidates = {
      people,
      viewTypes: universe.viewTypes.map(v => ({ id: v.value, name: viewTypeLabel(v.value) })),
      tags: universe.tags.map(t => ({ id: t.value, name: t.value })),
      workspaces: [...workspaceList].map(([id, name]) => ({ id, name })),
      dataSources: [...sourceList].map(([id, name]) => ({ id, name })),
    }
    const resolver: TokenResolver = {
      person: q => matchOne(people, q, p => p.displayName, p => p.email)?.userId ?? null,
      // A type matches its label or its raw key (`context`), whichever was typed.
      viewType: q => matchOne(candidates.viewTypes, q, v => v.name, v => v.id)?.id ?? null,
      tag: q => matchOne(candidates.tags, q, t => t.name)?.id ?? null,
      workspace: q => matchOne(candidates.workspaces, q, w => w.name)?.id ?? null,
      dataSource: q => matchOne(candidates.dataSources, q, d => d.name)?.id ?? null,
    }
    return { resolver, candidates }
  }, [workspaces, universe, people])
}
