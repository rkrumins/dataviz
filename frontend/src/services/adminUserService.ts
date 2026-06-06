/**
 * Admin User Service — manage user accounts, roles, and approvals.
 */
import { authFetch } from './apiClient'

const ADMIN_USERS_API = '/api/v1/admin/users'

export interface AdminUserResponse {
    id: string
    email: string
    firstName: string
    lastName: string
    displayName: string
    status: string
    role: string
    createdAt: string
    updatedAt: string
    resetRequested: boolean
}

export interface ResetTokenResponse {
    resetToken: string
    expiresAt: string
}

export interface InviteResponse {
    inviteToken: string
    role: string | null
    /** Phase 11: workspace the invite binds into (workspace-scoped
     *  roles) and the pinned email (privileged / email-bound
     *  invites). Both null for a global shareable invite. */
    workspaceId: string | null
    email: string | null
    /** Phase 13: groups the new user is added to on signup. */
    groupIds: string[] | null
    expiresAt: string
}

export interface CreateInviteOptions {
    workspaceId?: string | null
    email?: string | null
    /** Phase 13: optional list of group ids to attach on signup. */
    groupIds?: string[] | null
    /** Phase 14: opt-in escape hatch for shareable group invites.
     *  Default ``false`` keeps the safe behavior (groups → email
     *  required). Setting ``true`` bypasses the groups-email check
     *  on the backend and emits a distinct audit event. It does NOT
     *  bypass the privileged-role email requirement. */
    allowShareableWithGroups?: boolean
    expiresInHours?: number
}

export const adminUserService = {
    listUsers(status?: string): Promise<AdminUserResponse[]> {
        const params = status ? `?status=${encodeURIComponent(status)}` : ''
        return authFetch<AdminUserResponse[]>(`${ADMIN_USERS_API}${params}`)
    },

    approveUser(userId: string): Promise<{ detail: string }> {
        return authFetch<{ detail: string }>(`${ADMIN_USERS_API}/${userId}/approve`, {
            method: 'POST',
        })
    },

    rejectUser(userId: string, rejectionReason?: string): Promise<{ detail: string }> {
        return authFetch<{ detail: string }>(`${ADMIN_USERS_API}/${userId}/reject`, {
            method: 'POST',
            body: JSON.stringify({ rejectionReason: rejectionReason || null }),
        })
    },

    changeRole(userId: string, role: string): Promise<{ detail: string }> {
        return authFetch<{ detail: string }>(`${ADMIN_USERS_API}/${userId}/role`, {
            method: 'PUT',
            body: JSON.stringify({ role }),
        })
    },

    /** Admin-side identity edit. Both fields optional; backend
     *  ignores undefined and trims whitespace. Email is intentionally
     *  not editable here — it's the SSO identity key. */
    updateUser(
        userId: string,
        body: { firstName?: string; lastName?: string },
    ): Promise<AdminUserResponse> {
        return authFetch<AdminUserResponse>(`${ADMIN_USERS_API}/${userId}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
        })
    },

    suspendUser(userId: string): Promise<{ detail: string }> {
        return authFetch<{ detail: string }>(`${ADMIN_USERS_API}/${userId}/suspend`, {
            method: 'POST',
        })
    },

    reactivateUser(userId: string): Promise<{ detail: string }> {
        return authFetch<{ detail: string }>(`${ADMIN_USERS_API}/${userId}/reactivate`, {
            method: 'POST',
        })
    },

    resetPassword(userId: string, newPassword: string): Promise<{ detail: string }> {
        return authFetch<{ detail: string }>(`${ADMIN_USERS_API}/${userId}/reset-password`, {
            method: 'POST',
            body: JSON.stringify({ newPassword }),
        })
    },

    generateResetToken(userId: string): Promise<ResetTokenResponse> {
        return authFetch<ResetTokenResponse>(`${ADMIN_USERS_API}/${userId}/generate-reset-token`, {
            method: 'POST',
        })
    },

    createInvite(
        role: string | null = null,
        opts: CreateInviteOptions = {},
    ): Promise<InviteResponse> {
        // Phase 11: ``role`` is optional (null = plain activated
        // account). Workspace-scoped roles take ``workspaceId``;
        // privileged roles take ``email`` to bind the link to one
        // identity. The backend validates the role × scope ×
        // privilege rules.
        const body: Record<string, unknown> = {
            expiresInHours: opts.expiresInHours ?? 72,
        }
        if (role) body.role = role
        if (opts.workspaceId) body.workspaceId = opts.workspaceId
        if (opts.email) body.email = opts.email
        if (opts.groupIds && opts.groupIds.length > 0) body.groupIds = opts.groupIds
        if (opts.allowShareableWithGroups) body.allowShareableWithGroups = true
        return authFetch<InviteResponse>(`${ADMIN_USERS_API}/invite`, {
            method: 'POST',
            body: JSON.stringify(body),
        })
    },
}
