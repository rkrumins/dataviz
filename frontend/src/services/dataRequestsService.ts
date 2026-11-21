/**
 * Data requests: someone in a workspace asks for data to be connected to it — where it
 * lives, what of it, why, by when, and who knows it — and the platform team (Org and
 * Super Admins: `system:workspaces:create`) takes it on, connects it, or declines it.
 * A workspace's own data people (`workspace:datasource:manage` there) may take on and
 * connect their workspace's requests too. Behind `dataRequestsEnabled`.
 */
import { authFetch } from './apiClient'

export type DataRequestStatus = 'pending' | 'in_progress' | 'connected' | 'declined' | 'withdrawn'
export type DataRequestSystem =
    | 'snowflake' | 'databricks' | 'bigquery' | 'postgres' | 'dbt' | 'datahub' | 'neo4j' | 'file' | 'other'
export type DataRequestUrgency = 'no_rush' | 'this_month' | 'this_week'

export const OPEN_DATA_REQUEST_STATUSES: readonly DataRequestStatus[] = ['pending', 'in_progress']

export interface DataRequestPerson {
    id: string
    displayName?: string | null
}

export interface DataRequest {
    id: string
    workspaceId: string
    workspaceName?: string | null
    requestedBy: string
    requesterName?: string | null
    title: string
    system: DataRequestSystem
    details?: string | null
    purpose?: string | null
    urgency: DataRequestUrgency
    contactIds: string[]
    contacts?: DataRequestPerson[]
    status: DataRequestStatus
    assigneeId?: string | null
    assigneeName?: string | null
    resolutionNote?: string | null
    /** The data source it became, once connected — when one was named. */
    dataSourceId?: string | null
    dataSourceLabel?: string | null
    createdAt: string
    updatedAt?: string | null
    resolvedAt?: string | null
    resolvedBy?: string | null
}

/** What the person asking fills in. */
export interface DataRequestDraft {
    title: string
    system: DataRequestSystem
    details?: string
    purpose?: string
    urgency: DataRequestUrgency
    contactIds: string[]
}

const json = (body: unknown): RequestInit => ({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

const inWorkspace = (wsId: string) => `/api/v1/admin/workspaces/${encodeURIComponent(wsId)}/data-requests`
const ADMIN = '/api/v1/admin/data-requests'

export const dataRequestsService = {
    submit: (wsId: string, draft: DataRequestDraft) => authFetch<DataRequest>(inWorkspace(wsId), json(draft)),
    listForWorkspace: (wsId: string) => authFetch<DataRequest[]>(inWorkspace(wsId)),
    listMine: () => authFetch<DataRequest[]>('/api/v1/me/data-requests'),
    withdraw: (id: string) =>
        authFetch<DataRequest>(`/api/v1/me/data-requests/${encodeURIComponent(id)}/withdraw`, { method: 'POST' }),

    listToAnswer: (status = 'open') => authFetch<DataRequest[]>(`${ADMIN}?status=${encodeURIComponent(status)}`),
    start: (id: string) => authFetch<DataRequest>(`${ADMIN}/${encodeURIComponent(id)}/start`, { method: 'POST' }),
    connect: (id: string, body: { dataSourceId?: string | null; note?: string } = {}) =>
        authFetch<DataRequest>(`${ADMIN}/${encodeURIComponent(id)}/connect`, json({
            dataSourceId: body.dataSourceId || undefined, note: body.note || undefined,
        })),
    decline: (id: string, reason?: string) =>
        authFetch<DataRequest>(`${ADMIN}/${encodeURIComponent(id)}/decline`, json({ reason: reason || undefined })),
}
