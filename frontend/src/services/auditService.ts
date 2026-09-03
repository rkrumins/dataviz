/**
 * Audit service — read the RBAC + user-lifecycle audit log.
 *
 * Phase 7 surface. The backend reads from ``outbox_events`` and
 * filters by event type, actor, target user, target role, and a
 * cursor-paginated time window.
 */
import { authFetch } from './apiClient'


const AUDIT_API = '/api/v1/admin/audit'


export type AuditSeverity = 'info' | 'warning' | 'critical'

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

    /** WHO those ids are, resolved server-side in one batched lookup per page.
     *
     *  NULL MEANS UNRESOLVED, NEVER "nobody" — a system-generated event, a
     *  hard-deleted row, or a payload naming something that was never a user
     *  all arrive empty, and the id stays authoritative. Render the id in that
     *  case; never print a name the server did not vouch for.
     *
     *  `*Deleted` marks an account that is soft-deleted but still named: an
     *  audit log's most valuable row is often about an account that is gone. */
    /** The workspace's name, same contract: null means unresolved, and the
     *  id stays authoritative. Deleted workspaces are still named — an event
     *  in a workspace that has since been torn down is among the more
     *  interesting rows in a log. */
    workspaceName?: string | null
    actorName?: string | null
    actorEmail?: string | null
    actorDeleted?: boolean
    targetUserName?: string | null
    targetUserEmail?: string | null
    targetUserDeleted?: boolean

    /** Phase 8: backend-derived display fields. ``severity`` drives
     *  the row colour, ``summary`` is the human one-liner shown
     *  instead of the raw ``event_type`` code. */
    severity: AuditSeverity
    summary: string

    /** Every other internal id this event mentions — groups, IdP
     *  connections, views, workspaces inside the payload — resolved to
     *  its display name, keyed by the id. Absence means unresolved and
     *  the id stays authoritative. */
    resolvedNames?: Record<string, string>
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
    /** ``security`` (default) hides per-request noise + password /
     *  signup chrome; surfaces logins, role changes, every RBAC
     *  mutation. ``activity`` adds back password / signup chrome for
     *  support work. ``all`` is the unfiltered firehose.
     *
     *  ``sso`` differs in kind: instead of subtracting noisy event
     *  types it narrows the prefix set to the identity surface
     *  (provider + mapping CRUD, auth posture, identity links, sign-in
     *  outcomes) and hides nothing within it. */
    category?: 'security' | 'activity' | 'all' | 'sso'
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
