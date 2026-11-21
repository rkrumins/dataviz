/**
 * Workspace requests: someone who can't create workspaces asks for one of their own,
 * and a platform or org admin approves it (renaming it first if need be), sends it
 * back with a question, or declines it. On approval the requester becomes the new
 * workspace's admin, the teammates they named join it, and the Playground graphs they
 * chose move into it with their views. Behind `workspaceRequestsEnabled`.
 */
import { authFetch } from './apiClient'

export type WorkspaceRequestStatus = 'pending' | 'changes_requested' | 'approved' | 'declined' | 'withdrawn'
export type WorkspacePurpose = 'team' | 'project' | 'poc' | 'reporting' | 'other'

export const OPEN_REQUEST_STATUSES: readonly WorkspaceRequestStatus[] = ['pending', 'changes_requested']

export interface WorkspaceRequestPerson {
    id: string
    displayName: string
}

export interface WorkspaceRequestSource {
    id: string
    label: string
    viewCount: number
}

export interface WorkspaceRequestOutcome {
    workspaceId?: string | null
    movedSources: string[]
    failedSources: { id: string; reason: string }[]
    membersAdded: string[]
}

export interface WorkspaceRequest {
    id: string
    requesterId: string
    requesterName?: string | null
    name: string
    description?: string | null
    purpose: WorkspacePurpose
    teamName?: string | null
    teammateIds: string[]
    teammates?: WorkspaceRequestPerson[]
    playgroundSourceIds: string[]
    playgroundSources?: WorkspaceRequestSource[]
    dataNeeds?: string | null
    note?: string | null
    status: WorkspaceRequestStatus
    /** The approver's question, while it is sent back. */
    question?: string | null
    createdAt: string
    updatedAt?: string | null
    resolvedAt?: string | null
    resolvedBy?: string | null
    resolutionNote?: string | null
    workspaceId?: string | null
    outcome?: WorkspaceRequestOutcome | null
    /** Approver detail only: how to reach the requester, and what they built in the Playground. */
    requesterEmail?: string | null
    playgroundActivity?: { graphs: number; views: number }
}

/** What the requester fills in. */
export interface WorkspaceRequestDraft {
    name: string
    description?: string
    purpose: WorkspacePurpose
    teamName?: string
    teammateIds: string[]
    playgroundSourceIds: string[]
    dataNeeds?: string
    note?: string
}

/** The refusal a taken name comes back with, carrying a free one to use instead. */
export function nameTakenSuggestion(error: unknown): string | null {
    const detail = (error as { detail?: unknown } | null)?.detail as { type?: string; suggestion?: string } | undefined
    return detail?.type === 'name_taken' ? detail.suggestion ?? null : null
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

const ME = '/api/v1/me/workspace-requests'
const ADMIN = '/api/v1/admin/workspace-requests'

export const workspaceRequestsService = {
    submit: (draft: WorkspaceRequestDraft) => authFetch<WorkspaceRequest>('/api/v1/workspace-requests', json(draft)),
    listMine: () => authFetch<WorkspaceRequest[]>(ME),
    getMine: (id: string) => authFetch<WorkspaceRequest>(`${ME}/${encodeURIComponent(id)}`),
    resubmit: (id: string, draft: WorkspaceRequestDraft) =>
        authFetch<WorkspaceRequest>(`${ME}/${encodeURIComponent(id)}`, json(draft, 'PUT')),
    withdraw: (id: string) => authFetch<WorkspaceRequest>(`${ME}/${encodeURIComponent(id)}/withdraw`, { method: 'POST' }),

    listToAnswer: (status = 'open') => authFetch<WorkspaceRequest[]>(`${ADMIN}?status=${encodeURIComponent(status)}`),
    get: (id: string) => authFetch<WorkspaceRequest>(`${ADMIN}/${encodeURIComponent(id)}`),
    approve: (id: string, overrides: { name?: string; description?: string } = {}) =>
        authFetch<WorkspaceRequest>(`${ADMIN}/${encodeURIComponent(id)}/approve`, json(overrides)),
    sendBack: (id: string, question: string) =>
        authFetch<WorkspaceRequest>(`${ADMIN}/${encodeURIComponent(id)}/send-back`, json({ question })),
    decline: (id: string, reason?: string) =>
        authFetch<WorkspaceRequest>(`${ADMIN}/${encodeURIComponent(id)}/decline`, json({ reason: reason || undefined })),
}
