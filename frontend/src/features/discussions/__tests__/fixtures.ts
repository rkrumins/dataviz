import type { Message, PeopleMap, SubjectPeople, ThreadDetail } from '@/services/discussionsService'

export const at = (min: number) => new Date(Date.UTC(2026, 10, 20, 12, 0) + min * 60_000).toISOString()

export const PEOPLE: PeopleMap = {
    u_me: { id: 'u_me', displayName: 'Me Myself', email: 'me@x.io', avatarId: null, hasImage: false, deleted: false },
    u_ana: { id: 'u_ana', displayName: 'Ana Silva', email: 'ana@x.io', avatarId: null, hasImage: false, deleted: false },
    u_bo: { id: 'u_bo', displayName: 'Bo Chen', email: 'bo@x.io', avatarId: null, hasImage: false, deleted: false },
    u_fay: { id: 'u_fay', displayName: 'Fay Liu', email: 'fay@x.io', avatarId: null, hasImage: false, deleted: false },
}

export const message = (id: string, authorId: string, body: string, min: number, over: Partial<Message> = {}): Message => ({
    id, kind: 'reply', authorId, body, mentions: [], createdAt: at(min), editedAt: null, deletedAt: null, version: 1, roles: [], ...over,
})

export function thread(over: Partial<ThreadDetail> = {}): ThreadDetail {
    const messages = over.messages ?? [
        message('m_q', 'u_me', 'Where does the tier column come from?', 0, { kind: 'question', roles: ['asker'] }),
        message('m_1', 'u_ana', 'From dim_customer.', 10, { roles: ['view_owner'] }),
        message('m_2', 'u_bo', 'Computed nightly from trailing revenue.', 20, { roles: ['data_steward'] }),
    ]
    return {
        id: 'th_1',
        subject: { type: 'view', id: 'v1', name: 'Revenue', workspaceId: 'ws1', workspaceName: 'Finance', link: '/views/v1' },
        entityId: null, entityLabel: null, visibility: 'open', status: 'open', askedBy: 'u_me',
        excerpt: messages[0].body, messageCount: messages.length, participantIds: ['u_bo', 'u_ana', 'u_me'], participantCount: 3,
        answerMessageId: null, lastActivityAt: messages[messages.length - 1].createdAt, lastMessageBy: messages[messages.length - 1].authorId,
        createdAt: messages[0].createdAt, unread: false, muted: false, following: false, version: 3,
        access: { canReply: true, canAnswer: true, canClose: true, canModerate: false },
        privateAudience: null, messages, olderCursor: null, lastReadAt: null, people: PEOPLE,
        ...over,
    }
}

export const SUBJECT_PEOPLE: SubjectPeople = {
    viewOwners: [
        { personId: 'u_ana', via: 'creator', groupId: null, groupName: null, canRead: true },
        { personId: 'u_me', via: 'editor_grant', groupId: null, groupName: null, canRead: true },
    ],
    dataContacts: {
        owner: { personId: 'u_bo', via: 'named_owner', groupId: null, groupName: null, canRead: true },
        stewards: [{ personId: 'u_fay', via: 'named_steward', groupId: null, groupName: null, canRead: false }],
        provenance: 'named',
    },
    fallback: [],
    truncated: 0,
    people: PEOPLE,
}

/** A 409 as `authFetch` throws it. */
export const staleError = () => Object.assign(new Error('Someone changed this first.'), { status: 409, detail: { type: 'stale', message: 'Changed' } })
