/**
 * Admin User Service — manage user accounts, roles, and approvals.
 */
import { authFetch, authFetchPage } from './apiClient'

const ADMIN_USERS_API = '/api/v1/admin/users'

/** One linked SSO identity as the admin list carries it. */
export interface AdminUserIdentityRef {
    providerId: string
    slug: string
    displayName: string
    kind: string
    lastLoginAt: string | null
}

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
    /** Still holding a shipped default password, and required to
     *  change it before it can do anything else. */
    mustChangePassword: boolean
    /** How the account signs in: a usable password (the disabled
     *  sentinel counts as none)… */
    hasPassword: boolean
    /** …where the account came from (local_signup | sso_jit | invite |
     *  admin_created | admin_linked)… */
    signupSource: string | null
    /** …and the SSO identities linked to it, with which IdP each is. */
    identities: AdminUserIdentityRef[]
    /** Break-glass: keeps password sign-in under SSO enforcement, and
     *  forced sign-out sweeps skip it. */
    isSystemAccount: boolean
    /** Last successful sign-in of any kind (password, invite, OIDC, SAML,
     *  portal, Enterprise Gateway, silent gateway re-sign-in). The three
     *  activity stamps are null until it happens after tracking began, and
     *  absent from older servers. */
    lastLoginAt?: string | null
    /** Last time the account had the app open (its last authenticated
     *  request), to 5-minute resolution. */
    lastSeenAt?: string | null
    /** Last action that counts toward Activity analytics (opened a view,
     *  searched/traced, exported/published, edited a view), to 5-minute
     *  resolution. */
    lastActiveAt?: string | null
}

/** The admin user list's sortable columns. The server sorts by what each
 *  column shows (the resolved display name, the role or its default);
 *  never-seen / never-signed-in accounts sort last either way. */
export type AdminUserSort =
    | 'name' | 'email' | 'status' | 'role' | 'createdAt' | 'lastSeenAt' | 'lastLoginAt'

export interface ListUsersParams {
    status?: string
    /** Matched server-side against name, email, user id, role and the
     *  linked sign-in providers. */
    search?: string
    sort?: AdminUserSort
    order?: 'asc' | 'desc'
    limit: number
    offset?: number
}

/** Counts across every account — the list itself is paged. */
export interface AdminUserStats {
    total: number
    pending: number
    active: number
    suspended: number
    /** Platform admins: super_admin + org_admin. */
    admins: number
    resetRequested: number
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
    /** Phase 15: the ledger row backing this link, so the success card
     *  can point at something revocable. */
    inviteId: string | null
    maxUses: number | null
    emailDomain: string | null
}

/** Phase 15: a row in the outstanding-links list. Carries NO token —
 *  the link is copyable when it is created, and a read-only list must
 *  not become somewhere credentials can be harvested. */
export interface InviteSummary {
    id: string
    role: string | null
    workspaceId: string | null
    workspaceName: string | null
    email: string | null
    emailDomain: string | null
    groupIds: string[]
    groupNames: string[]
    maxUses: number | null
    useCount: number
    redemptionCount: number
    /** Derived server-side, never stored. */
    status: 'active' | 'revoked' | 'expired' | 'exhausted'
    createdBy: string
    createdAt: string
    expiresAt: string
    revokedAt: string | null
    revokedBy: string | null
}

/** Phase 15: what happened for one address in a bulk invite. */
export interface BulkInviteResult {
    email: string
    outcome: 'created' | 'already_a_user' | 'invalid_email' | 'duplicate' | 'failed'
    inviteToken: string | null
    inviteId: string | null
    detail: string | null
}

export interface BulkInviteResponse {
    created: number
    skipped: number
    results: BulkInviteResult[]
    expiresAt: string
}

/** Phase 15: somebody joined through one of MY links. */
export interface InviteActivityItem {
    id: string
    email: string
    userId: string
    redeemedAt: string
    inviteId: string
    role: string | null
    workspaceId: string | null
    workspaceName: string | null
}

export interface InviteRedemption {
    id: string
    userId: string
    email: string
    redeemedAt: string
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
    /** Phase 15: seat cap. Omit / null for unlimited until expiry. */
    maxUses?: number | null
    /** Phase 15: restrict a shareable link to one mail domain. Ignored
     *  when ``email`` pins a single address, which is narrower. */
    emailDomain?: string | null
}

export const adminUserService = {
    /** One page of accounts, searched and sorted server-side. ``total`` is
     *  how many match across EVERY page — never infer it from the page. */
    listUsers(params: ListUsersParams): Promise<{ items: AdminUserResponse[]; total: number }> {
        const query = new URLSearchParams({
            limit: String(params.limit),
            offset: String(params.offset ?? 0),
        })
        if (params.status) query.set('status', params.status)
        if (params.search?.trim()) query.set('search', params.search.trim())
        if (params.sort) query.set('sort', params.sort)
        if (params.order) query.set('order', params.order)
        return authFetchPage<AdminUserResponse>(`${ADMIN_USERS_API}?${query}`)
    },

    getStats(): Promise<AdminUserStats> {
        return authFetch<AdminUserStats>(`${ADMIN_USERS_API}/stats`)
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

    /** Mark or unmark the break-glass flag. */
    setSystemAccount(
        userId: string, isSystemAccount: boolean,
    ): Promise<AdminUserResponse> {
        return authFetch<AdminUserResponse>(
            `${ADMIN_USERS_API}/${userId}/system-account`,
            {
                method: 'POST',
                body: JSON.stringify({ isSystemAccount }),
            },
        )
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
        if (opts.maxUses) body.maxUses = opts.maxUses
        if (opts.emailDomain) body.emailDomain = opts.emailDomain
        return authFetch<InviteResponse>(`${ADMIN_USERS_API}/invite`, {
            method: 'POST',
            body: JSON.stringify(body),
        })
    },

    /** Outstanding links. A platform admin sees all of them; anyone
     *  else sees only the ones they created. */
    listInvites(status: string = 'active'): Promise<InviteSummary[]> {
        return authFetch<InviteSummary[]>(
            `${ADMIN_USERS_API}/invites?status=${encodeURIComponent(status)}`,
        )
    },

    /** Kill a link now, regardless of expiry or remaining seats. */
    revokeInvite(inviteId: string): Promise<InviteSummary> {
        return authFetch<InviteSummary>(
            `${ADMIN_USERS_API}/invites/${encodeURIComponent(inviteId)}/revoke`,
            { method: 'POST' },
        )
    },

    /** People who signed up through links I created, newest first.
     *  Scoped to the caller — this answers "did my invitation work?",
     *  not "who joined the company". */
    listMyInviteActivity(): Promise<InviteActivityItem[]> {
        return authFetch<InviteActivityItem[]>('/api/v1/users/me/invite-activity')
    },

    /** One email-pinned link per address, from one set of settings.
     *  Partial success is normal and reported per row. */
    createBulkInvites(
        emails: string[],
        role: string | null,
        opts: CreateInviteOptions = {},
    ): Promise<BulkInviteResponse> {
        const body: Record<string, unknown> = {
            emails,
            expiresInHours: opts.expiresInHours ?? 72,
        }
        if (role) body.role = role
        if (opts.workspaceId) body.workspaceId = opts.workspaceId
        if (opts.groupIds && opts.groupIds.length > 0) body.groupIds = opts.groupIds
        return authFetch<BulkInviteResponse>(`${ADMIN_USERS_API}/invite/bulk`, {
            method: 'POST',
            body: JSON.stringify(body),
        })
    },

    /** Create one account outright, rather than handing out a link.
     *
     *  The other door in: an invite is somebody provisioning themselves
     *  from a link you sent; this is you provisioning them directly. */
    createUser(body: CreateUserRequest): Promise<CreatedUser> {
        return authFetch<CreatedUser>(ADMIN_USERS_API, {
            method: 'POST',
            body: JSON.stringify(body),
        })
    },

    /** Several accounts from one set of settings. Reports per row, so
     *  one address that already exists does not cost the others. */
    createUsersBulk(body: BulkCreateUsersRequest): Promise<BulkCreateUsersResponse> {
        return authFetch<BulkCreateUsersResponse>(`${ADMIN_USERS_API}/bulk`, {
            method: 'POST',
            body: JSON.stringify(body),
        })
    },

    /** Give a link more time (and optionally more seats). The URL
     *  already shared keeps working. */
    extendInvite(
        inviteId: string,
        opts: { expiresInHours: number; additionalUses?: number | null },
    ): Promise<InviteSummary> {
        const body: Record<string, unknown> = { expiresInHours: opts.expiresInHours }
        if (opts.additionalUses) body.additionalUses = opts.additionalUses
        return authFetch<InviteSummary>(
            `${ADMIN_USERS_API}/invites/${encodeURIComponent(inviteId)}/extend`,
            { method: 'POST', body: JSON.stringify(body) },
        )
    },

    /** Issue a fresh URL for the same invitation. Every URL already
     *  handed out stops working — that is the difference from extend. */
    regenerateInvite(
        inviteId: string,
        opts: { expiresInHours: number },
    ): Promise<InviteResponse> {
        return authFetch<InviteResponse>(
            `${ADMIN_USERS_API}/invites/${encodeURIComponent(inviteId)}/regenerate`,
            { method: 'POST', body: JSON.stringify({ expiresInHours: opts.expiresInHours }) },
        )
    },

    listInviteRedemptions(inviteId: string): Promise<InviteRedemption[]> {
        return authFetch<InviteRedemption[]>(
            `${ADMIN_USERS_API}/invites/${encodeURIComponent(inviteId)}/redemptions`,
        )
    },
}

// ── Admin-created accounts ────────────────────────────────────────────

/** How a newly created account first signs in.
 *
 *  `setup_link` leaves no usable password at all — the account exists,
 *  and a one-time link lets the person choose their own, so nobody
 *  (including the admin who created it) ever knows it. That is why it is
 *  the default rather than the admin typing one.
 */
export type CredentialMode = 'setup_link' | 'password' | 'sso_only'

export interface CreateUserRequest {
    email: string
    firstName: string
    lastName: string
    role?: string | null
    workspaceId?: string | null
    groupIds?: string[] | null
    credential?: CredentialMode
    password?: string | null
    activate?: boolean
}

export interface CreatedUser {
    id: string
    email: string
    firstName: string
    lastName: string
    status: string
    role: string | null
    workspaceId: string | null
    groupIds: string[]
    /** Present only for `setup_link`, and only this once. */
    setupToken: string | null
    setupExpiresAt: string | null
}

export interface BulkCreateUserRow {
    email: string
    firstName?: string | null
    lastName?: string | null
}

export interface BulkCreateUsersRequest {
    users: BulkCreateUserRow[]
    role?: string | null
    workspaceId?: string | null
    groupIds?: string[] | null
    credential?: CredentialMode
    activate?: boolean
}

export interface BulkCreateUserResult {
    email: string
    outcome: 'created' | 'already_a_user' | 'invalid_email' | 'duplicate' | 'failed'
    userId: string | null
    setupToken: string | null
    detail: string | null
}

export interface BulkCreateUsersResponse {
    created: number
    skipped: number
    results: BulkCreateUserResult[]
}
