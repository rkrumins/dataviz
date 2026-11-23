/**
 * A workspace's groups, their members and identity-provider links; suggestions of
 * identity-provider groups; and the platform administrators' queue of links to make.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
    idpGroupsService, idpLinkRequestsService, workspaceGroupsService, type GroupRole, type NewGroup,
} from '@/services/workspaceGroupsService'
import { useAuthStore } from '@/store/auth'

const KEY = ['workspace-groups'] as const
const LINKS = ['idp-link-requests'] as const

export function useWorkspaceGroups(wsId: string | null | undefined) {
    return useQuery({
        queryKey: [...KEY, wsId],
        queryFn: () => workspaceGroupsService.list(wsId!),
        enabled: !!wsId,
        staleTime: 30_000,
    })
}

export function useGroupMembers(wsId: string, groupId: string | null) {
    return useQuery({
        queryKey: [...KEY, wsId, 'members', groupId],
        queryFn: () => workspaceGroupsService.members(wsId, groupId!),
        enabled: !!groupId,
    })
}

export function useWorkspaceGroupActions(wsId: string) {
    const queryClient = useQueryClient()
    const done = async () => {
        await queryClient.invalidateQueries({ queryKey: [...KEY, wsId] })
        await queryClient.invalidateQueries({ queryKey: LINKS })
    }
    return {
        create: useMutation({ mutationFn: (body: NewGroup) => workspaceGroupsService.create(wsId, body), onSuccess: done }),
        update: useMutation({
            mutationFn: ({ groupId, ...body }: { groupId: string; name?: string; description?: string; role?: GroupRole }) =>
                workspaceGroupsService.update(wsId, groupId, body),
            onSuccess: done,
        }),
        remove: useMutation({ mutationFn: (groupId: string) => workspaceGroupsService.remove(wsId, groupId), onSuccess: done }),
        addMember: useMutation({
            mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) => workspaceGroupsService.addMember(wsId, groupId, userId),
            onSuccess: done,
        }),
        removeMember: useMutation({
            mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) => workspaceGroupsService.removeMember(wsId, groupId, userId),
            onSuccess: done,
        }),
        linkIdp: useMutation({
            mutationFn: ({ groupId, idpGroup, providerId }: { groupId: string; idpGroup: string; providerId?: string | null }) =>
                workspaceGroupsService.linkIdp(wsId, groupId, idpGroup, providerId),
            onSuccess: done,
        }),
        unlinkIdp: useMutation({
            mutationFn: ({ groupId, mappingId }: { groupId: string; mappingId: string }) => workspaceGroupsService.unlinkIdp(wsId, groupId, mappingId),
            onSuccess: done,
        }),
    }
}

export function useIdpGroupSuggestions(q: string, enabled = true) {
    return useQuery({
        queryKey: ['idp-group-suggestions', q],
        queryFn: () => idpGroupsService.suggestions(q),
        enabled,
        staleTime: 60_000,
    })
}

export function useIdpGroupPreview(idpGroup: string | null) {
    const canSee = useAuthStore(s => s.can('system:admin'))
    return useQuery({
        queryKey: ['idp-group-preview', idpGroup],
        queryFn: () => idpGroupsService.preview(idpGroup!),
        enabled: canSee && !!idpGroup,
        staleTime: 60_000,
    })
}

export function useIdpLinkRequests(status: 'pending' | 'all' = 'pending') {
    const canSee = useAuthStore(s => s.can('system:admin'))
    return useQuery({
        queryKey: [...LINKS, status],
        queryFn: () => idpLinkRequestsService.list(status),
        enabled: canSee,
        staleTime: 30_000,
    })
}

export function useIdpLinkRequestActions() {
    const queryClient = useQueryClient()
    const done = async () => {
        await queryClient.invalidateQueries({ queryKey: LINKS })
        await queryClient.invalidateQueries({ queryKey: KEY })
        await queryClient.invalidateQueries({ queryKey: ['workspace-requests'] })
    }
    return {
        link: useMutation({
            mutationFn: ({ id, providerId }: { id: string; providerId?: string | null }) => idpLinkRequestsService.link(id, providerId),
            onSuccess: done,
        }),
        decline: useMutation({
            mutationFn: ({ id, reason }: { id: string; reason?: string }) => idpLinkRequestsService.decline(id, reason),
            onSuccess: done,
        }),
    }
}
