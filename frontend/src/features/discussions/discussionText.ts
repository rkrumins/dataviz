/**
 * The words and colours a conversation is drawn with: who someone is (a former member stays one),
 * what role they hold in a thread, how they came to be someone to ask, and each status. Literal
 * class strings throughout — Tailwind only sees classes written out whole.
 */
import type {
    DiscussionStatus, MessageRole, PeopleMap, Person, PersonVia, SubjectKey,
} from '@/services/discussionsService'
import type { StackPerson } from '@/components/ui/AvatarStack'

export const FORMER_MEMBER = 'Former member'

/** A person's name as a conversation shows it. */
export function nameOf(id: string | null | undefined, people: PeopleMap | undefined): string {
    if (!id) return 'Someone'
    const p = people?.[id]
    if (!p) return 'Someone'
    if (p.deleted) return FORMER_MEMBER
    return p.displayName || p.email || 'Someone'
}

/** A person for an avatar stack. */
export function stackPerson(id: string, people: PeopleMap | undefined): StackPerson {
    const p: Person | undefined = people?.[id]
    return { id, name: nameOf(id, people), avatarId: p?.avatarId ?? null, hasImage: p?.hasImage ?? false, deleted: p?.deleted }
}

/** "Ana", "Ana and Bo", "Ana, Bo and 3 others". */
export function listNames(names: readonly string[], max = 3): string {
    if (names.length === 0) return ''
    if (names.length === 1) return names[0]
    if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    const rest = names.length - (max - 1)
    return `${names.slice(0, max - 1).join(', ')} and ${rest} others`
}

export const ROLE_LABEL: Record<MessageRole, string> = {
    asker: 'Asker',
    view_owner: 'View owner',
    data_owner: 'Data owner',
    data_steward: 'Data steward',
    admin: 'Admin',
}

export const ROLE_CLASS: Record<MessageRole, string> = {
    asker: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    view_owner: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
    data_owner: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
    data_steward: 'bg-teal-500/10 text-teal-700 dark:text-teal-300',
    admin: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
}

/** How someone came to be a person to ask, in a few words. */
export const VIA_CAPTION: Record<PersonVia, string> = {
    creator: 'Created this view',
    editor_grant: 'Can edit this view',
    named_owner: 'Data owner',
    named_steward: 'Data steward',
    created_source: 'Connected the data',
    data_request: 'Asked for this data',
    workspace_admin: 'Workspace admin',
    org_admin: 'Org admin',
}

export const STATUS_LABEL: Record<DiscussionStatus, string> = {
    open: 'Open',
    answered: 'Answered',
    closed: 'Closed',
}

export const STATUS_CLASS: Record<DiscussionStatus, string> = {
    open: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25',
    answered: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25',
    closed: 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted border-glass-border',
}

/** "this view", "this data source" — what a subject is called in a sentence. */
export function subjectNoun(subject: SubjectKey): string {
    return subject.type === 'view' ? 'this view' : 'this data source'
}

/** Where a message of a thread is, for Copy link. */
export function messageLink(link: string | null | undefined, threadId: string, messageId?: string | null): string {
    const base = link || '/'
    const url = new URL(base, window.location.origin)
    url.searchParams.set('discussion', threadId)
    if (messageId) url.searchParams.set('message', messageId)
    else url.searchParams.delete('message')
    return url.toString()
}
