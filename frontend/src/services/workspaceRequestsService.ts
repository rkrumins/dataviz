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

/** What a proposed group may do in the workspace. */
export type ProposedGroupRole = 'workspace_viewer' | 'workspace_member' | 'workspace_publisher'

/** A group the requester proposes for the workspace: made on approval, bound to the workspace with
 *  `role`, with `memberIds` in it — and, when `idpGroup` names a group in the identity provider
 *  (an Active Directory group, say), linked to it so its membership follows the directory. */
export interface ProposedGroup {
    /** The requester's own id for it, so an approver's rename can name it. */
    key: string
    /** Short — created as "<workspace> · <name>". */
    name: string
    description?: string
    role: ProposedGroupRole
    memberIds: string[]
    /** On a read: the members by name. */
    members?: WorkspaceRequestPerson[]
    idpGroup?: string | null
}

export interface WorkspaceRequestOutcome {
    workspaceId?: string | null
    movedSources: string[]
    failedSources: { id: string; reason: string }[]
    membersAdded: string[]
    /** The groups made: the proposal's key, the group, its full name. */
    groupsCreated?: { key: string; groupId: string; name: string }[]
    /** Groups linked to the identity provider on approval. */
    idpLinksCreated?: { groupId: string; idpGroup: string }[]
    /** Links waiting for a platform administrator to confirm. */
    idpLinksPending?: { groupId: string; groupName: string; idpGroup: string }[]
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
    groups?: ProposedGroup[]
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
    /** Approver detail: whether the Playground's sandbox connection lets a new workspace in
     *  (null when no graph comes along). */
    sandboxAdmitsNew?: boolean | null
}

/** What the requester fills in. */
export interface WorkspaceRequestDraft {
    name: string
    description?: string
    purpose: WorkspacePurpose
    teamName?: string
    teammateIds: string[]
    playgroundSourceIds: string[]
    groups?: ProposedGroup[]
    dataNeeds?: string
    note?: string
}

/** The name a proposed group is created with. */
export const groupFullName = (workspaceName: string, groupName: string) =>
    `${workspaceName.trim()} · ${groupName.trim()}`

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
    approve: (id: string, overrides: {
        name?: string; description?: string
        /** Full names for the proposed groups, by key, where the approver changed them. */
        groupNames?: Record<string, string>
        /** The identity-provider connection the links are for; none means any connection. */
        idpProviderId?: string | null
        /** Allow the new workspace on the sandbox connection, so the graphs can move. */
        admitToSandbox?: boolean
    } = {}) =>
        authFetch<WorkspaceRequest>(`${ADMIN}/${encodeURIComponent(id)}/approve`, json(overrides)),
    /** A platform administrator links a group from an approved request to its identity-provider group. */
    sendBack: (id: string, question: string) =>
        authFetch<WorkspaceRequest>(`${ADMIN}/${encodeURIComponent(id)}/send-back`, json({ question })),
    decline: (id: string, reason?: string) =>
        authFetch<WorkspaceRequest>(`${ADMIN}/${encodeURIComponent(id)}/decline`, json({ reason: reason || undefined })),
}
