/**
 * Access-requests Service — Phase 4.3 self-service workflow.
 *
 * Drives the "Request access" composer in ``AccessDeniedModal`` and
 * the My Pending Requests section on ``MyAccessPage``. The admin
 * inbox lives inside ``WorkspaceMembers`` and uses the
 * workspace-scoped ``listForWorkspace`` query.
 */
import { authFetch } from './apiClient'


// ── Types ────────────────────────────────────────────────────────────

export type AccessRequestStatus = 'pending' | 'approved' | 'denied'

export interface AccessRequestRequester {
    id: string
    email: string | null
    displayName: string | null
}

export interface AccessRequestTarget {
    type: 'workspace'
    id: string
    label: string | null
}

export interface AccessRequestResponse {
    id: string
    requester: AccessRequestRequester
    target: AccessRequestTarget
    requestedRole: string
    justification: string | null
    status: AccessRequestStatus
    createdAt: string
    resolvedAt: string | null
    resolvedBy: string | null
    resolutionNote: string | null
}

export interface AccessRequestCreateRequest {
    targetType: 'workspace'
    targetId: string
    requestedRole: string
    justification?: string | null
}

export interface AccessRequestResolveRequest {
    note?: string | null
}


// ── Service ──────────────────────────────────────────────────────────

export const accessRequestsService = {
    /** Submit a new access request as the current user. */
    submit(req: AccessRequestCreateRequest): Promise<AccessRequestResponse> {
        return authFetch<AccessRequestResponse>('/api/v1/access-requests', {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    /** Caller's own queue. Optional ``status`` filter. */
    listMine(opts?: { status?: AccessRequestStatus }): Promise<AccessRequestResponse[]> {
        const qs = opts?.status ? `?status=${encodeURIComponent(opts.status)}` : ''
        return authFetch<AccessRequestResponse[]>(`/api/v1/me/access-requests${qs}`)
    },

    /** Admin inbox for one workspace. Defaults to pending-only. */
    listForWorkspace(
        wsId: string,
        opts?: { status?: AccessRequestStatus | 'all' },
    ): Promise<AccessRequestResponse[]> {
        const status = opts?.status ?? 'pending'
        const qs = status === 'all' ? '' : `?status=${encodeURIComponent(status)}`
        return authFetch<AccessRequestResponse[]>(
            `/api/v1/admin/workspaces/${encodeURIComponent(wsId)}/access-requests${qs}`,
        )
    },

    /** Approve a pending request — atomically creates the binding. */
    approve(
        requestId: string,
        body?: AccessRequestResolveRequest,
    ): Promise<AccessRequestResponse> {
        return authFetch<AccessRequestResponse>(
            `/api/v1/admin/access-requests/${encodeURIComponent(requestId)}/approve`,
            { method: 'POST', body: JSON.stringify(body ?? {}) },
        )
    },

    /** Deny a pending request with an optional resolution note. */
    deny(
        requestId: string,
        body?: AccessRequestResolveRequest,
    ): Promise<AccessRequestResponse> {
        return authFetch<AccessRequestResponse>(
            `/api/v1/admin/access-requests/${encodeURIComponent(requestId)}/deny`,
            { method: 'POST', body: JSON.stringify(body ?? {}) },
        )
    },
}
