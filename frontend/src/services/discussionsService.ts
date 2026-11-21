/**
 * Discussions Service — questions and conversations about a view or a data source.
 *
 * Maps to ``/api/v1/discussions`` (a subject's threads, and one thread) and the caller's own
 * corners of it under ``/api/v1/me`` (their conversations, unread counts, what they watch). Every
 * conversation is about a subject — there are no direct messages — and every read is checked
 * against what the caller may see, so a private thread never shows up in a count it shouldn't.
 *
 * Writes carry a ``clientKey``: the same key sent twice (a Retry after a lost answer) returns the
 * first write instead of making a second.
 *
 * The summaries answer with an ETag (``private, max-age=0, must-revalidate``); a plain fetch
 * revalidates on its own, so a poll of an unchanged summary costs a 304.
 */
import { authFetch } from './apiClient'

// ── Shared shapes ──────────────────────────────────────────────────

export type SubjectType = 'view' | 'data_source'

/** What a conversation is about, by type and id — all a request needs. */
export interface SubjectKey {
    type: SubjectType
    id: string
}

export interface SubjectRef extends SubjectKey {
    name: string
    workspaceId: string | null
    workspaceName: string | null
    link: string
}

export interface Person {
    id: string
    displayName: string
    email: string | null
    avatarId: string | null
    hasImage: boolean
    /** The account is gone: shown as "Former member". */
    deleted: boolean
}

/** Every person id a payload names, resolved. */
export type PeopleMap = Record<string, Person>

export type DiscussionStatus = 'open' | 'answered' | 'closed'
export type Visibility = 'open' | 'private'
export type JoinedVia = 'asked' | 'asked_to' | 'mentioned' | 'replied' | 'followed'
export type PersonVia =
    | 'creator' | 'editor_grant' | 'named_owner' | 'named_steward'
    | 'created_source' | 'data_request' | 'workspace_admin' | 'org_admin'

/** A thread as a list shows it. */
export interface ThreadSummary {
    id: string
    subject: SubjectRef
    /** The node it is about, when it was asked about one. */
    entityId: string | null
    entityLabel: string | null
    visibility: Visibility
    status: DiscussionStatus
    askedBy: string
    /** The first 200 characters of the question. */
    excerpt: string
    /** Includes the question. */
    messageCount: number
    /** Up to 6, most recent first. */
    participantIds: string[]
    participantCount: number
    answerMessageId: string | null
    /** Who accepted the answer (in `people`), and when. Optional on purpose: a server without
     *  them still draws — "Accepted answer" instead of "Accepted by …". */
    resolvedBy?: string | null
    resolvedAt?: string | null
    lastActivityAt: string
    lastMessageBy: string
    createdAt: string
    unread: boolean
    muted: boolean
    following: boolean
    version: number
}

export type MessageRole = 'asker' | 'view_owner' | 'data_owner' | 'data_steward' | 'admin'

export interface Message {
    id: string
    kind: 'question' | 'reply'
    authorId: string
    /** '' once deleted. */
    body: string
    mentions: string[]
    createdAt: string
    editedAt: string | null
    deletedAt: string | null
    version: number
    /** The author's badges in this thread. */
    roles: MessageRole[]
}

export interface ThreadAccess {
    canReply: boolean
    canAnswer: boolean
    canClose: boolean
    canModerate: boolean
    canEditContacts?: boolean
}

export interface ThreadDetail extends ThreadSummary {
    access: ThreadAccess
    /** Who can see a private thread (null when it is open). */
    privateAudience: string[] | null
    /** Oldest first. */
    messages: Message[]
    olderCursor: string | null
    /** When the caller last read it: where "New since you last looked" goes. */
    lastReadAt: string | null
    people: PeopleMap
}

export interface ThreadList {
    threads: ThreadSummary[]
    nextCursor: string | null
    latest?: string | null
    people: PeopleMap
}

export interface SubjectSummary {
    open: number
    answered: number
    closed: number
    total: number
    unread: number
    watching: boolean
    /** Changes whenever any thread on the subject does: lists are read again only then. */
    latest: string | null
    /** Questions per node on the canvas. */
    byEntity: Record<string, { open: number; total: number }>
}

export interface PersonRole {
    personId: string
    via: PersonVia
    groupId: string | null
    groupName: string | null
    /** Whether they can open the subject — a question can't reach them otherwise. */
    canRead: boolean
}

export interface SubjectPeople {
    viewOwners: PersonRole[]
    dataContacts: {
        owner: PersonRole | null
        stewards: PersonRole[]
        provenance: 'named' | 'derived' | 'fallback'
    }
    /** Who is asked when nobody else is: the workspace's admins, then the Org Admins. */
    fallback: PersonRole[]
    /** People left out of a group too large to ask everyone in. */
    truncated: number
    people: PeopleMap
}

export type MentionablePerson = Person & { hint: string | null }

export interface AskInput {
    body: string
    visibility: Visibility
    route: { viewOwners: boolean; dataContacts: boolean }
    recipientIds: string[]
    mentions: string[]
    entityId?: string
    entityLabel?: string
    clientKey: string
}

export interface NotReached {
    personId: string
    reason: 'cannot_read' | 'not_a_person' | 'inactive' | 'group_too_large'
}

export interface AskResult {
    thread: ThreadDetail
    reached: string[]
    notReached: NotReached[]
    usedFallback: boolean
}

export interface MessageResult {
    message: Message
    thread: ThreadSummary
    people: PeopleMap
}

export type MyBox = 'to-me' | 'mine' | 'mentions' | 'watching'

export interface MySummary {
    toMe: { unread: number; waiting: number }
    mine: { unread: number; open: number }
    mentions: { unread: number }
    watching: { unread: number }
    totalUnread: number
}

export interface Watch {
    subject: SubjectRef
    createdAt: string
    open: number
}

// ── Routes ─────────────────────────────────────────────────────────

const BASE = '/api/v1/discussions'
const ME = '/api/v1/me'

const subjectBase = (s: SubjectKey) =>
    `${BASE}/subjects/${encodeURIComponent(s.type)}/${encodeURIComponent(s.id)}`
const threadBase = (id: string) => `${BASE}/${encodeURIComponent(id)}`

const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

/** A query string from the params that have a value. */
function qs(params: Record<string, string | number | boolean | null | undefined>): string {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
    const s = q.toString()
    return s ? `?${s}` : ''
}

export interface ThreadFilter {
    status?: DiscussionStatus | 'all'
    entityId?: string | null
    mine?: boolean
}

export function listSubjectThreads(
    subject: SubjectKey,
    filter: ThreadFilter = {},
    page: { cursor?: string | null; updatedSince?: string | null; limit?: number } = {},
): Promise<ThreadList> {
    return authFetch<ThreadList>(`${subjectBase(subject)}${qs({
        status: filter.status, entityId: filter.entityId, mine: filter.mine || undefined,
        cursor: page.cursor, updatedSince: page.updatedSince, limit: page.limit,
    })}`)
}

export function getSubjectSummary(subject: SubjectKey): Promise<SubjectSummary> {
    return authFetch<SubjectSummary>(`${subjectBase(subject)}/summary`)
}

export function getSubjectPeople(subject: SubjectKey): Promise<SubjectPeople> {
    return authFetch<SubjectPeople>(`${subjectBase(subject)}/people`)
}

export function listMentionable(subject: SubjectKey, q: string, limit = 10): Promise<{ people: MentionablePerson[] }> {
    return authFetch(`${subjectBase(subject)}/mentionable${qs({ q, limit })}`)
}

export function askQuestion(subject: SubjectKey, input: AskInput): Promise<AskResult> {
    return authFetch<AskResult>(subjectBase(subject), json('POST', input))
}

export function watchSubject(subject: SubjectKey): Promise<{ watching: boolean }> {
    return authFetch(`${subjectBase(subject)}/watch`, json('PUT'))
}

export function unwatchSubject(subject: SubjectKey): Promise<{ watching: boolean }> {
    return authFetch(`${subjectBase(subject)}/watch`, json('DELETE'))
}

/** A thread: its first page of messages, an older page (`cursor`), or what changed `since`. */
export function getThread(id: string, page: { cursor?: string | null; since?: string | null; limit?: number } = {}): Promise<ThreadDetail> {
    return authFetch<ThreadDetail>(`${threadBase(id)}${qs({ cursor: page.cursor, since: page.since, limit: page.limit })}`)
}

export function postReply(id: string, input: { body: string; mentions: string[]; clientKey: string }): Promise<MessageResult> {
    return authFetch<MessageResult>(`${threadBase(id)}/messages`, json('POST', input))
}

export function editMessage(id: string, messageId: string, input: { body: string; mentions: string[]; expectedVersion: number }): Promise<MessageResult> {
    return authFetch<MessageResult>(`${threadBase(id)}/messages/${encodeURIComponent(messageId)}`, json('PATCH', input))
}

export function deleteMessage(id: string, messageId: string): Promise<MessageResult> {
    return authFetch<MessageResult>(`${threadBase(id)}/messages/${encodeURIComponent(messageId)}`, json('DELETE'))
}

export function acceptAnswer(id: string, messageId: string, expectedVersion: number): Promise<{ thread: ThreadSummary }> {
    return authFetch(`${threadBase(id)}/answer`, json('POST', { messageId, expectedVersion }))
}

export function unacceptAnswer(id: string, expectedVersion: number): Promise<{ thread: ThreadSummary }> {
    return authFetch(`${threadBase(id)}/answer`, json('DELETE', { expectedVersion }))
}

export function closeThread(id: string, expectedVersion: number): Promise<{ thread: ThreadSummary }> {
    return authFetch(`${threadBase(id)}/close`, json('POST', { expectedVersion }))
}

export function reopenThread(id: string, expectedVersion: number): Promise<{ thread: ThreadSummary }> {
    return authFetch(`${threadBase(id)}/reopen`, json('POST', { expectedVersion }))
}

/** Deletes the question, and with it the thread. */
export function deleteThread(id: string): Promise<void> {
    return authFetch<void>(threadBase(id), json('DELETE'))
}

export function setThreadMe(id: string, state: { muted?: boolean; following?: boolean }): Promise<{ muted: boolean; following: boolean }> {
    return authFetch(`${threadBase(id)}/me`, json('PUT', state))
}

export function markThreadRead(id: string): Promise<{ lastReadAt: string }> {
    return authFetch(`${threadBase(id)}/read`, json('POST'))
}

// ── The caller's own ───────────────────────────────────────────────

export function listMyDiscussions(
    box: MyBox = 'to-me',
    status: DiscussionStatus | 'all' = 'all',
    page: { cursor?: string | null; limit?: number } = {},
): Promise<ThreadList> {
    return authFetch<ThreadList>(`${ME}/discussions${qs({ box, status, cursor: page.cursor, limit: page.limit })}`)
}

export function getMyDiscussionSummary(): Promise<MySummary> {
    return authFetch<MySummary>(`${ME}/discussions/summary`)
}

export function listMyWatches(page: { cursor?: string | null; limit?: number } = {}): Promise<{ items: Watch[]; nextCursor: string | null }> {
    return authFetch(`${ME}/watches${qs({ cursor: page.cursor, limit: page.limit })}`)
}

// ── Errors ─────────────────────────────────────────────────────────

/** The refusal's `detail.type` (`stale`, `feature_disabled`, `rate_limited`…), when it has one. */
export function discussionErrorType(err: unknown): string | null {
    const detail = (err as { detail?: unknown } | null)?.detail
    const type = (detail as { type?: unknown } | null)?.type
    return typeof type === 'string' ? type : null
}

/** Someone else changed it first: a 409 the reader resolves by reading it again. */
export function isStale(err: unknown): boolean {
    return (err as { status?: number } | null)?.status === 409 || discussionErrorType(err) === 'stale'
}
