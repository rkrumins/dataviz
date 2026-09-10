/**
 * Groups Service — admin CRUD for user groups.
 *
 * Mirrors the backend's ``/api/v1/admin/groups`` surface. Subjects of
 * the form ``{type, id}`` are reused by ``workspaceMembersService`` and
 * ``viewGrantsService``; the response shapes share the alias scheme
 * (``camelCase`` JSON ↔ snake_case Python).
 */
import { authFetch } from './apiClient'

const API = '/api/v1/admin/groups'


// ── Types ────────────────────────────────────────────────────────────

/** One face in a group's avatar stack on the admin table. */
export interface GroupMemberPreview {
    id: string
    displayName: string | null
    /** The illustration this person picked, when they picked one. */
    avatarId?: string | null
}

export interface GroupResponse {
    id: string
    name: string
    description: string | null
    source: string
    externalId: string | null
    createdAt: string
    updatedAt: string
    memberCount: number
    /** First few members, so the table can draw faces instead of a bare
     *  number. Optional so an older backend still parses. */
    memberPreview?: GroupMemberPreview[]
}

export interface GroupCreateRequest {
    name: string
    description?: string | null
}

export interface GroupUpdateRequest {
    name?: string | null
    description?: string | null
}

export interface GroupMemberResponse {
    userId: string
    groupId: string
    addedAt: string
    addedBy: string | null
    /** "local" (an admin added them) or "sso" (the directory did, via a
     *  group mapping). Optional so an older backend still parses. */
    source?: string
    /** Server-resolved identity. The member list used to join these
     *  client-side against the admin user list, which capped at 50 rows
     *  and 403'd for a delegated groups admin. `null` means the id
     *  resolves to nothing — show the raw id, never invent a name. */
    displayName?: string | null
    email?: string | null
    status?: string | null
    /** A soft-deleted account still in the group; the list says so
     *  rather than showing them as current. */
    deleted?: boolean
    /** The picked illustration. `UserAvatar` prefers the provider photo,
     *  then this, then gradient initials. */
    avatarId?: string | null
}


// ── Service ──────────────────────────────────────────────────────────

export const groupsService = {
    list(opts?: { limit?: number; offset?: number }): Promise<GroupResponse[]> {
        const params = new URLSearchParams()
        if (opts?.limit != null) params.set('limit', String(opts.limit))
        if (opts?.offset != null) params.set('offset', String(opts.offset))
        const qs = params.toString()
        return authFetch<GroupResponse[]>(qs ? `${API}?${qs}` : API)
    },

    create(req: GroupCreateRequest): Promise<GroupResponse> {
        return authFetch<GroupResponse>(API, {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    update(groupId: string, req: GroupUpdateRequest): Promise<GroupResponse> {
        return authFetch<GroupResponse>(`${API}/${groupId}`, {
            method: 'PATCH',
            body: JSON.stringify(req),
        })
    },

    delete(groupId: string): Promise<void> {
        return authFetch<void>(`${API}/${groupId}`, { method: 'DELETE' })
    },

    listMembers(groupId: string): Promise<GroupMemberResponse[]> {
        return authFetch<GroupMemberResponse[]>(`${API}/${groupId}/members`)
    },

    addMember(groupId: string, userId: string): Promise<GroupMemberResponse> {
        return authFetch<GroupMemberResponse>(`${API}/${groupId}/members`, {
            method: 'POST',
            body: JSON.stringify({ userId }),
        })
    },

    removeMember(groupId: string, userId: string): Promise<void> {
        return authFetch<void>(`${API}/${groupId}/members/${userId}`, {
            method: 'DELETE',
        })
    },
}
