/**
 * useWorkspacePage — server-paginated workspace list.
 *
 * The workspaces store loads every workspace (with its data sources nested) for
 * the app's own scope resolution. That's the wrong shape for a *list*: a rail
 * showing ten rows shouldn't depend on the whole estate being in memory, and it
 * shouldn't grow a longer and longer scrollbar as the estate does.
 *
 * Search and paging happen on the server, so the page count is honest and the
 * payload is bounded no matter how many workspaces exist.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'

export function useWorkspacePage(params: {
    page: number
    pageSize: number
    search?: string
    enabled?: boolean
}): {
    workspaces: WorkspaceResponse[]
    totalCount: number
    isLoading: boolean
    isError: boolean
    refetch: () => void
} {
    const { page, pageSize, search = '', enabled = true } = params

    const query = useQuery({
        queryKey: ['workspaces', 'page', { page, pageSize, search }],
        queryFn: () => workspaceService.listPage({
            limit: pageSize,
            offset: page * pageSize,
            search: search || undefined,
        }),
        enabled,
        // Keep the current page on screen while the next one loads — paging that
        // blanks the list feels broken.
        placeholderData: keepPreviousData,
        staleTime: 30_000,
    })

    return {
        workspaces: query.data?.items ?? [],
        totalCount: query.data?.totalCount ?? 0,
        isLoading: query.isLoading,
        isError: query.isError,
        refetch: () => { void query.refetch() },
    }
}
