/**
 * Audit service — read the RBAC + user-lifecycle audit log.
 *
 * Phase 7 surface. The backend reads from ``outbox_events`` and
 * filters by event type, actor, target user, target role, and a
 * cursor-paginated time window.
 */
import { authFetch } from './apiClient'


const AUDIT_API = '/api/v1/admin/audit'


export interface AuditEvent {
    eventId: string
    eventType: string
    eventVersion: number
    aggregateType?: string | null
    aggregateId?: string | null
    createdAt: string

    actorId?: string | null
    targetUserId?: string | null
    targetRole?: string | null
    workspaceId?: string | null

    payload: Record<string, unknown>
}


export interface AuditListResponse {
    events: AuditEvent[]
    nextCursor?: string | null
}


export interface AuditFilters {
    eventType?: string
    actorId?: string
    targetUserId?: string
    targetRole?: string
    workspaceId?: string
    fromTs?: string
    toTs?: string
    cursor?: string
    limit?: number
}


function buildQuery(filters: AuditFilters): string {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filters)) {
        if (v === undefined || v === null || v === '') continue
        params.set(k, String(v))
    }
    const qs = params.toString()
    return qs ? `?${qs}` : ''
}


export const auditService = {
    /** List audit events, newest first. Returns a page + optional
     *  ``nextCursor`` to fetch the next page. */
    list(filters: AuditFilters = {}): Promise<AuditListResponse> {
        return authFetch<AuditListResponse>(`${AUDIT_API}${buildQuery(filters)}`)
    },

    /** Distinct event types currently in the audit namespace. Used
     *  by the FE filter dropdown so the chip list stays in sync with
     *  whatever the backend actually emits. */
    listEventTypes(): Promise<string[]> {
        return authFetch<string[]>(`${AUDIT_API}/event-types`)
    },
}
