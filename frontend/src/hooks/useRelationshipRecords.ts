/**
 * Several relationships read at once, for comparing and editing them together — the batch form of
 * `useRelationshipRecord`, never the canvas copy (canvas edges carry no properties).
 *
 * Under version control one read answers for all of them (`POST …/edges/read`, a slice of
 * `EDGE_READ_MAX` at a time): each one's entity id, properties and token, exactly as main — or the
 * open draft — has it, and which refs name none (deleted in the draft, or not there at all). A
 * data source not under version control is read through the view's provider, a slice of ends at a
 * time; nothing can be edited there, so it has no tokens to give.
 *
 * Keyed under the versioning namespace, so every save, import and start-editing refreshes it.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useGraphProviderContext } from '@/providers/GraphProviderContext'
import { VERSIONING_KEYS } from '@/features/versioning/hooks/useVersioning'
import { EDGE_READ_MAX, readEdges, type EdgeReadRef } from '@/services/versioningApiService'
import { pickRelationship, type RelationshipRef } from './useRelationshipRecord'

export interface RelationshipRecordOf {
  /** The versioned entity id — what an edit addresses. */
  entityId: string
  edgeType: string
  properties: Record<string, unknown>
  /** Its token, under version control. */
  version?: string
}

export interface RelationshipRecords {
  /** By the ref's id. */
  records: ReadonlyMap<string, RelationshipRecordOf>
  /** Refs whose relationship the draft deleted. */
  deleted: ReadonlySet<string>
  /** Refs that name no relationship here. */
  missing: ReadonlySet<string>
  /** Read from the version store: each record has its token. */
  versioned: boolean
  isLoading: boolean
  isError: boolean
  refetch: () => void
}

/** Ends per provider read: its sources × targets bound what one read can return. */
const PROVIDER_SLICE = 50
const PROVIDER_LIMIT = 5000

const EMPTY_SET: ReadonlySet<string> = new Set()
const EMPTY_RECORDS: ReadonlyMap<string, RelationshipRecordOf> = new Map()

export function useRelationshipRecords(
  refs: readonly RelationshipRef[],
  scope: { wsId?: string | null; graphId?: string | null; branchId?: string | null },
): RelationshipRecords {
  const { provider, providerVersion } = useGraphProviderContext()
  const providerScope = (provider as { scopeKey?: string } | null)?.scopeKey ?? ''
  const versioned = !!scope.wsId && !!scope.graphId
  const key = useMemo(() => refs.map((r) => r.id).join('\n'), [refs])
  const q = useQuery({
    queryKey: [...VERSIONING_KEYS.all, 'relationships', versioned ? scope.graphId : providerScope,
      scope.branchId ?? null, providerVersion, key],
    queryFn: async ({ signal }) => {
      const records = new Map<string, RelationshipRecordOf>()
      const deleted = new Set<string>()
      const missing = new Set<string>()
      if (versioned) {
        for (let i = 0; i < refs.length; i += EDGE_READ_MAX) {
          const slice: EdgeReadRef[] = refs.slice(i, i + EDGE_READ_MAX)
            .map((r) => ({ id: r.id, source: r.source, target: r.target, edgeType: r.edgeType }))
          const res = await readEdges(scope.wsId!, scope.graphId!, scope.branchId, slice, signal)
          for (const e of res.edges) {
            records.set(e.id, { entityId: e.entityId, edgeType: e.edgeType, properties: e.properties ?? {},
              ...(e.version ? { version: e.version } : {}) })
          }
          res.deleted.forEach((id) => deleted.add(id))
          res.missing.forEach((id) => missing.add(id))
        }
        return { records, deleted, missing }
      }
      for (let i = 0; i < refs.length; i += PROVIDER_SLICE) {
        const slice = refs.slice(i, i + PROVIDER_SLICE)
        const edges = await provider!.getEdges({
          sourceUrns: [...new Set(slice.map((r) => r.source))],
          targetUrns: [...new Set(slice.map((r) => r.target))],
          limit: PROVIDER_LIMIT,
        })
        for (const r of slice) {
          const e = pickRelationship(edges, r)
          if (e) records.set(r.id, { entityId: e.id, edgeType: e.edgeType, properties: e.properties ?? {} })
          else missing.add(r.id)
        }
      }
      return { records, deleted, missing }
    },
    enabled: refs.length > 0 && (versioned || !!provider),
    staleTime: 30_000,
  })
  return {
    records: q.data?.records ?? EMPTY_RECORDS,
    deleted: q.data?.deleted ?? EMPTY_SET,
    missing: q.data?.missing ?? EMPTY_SET,
    versioned,
    isLoading: q.isLoading,
    isError: q.isError,
    refetch: () => { void q.refetch() },
  }
}
