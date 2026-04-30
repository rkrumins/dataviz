/**
 * Permissions Service — read-only catalogue + role-definition + per-user
 * access endpoints. Backs the Permissions admin page.
 */
import { authFetch } from './apiClient'


// ── Types ────────────────────────────────────────────────────────────

export interface PermissionResponse {
    id: string                  // e.g. "workspace:view:edit"
    description: string
    category: 'system' | 'workspace' | 'resource'
}

export interface RoleDefinitionResponse {
    name: string
    description: string | null
    /** ``global`` means usable in any binding; ``workspace`` means
     *  only assignable inside the workspace whose id is ``scopeId``. */
    scopeType: 'global' | 'workspace'
    scopeId: string | null
    /** System roles (admin / user / viewer) are immutable. */
    isSystem: boolean
    permissions: string[]
    createdAt: string | null
    updatedAt: string | null
    createdBy: string | null
    /** Number of role_bindings rows referencing this role. The Delete
     *  button is disabled when this is > 0. */
    bindingCount: number
}

export interface RoleCreateRequest {
    name: string
    description?: string | null
    scopeType: 'global' | 'workspace'
    scopeId?: string | null
    permissions: string[]
}

export interface RoleUpdateRequest {
    description?: string | null
    permissions?: string[]
}


// ── Per-user access ──────────────────────────────────────────────────

export interface AccessBindingScope {
    type: 'global' | 'workspace'
    id: string | null           // NULL for global
    label: string | null        // workspace name when resolvable
}

export interface AccessViaGroup {
    id: string
    name: string
}

export interface AccessBinding {
    bindingId: string
    role: string                // 'admin' | 'user' | 'viewer'
    scope: AccessBindingScope
    grantedAt: string
    grantedBy: string | null
    /** When non-null, this binding was inherited via the named group. */
    viaGroup: AccessViaGroup | null
}

export interface AccessGroup {
    id: string
    name: string
    memberCount: number
}

export interface AccessSubject {
    id: string
    email: string
    displayName: string
    status: string
    /** Highest legacy DTO role string (admin > user > viewer). */
    role: string
}

export interface UserAccessResponse {
    user: AccessSubject
    /** Bindings whose subject is the user directly. */
    directBindings: AccessBinding[]
    /** Bindings inherited via a group the user belongs to. */
    inheritedBindings: AccessBinding[]
    /** Group memberships, with member counts. */
    groups: AccessGroup[]
    /** Effective global permissions (post-resolver, post-wildcard). */
    effectiveGlobal: string[]
    /** Effective per-workspace permissions, keyed by workspace id. */
    effectiveWs: Record<string, string[]>
}


// ── Service ──────────────────────────────────────────────────────────

export const permissionsService = {
    listPermissions(): Promise<PermissionResponse[]> {
        return authFetch<PermissionResponse[]>('/api/v1/admin/permissions')
    },

    /**
     * List roles. When ``opts.workspaceId`` is provided, returns
     * global roles **plus** roles scoped to that workspace — the
     * exact set of roles bindable inside that workspace.
     */
    listRoles(opts?: { workspaceId?: string }): Promise<RoleDefinitionResponse[]> {
        if (opts?.workspaceId) {
            const qs = new URLSearchParams({
                scopeType: 'workspace',
                scopeId: opts.workspaceId,
            }).toString()
            return authFetch<RoleDefinitionResponse[]>(`/api/v1/admin/roles?${qs}`)
        }
        return authFetch<RoleDefinitionResponse[]>('/api/v1/admin/roles')
    },

    createRole(req: RoleCreateRequest): Promise<RoleDefinitionResponse> {
        return authFetch<RoleDefinitionResponse>('/api/v1/admin/roles', {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    updateRole(name: string, req: RoleUpdateRequest): Promise<RoleDefinitionResponse> {
        return authFetch<RoleDefinitionResponse>(
            `/api/v1/admin/roles/${encodeURIComponent(name)}`,
            { method: 'PUT', body: JSON.stringify(req) },
        )
    },

    deleteRole(name: string): Promise<void> {
        return authFetch<void>(
            `/api/v1/admin/roles/${encodeURIComponent(name)}`,
            { method: 'DELETE' },
        )
    },

    getUserAccess(userId: string): Promise<UserAccessResponse> {
        return authFetch<UserAccessResponse>(
            `/api/v1/admin/users/${encodeURIComponent(userId)}/access`,
        )
    },
}
