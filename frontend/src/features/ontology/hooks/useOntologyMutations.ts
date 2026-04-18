import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ontologyDefinitionService, type OntologyCreateRequest, type OntologyUpdateRequest } from '@/services/ontologyDefinitionService'
import { useInvalidateGraphSchema } from '@/hooks/useGraphSchema'
import { ONTOLOGY_KEYS } from './useOntologies'

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
    mutationFn: (id: string) => ontologyDefinitionService.publish(id),
    onSuccess: invalidateAll,
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
