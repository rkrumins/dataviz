/**
 * useDataSourceTransfers — moving a data source between workspaces.
 *
 * One query-key family for every list that shows a transfer (the source's
 * history, a workspace's banner, the Requests tab), so proposing, answering
 * or cancelling refreshes them all at once. A move, an accepted request or
 * an undo also changes where the source and its views live, so those
 * refresh both workspaces, the catalog, the view lists and the activity
 * feeds as well.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'

import {
    dataSourceTransferService,
    type DataSourceTransferResponse,
    type TransferFilter,
    type TransferMoveRequest,
} from '@/services/dataSourceTransferService'
import { WORKSPACE_SUMMARY_KEY } from '@/hooks/useWorkspaceSummary'
import { VIEW_ACTIVITY_QUERY_KEY } from '@/hooks/useViewActivity'
import { ACTIVITY_KEYS } from '@/hooks/useActivity'
import { useWorkspacesStore } from '@/store/workspaces'

export const TRANSFERS_KEY = ['data-source-transfers'] as const

/** Everything a relocation changes, in both workspaces it touched. */
export function invalidateAfterTransfer(queryClient: QueryClient, workspaceIds: string[]) {
    for (const ws of new Set(workspaceIds)) {
        void queryClient.invalidateQueries({ queryKey: ['workspace', ws] })
        void queryClient.invalidateQueries({ queryKey: ['workspace-detail-phase2', ws] })
        void queryClient.invalidateQueries({ queryKey: ['workspaces', ws, 'data-sources'] })
    }
    for (const queryKey of [
        ['catalog'], WORKSPACE_SUMMARY_KEY, ['workspaces', 'page'],
        ['views'], ['explorer-views'], ['view'], [VIEW_ACTIVITY_QUERY_KEY],
        ACTIVITY_KEYS.all, TRANSFERS_KEY,
    ]) {
        void queryClient.invalidateQueries({ queryKey: [...queryKey] })
    }
    // The persisted workspace list re-homes an active data source that moved away.
    void useWorkspacesStore.getState().loadWorkspaces()
}

const sides = (t: DataSourceTransferResponse) => [t.fromWorkspace.id, t.toWorkspace.id]

/** The workspaces the source could go to, each with what the caller may do there. */
export function useMoveDestinations(wsId: string | null, dsId: string | null, enabled = true) {
    const query = useQuery({
        queryKey: [...TRANSFERS_KEY, 'destinations', wsId, dsId],
        queryFn: () => dataSourceTransferService.destinations(wsId as string, dsId as string),
        enabled: enabled && !!wsId && !!dsId,
        staleTime: 30_000,
    })
    return {
        destinations: query.data,
        isLoading: query.isLoading,
        error: query.error as Error | null,
        refetch: query.refetch,
    }
}

/** What moving the source to `to` would do. Never served stale: it is what
 *  the person confirms, and the server refuses a move whose preview changed. */
export function useMovePreview(wsId: string | null, dsId: string | null, to: string | null, enabled = true) {
    const query = useQuery({
        queryKey: [...TRANSFERS_KEY, 'preview', wsId, dsId, to],
        queryFn: () => dataSourceTransferService.preview(wsId as string, dsId as string, to as string),
        enabled: enabled && !!wsId && !!dsId && !!to,
        staleTime: 0,
        retry: false,
    })
    return {
        preview: query.data,
        isLoading: query.isLoading,
        isFetching: query.isFetching,
        error: query.error as Error | null,
        refetch: query.refetch,
    }
}

/** Where this source has lived, newest first. */
export function useTransferHistory(wsId: string | null, dsId: string | null, enabled = true) {
    const query = useQuery({
        queryKey: [...TRANSFERS_KEY, 'history', wsId, dsId],
        queryFn: () => dataSourceTransferService.history(wsId as string, dsId as string),
        enabled: enabled && !!wsId && !!dsId,
        staleTime: 15_000,
        retry: false,
    })
    return { transfers: query.data, isLoading: query.isLoading, error: query.error as Error | null }
}

/** Requests waiting on the workspaces the caller administers — the Requests tab. */
export function useIncomingTransfers(status: TransferFilter = 'open', opts?: { enabled?: boolean }) {
    const query = useQuery({
        queryKey: [...TRANSFERS_KEY, 'incoming', status],
        queryFn: () => dataSourceTransferService.listIncoming(status),
        enabled: opts?.enabled ?? true,
        staleTime: 15_000,
    })
    return {
        transfers: query.data,
        isLoading: query.isLoading,
        error: query.error as Error | null,
        refetch: query.refetch,
    }
}

/** One workspace's open transfers, in both directions — its banner. */
export function useWorkspaceTransfers(wsId: string | null, status: TransferFilter = 'open', opts?: { enabled?: boolean }) {
    const query = useQuery({
        queryKey: [...TRANSFERS_KEY, 'workspace', wsId, status],
        queryFn: () => dataSourceTransferService.listForWorkspace(wsId as string, status),
        enabled: (opts?.enabled ?? true) && !!wsId,
        staleTime: 15_000,
    })
    return { transfers: query.data, isLoading: query.isLoading, error: query.error as Error | null }
}

/** One transfer, with a fresh preview while it waits. */
export function useTransferDetail(id: string | null) {
    const query = useQuery({
        queryKey: [...TRANSFERS_KEY, 'detail', id],
        queryFn: () => dataSourceTransferService.get(id as string),
        enabled: !!id,
        staleTime: 0,
        retry: false,
    })
    return {
        detail: query.data,
        isLoading: query.isLoading,
        isFetching: query.isFetching,
        error: query.error as Error | null,
        refetch: query.refetch,
    }
}

interface MoveVars { wsId: string; dsId: string; body: TransferMoveRequest; reason?: string }

/** Move, ask, answer, take back and undo. */
export function useTransferActions() {
    const queryClient = useQueryClient()
    const relocated = (t: DataSourceTransferResponse) => invalidateAfterTransfer(queryClient, sides(t))
    const listed = () => queryClient.invalidateQueries({ queryKey: TRANSFERS_KEY })

    const move = useMutation({
        mutationFn: ({ wsId, dsId, body, reason }: MoveVars) =>
            dataSourceTransferService.move(wsId, dsId, body, reason),
        onSuccess: relocated,
    })
    const propose = useMutation({
        mutationFn: ({ wsId, dsId, body, reason }: MoveVars) =>
            dataSourceTransferService.propose(wsId, dsId, body, reason),
        onSuccess: listed,
    })
    const accept = useMutation({
        mutationFn: ({ id, previewToken, reason }: { id: string; previewToken: string; reason?: string }) =>
            dataSourceTransferService.accept(id, previewToken, reason),
        onSuccess: relocated,
    })
    const decline = useMutation({
        mutationFn: ({ id, note }: { id: string; note?: string }) => dataSourceTransferService.decline(id, note),
        onSuccess: listed,
    })
    const cancel = useMutation({
        mutationFn: ({ id, note }: { id: string; note?: string }) => dataSourceTransferService.cancel(id, note),
        onSuccess: listed,
    })
    const undo = useMutation({
        mutationFn: ({ id, reason }: { id: string; reason?: string }) => dataSourceTransferService.undo(id, reason),
        onSuccess: relocated,
    })
    return { move, propose, accept, decline, cancel, undo }
}
