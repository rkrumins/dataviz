/**
 * React Query wrappers for a view's versions (the history of its design, not graph commits).
 *
 * The status query backs the header chip ("v8 •" when there are unsaved changes), so it is
 * invalidated by anything that writes a view: saves here, restores, imports and exports (an
 * export with unsaved changes saves them as a version first).
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  compareViewVersions,
  getViewVersionStatus,
  listViewVersions,
  restoreViewVersion,
  saveViewVersion,
  type ViewVersionPage,
  type ViewVersionStatus,
} from '@/services/viewVersionsApiService'
import { VIEW_ACTIVITY_QUERY_KEY } from './useViewActivity'
import { VIEW_QUERY_KEY } from './useViewMetadata'

export const VIEW_VERSIONS_QUERY_KEY = 'view-versions' as const
export const VIEW_VERSION_STATUS_QUERY_KEY = 'view-version-status' as const

/** Refresh everything that shows a view's versions after a write to it. */
export function invalidateViewVersions(queryClient: QueryClient, viewId: string): void {
  void queryClient.invalidateQueries({ queryKey: [VIEW_VERSIONS_QUERY_KEY, viewId] })
  void queryClient.invalidateQueries({ queryKey: [VIEW_VERSION_STATUS_QUERY_KEY, viewId] })
  void queryClient.invalidateQueries({ queryKey: [VIEW_ACTIVITY_QUERY_KEY, viewId] })
}

export function useViewVersionStatus(viewId: string | null | undefined, enabled = true) {
  return useQuery<ViewVersionStatus, Error>({
    queryKey: [VIEW_VERSION_STATUS_QUERY_KEY, viewId],
    queryFn: () => getViewVersionStatus(viewId!),
    enabled: enabled && !!viewId,
    staleTime: 15_000,
    retry: 1,
  })
}

export function useViewVersions(viewId: string | null | undefined, enabled = true) {
  return useQuery<ViewVersionPage, Error>({
    queryKey: [VIEW_VERSIONS_QUERY_KEY, viewId],
    queryFn: () => listViewVersions(viewId!, { limit: 100 }),
    enabled: enabled && !!viewId,
    staleTime: 15_000,
    retry: 1,
  })
}

export function useCompareViewVersions(
  viewId: string | null | undefined, from: number | null, to: number | 'working' | null,
) {
  return useQuery({
    queryKey: [VIEW_VERSIONS_QUERY_KEY, viewId, 'compare', from, to],
    queryFn: () => compareViewVersions(viewId!, from!, to!),
    enabled: !!viewId && from !== null && to !== null,
    staleTime: 60_000,
  })
}

export function useSaveViewVersion(viewId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (message?: string) => saveViewVersion(viewId, message),
    onSuccess: () => invalidateViewVersions(queryClient, viewId),
  })
}

export function useRestoreViewVersion(viewId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (version: number) => restoreViewVersion(viewId, version),
    onSuccess: () => {
      invalidateViewVersions(queryClient, viewId)
      // The view's design changed: every cached copy of it is stale.
      void queryClient.invalidateQueries({ queryKey: [...VIEW_QUERY_KEY, viewId] })
      void queryClient.invalidateQueries({ queryKey: ['views'] })
      void queryClient.invalidateQueries({ queryKey: ['explorer-views'] })
    },
  })
}
