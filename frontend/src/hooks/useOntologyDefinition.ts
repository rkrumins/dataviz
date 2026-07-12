/**
 * useOntologyDefinition — fetches a single ontology definition (name,
 * description, publish state, type definitions) by id.
 *
 * The ontologies router is system:admin-gated; the service already sends
 * silent403 on reads, so non-admin callers simply resolve to `null` and the
 * consuming UI degrades (no denial modal, no error state).
 */
import { useQuery } from '@tanstack/react-query'
import {
    ontologyDefinitionService,
    type OntologyDefinitionResponse,
} from '@/services/ontologyDefinitionService'

export function useOntologyDefinition(ontologyId?: string | null): {
    ontology: OntologyDefinitionResponse | null
    isLoading: boolean
} {
    const query = useQuery({
        queryKey: ['ontology-def', ontologyId],
        queryFn: () => ontologyDefinitionService.get(ontologyId as string),
        enabled: !!ontologyId,
        retry: false,
        staleTime: 5 * 60_000,
    })
    return { ontology: query.data ?? null, isLoading: query.isLoading }
}
