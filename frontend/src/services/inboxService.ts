/**
 * Inbox Service — the caller's own bell.
 * Maps to ``/api/v1/me/notifications`` (the backend route keeps its name).
 *
 * Every route here is scoped to the signed-in user by construction: there
 * is no "read someone else's inbox" shape to call, so nothing in this
 * module takes a user id.
 */
import { authFetch } from './apiClient'


/**
 * ``kind`` is deliberately a plain string, not a union.
 *
 * It is a free-text column on the backend and new kinds are added there
 * without a frontend deploy. Typing it as a closed union would make every
 * such addition a type error at the call sites that switch on it, which is
 * exactly backwards — the UI's job is to render an unknown kind sensibly,
 * not to refuse to compile. ``KNOWN_INBOX_KINDS`` below documents
 * the ones in use today for readers; the renderer falls back for the rest.
 */
export interface InboxItem {
    id: string
    kind: string
    title: string
    body?: string | null
    link?: string | null
    actorId?: string | null
    actorName?: string | null
    resourceType?: string | null
    resourceId?: string | null
    /** ISO timestamp, or null/absent while unread. */
    readAt?: string | null
    createdAt: string
}

/** The kinds the backend emits today. Not exhaustive by contract — see
 *  the note on ``InboxItem.kind``. */
export const KNOWN_INBOX_KINDS = [
    'view.shared',
    'view.publish_requested',
    'view.publish_approved',
    'view.publish_denied',
] as const

/** Both endpoints answer with this same shape, so marking read needs no
 *  follow-up GET to learn the new badge count. */
export interface InboxList {
    items: InboxItem[]
    unread: number
}

export interface ListInboxOptions {
    limit?: number
    unreadOnly?: boolean
}


const BASE = '/api/v1/me/notifications'


export function listInbox(
    opts: ListInboxOptions = {},
): Promise<InboxList> {
    const params = new URLSearchParams({
        limit: String(opts.limit ?? 30),
        unreadOnly: String(opts.unreadOnly ?? false),
    })
    return authFetch<InboxList>(`${BASE}?${params.toString()}`)
}

/**
 * Mark messages read. Omitting ``ids`` marks ALL of them read —
 * that asymmetry is the backend's contract, so it is spelled out here
 * rather than left to a caller passing an empty array by accident (which
 * would mark exactly nothing).
 */
export function markInboxRead(ids?: string[]): Promise<InboxList> {
    return authFetch<InboxList>(`${BASE}/read`, {
        method: 'POST',
        body: JSON.stringify(ids ? { ids } : {}),
    })
}
