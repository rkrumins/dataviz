/**
 * Workspace Members Service — list and manage role bindings scoped to
 * one workspace. Maps to ``/api/v1/admin/workspaces/{ws}/members``.
 */
import type { AccessRequestManager } from './accessRequestsService'
import { authFetch } from './apiClient'
import { withReason, type ActivityOpts } from './activityReason'
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
    /** Granted around the identity provider: its end is moved only when
     *  confirmed as an exception again, and never cleared. */
    idpException?: boolean
}

/** One route by which a user holds a role in the workspace — a direct
 *  binding, or one inherited through a group. */
/** How a grant came about. ``joined``: the person joined a workspace open
 *  to everyone. */
export type AccessOrigin = 'direct' | 'request' | 'exception' | 'joined' | 'idp' | 'team' | 'org_role'

export interface AccessProvenance {
    origin: AccessOrigin
    /** The team or organization-wide role it came through. */
    source: string | null
    /** Who added or approved it, and when. */
    by: string | null
    at: string | null
    /** The access request it answered. */
    requestId: string | null
    /** The identity provider's groups that grant it, and the provider. */
    idpGroups: string[]
    idpProvider: string | null
}

export interface WorkspaceAccessGrant {
    role: string
    /** ``org``: an organization-wide role that reaches every workspace. */
    via: 'direct' | 'group' | 'org'
    bindingId: string
    groupId: string | null
    groupName: string | null
    expiresAt: string | null
    provenance?: AccessProvenance | null
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
    /** People who reach every workspace through an organization-wide role. */
    orgWideUsers?: number
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
    /** Confirms adding a person in the app to a workspace whose access its
     *  identity provider decides — the grant is marked as an exception. */
    exception?: boolean
}

export interface WorkspaceMemberExpiryUpdateRequest {
    expiresAt?: string | null
    expiresIn?: string | null
    /** Confirms an exception to the identity provider stays one. */
    exception?: boolean
}


// ── Service ──────────────────────────────────────────────────────────

/** What the caller may hand out in a workspace, already narrowed to what
 *  they could grant themselves. */
export interface WorkspaceGrantOptions {
    tier: 'admin' | 'steward'
    accessMode: 'app' | 'idp'
    /** ``requestable``: neither administers the workspace nor lets people in —
     *  the roles a service account may hold. */
    roles: { name: string; description: string | null; isSystem: boolean; requestable?: boolean }[]
    /** App-managed teams bound here whose every role the caller could grant. */
    groups: { id: string; name: string; memberCount: number; roles: string[] }[]
    /** Identity-provider groups whose members reach the workspace. */
    idpRoutes: {
        idpGroup: string
        provider: string | null
        role: string | null
        viaGroupId: string | null
        viaGroupName: string | null
    }[]
    /** The data sources any role here reads — there are no per-source grants
     *  inside a workspace. Absent on servers that predate it. */
    dataSources?: { id: string; label: string | null; restricted: boolean }[]
}

function url(wsId: string, suffix: string = ''): string {
    return `/api/v1/admin/workspaces/${encodeURIComponent(wsId)}/members${suffix}`
}


/** A service account that may be added here: what it is for, who manages it,
 *  and the roles it holds here already. */
export interface ServiceAccountCandidate {
    id: string
    name: string
    description: string | null
    managers: AccessRequestManager[]
    roles: string[]
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

    /** The roles, teams and identity-provider groups the caller may grant here. */
    grantOptions(wsId: string): Promise<WorkspaceGrantOptions> {
        return authFetch<WorkspaceGrantOptions>(url(wsId, '/grant-options'))
    },

    /** Enabled service accounts matching ``q``, to add here like a person. */
    serviceAccountCandidates(wsId: string, q: string): Promise<ServiceAccountCandidate[]> {
        const search = q ? `?q=${encodeURIComponent(q)}` : ''
        return authFetch<ServiceAccountCandidate[]>(url(wsId, `/service-accounts${search}`))
    },

    create(
        wsId: string,
        req: WorkspaceMemberCreateRequest,
        opts?: ActivityOpts,
    ): Promise<WorkspaceMemberResponse> {
        return authFetch<WorkspaceMemberResponse>(url(wsId), withReason({
            method: 'POST',
            body: JSON.stringify(req),
        }, opts?.reason))
    },

    revoke(wsId: string, bindingId: string, opts?: ActivityOpts): Promise<void> {
        return authFetch<void>(url(wsId, `/${bindingId}`), withReason({ method: 'DELETE' }, opts?.reason))
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
