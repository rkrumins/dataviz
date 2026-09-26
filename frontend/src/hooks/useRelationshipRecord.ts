/**
 * The relationship drawer's own read of a relationship — never the canvas copy.
 *
 * Canvas edges are the wrong source for a relationship's details: the mappers
 * that put them on the board drop `properties`, a trace or drill reads them
 * under FalkorDB's internal id rather than the entity id, and nothing refreshes
 * them after a save. So the drawer asks the view's own provider — already
 * scoped to the open draft (`?branchId=`) — for the relationships between the
 * two endpoints, and picks the one it shows: by id, else by its
 * (source, target, type), which writes keep unique.
 *
 * Keyed under the versioning namespace, so every save, import and
 * start-editing that refreshes versioning state refreshes this read too.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useGraphProviderContext } from '@/providers/GraphProviderContext'
import { VERSIONING_KEYS } from '@/features/versioning/hooks/useVersioning'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { GraphEdge } from '@/providers/GraphDataProvider'

export interface RelationshipRef {
  id: string
  source: string
  target: string
  edgeType: string
}

/** Every relationship stored directly between two entities (no type filter —
 *  the branch readers compare types case-sensitively). */
export function useRelationshipsBetween(source: string | undefined, target: string | undefined, enabled = true) {
  const { provider, providerVersion } = useGraphProviderContext()
  // The provider's (workspace, data source, branch, view) identity, so a draft
  // and main never share an answer.
  const scope = (provider as { scopeKey?: string } | null)?.scopeKey ?? ''
  return useQuery({
    queryKey: [...VERSIONING_KEYS.all, 'relationship', scope, providerVersion, source, target],
    queryFn: () => provider!.getEdges({ sourceUrns: [source!], targetUrns: [target!] }),
    enabled: enabled && !!provider && !!source && !!target,
    staleTime: 30_000,
  })
}

/** The stored relationship a drawer target stands for: its own id, else the one
 *  relationship of its type between its endpoints. */
export function pickRelationship(edges: GraphEdge[] | undefined, ref: RelationshipRef | null): GraphEdge | undefined {
  if (!edges || !ref) return undefined
  const byId = edges.find((e) => e.id === ref.id)
  if (byId) return byId
  const type = ref.edgeType.toUpperCase()
  const sameTriple = edges.filter((e) =>
    e.sourceUrn === ref.source && e.targetUrn === ref.target && e.edgeType.toUpperCase() === type)
  return sameTriple.length === 1 ? sameTriple[0] : undefined
}

export function useRelationshipRecord(ref: RelationshipRef | null) {
  // A relationship drawn but not yet saved has no stored record to read.
  const unsaved = useStagedChangesStore((s) =>
    !!ref && s.changes.some((c) => c.type === 'create_edge' && c.targetId === ref.id))
  const q = useRelationshipsBetween(ref?.source, ref?.target, !!ref && !unsaved)
  const record = useMemo(() => pickRelationship(q.data, ref), [q.data, ref])
  return {
    record,
    /** The versioned entity id — what history and edits address. */
    entityId: record?.id ?? ref?.id ?? null,
    unsaved,
    isLoading: q.isLoading,
    isError: q.isError,
    refetch: q.refetch,
  }
}
