/**
 * The Playground, for the surfaces that offer it: whether there is one this person
 * may join (and they've joined), and joining — after which their permissions and
 * workspaces are read again so the Playground opens straight away.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { playgroundService, type NewPlaygroundGraph, type PlaygroundSetup } from '@/services/playgroundService'
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

/** The samples a member may start a graph from, and how many more graphs they may start. A
 *  sample is a blank graph, so they're offered only while blank graphs and version control are. */
export function usePlaygroundSamples() {
    const playground = useFeature(PLAYGROUND_FEATURE)
    const blankModels = useFeature('blankModelsEnabled')
    const versioning = useFeature('versioningEnabled')
    return useQuery({
        queryKey: [...KEY, 'samples'],
        queryFn: () => playgroundService.samples(),
        enabled: playground && blankModels && versioning,
        staleTime: 60_000,
        retry: false,
    })
}

/** A new graph of the reader's: the workspace and the quota are read again — and the workspaces
 *  store, which the new view's page reads its data source from. */
function useGraphMade(workspaceId: string) {
    const queryClient = useQueryClient()
    return async () => {
        void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] })
        void queryClient.invalidateQueries({ queryKey: ['workspace-detail-phase2', workspaceId] })
        void queryClient.invalidateQueries({ queryKey: KEY })
        await useWorkspacesStore.getState().loadWorkspaces().catch(() => {})
    }
}

/** Start a graph from a sample. */
export function useStartSample(workspaceId: string) {
    const made = useGraphMade(workspaceId)
    return useMutation({
        mutationFn: (sampleId: string) => playgroundService.startSample(sampleId),
        onSuccess: made,
    })
}

/** Make a new graph of the reader's, with no rows yet: a file's rows come through the import. */
export function useCreateGraph(workspaceId: string) {
    const made = useGraphMade(workspaceId)
    return useMutation({
        mutationFn: (body: NewPlaygroundGraph) => playgroundService.createGraph(body),
        onSuccess: made,
    })
}

/** The semantic layers the reader may build on here. Under `['playground']`, so whatever reads
 *  the Playground again (a graph made, a layer of their own changed) reads these again too. */
export function usePlaygroundModels(enabled = true) {
    const playground = useFeature(PLAYGROUND_FEATURE)
    return useQuery({
        queryKey: [...KEY, 'models'],
        queryFn: () => playgroundService.listModels(),
        enabled: playground && enabled,
        staleTime: 30_000,
        retry: false,
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
