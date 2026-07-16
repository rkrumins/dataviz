import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ontologyDefinitionService, type AdoptionParams } from '@/services/ontologyDefinitionService'

export const ONTOLOGY_KEYS = {
  all: ['ontologies'] as const,
  list: () => [...ONTOLOGY_KEYS.all, 'list'] as const,
  detail: (id: string) => [...ONTOLOGY_KEYS.all, 'detail', id] as const,
  versions: (id: string) => [...ONTOLOGY_KEYS.all, 'versions', id] as const,
  assignments: (id: string) => [...ONTOLOGY_KEYS.all, 'assignments', id] as const,
  adoption: (id: string, params: AdoptionParams = {}) =>
    [...ONTOLOGY_KEYS.all, 'adoption', id, params] as const,
  audit: (id: string) => [...ONTOLOGY_KEYS.all, 'audit', id] as const,
}

export function useOntologyAdoption(id: string | undefined, params: AdoptionParams = {}) {
  return useQuery({
    queryKey: ONTOLOGY_KEYS.adoption(id!, params),
    queryFn: () => ontologyDefinitionService.adoption(id!, params),
    enabled: !!id,
    staleTime: 30_000,
    // Keep the previous page visible while the next page / filter loads (no flash of empty).
    placeholderData: keepPreviousData,
  })
}

/**
 * The list cache key. Exported because the DASHBOARD reads this same list (its
 * Semantic Layers section) and must land on the SAME cache entry — it used to
 * hand-roll a second fetch under ['dashboard','ontologies'], so publishing a
 * layer here left the dashboard serving a stale copy. One builder, one key: the
 * two can't drift apart by a typo.
 */
export const ontologyListKey = (includeDeleted = false) =>
  [...ONTOLOGY_KEYS.list(), { includeDeleted }] as const

export function useOntologies(includeDeleted = false) {
  return useQuery({
    queryKey: ontologyListKey(includeDeleted),
    queryFn: () => ontologyDefinitionService.list(false, includeDeleted),
    staleTime: 30_000,
  })
}

export function useOntology(id: string | undefined) {
  return useQuery({
    queryKey: ONTOLOGY_KEYS.detail(id!),
    queryFn: () => ontologyDefinitionService.get(id!),
    enabled: !!id,
    staleTime: 30_000,
  })
}

export function useOntologyVersions(id: string | undefined) {
  return useQuery({
    queryKey: ONTOLOGY_KEYS.versions(id!),
    queryFn: () => ontologyDefinitionService.listVersions(id!),
    enabled: !!id,
    staleTime: 60_000,
  })
}

export function useOntologyAssignments(id: string | undefined) {
  return useQuery({
    queryKey: ONTOLOGY_KEYS.assignments(id!),
    queryFn: () => ontologyDefinitionService.getAssignments(id!),
    enabled: !!id,
    staleTime: 30_000,
  })
}

/**
 * Audit trail, newest-first. `limit` is a grow-only window ("Load more" bumps
 * it) — the backend caps at 500; refetching from 0 each time keeps this a
 * plain useQuery (audit reads are cheap) instead of infinite-query plumbing.
 */
export function useOntologyAuditLog(id: string | undefined, limit = 25) {
  return useQuery({
    queryKey: [...ONTOLOGY_KEYS.audit(id!), limit],
    queryFn: () => ontologyDefinitionService.auditLog(id!, { limit }),
    enabled: !!id,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })
}
