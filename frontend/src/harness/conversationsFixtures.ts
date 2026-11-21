/**
 * Fixtures for the conversations harness: a view in Finance Risk, the people who look after it,
 * and its questions in every state a reader meets — open with new replies, answered, private,
 * about a node, with a deleted reply and a former member, closed.
 */
import type {
    Message, PeopleMap, Person, SubjectPeople, SubjectRef, SubjectSummary, ThreadDetail, ThreadSummary,
} from '../services/discussionsService'
import type { InboxItem } from '../services/inboxService'

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const person = (id: string, displayName: string, extra: Partial<Person> = {}): Person => ({
    id, displayName, email: `${displayName.split(' ')[0].toLowerCase()}@example.com`, avatarId: null, hasImage: false, deleted: false, ...extra,
})

export const PEOPLE: PeopleMap = {
    usr_me: person('usr_me', 'Sam Reader'),
    usr_ana: person('usr_ana', 'Ana Silva'),
    usr_bo: person('usr_bo', 'Bo Chen'),
    usr_cy: person('usr_cy', 'Cy Park'),
    usr_dee: person('usr_dee', 'Dee Okafor'),
    usr_eli: person('usr_eli', 'Eli Novak'),
    usr_fay: person('usr_fay', 'Fay Liu'),
    usr_gone: person('usr_gone', 'Gil Moreau', { deleted: true, email: null }),
}

export const VIEW: SubjectRef = {
    type: 'view', id: 'view_rev', name: 'Revenue lineage — FY26', workspaceId: 'ws_fin', workspaceName: 'Finance Risk', link: '/views/view_rev',
}

let n = 0
const msg = (authorId: string, body: string, min: number, over: Partial<Message> = {}): Message => ({
    id: `dmsg_${++n}`, kind: 'reply', authorId, body, mentions: [], createdAt: ago(min), editedAt: null, deletedAt: null, version: 1,
    roles: authorId === 'usr_ana' ? ['view_owner'] : authorId === 'usr_bo' ? ['data_steward'] : authorId === 'usr_dee' ? ['admin'] : [],
    ...over,
})

const ACCESS = { canReply: true, canAnswer: true, canClose: true, canModerate: false }

function detail(over: Partial<ThreadDetail> & Pick<ThreadDetail, 'id' | 'messages' | 'askedBy'>): ThreadDetail {
    const messages = over.messages
    const ids = [...new Set([...messages].reverse().map((m) => m.authorId))]
    const question = messages.find((m) => m.kind === 'question')
    return {
        subject: VIEW, entityId: null, entityLabel: null, visibility: 'open', status: 'open',
        excerpt: (question?.body ?? '').slice(0, 200), messageCount: messages.length,
        participantIds: ids.slice(0, 6), participantCount: ids.length, answerMessageId: null,
        lastActivityAt: messages[messages.length - 1].createdAt, lastMessageBy: messages[messages.length - 1].authorId,
        createdAt: messages[0].createdAt, unread: false, muted: false, following: false, version: 1,
        access: ACCESS, privateAudience: null, olderCursor: null, lastReadAt: null, people: PEOPLE,
        ...over,
    }
}

// Open, asked by Cy about a figure; the reader looked in after Ana's first reply, and two came since.
const q1 = msg('usr_cy', 'Why does Net revenue drop in March when the general ledger shows growth? Is the FX adjustment applied twice somewhere between the ledger and this mart?', 60 * 26, { kind: 'question', roles: ['asker'] })
const r1a = msg('usr_ana', 'Good catch — the view follows the March restatement, so the FX step runs on the restated figures. @Bo Chen can you confirm the mart only applies it once?', 60 * 25, { mentions: ['usr_bo'] })
const r1b = msg('usr_bo', 'It’s applied once, in fx_normalise. The ledger you’re comparing with is pre-restatement — the reconciliation is written up here: https://wiki.example.com/finance/fx-restatement.', 60 * 3)
const r1c = msg('usr_cy', 'That explains it, thanks both. I’ll compare against the restated ledger.', 40, { roles: ['asker'] })

// Answered: the reader asked where a column comes from; Bo's reply was accepted.
const q2 = msg('usr_me', 'Where does the “Customer tier” column come from? It doesn’t match the CRM.', 60 * 24 * 6, { kind: 'question', roles: ['asker'] })
const r2a = msg('usr_bo', 'It’s computed nightly in dim_customer from trailing-12-month revenue, not read from the CRM. Tiers move on the 1st of each month, so a customer can sit in a different tier from the CRM for a few weeks.', 60 * 24 * 5)
const r2b = msg('usr_me', 'Perfect — that’s the gap I was seeing.', 60 * 24 * 5 - 30, { roles: ['asker'] })

// Private: asked of the view's owners only.
const q3 = msg('usr_me', 'Before I share this with the audit team: are the intercompany eliminations in this view final for Q3?', 60 * 5, { kind: 'question', roles: ['asker'] })
const r3a = msg('usr_ana', 'Not yet — two entities are still being reconciled. I’ll reply here once they’re signed off, probably Thursday.', 60 * 2)

// About a node on the canvas.
const q4 = msg('usr_eli', 'gl_balances has two rows per account for October. Is that expected while the close is open?', 60 * 9, { kind: 'question', roles: ['asker'] })
const r4a = msg('usr_dee', 'Yes — one is the soft close and one the hard close. The hard-close row wins once it lands.', 60 * 8, { roles: ['admin'] })

// A deleted reply, and a question asked by someone who has since left.
const q5 = msg('usr_gone', 'Is the APAC feed still delayed by a day?', 60 * 24 * 30, { kind: 'question', roles: ['asker'] })
const r5a = msg('usr_cy', '', 60 * 24 * 29, { deletedAt: ago(60 * 24 * 29) })
const r5b = msg('usr_ana', 'Not any more — it has landed on time since the October migration.', 60 * 24 * 28, { editedAt: ago(60 * 24 * 27) })

const q6 = msg('usr_cy', 'Can we add the EMEA cost centres to this view?', 60 * 24 * 12, { kind: 'question', roles: ['asker'] })
const r6a = msg('usr_ana', 'They’re in the “Cost lineage” view instead — closing this one.', 60 * 24 * 11)

export const THREADS: Record<string, ThreadDetail> = {
    th_open: detail({ id: 'th_open', askedBy: 'usr_cy', messages: [q1, r1a, r1b, r1c], unread: true, lastReadAt: ago(60 * 24), following: true }),
    th_answered: detail({
        id: 'th_answered', askedBy: 'usr_me', messages: [q2, r2a, r2b], status: 'answered', answerMessageId: r2a.id,
        resolvedBy: 'usr_me', resolvedAt: ago(60 * 24 * 5 - 30), lastReadAt: ago(60),
    }),
    th_private: detail({
        id: 'th_private', askedBy: 'usr_me', messages: [q3, r3a], visibility: 'private',
        privateAudience: ['usr_me', 'usr_ana', 'usr_eli', 'usr_dee'], lastReadAt: ago(60 * 3), unread: true,
    }),
    th_anchored: detail({
        id: 'th_anchored', askedBy: 'usr_eli', messages: [q4, r4a], entityId: 'urn:fin:gl_balances', entityLabel: 'gl_balances',
        access: { ...ACCESS, canAnswer: false },
    }),
    th_deleted: detail({ id: 'th_deleted', askedBy: 'usr_gone', messages: [q5, r5a, r5b], access: { ...ACCESS, canAnswer: false, canClose: false } }),
    th_closed: detail({ id: 'th_closed', askedBy: 'usr_cy', messages: [q6, r6a], status: 'closed', access: { ...ACCESS, canAnswer: false } }),
}

export const STATE_THREAD: Record<string, string> = {
    open: 'th_open', answered: 'th_answered', private: 'th_private', anchored: 'th_anchored', deleted: 'th_deleted', closed: 'th_closed',
}

/** A thread as a list row: the detail without what only the thread itself carries. */
export function summaryOf(t: ThreadDetail): ThreadSummary {
    const row: Partial<ThreadDetail> = { ...t }
    for (const k of ['access', 'privateAudience', 'messages', 'olderCursor', 'lastReadAt', 'people'] as const) delete row[k]
    return row as ThreadSummary
}

export const SUMMARY: SubjectSummary = {
    open: 4, answered: 1, closed: 1, total: 6, unread: 2, watching: false, latest: ago(40),
    byEntity: {
        'urn:fin:gl_balances': { open: 1, total: 1 }, 'urn:fin:net_revenue': { open: 2, total: 3 }, 'urn:fin:dim_customer': { open: 0, total: 1 },
    },
}

export const SUBJECT_PEOPLE: SubjectPeople = {
    viewOwners: [
        { personId: 'usr_ana', via: 'creator', groupId: null, groupName: null, canRead: true },
        { personId: 'usr_eli', via: 'editor_grant', groupId: 'grp_fin', groupName: 'Finance analysts', canRead: true },
    ],
    dataContacts: {
        owner: { personId: 'usr_bo', via: 'named_owner', groupId: null, groupName: null, canRead: true },
        stewards: [
            { personId: 'usr_fay', via: 'named_steward', groupId: null, groupName: null, canRead: false },
        ],
        provenance: 'named',
    },
    fallback: [{ personId: 'usr_dee', via: 'workspace_admin', groupId: null, groupName: null, canRead: true }],
    truncated: 0,
    people: PEOPLE,
}

export const MENTIONABLE = [
    { ...PEOPLE.usr_ana, hint: 'View owner' },
    { ...PEOPLE.usr_bo, hint: 'Data owner' },
    { ...PEOPLE.usr_eli, hint: 'Can edit' },
    { ...PEOPLE.usr_cy, hint: null },
    { ...PEOPLE.usr_dee, hint: 'Workspace admin' },
]

const inbox = (id: string, kind: string, title: string, body: string, actorId: string | null, min: number, read = false, resourceType = 'discussion'): InboxItem => ({
    id, kind, title, body, link: `/views/view_rev?discussion=th_open`, actorId, actorName: actorId ? PEOPLE[actorId]?.displayName : null,
    resourceType, resourceId: 'th_open', readAt: read ? ago(min - 1) : null, createdAt: ago(min),
})

export const INBOX: InboxItem[] = [
    inbox('n1', 'discussion.replied', 'Bo Chen replied on “Revenue lineage — FY26”', 'It’s applied once, in fx_normalise. The ledger you’re comparing with is pre-restatement…', 'usr_bo', 3),
    inbox('n2', 'discussion.mentioned', 'Ana Silva mentioned you on “Revenue lineage — FY26”', '@Sam Reader could you sanity-check the March figures before Friday?', 'usr_ana', 50),
    inbox('n3', 'discussion.asked', 'Cy Park asked about “Revenue lineage — FY26”', 'Why does Net revenue drop in March when the general ledger shows growth?', 'usr_cy', 60 * 26),
    inbox('n4', 'discussion.answered', 'Your question was answered', 'Where does the “Customer tier” column come from?', 'usr_bo', 60 * 24 * 5, true),
    inbox('n5', 'data_source.contact_added', 'You’re a data steward for “Finance marts”', 'People can now ask you about it.', 'usr_dee', 60 * 24 * 6, true, 'data_source'),
    inbox('n6', 'view.shared', '“Cost lineage” was shared with you', 'You can open it as a viewer.', 'usr_ana', 60 * 24 * 9, true, 'view'),
]
