/**
 * Data source transfers — moving a data source, with its views and who can
 * read them, to another workspace.
 *
 * Someone who runs both workspaces moves it directly. Someone who runs only
 * the source sends a request, which the destination's admins accept (that
 * runs the move) or decline. Every move is recorded, and the latest one can
 * be undone for a while: the drawer's lifecycle reads that history.
 *
 * Mirrors the models in ``backend/common/models/management.py`` ("Moving a
 * data source between workspaces"). Errors are ``authFetch``'s: a readable
 * message with the HTTP ``status`` on it, so a 409 (something changed, or
 * something is in the way) can be told from a refusal or an outage.
 */
import { authFetch } from './apiClient'
import { withReason } from './activityReason'

// ── Types ────────────────────────────────────────────────────────────

/** What the caller may do: move now, or ask the destination's admins. */
export type TransferMode = 'direct' | 'request'

export type TransferStatus = 'pending' | 'completed' | 'declined' | 'cancelled' | 'expired' | 'undone'

/** A list filter: requests still waiting, or every one. */
export type TransferFilter = 'open' | 'all'

export interface TransferSubjectRef {
    type: 'user' | 'group'
    id: string
}

export interface TransferWorkspaceRef {
    id: string
    /** Null when the reader can't open that workspace: its name stays its own. */
    name: string | null
}

export interface TransferPersonRef {
    id: string
    name: string
    email?: string | null
}

export interface TransferEntity {
    id: string
    name: string
    type: string
}

/** Something to resolve first (a blocker) or worth knowing (a note). A
 *  transient blocker clears by itself — a run finishing — so a request may
 *  be sent while it holds, but not accepted. */
export interface TransferIssue {
    code: string
    message: string
    severity: 'blocker' | 'warning' | 'info'
    transient: boolean
    items: TransferEntity[]
}

export interface TransferView {
    id: string
    name: string
    visibility: string
    ownerId?: string | null
    ownerName?: string | null
    trashed: boolean
    /** Has no data source of its own and reads this one as the workspace default. */
    followsDefault: boolean
    publishRequested: boolean
}

export interface TransferViewCounts {
    /** Every view that moves, trashed ones included. */
    total: number
    trashed: number
    followsDefault: number
    /** Live views, by who can see them. */
    private: number
    workspace: number
    enterprise: number
    publishRequested: number
}

/** A person or team who reads moved views today and would lose them. */
export interface TransferSubject {
    type: 'user' | 'group'
    id: string
    name: string
    email?: string | null
    memberCount?: number | null
    /** Their role in the source workspace, in words. */
    role: string
    /** How many moved views they would lose. */
    views: number
    keep: boolean
}

export interface TransferAccess {
    creators: number
    sharedWith: number
    everyone: number
    gainsPeople: number
    gainsViews: number
    adminViews: number
    loses: TransferSubject[]
}

export interface TransferVersioning {
    commits: number
    openDrafts: number
    openReviews: number
    forks: number
}

export interface TransferPrimary {
    wasPrimary: boolean
    wasDefault: boolean
    becomesPrimary: boolean
    /** The destination source flagged primary so the move can't change its default. */
    pinsDestinationDefault?: string | null
}

export interface TransferIdentity {
    identityProperty?: string | null
    nameProperty?: string | null
}

export interface TransferPreview {
    dataSource: TransferEntity
    fromWorkspace: TransferWorkspaceRef
    toWorkspace: TransferWorkspaceRef
    mode: TransferMode | null
    blockers: TransferIssue[]
    notes: TransferIssue[]
    views: TransferView[]
    viewCounts: TransferViewCounts
    access: TransferAccess
    versioning: TransferVersioning | null
    primary: TransferPrimary
    identity: TransferIdentity | null
    /** Changes whenever anything a reviewer must re-read changes. */
    token: string
}

export interface TransferDestination {
    id: string
    name: string
    description?: string | null
    dataSourceCount: number
    mode: TransferMode | null
    /** Why the source can't go there, when `mode` is null. */
    reason?: string | null
}

export interface DataSourceTransferResponse {
    id: string
    kind: 'move' | 'request'
    status: TransferStatus
    dataSource: TransferEntity
    fromWorkspace: TransferWorkspaceRef
    toWorkspace: TransferWorkspaceRef
    createdBy: TransferPersonRef | null
    createdAt: string
    reason: string | null
    expiresAt: string | null
    resolvedBy: TransferPersonRef | null
    resolvedAt: string | null
    resolutionNote: string | null
    completedAt: string | null
    undoneBy: TransferPersonRef | null
    undoneAt: string | null
    viewCount: number
    keptAccess: number
    undoUntil: string | null
    canAccept: boolean
    canDecline: boolean
    canCancel: boolean
    canUndo: boolean
    undoBlockedBy: string | null
}

/** What changed between a request being sent and being read. */
export interface TransferChanges {
    viewsAdded: number
    viewsRemoved: number
    newPeople: number
}

export interface DataSourceTransferDetail {
    transfer: DataSourceTransferResponse
    /** Fresh, while the request is open; `access.loses[].keep` is the proposer's plan. */
    preview: TransferPreview | null
    changesSinceRequest: TransferChanges | null
}

export interface TransferMoveRequest {
    targetWorkspaceId: string
    /** Who keeps view-only access to the moved views. Null keeps everyone's; [] nobody's. */
    keep?: TransferSubjectRef[] | null
    /** The preview the person confirmed: if it has changed since, the server says so (409). */
    previewToken?: string | null
}

// ── Service ──────────────────────────────────────────────────────────

const ADMIN_API = '/api/v1/admin/data-source-transfers'

function sourceApi(wsId: string, dsId: string): string {
    return `/api/v1/admin/workspaces/${encodeURIComponent(wsId)}/data-sources/${encodeURIComponent(dsId)}`
}

function post<T>(url: string, body: unknown, reason?: string | null): Promise<T> {
    return authFetch<T>(url, withReason({ method: 'POST', body: JSON.stringify(body) }, reason))
}

export const dataSourceTransferService = {
    /** Every workspace the caller can see, and whether the source can go there. */
    destinations(wsId: string, dsId: string): Promise<TransferDestination[]> {
        return authFetch<TransferDestination[]>(`${sourceApi(wsId, dsId)}/move-destinations`)
    },

    /** What moving the source to `targetWorkspaceId` would do, and who it would affect. */
    preview(wsId: string, dsId: string, targetWorkspaceId: string): Promise<TransferPreview> {
        return authFetch<TransferPreview>(
            `${sourceApi(wsId, dsId)}/move-preview?to=${encodeURIComponent(targetWorkspaceId)}`,
        )
    },

    /** Move it now — for someone who runs both workspaces. */
    move(wsId: string, dsId: string, body: TransferMoveRequest, reason?: string | null): Promise<DataSourceTransferResponse> {
        return post(`${sourceApi(wsId, dsId)}/move`, body, reason)
    },

    /** Ask the destination's admins to take it. */
    propose(wsId: string, dsId: string, body: TransferMoveRequest, reason?: string | null): Promise<DataSourceTransferResponse> {
        return post(`${sourceApi(wsId, dsId)}/transfer-requests`, body, reason)
    },

    /** Where this source has lived, newest first. */
    history(wsId: string, dsId: string): Promise<DataSourceTransferResponse[]> {
        return authFetch<DataSourceTransferResponse[]>(`${sourceApi(wsId, dsId)}/transfers`)
    },

    /** One workspace's transfers, in both directions. Open by default. */
    listForWorkspace(wsId: string, status: TransferFilter = 'open'): Promise<DataSourceTransferResponse[]> {
        return authFetch<DataSourceTransferResponse[]>(
            `/api/v1/admin/workspaces/${encodeURIComponent(wsId)}/data-source-transfers?status=${status}`,
        )
    },

    /** Requests to the workspaces the caller administers. Open by default. */
    listIncoming(status: TransferFilter = 'open'): Promise<DataSourceTransferResponse[]> {
        return authFetch<DataSourceTransferResponse[]>(`${ADMIN_API}?status=${status}`)
    },

    /** One transfer, with a fresh preview while it is still waiting. */
    get(id: string): Promise<DataSourceTransferDetail> {
        return authFetch<DataSourceTransferDetail>(`${ADMIN_API}/${encodeURIComponent(id)}`)
    },

    /** Accept a request, which runs the move. `previewToken` is the preview the reviewer read. */
    accept(id: string, previewToken: string, reason?: string | null): Promise<DataSourceTransferResponse> {
        return post(`${ADMIN_API}/${encodeURIComponent(id)}/accept`, { previewToken }, reason)
    },

    /** Decline a request. The note reaches the person who asked, and the activity log. */
    decline(id: string, note?: string | null): Promise<DataSourceTransferResponse> {
        return post(`${ADMIN_API}/${encodeURIComponent(id)}/decline`, { note: note || null }, note)
    },

    /** Take a request back before it is answered. */
    cancel(id: string, note?: string | null): Promise<DataSourceTransferResponse> {
        return post(`${ADMIN_API}/${encodeURIComponent(id)}/cancel`, { note: note || null }, note)
    },

    /** Put the source back where it was, while that can still be done exactly. */
    undo(id: string, reason?: string | null): Promise<DataSourceTransferResponse> {
        return post(`${ADMIN_API}/${encodeURIComponent(id)}/undo`, {}, reason)
    },
}
