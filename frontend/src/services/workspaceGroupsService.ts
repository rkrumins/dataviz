/**
 * A workspace's groups — the teams it gives access to — and their links to groups in the
 * identity provider.
 *
 * Groups a workspace owns are its admins' to manage: made for it (named "<workspace> ·
 * <name>"), given a role in it, filled with people, and linked to an identity-provider group
 * (an Active Directory group, say) so membership follows the directory. Groups it doesn't
 * own — platform-wide ones bound to it — are listed read-only. Linking a group to the
 * identity provider is a platform administrator's: anyone else's link waits as a request.
 */
import { authFetch } from './apiClient'
import type { ProposedGroupRole } from './workspaceRequestsService'

export type GroupRole = ProposedGroupRole

export interface GroupPerson { id: string; displayName?: string | null }

export interface IdpLink {
    mappingId: string
    idpGroup: string
    providerId?: string | null
    providerName?: string | null
}

export interface PendingIdpLink {
    requestId: string
    idpGroup: string
    requestedBy: string
    requestedByName?: string | null
    requestedAt: string
}

export interface WorkspaceGroup {
    id: string
    /** The full name, "<workspace> · <name>". */
    name: string
    /** The name without its workspace's. */
    shortName: string
    description?: string | null
    /** Made for this workspace and managed by its admins (else a platform-wide group bound to it). */
    owned: boolean
    /** Its role here (none for an owned group whose binding has gone). */
    role?: string | null
    roleLabel?: string | null
    memberCount: number
    memberPreview: GroupPerson[]
    source: string
    idpLinks: IdpLink[]
    pendingIdpLink?: PendingIdpLink | null
    createdAt: string
}

export interface GroupMember {
    id: string
    displayName?: string | null
    email?: string | null
    /** 'sso': the identity provider put them there (and takes them out). */
    source: 'local' | 'sso'
    addedAt: string
}

export interface NewGroup {
    name: string
    description?: string
    role: GroupRole
    memberIds: string[]
    idpGroup?: string
}

export interface IdpGroupSuggestion { idpGroup: string; seenCount?: number | null }

export interface IdpGroupPreview {
    idpGroup: string
    seenCount: number
    people: GroupPerson[]
    note: string
}

export interface IdpLinkRequest {
    id: string
    groupId: string
    groupName: string
    workspaceId: string
    workspaceName?: string | null
    idpGroup: string
    providerId?: string | null
    requestedBy: string
    requestedByName?: string | null
    requestedAt: string
    status: 'pending' | 'linked' | 'declined' | 'cancelled'
    source: 'workspace' | 'workspace_request'
    sourceId?: string | null
    resolvedBy?: string | null
    resolvedAt?: string | null
    resolutionNote?: string | null
    seenCount: number
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const base = (wsId: string) => `/api/v1/admin/workspaces/${encodeURIComponent(wsId)}/groups`
const one = (wsId: string, groupId: string) => `${base(wsId)}/${encodeURIComponent(groupId)}`

export const workspaceGroupsService = {
    list: (wsId: string) => authFetch<WorkspaceGroup[]>(base(wsId)),
    create: (wsId: string, body: NewGroup) => authFetch<WorkspaceGroup>(base(wsId), json(body)),
    update: (wsId: string, groupId: string, body: { name?: string; description?: string; role?: GroupRole }) =>
        authFetch<WorkspaceGroup>(one(wsId, groupId), json(body, 'PATCH')),
    remove: (wsId: string, groupId: string) => authFetch<void>(one(wsId, groupId), { method: 'DELETE' }),
    members: (wsId: string, groupId: string) => authFetch<GroupMember[]>(`${one(wsId, groupId)}/members`),
    addMember: (wsId: string, groupId: string, userId: string) =>
        authFetch<GroupMember>(`${one(wsId, groupId)}/members`, json({ userId })),
    removeMember: (wsId: string, groupId: string, userId: string) =>
        authFetch<void>(`${one(wsId, groupId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
    linkIdp: (wsId: string, groupId: string, idpGroup: string, providerId?: string | null) =>
        authFetch<WorkspaceGroup>(`${one(wsId, groupId)}/idp-link`, json({ idpGroup, providerId: providerId || undefined })),
    unlinkIdp: (wsId: string, groupId: string, mappingId: string) =>
        authFetch<void>(`${one(wsId, groupId)}/idp-links/${encodeURIComponent(mappingId)}`, { method: 'DELETE' }),
}

export const idpGroupsService = {
    /** Identity-provider groups to suggest: your own (from your sign-ins), or — for a platform
     *  administrator — every one seen, with how many people have it. */
    suggestions: (q: string, limit = 12) =>
        authFetch<IdpGroupSuggestion[]>(`/api/v1/idp-groups/suggestions?q=${encodeURIComponent(q)}&limit=${limit}`),
    /** Who had the group at their last single sign-on (platform administrators). */
    preview: (idpGroup: string) =>
        authFetch<IdpGroupPreview>(`/api/v1/admin/idp-groups/preview?idpGroup=${encodeURIComponent(idpGroup)}`),
}

export const idpLinkRequestsService = {
    list: (status: 'pending' | 'all' = 'pending') =>
        authFetch<IdpLinkRequest[]>(`/api/v1/admin/idp-link-requests?status=${status}`),
    link: (id: string, providerId?: string | null) =>
        authFetch<IdpLinkRequest>(`/api/v1/admin/idp-link-requests/${encodeURIComponent(id)}/link`, json({ providerId: providerId || undefined })),
    decline: (id: string, reason?: string) =>
        authFetch<IdpLinkRequest>(`/api/v1/admin/idp-link-requests/${encodeURIComponent(id)}/decline`, json({ reason: reason || undefined })),
}
