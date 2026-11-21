/**
 * The Playground, for the surfaces that offer it: whether there is one this person
 * may join (and they've joined), and joining — after which their permissions and
 * workspaces are read again so the Playground opens straight away.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { playgroundService, type PlaygroundSetup } from '@/services/playgroundService'
import { useFeature } from '@/store/features'
import { useAuthStore } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'

export const PLAYGROUND_FEATURE = 'playgroundEnabled'
const KEY = ['playground'] as const

export function usePlayground() {
    const enabled = useFeature(PLAYGROUND_FEATURE)
    return useQuery({
        queryKey: KEY,
        queryFn: () => playgroundService.get(),
        enabled,
        staleTime: 60_000,
        retry: false,
    })
}

export function useJoinPlayground() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: () => playgroundService.join(),
        onSuccess: async (info) => {
            // Permissions and workspaces first: whoever reads "joined" next may open it at once.
            await useAuthStore.getState().refreshPermissions()
            await useWorkspacesStore.getState().loadWorkspaces()
            queryClient.setQueryData(KEY, info)
        },
    })
}

export function useSetUpPlayground() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (body: PlaygroundSetup) => playgroundService.setUp(body),
        onSuccess: async (info) => {
            queryClient.setQueryData(KEY, info)
            await useWorkspacesStore.getState().loadWorkspaces()
        },
    })
}
