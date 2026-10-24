/**
 * Access reviews Service — a workspace admin goes through who holds access
 * and keeps or removes each grant. Maps to
 * ``/api/v1/admin/workspaces/{ws}/access-reviews``.
 *
 * A review covers the grants made here — people's and teams' — as they
 * stood when it began. Removing one takes it away at once; nothing is
 * removed unless a reviewer removes it.
 */
import { authFetch } from './apiClient'
import type { AccessOrigin, MemberSubject } from './workspaceMembersService'


// ── Types ────────────────────────────────────────────────────────────

export type AccessReviewStatus = 'open' | 'completed' | 'cancelled'
export type AccessReviewDecision = 'keep' | 'remove'

export interface AccessReviewCounts {
    total: number
    kept: number
    removed: number
    undecided: number
}

export interface AccessReviewItem {
    id: string
    subject: MemberSubject
    role: string
    bindingId: string | null
    origin: AccessOrigin | null
    grantedAt: string | null
    expiresAt: string | null
    lastLoginAt: string | null
    /** Whether the grant still exists. */
    current: boolean
    decision: AccessReviewDecision | null
    decidedBy: string | null
    decidedAt: string | null
    note: string | null
}

export interface AccessReview {
    id: string
    workspaceId: string
    status: AccessReviewStatus
    startedBy: string | null
    startedAt: string
    dueAt: string
    completedAt: string | null
    completedBy: string | null
    counts: AccessReviewCounts
    /** Only when one review is read. */
    items?: AccessReviewItem[] | null
    /** People it can't cover: their identity provider or an
     *  organization-wide role lets them in. */
    notReviewed?: { identityProvider?: number; organizationWide?: number }
}


// ── Service ──────────────────────────────────────────────────────────

function url(wsId: string, suffix: string = ''): string {
    return `/api/v1/admin/workspaces/${encodeURIComponent(wsId)}/access-reviews${suffix}`
}

export const accessReviewsService = {
    /** The workspace's reviews, newest first. */
    list(wsId: string): Promise<AccessReview[]> {
        return authFetch<AccessReview[]>(url(wsId))
    },

    get(wsId: string, reviewId: string): Promise<AccessReview> {
        return authFetch<AccessReview>(url(wsId, `/${encodeURIComponent(reviewId)}`))
    },

    /** Start one, due in 7, 14 or 30 days. One open review at a time. */
    start(wsId: string, dueInDays: 7 | 14 | 30): Promise<AccessReview> {
        return authFetch<AccessReview>(url(wsId), { method: 'POST', body: JSON.stringify({ dueInDays }) })
    },

    /** Keep a grant, or remove it — at once. */
    decide(
        wsId: string,
        reviewId: string,
        itemId: string,
        body: { decision: AccessReviewDecision; note?: string | null },
    ): Promise<AccessReview> {
        return authFetch<AccessReview>(
            url(wsId, `/${encodeURIComponent(reviewId)}/items/${encodeURIComponent(itemId)}`),
            { method: 'POST', body: JSON.stringify(body) },
        )
    },

    /** Close it once every grant is decided. */
    complete(wsId: string, reviewId: string): Promise<AccessReview> {
        return authFetch<AccessReview>(url(wsId, `/${encodeURIComponent(reviewId)}/complete`), {
            method: 'POST',
            body: '{}',
        })
    },

    /** Stop it; what was already removed stays removed. */
    cancel(wsId: string, reviewId: string): Promise<AccessReview> {
        return authFetch<AccessReview>(url(wsId, `/${encodeURIComponent(reviewId)}/cancel`), {
            method: 'POST',
            body: '{}',
        })
    },
}
