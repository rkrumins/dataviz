/**
 * Access-requests Service — asking to join a workspace, and answering.
 *
 * Drives Request access (``RequestAccessDialog``, from Find a workspace,
 * the access-denied card and a workspace you can't open), the requests
 * on ``MyAccessPage``, and — for the people who let others in — the
 * Requests tab: one list across every workspace they answer, approved
 * with a role or a team, pointed to the identity provider, or denied.
 */
import { authFetch } from './apiClient'


// ── Types ────────────────────────────────────────────────────────────

/** ``awaiting_idp``: an approver pointed the person to the identity-provider
 *  group that grants it; it closes itself when that access arrives. */
export type AccessRequestStatus = 'pending' | 'awaiting_idp' | 'approved' | 'denied' | 'withdrawn'

/** A list filter: the open ones (pending or waiting on the identity
 *  provider), every one, or a single status. */
export type AccessRequestFilter = 'open' | 'all' | AccessRequestStatus

export const OPEN_STATUSES: readonly AccessRequestStatus[] = ['pending', 'awaiting_idp']

export interface AccessRequestRequester {
    id: string
    email: string | null
    displayName: string | null
    /** Has ever signed in through an identity provider — pointing someone
     *  who hasn't to an IdP group would leave their request waiting. */
    ssoLinked?: boolean
}

/** Who decides who is in a workspace: approvers here, or its identity
 *  provider's groups. */
export type WorkspaceAccessMode = 'app' | 'idp'

export interface AccessRequestTarget {
    type: 'workspace'
    id: string
    /** Withheld (null) from a requester who couldn't otherwise see the workspace. */
    label: string | null
    accessMode?: WorkspaceAccessMode | null
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
    /** What the approver decided: the role granted, or the team… */
    grantedRole?: string | null
    grantedGroup?: { id: string; name: string | null } | null
    /** …or the identity-provider group they were pointed to. */
    idpGroup?: string | null
    idpProvider?: string | null
    /** Granted in the app for a workspace whose identity provider decides. */
    idpException?: boolean
    accessExpiresAt?: string | null
    /** When access through the identity provider arrived. */
    fulfilledAt?: string | null
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

/** Approve with a role (the one asked for when neither is given),
 *  optionally until a date, or by adding the person to a team.
 *  ``exception`` confirms granting in the app where the identity
 *  provider decides. */
export interface AccessRequestApproveRequest {
    note?: string | null
    role?: string | null
    groupId?: string | null
    expiresAt?: string | null
    expiresIn?: string | null
    exception?: boolean
}

export interface AccessRequestRouteRequest {
    idpGroup: string
    note?: string | null
}

/** A role someone may ask for (or an approver may grant) in a workspace. */
export interface RequestableRole {
    name: string
    description: string | null
    isSystem: boolean
}


// ── Service ──────────────────────────────────────────────────────────

const filterQuery = (status?: AccessRequestFilter) =>
    status ? `status=${encodeURIComponent(status)}` : ''

export const accessRequestsService = {
    /** The roles anyone may ask for in a workspace — never its name. */
    requestableRoles(workspaceId: string): Promise<RequestableRole[]> {
        return authFetch<RequestableRole[]>(
            `/api/v1/access-requests/requestable-roles?workspaceId=${encodeURIComponent(workspaceId)}`,
        )
    },

    /** Ask to join. Asking again returns the open request. */
    submit(req: AccessRequestCreateRequest): Promise<AccessRequestResponse> {
        return authFetch<AccessRequestResponse>('/api/v1/access-requests', {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    /** Caller's own requests, newest first. */
    listMine(opts?: { status?: AccessRequestFilter }): Promise<AccessRequestResponse[]> {
        const qs = filterQuery(opts?.status)
        return authFetch<AccessRequestResponse[]>(`/api/v1/me/access-requests${qs ? `?${qs}` : ''}`)
    },

    /** Take back one of your open requests. */
    withdraw(requestId: string): Promise<AccessRequestResponse> {
        return authFetch<AccessRequestResponse>(
            `/api/v1/me/access-requests/${encodeURIComponent(requestId)}/withdraw`,
            { method: 'POST', body: '{}' },
        )
    },

    /** Every request the caller answers, across their workspaces. Open by default. */
    listToAnswer(opts?: { status?: AccessRequestFilter; workspaceId?: string }): Promise<AccessRequestResponse[]> {
        const params = new URLSearchParams({ status: opts?.status ?? 'open' })
        if (opts?.workspaceId) params.set('workspaceId', opts.workspaceId)
        return authFetch<AccessRequestResponse[]>(`/api/v1/admin/access-requests?${params}`)
    },

    /** One workspace's requests. Open by default. */
    listForWorkspace(
        wsId: string,
        opts?: { status?: AccessRequestFilter },
    ): Promise<AccessRequestResponse[]> {
        return authFetch<AccessRequestResponse[]>(
            `/api/v1/admin/workspaces/${encodeURIComponent(wsId)}/access-requests?${filterQuery(opts?.status ?? 'open')}`,
        )
    },

    /** Approve, granting the access in the same step. */
    approve(
        requestId: string,
        body?: AccessRequestApproveRequest,
    ): Promise<AccessRequestResponse> {
        return authFetch<AccessRequestResponse>(
            `/api/v1/admin/access-requests/${encodeURIComponent(requestId)}/approve`,
            { method: 'POST', body: JSON.stringify(body ?? {}) },
        )
    },

    /** Point the person to the identity-provider group that grants it. */
    route(requestId: string, body: AccessRequestRouteRequest): Promise<AccessRequestResponse> {
        return authFetch<AccessRequestResponse>(
            `/api/v1/admin/access-requests/${encodeURIComponent(requestId)}/route`,
            { method: 'POST', body: JSON.stringify(body) },
        )
    },

    /** Deny an open request with an optional reason the requester sees. */
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
