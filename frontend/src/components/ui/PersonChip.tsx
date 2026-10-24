/**
 * PersonChip — a person, as every record that names one shows them.
 *
 * A face and a name, where a record holds only an id: who triggered a run, who
 * added a member, who acted. Hovering spells the person out — the larger
 * face, their email, their id, and whether the account is gone. The name
 * links to them in User Management.
 *
 * The rules the activity log set for naming people hold here too:
 *
 * - While the name is on its way the chip shimmers in its final shape, so a
 *   column of people does not jump when the batch lands.
 * - An id that names nobody stays the id, verbatim — a system actor, a
 *   hard-deleted row. "Unknown user" would claim a fact nobody has.
 * - A deleted account is still named, and marked.
 * - A service account is shown as one: a bot for a face, no address, and its
 *   name opens it under Service accounts rather than User Management.
 *
 * Names come from the record when it carries them (`person`: an activity
 * event names its people), and otherwise from one batched directory lookup
 * per page (`usePerson`). A page of people without pictures asks for none.
 */
import type { ReactNode } from 'react'
import { Bot } from 'lucide-react'

import { isServiceAccountId, serviceAccountHref } from '@/lib/serviceAccounts'
import { cn } from '@/lib/utils'
import { usePersonLookup } from '@/hooks/usePerson'

import { HoverTip } from './HoverTip'
import { Skeleton } from './Skeleton'
import { UserAvatar } from './UserAvatar'

/** What a record may already know about a person. */
export interface PersonRef {
    name?: string | null
    displayName?: string | null
    email?: string | null
    deleted?: boolean
    avatarId?: string | null
    hasImage?: boolean
}

export type PersonChipSize = 'xs' | 'sm' | 'md'

const SIZES: Record<PersonChipSize, { avatar: string; text: string; gap: string; bar: string }> = {
    xs: { avatar: 'h-4 w-4 text-[7px]', text: 'text-[11px]', gap: 'gap-1.5', bar: 'h-2.5 w-16' },
    sm: { avatar: 'h-5 w-5 text-[8px]', text: 'text-xs', gap: 'gap-1.5', bar: 'h-3 w-20' },
    md: { avatar: 'h-8 w-8 text-[11px]', text: 'text-[13px]', gap: 'gap-2.5', bar: 'h-3.5 w-28' },
}

/** The chip's outermost box: shrinks inside a flex row, so long names truncate. */
const OUTER = 'inline-flex min-w-0 max-w-full align-middle'

/** Where a person is managed. Kept beside the chip so every surface links the same way. */
export const personHref = (id: string) => `/admin/users?user=${encodeURIComponent(id)}`

/** Where whoever an id names is looked after: a service account has its own page. */
export const accountHref = (id: string) => isServiceAccountId(id) ? serviceAccountHref(id) : personHref(id)

export function PersonChip({ id, person, size = 'sm', showEmail = false, caption, link = true, className }: {
    id: string
    /** The person as the record names them; omitted, they are looked up. */
    person?: PersonRef | null
    size?: PersonChipSize
    /** The email under the name (at `md`). */
    showEmail?: boolean
    /** A line under the name, e.g. "who it happened to". */
    caption?: ReactNode
    /** Off inside a link or a row that is itself a button. */
    link?: boolean
    className?: string
}) {
    const lookup = usePersonLookup(person === undefined ? id : null)
    const failed = person === undefined && lookup.isError
    const who: PersonRef | null | undefined = person === undefined ? (failed ? null : lookup.data) : person
    const s = SIZES[size]

    if (who === undefined) {
        return (
            <span className={cn('inline-flex items-center align-middle', s.gap, className)} aria-busy="true">
                <Skeleton className={cn('shrink-0 rounded-full', s.avatar)} />
                <Skeleton className={s.bar} />
                <span className="sr-only">Loading {id}</span>
            </span>
        )
    }

    const account = isServiceAccountId(id)
    const name = who?.name || who?.displayName || null
    // A service account's address is a placeholder nobody can write to.
    const email = account ? null : who?.email || null
    const resolved = !!(name || email)
    const label = name || email || id
    const deleted = !!who?.deleted

    if (!resolved) {
        return (
            <HoverTip
                label={failed ? 'Name not available' : 'Not in the user directory'}
                detail={failed
                    ? `${id} — the user directory could not be reached just now, so the id is shown instead.`
                    : `${id} — no account matches this id. It may be the platform itself, or an account that was permanently removed.`}
                className={cn(OUTER, className)}
            >
                <span className={cn('inline-flex min-w-0 max-w-full items-center', s.gap)}>
                    <span
                        aria-hidden
                        className={cn(
                            'grid shrink-0 place-items-center rounded-full bg-black/[0.05] font-bold text-ink-muted dark:bg-white/[0.07]',
                            s.avatar,
                        )}
                    >
                        ?
                    </span>
                    <span className={cn('truncate font-mono text-ink-secondary', size === 'md' ? 'text-xs' : 'text-[10px]')}>{id}</span>
                </span>
            </HoverTip>
        )
    }

    const face = (className: string) => account ? (
        <span aria-hidden className={cn('grid shrink-0 place-items-center rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400', className)}>
            <Bot className="h-3/5 w-3/5" />
        </span>
    ) : (
        <UserAvatar userId={id} name={label} avatarId={who?.avatarId} hasImage={who?.hasImage} className={className} />
    )

    const nameNode = (
        <span className={cn('block truncate font-semibold text-ink', s.text, link && 'group-hover/person:text-accent-lineage group-hover/person:underline')}>
            {label}
        </span>
    )

    return (
        <HoverTip
            label={
                <span className="flex items-center gap-3">
                    {face(cn('h-10 w-10 text-sm font-bold', deleted && 'grayscale'))}
                    <span className="min-w-0">
                        <span className="block truncate font-semibold text-ink">{label}</span>
                        {account && <span className="block truncate text-[11px] text-ink-secondary">Service account</span>}
                        {email && email !== label && <span className="block truncate text-[11px] text-ink-secondary">{email}</span>}
                        <span className="block truncate font-mono text-[10px] text-ink-muted">{id}</span>
                    </span>
                </span>
            }
            detail={deleted
                ? 'This account has been deleted. It is still named here: the record is of what happened.'
                : link ? (account ? 'Opens it in Service accounts.' : 'Opens their account in User Management.') : undefined}
            className={cn(OUTER, className)}
        >
            <span className={cn('group/person inline-flex min-w-0 max-w-full items-center', s.gap)}>
                {face(cn(s.avatar, 'font-bold ring-1 ring-black/[0.04] dark:ring-white/[0.08]', deleted && 'grayscale opacity-70'))}
                <span className="min-w-0 leading-tight">
                    {link ? (
                        <a href={accountHref(id)} onClick={(e) => e.stopPropagation()} className="outline-none focus-visible:underline">
                            {nameNode}
                        </a>
                    ) : nameNode}
                    {showEmail && email && name && (
                        <span className="block truncate text-[11px] text-ink-muted">{email}</span>
                    )}
                    {caption && <span className="block truncate text-[10px] text-ink-muted">{caption}</span>}
                </span>
                {deleted && (
                    <span className="shrink-0 rounded-full border border-red-500/20 bg-red-500/[0.08] px-1.5 text-[9px] font-semibold leading-4 text-red-600 dark:text-red-400">
                        Deleted
                    </span>
                )}
            </span>
        </HoverTip>
    )
}
