/**
 * Workspace Members Service — list and manage role bindings scoped to
 * one workspace. Maps to ``/api/v1/admin/workspaces/{ws}/members``.
 */
import { authFetch } from './apiClient'
import type { ImpactPreviewResponse } from './permissionsService'


// ── Types ────────────────────────────────────────────────────────────

export interface MemberSubject {
    type: 'user' | 'group'
    id: string
    displayName: string | null
    secondary: string | null
}

export interface WorkspaceMemberResponse {
    bindingId: string
    /** Phase 3: any role name in the canonical ``roles`` table.
     *  Built-ins (workspace_admin / workspace_member / workspace_viewer)
     *  plus any custom role. */
    role: string
    grantedAt: string
    grantedBy: string | null
    /** Phase 7: ISO timestamp when the binding auto-expires, or
     *  ``null`` for permanent bindings. Used by the FE to render
     *  countdown badges and warn before access lapses. */
    expiresAt: string | null
    subject: MemberSubject
}

/** One route by which a user holds a role in the workspace — a direct
 *  binding, or one inherited through a group. */
export interface WorkspaceAccessGrant {
    role: string
    via: 'direct' | 'group'
    bindingId: string
    groupId: string | null
    groupName: string | null
    expiresAt: string | null
}

/** A person with effective access, flattened across their direct
 *  binding(s) and every bound group they belong to. */
export interface WorkspaceAccessUser {
    userId: string
    displayName: string | null
    email: string | null
    avatarId: string | null
    status: string | null
    deleted: boolean
    /** Distinct roles held here; permissions are the union of these. */
    roles: string[]
    /** Single badge label — the highest-precedence built-in role, or the
     *  first role when only custom ones are held. See ``roles`` for all. */
    effectiveRole: string
    grants: WorkspaceAccessGrant[]
}

export interface WorkspaceAccessResponse {
    users: WorkspaceAccessUser[]
    totalUsers: number
    /** Users with ≥1 binding of each kind. A user can be in BOTH, so
     *  these need not sum to ``totalUsers``. */
    directUsers: number
    viaGroupUsers: number
}

export interface WorkspaceMemberCreateRequest {
    subjectType: 'user' | 'group'
    subjectId: string
    role: string  // see WorkspaceMemberResponse.role
    /** Phase 7: one of these two — never both. ``expiresAt`` is an
     *  ISO timestamp; ``expiresIn`` is a duration shortcut the
     *  backend normalises (``"24h"`` / ``"7d"`` / ``"2w"``). Omit
     *  both for a permanent binding. */
    expiresAt?: string | null
    expiresIn?: string | null
}

export interface WorkspaceMemberExpiryUpdateRequest {
    expiresAt?: string | null
    expiresIn?: string | null
}


// ── Service ──────────────────────────────────────────────────────────

function url(wsId: string, suffix: string = ''): string {
    return `/api/v1/admin/workspaces/${encodeURIComponent(wsId)}/members${suffix}`
}


export const workspaceMembersService = {
    list(wsId: string): Promise<WorkspaceMemberResponse[]> {
        return authFetch<WorkspaceMemberResponse[]>(url(wsId))
    },

    /** The flattened, inheritance-aware access list: every distinct
     *  person who can reach the workspace, directly or via a bound
     *  group, with the route(s) that got them there. */
    listEffective(wsId: string): Promise<WorkspaceAccessResponse> {
        return authFetch<WorkspaceAccessResponse>(url(wsId, '/effective'))
    },

    create(
        wsId: string,
        req: WorkspaceMemberCreateRequest,
    ): Promise<WorkspaceMemberResponse> {
        return authFetch<WorkspaceMemberResponse>(url(wsId), {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    revoke(wsId: string, bindingId: string): Promise<void> {
        return authFetch<void>(url(wsId, `/${bindingId}`), { method: 'DELETE' })
    },

    /**
     * Phase 7 — extend, change, or clear a binding's expiry.
     * Sending an empty body (no ``expiresAt`` and no ``expiresIn``)
     * clears the expiry → permanent binding.
     */
    updateExpiry(
        wsId: string,
        bindingId: string,
        req: WorkspaceMemberExpiryUpdateRequest,
    ): Promise<WorkspaceMemberResponse> {
        return authFetch<WorkspaceMemberResponse>(
            url(wsId, `/${bindingId}/expiry`),
            { method: 'PUT', body: JSON.stringify(req) },
        )
    },

    /**
     * Phase 4.4 — read-only sibling of revoke: compute the user
     * (or every group member's) gained/lost permissions before
     * actually committing the revoke.
     */
    previewRevoke(
        wsId: string,
        bindingId: string,
    ): Promise<ImpactPreviewResponse> {
        return authFetch<ImpactPreviewResponse>(
            url(wsId, `/${bindingId}/preview-revoke`),
            { method: 'POST', body: JSON.stringify({}) },
        )
    },
}
