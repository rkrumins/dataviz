/**
 * useEntityBaseline — what an entity is published as while a draft changes it: main where the draft
 * began (its change-list entry's `before`), so the draft's saved changes keep saying what they
 * changed, property by property — with what the draft has saved (`saved`) and how it stands
 * (`status`). `published` is `{}` for an entity new in the draft (everything in it is new).
 * Undefined outside a draft, for an entity not saved yet, until read, or when it can't be read —
 * the drawer then says only what is staged. Cached with the draft's change list, and read again when
 * the draft moves.
 */
import { useMemo } from 'react'
import type { ChangeListEntry } from '@/services/versioningApiService'
import { useChangeEntry } from './useVersioning'

export interface EntityBaseline {
  published: Record<string, unknown>
  saved: Record<string, unknown> | null
  status: ChangeListEntry['status']
}

export function useEntityBaseline(
  scope: { wsId?: string; graphId?: string | null; mainBranchId?: string | null; branchId?: string | null },
  entityId: string | null | undefined,
): EntityBaseline | undefined {
  const draftId = scope.branchId && scope.branchId !== scope.mainBranchId ? scope.branchId : null
  const origin = useMemo(() => (draftId ? { branchId: draftId } : null), [draftId])
  const q = useChangeEntry(scope.wsId, scope.graphId, origin, entityId)
  return useMemo(() => (q.data ? {
    published: (q.data.before as Record<string, unknown> | null | undefined) ?? {},
    saved: (q.data.after as Record<string, unknown> | null | undefined) ?? null,
    status: q.data.status,
  } : undefined), [q.data])
}
