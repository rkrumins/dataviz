/**
 * useWorkspaceAccess — finding a workspace, asking to join (or joining one
 * open to everyone), asking to keep access, following the request, and
 * answering requests.
 *
 * One query-key family, so asking, withdrawing, answering or a change to
 * the caller's own permissions refreshes every list that shows a request at
 * once: Find a workspace, My Access and the Requests tab.
 */
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
    accessRequestsService,
    type AccessRequestApproveRequest,
    type AccessRequestCreateRequest,
    type AccessRequestFilter,
    type AccessRequestRouteRequest,
} from '@/services/accessRequestsService'
import { workspaceMembersService } from '@/services/workspaceMembersService'
import { workspaceService } from '@/services/workspaceService'
import { PERMISSIONS_CHANGED_EVENT } from '@/store/permissionChangeBus'
import { useFeature } from '@/store/features'

/** The admin switch behind Find a workspace. Ships off. */
export const WORKSPACE_DIRECTORY_FEATURE = 'workspaceDirectoryEnabled'

export const WORKSPACE_ACCESS_KEY = ['workspace-access'] as const

/** Refetch every request list when the caller's permissions change — an
 *  approval has just let them in somewhere. */
function useRefreshOnPermissionChange() {
    const queryClient = useQueryClient()
    useEffect(() => {
        const onChange = () => void queryClient.invalidateQueries({ queryKey: WORKSPACE_ACCESS_KEY })
        window.addEventListener(PERMISSIONS_CHANGED_EVENT, onChange)
        return () => window.removeEventListener(PERMISSIONS_CHANGED_EVENT, onChange)
    }, [queryClient])
}

/** Find a workspace. Not asked for while the switch is off. */
export function useWorkspaceDirectory() {
    const enabled = useFeature(WORKSPACE_DIRECTORY_FEATURE)
    useRefreshOnPermissionChange()
    const query = useQuery({
        queryKey: [...WORKSPACE_ACCESS_KEY, 'directory'],
        queryFn: () => workspaceService.directory(),
        enabled,
        staleTime: 30_000,
    })
    return {
        enabled,
        entries: query.data,
        isLoading: enabled && query.isLoading,
        error: query.error as Error | null,
        refetch: query.refetch,
    }
}

/** The caller's own requests, newest first. */
export function useMyAccessRequests(status?: AccessRequestFilter) {
    useRefreshOnPermissionChange()
    const query = useQuery({
        queryKey: [...WORKSPACE_ACCESS_KEY, 'mine', status ?? 'all'],
        queryFn: () => accessRequestsService.listMine(status ? { status } : undefined),
        staleTime: 15_000,
    })
    return { requests: query.data, isLoading: query.isLoading, error: query.error as Error | null }
}

/** What may be asked for in a workspace, and how it takes requests —
 *  never its name. */
export function useRequestableRoles(workspaceId: string | null) {
    const query = useQuery({
        queryKey: [...WORKSPACE_ACCESS_KEY, 'requestable', workspaceId],
        queryFn: () => accessRequestsService.requestableRoles(workspaceId as string),
        enabled: !!workspaceId,
        staleTime: 5 * 60_000,
        retry: false,
    })
    return {
        roles: query.data?.roles,
        requestPolicy: query.data?.requestPolicy ?? 'approval',
        joinRole: query.data?.joinRole ?? null,
        isLoading: query.isLoading,
        error: query.error as Error | null,
    }
}

/** Ask to join, join an open workspace, ask to keep access, and take a
 *  request back. */
export function useAccessRequestActions() {
    const queryClient = useQueryClient()
    const refresh = () => queryClient.invalidateQueries({ queryKey: WORKSPACE_ACCESS_KEY })
    const submit = useMutation({
        mutationFn: (req: AccessRequestCreateRequest) => accessRequestsService.submit(req),
        onSuccess: refresh,
    })
    const join = useMutation({
        mutationFn: (workspaceId: string) => accessRequestsService.join(workspaceId),
        onSuccess: refresh,
    })
    const extend = useMutation({
        mutationFn: (req: { bindingId: string; justification?: string | null }) => accessRequestsService.extend(req),
        onSuccess: refresh,
    })
    const withdraw = useMutation({
        mutationFn: (requestId: string) => accessRequestsService.withdraw(requestId),
        onSuccess: refresh,
    })
    return { submit, join, extend, withdraw }
}

/** Every request the caller answers, across their workspaces — empty for
 *  someone who answers none. */
export function useRequestsToAnswer(status: AccessRequestFilter = 'open', opts?: { enabled?: boolean; workspaceId?: string }) {
    useRefreshOnPermissionChange()
    const query = useQuery({
        queryKey: [...WORKSPACE_ACCESS_KEY, 'to-answer', status, opts?.workspaceId ?? null],
        queryFn: () => accessRequestsService.listToAnswer({ status, workspaceId: opts?.workspaceId }),
        enabled: opts?.enabled ?? true,
        staleTime: 15_000,
    })
    return {
        requests: query.data,
        isLoading: query.isLoading,
        error: query.error as Error | null,
        refetch: query.refetch,
    }
}

/** What the caller may grant in a workspace. */
export function useGrantOptions(workspaceId: string | null) {
    const query = useQuery({
        queryKey: [...WORKSPACE_ACCESS_KEY, 'grant-options', workspaceId],
        queryFn: () => workspaceMembersService.grantOptions(workspaceId as string),
        enabled: !!workspaceId,
        staleTime: 60_000,
    })
    return { options: query.data, isLoading: query.isLoading, error: query.error as Error | null }
}

/** Approve, point to the identity provider, or deny. */
export function useAnswerActions() {
    const queryClient = useQueryClient()
    const refresh = () => queryClient.invalidateQueries({ queryKey: WORKSPACE_ACCESS_KEY })
    const approve = useMutation({
        mutationFn: ({ id, body }: { id: string; body: AccessRequestApproveRequest }) =>
            accessRequestsService.approve(id, body),
        onSuccess: refresh,
    })
    const route = useMutation({
        mutationFn: ({ id, body }: { id: string; body: AccessRequestRouteRequest }) =>
            accessRequestsService.route(id, body),
        onSuccess: refresh,
    })
    const deny = useMutation({
        mutationFn: ({ id, note }: { id: string; note: string | null }) => accessRequestsService.deny(id, { note }),
        onSuccess: refresh,
    })
    return { approve, route, deny }
}
