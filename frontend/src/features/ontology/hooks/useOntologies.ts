import { useQuery } from '@tanstack/react-query'
import { ontologyDefinitionService } from '@/services/ontologyDefinitionService'

export const ONTOLOGY_KEYS = {
  all: ['ontologies'] as const,
  list: () => [...ONTOLOGY_KEYS.all, 'list'] as const,
  detail: (id: string) => [...ONTOLOGY_KEYS.all, 'detail', id] as const,
  versions: (id: string) => [...ONTOLOGY_KEYS.all, 'versions', id] as const,
  assignments: (id: string) => [...ONTOLOGY_KEYS.all, 'assignments', id] as const,
}

export function useOntologies() {
  return useQuery({
    queryKey: ONTOLOGY_KEYS.list(),
    queryFn: () => ontologyDefinitionService.list(),
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
