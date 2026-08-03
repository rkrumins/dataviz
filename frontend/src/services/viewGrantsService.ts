/**
 * View Grants Service — Layer-3 explicit shares on a single view.
 * Maps to ``/api/v1/views/{viewId}/grants``.
 */
import { authFetch } from './apiClient'
import type { MemberSubject } from './workspaceMembersService'


export interface ViewGrantResponse {
    grantId: string
    role: 'editor' | 'viewer'
    grantedAt: string
    grantedBy: string | null
    subject: MemberSubject
}

export interface ViewGrantCreateRequest {
    subjectType: 'user' | 'group'
    subjectId: string
    role: 'editor' | 'viewer'
}


function url(viewId: string, suffix: string = ''): string {
    return `/api/v1/views/${encodeURIComponent(viewId)}/grants${suffix}`
}


export const viewGrantsService = {
    /** silent403: whoever cannot manage grants gets a locked panel that
     *  says so. A global access-denied card on top of it is the same
     *  refusal twice, and the vaguer one. */
    list(viewId: string): Promise<ViewGrantResponse[]> {
        return authFetch<ViewGrantResponse[]>(url(viewId), { silent403: true })
    },

    create(viewId: string, req: ViewGrantCreateRequest): Promise<ViewGrantResponse> {
        return authFetch<ViewGrantResponse>(url(viewId), {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    /** Change an existing grant's role in place — no revoke + re-share,
     *  and the grant's audit trail (grantedAt/grantedBy) stays intact. */
    update(viewId: string, grantId: string, role: 'editor' | 'viewer'): Promise<ViewGrantResponse> {
        return authFetch<ViewGrantResponse>(url(viewId, `/${grantId}`), {
            method: 'PUT',
            body: JSON.stringify({ role }),
        })
    },

    delete(viewId: string, grantId: string): Promise<void> {
        return authFetch<void>(url(viewId, `/${grantId}`), { method: 'DELETE' })
    },
}
