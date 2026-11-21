/**
 * Workspace requests, for the requester (their own, and asking) and for the people who
 * answer them (platform and org admins: `system:workspaces:create`). Also the one
 * Request a workspace wizard, opened from anywhere — the Playground, the Dashboard,
 * Workspaces, an inbox link — and mounted once in the app shell.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import {
    workspaceRequestsService, type WorkspaceRequest, type WorkspaceRequestDraft,
} from '@/services/workspaceRequestsService'
import { useFeature } from '@/store/features'
import { useAuthStore } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'

export const WORKSPACE_REQUESTS_FEATURE = 'workspaceRequestsEnabled'
const KEY = ['workspace-requests'] as const

/** May this person answer workspace requests? Whoever may create workspaces. */
export function useCanAnswerWorkspaceRequests(): boolean {
    return useAuthStore(s => s.can('system:workspaces:create'))
}

export function useMyWorkspaceRequests() {
    const on = useFeature(WORKSPACE_REQUESTS_FEATURE)
    return useQuery({
        queryKey: [...KEY, 'mine'],
        queryFn: () => workspaceRequestsService.listMine(),
        enabled: on,
        staleTime: 30_000,
    })
}

export function useWorkspaceRequestsToAnswer(status = 'open') {
    const on = useFeature(WORKSPACE_REQUESTS_FEATURE)
    const can = useCanAnswerWorkspaceRequests()
    return useQuery({
        queryKey: [...KEY, 'answer', status],
        queryFn: () => workspaceRequestsService.listToAnswer(status),
        enabled: on && can,
        staleTime: 30_000,
    })
}

export function useWorkspaceRequest(id: string | null) {
    return useQuery({
        queryKey: [...KEY, 'one', id],
        queryFn: () => workspaceRequestsService.get(id!),
        enabled: !!id,
    })
}

export function useWorkspaceRequestActions() {
    const queryClient = useQueryClient()
    const done = () => queryClient.invalidateQueries({ queryKey: KEY })
    return {
        submit: useMutation({ mutationFn: (d: WorkspaceRequestDraft) => workspaceRequestsService.submit(d), onSuccess: done }),
        resubmit: useMutation({
            mutationFn: ({ id, draft }: { id: string; draft: WorkspaceRequestDraft }) => workspaceRequestsService.resubmit(id, draft),
            onSuccess: done,
        }),
        withdraw: useMutation({ mutationFn: (id: string) => workspaceRequestsService.withdraw(id), onSuccess: done }),
        approve: useMutation({
            mutationFn: ({ id, ...overrides }: {
                id: string; name?: string; description?: string
                groupNames?: Record<string, string>; idpProviderId?: string | null; admitToSandbox?: boolean
            }) => workspaceRequestsService.approve(id, overrides),
            onSuccess: async () => {
                await done()
                // The approver can open the new workspace straight away.
                await useWorkspacesStore.getState().loadWorkspaces()
            },
        }),
        sendBack: useMutation({
            mutationFn: ({ id, question }: { id: string; question: string }) => workspaceRequestsService.sendBack(id, question),
            onSuccess: done,
        }),
        decline: useMutation({
            mutationFn: ({ id, reason }: { id: string; reason?: string }) => workspaceRequestsService.decline(id, reason),
            onSuccess: done,
        }),
    }
}

/** The Request a workspace wizard: open from anywhere, on a fresh request (with graphs ticked
 *  already, from the Playground) or on one sent back, to answer and resend it. */
interface RequestWizardState {
    open: boolean
    preselectedSourceIds: string[]
    editing: WorkspaceRequest | null
    openWizard: (opts?: { preselectedSourceIds?: string[]; editing?: WorkspaceRequest }) => void
    closeWizard: () => void
}

export const useRequestWorkspaceWizard = create<RequestWizardState>(set => ({
    open: false,
    preselectedSourceIds: [],
    editing: null,
    openWizard: (opts = {}) => set({
        open: true, preselectedSourceIds: opts.preselectedSourceIds ?? [], editing: opts.editing ?? null,
    }),
    closeWizard: () => set({ open: false, editing: null, preselectedSourceIds: [] }),
}))
