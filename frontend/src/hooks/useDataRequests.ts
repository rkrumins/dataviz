/**
 * Data requests: asking for data in a workspace, following what was asked, and — for
 * the platform team (`system:workspaces:create`), the workspace's admins and the named
 * Owner or Stewards of a source — taking it on, connecting it or declining it; never
 * one's own. Also the one Ask for data wizard, opened from a workspace's Data → Sources
 * and Overview, and mounted once in the app shell.
 */
import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import { dataRequestsService, type DataRequestDraft } from '@/services/dataRequestsService'
import { peopleService } from '@/services/peopleService'
import { useFeature } from '@/store/features'
import { useAuthStore, usePermission } from '@/store/auth'

export const DATA_REQUESTS_FEATURE = 'dataRequestsEnabled'
/** The platform team: answers every workspace's requests. */
export const PLATFORM_PERMISSION = 'system:workspaces:create'
const KEY = ['data-requests'] as const

/** The workspace a request is asked in: the Playground takes none. */
export interface AskTarget { id: string; name: string; kind?: string }

/** May this person answer every workspace's data requests (and decline them)? */
export function useIsPlatformTeam(): boolean {
    return useAuthStore(s => s.can(PLATFORM_PERMISSION))
}

/** Who may move this workspace's requests on, and how far. */
export interface FulfilRights {
    /** The platform team or the workspace's admins: start one, connect it to any of its
     *  sources or to none. */
    full: boolean
    /** The sources here this person is a named Owner or Steward of (directly or through a
     *  team): they may connect a request to one of these, and only these. */
    contactSourceIds: string[]
}

export function useFulfilRights(workspaceId: string | null | undefined): FulfilRights {
    const platform = usePermission(PLATFORM_PERMISSION)
    const admin = usePermission('workspace:admin', workspaceId ?? null)
    const full = platform || (!!workspaceId && admin)
    const meId = useAuthStore(s => s.user?.id)
    // Your own profile says which data you look after — the same read your profile page makes.
    const { data } = useQuery({
        queryKey: ['people', meId],
        queryFn: () => peopleService.profile(meId!),
        enabled: !full && !!meId && !!workspaceId,
        staleTime: 60_000,
        retry: false,
    })
    const contactSourceIds = useMemo(
        () => (data?.dataContacts ?? []).filter(c => c.workspaceId === workspaceId).map(c => c.dataSourceId),
        [data, workspaceId],
    )
    return { full, contactSourceIds }
}

/** May this person take on this workspace's requests? The platform team, the workspace's
 *  admins, or a named Owner or Steward of one of its sources — and never one they asked for
 *  themselves, which the lists and the review leave out. */
export function useCanFulfil(workspaceId: string | null | undefined): boolean {
    const { full, contactSourceIds } = useFulfilRights(workspaceId)
    return full || contactSourceIds.length > 0
}

/** What to say when the server refuses an answer to a request. */
export function dataRequestRefusal(e: unknown): string {
    const d = (e as { detail?: { type?: string; message?: string } } | null)?.detail
    if (d?.type === 'own_request') {
        return 'You asked for this data, so someone else has to take it on — a workspace admin, the platform team, '
            + 'or an Owner or Steward of the source it becomes.'
    }
    return d?.message || (e instanceof Error && e.message) || 'Couldn’t save your answer.'
}

export function useWorkspaceDataRequests(workspaceId: string | null | undefined) {
    const on = useFeature(DATA_REQUESTS_FEATURE)
    return useQuery({
        queryKey: [...KEY, 'workspace', workspaceId],
        queryFn: () => dataRequestsService.listForWorkspace(workspaceId!),
        enabled: on && !!workspaceId,
        staleTime: 30_000,
    })
}

export function useDataRequestsToAnswer(status = 'open') {
    const on = useFeature(DATA_REQUESTS_FEATURE)
    const can = useIsPlatformTeam()
    return useQuery({
        queryKey: [...KEY, 'answer', status],
        queryFn: () => dataRequestsService.listToAnswer(status),
        enabled: on && can,
        staleTime: 30_000,
    })
}

export function useDataRequestActions() {
    const queryClient = useQueryClient()
    const done = () => queryClient.invalidateQueries({ queryKey: KEY })
    return {
        submit: useMutation({
            mutationFn: ({ workspaceId, draft }: { workspaceId: string; draft: DataRequestDraft }) =>
                dataRequestsService.submit(workspaceId, draft),
            onSuccess: done,
        }),
        withdraw: useMutation({ mutationFn: (id: string) => dataRequestsService.withdraw(id), onSuccess: done }),
        start: useMutation({ mutationFn: (id: string) => dataRequestsService.start(id), onSuccess: done }),
        connect: useMutation({
            mutationFn: ({ id, dataSourceId, note }: { id: string; dataSourceId?: string | null; note?: string }) =>
                dataRequestsService.connect(id, { dataSourceId, note }),
            onSuccess: done,
        }),
        decline: useMutation({
            mutationFn: ({ id, reason }: { id: string; reason?: string }) => dataRequestsService.decline(id, reason),
            onSuccess: done,
        }),
    }
}

/** The Ask for data wizard, open on one workspace. */
interface AskWizardState {
    workspace: AskTarget | null
    openWizard: (workspace: AskTarget) => void
    closeWizard: () => void
}

export const useAskForDataWizard = create<AskWizardState>(set => ({
    workspace: null,
    openWizard: workspace => set({ workspace }),
    closeWizard: () => set({ workspace: null }),
}))

/** Opens Ask for data on `workspace` — or undefined where it can't be asked: the switch is
 *  off, the reader can't read the workspace's data, or it is the Playground. */
export function useAskForData(workspace: AskTarget | null | undefined): (() => void) | undefined {
    const on = useFeature(DATA_REQUESTS_FEATURE)
    const canRead = usePermission('workspace:datasource:read', workspace?.id ?? null)
    const openWizard = useAskForDataWizard(s => s.openWizard)
    if (!on || !canRead || !workspace || workspace.kind === 'playground') return undefined
    return () => openWizard({ id: workspace.id, name: workspace.name, kind: workspace.kind })
}
