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
     *  Built-ins (admin / user / viewer) plus any custom role. */
    role: string
    grantedAt: string
    grantedBy: string | null
    subject: MemberSubject
}

export interface WorkspaceMemberCreateRequest {
    subjectType: 'user' | 'group'
    subjectId: string
    role: string  // see WorkspaceMemberResponse.role
}


// ── Service ──────────────────────────────────────────────────────────

function url(wsId: string, suffix: string = ''): string {
    return `/api/v1/admin/workspaces/${encodeURIComponent(wsId)}/members${suffix}`
}


export const workspaceMembersService = {
    list(wsId: string): Promise<WorkspaceMemberResponse[]> {
        return authFetch<WorkspaceMemberResponse[]>(url(wsId))
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
