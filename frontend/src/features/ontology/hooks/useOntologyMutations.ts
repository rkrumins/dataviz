import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ontologyDefinitionService, type OntologyCreateRequest, type OntologyUpdateRequest } from '@/services/ontologyDefinitionService'
import { useInvalidateGraphSchema, GRAPH_SCHEMA_QUERY_KEY } from '@/hooks/useGraphSchema'
import { ONTOLOGY_KEYS } from './useOntologies'
import { recordEvent } from '@/services/telemetryService'

export function useOntologyMutations() {
  const queryClient = useQueryClient()
  const invalidateSchema = useInvalidateGraphSchema()

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ONTOLOGY_KEYS.all })
    invalidateSchema()
  }

  const create = useMutation({
    mutationFn: (req: OntologyCreateRequest) => ontologyDefinitionService.create(req),
    onSuccess: invalidateAll,
  })

  const update = useMutation({
    mutationFn: ({ id, req }: { id: string; req: OntologyUpdateRequest }) =>
      ontologyDefinitionService.update(id, req),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ONTOLOGY_KEYS.list() })
      queryClient.invalidateQueries({ queryKey: ONTOLOGY_KEYS.detail(data.id) })
      invalidateSchema()
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => ontologyDefinitionService.delete(id),
    onSuccess: invalidateAll,
  })

  const publish = useMutation({
    mutationFn: (arg: string | { id: string; force?: boolean }) =>
      typeof arg === 'string'
        ? ontologyDefinitionService.publish(arg)
        : ontologyDefinitionService.publish(arg.id, arg.force ?? false),
    // Publishing bumps the server-side resolution caches for EVERY assigned
    // data source; refetching everything at once used to storm the provider
    // concurrency slots (each cold read pays the full re-resolution) and
    // surface as 429s. So: mark everything stale but refetch NOTHING except
    // what the publish surface itself shows — the rest (adoption, coverage,
    // graph schema, canvases) refetches lazily on next mount/focus.
    onSuccess: (data) => {
      // Adoption of the semantic layer — the platform's differentiator — was
      // measurable only as "rows exist", never as "someone published one".
      recordEvent('ontology.published')
      queryClient.invalidateQueries({ queryKey: ONTOLOGY_KEYS.all, refetchType: 'none' })
      queryClient.invalidateQueries({ queryKey: GRAPH_SCHEMA_QUERY_KEY, refetchType: 'none' })
      queryClient.invalidateQueries({ queryKey: ONTOLOGY_KEYS.detail(data.id) })
      queryClient.invalidateQueries({ queryKey: ONTOLOGY_KEYS.versions(data.id) })
      queryClient.invalidateQueries({ queryKey: ONTOLOGY_KEYS.list() })
    },
  })

  const clone = useMutation({
    mutationFn: (id: string) => ontologyDefinitionService.clone(id),
    onSuccess: invalidateAll,
  })

  const createNewVersion = useMutation({
    mutationFn: (id: string) => ontologyDefinitionService.createNewVersion(id),
    onSuccess: invalidateAll,
  })

  const validate = useMutation({
    mutationFn: (id: string) => ontologyDefinitionService.validate(id),
  })

  return { create, update, remove, publish, clone, createNewVersion, validate, invalidateAll }
}
