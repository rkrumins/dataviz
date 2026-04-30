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
    list(viewId: string): Promise<ViewGrantResponse[]> {
        return authFetch<ViewGrantResponse[]>(url(viewId))
    },

    create(viewId: string, req: ViewGrantCreateRequest): Promise<ViewGrantResponse> {
        return authFetch<ViewGrantResponse>(url(viewId), {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    delete(viewId: string, grantId: string): Promise<void> {
        return authFetch<void>(url(viewId, `/${grantId}`), { method: 'DELETE' })
    },
}
