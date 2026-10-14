/**
 * A person's saved filters, from the server, with every change shown at once.
 *
 * Renames, reorders and deletes land on screen before the server answers (and are
 * put back if it refuses), because a pill that hesitates after a click reads as a
 * click that missed. Creating waits for the answer instead: the server is what
 * decides a name is taken or the list is full, and the save popover shows that
 * answer where the name was typed.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createSavedViewFilter, deleteSavedViewFilter, listSavedViewFilters, reorderSavedViewFilters,
  updateSavedViewFilter, type SavedViewFilter,
} from '@/services/savedViewFiltersService'

const KEY = ['saved-view-filters'] as const

export function useSavedViewFilters(enabled = true) {
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: KEY,
    queryFn: listSavedViewFilters,
    enabled,
    staleTime: 60_000,
    retry: false,
  })

  /** Apply `change` to the cached list now; undo it if the server refuses. */
  const optimistic = <V,>(change: (rows: SavedViewFilter[], vars: V) => SavedViewFilter[]) => ({
    onMutate: async (vars: V) => {
      await qc.cancelQueries({ queryKey: KEY })
      const before = qc.getQueryData<SavedViewFilter[]>(KEY)
      qc.setQueryData<SavedViewFilter[]>(KEY, rows => change(rows ?? [], vars))
      return { before }
    },
    onError: (_e: unknown, _vars: V, ctx?: { before?: SavedViewFilter[] }) => {
      qc.setQueryData(KEY, ctx?.before)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  })

  const create = useMutation({
    mutationFn: createSavedViewFilter,
    onSuccess: saved => qc.setQueryData<SavedViewFilter[]>(KEY, rows => [...(rows ?? []), saved]),
  })
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; query?: string }) => updateSavedViewFilter(id, body),
    ...optimistic<{ id: string; name?: string; query?: string }>((rows, { id, ...body }) =>
      rows.map(r => (r.id === id ? { ...r, ...body } : r))),
  })
  const remove = useMutation({
    mutationFn: deleteSavedViewFilter,
    ...optimistic<string>((rows, id) => rows.filter(r => r.id !== id)),
  })
  const reorder = useMutation({
    mutationFn: reorderSavedViewFilters,
    ...optimistic<string[]>((rows, ids) => {
      const byId = new Map(rows.map(r => [r.id, r]))
      return ids.flatMap((id, position) => {
        const r = byId.get(id)
        return r ? [{ ...r, position }] : []
      })
    }),
  })

  return {
    filters: [...(list.data ?? [])].sort((a, b) => a.position - b.position),
    isLoading: list.isLoading,
    error: list.error,
    create,
    update,
    remove,
    reorder,
  }
}
