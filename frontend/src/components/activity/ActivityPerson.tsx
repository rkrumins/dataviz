/**
 * A person in the activity log, and an identifier worth copying.
 *
 * Moved from the old audit page, rules intact:
 *
 * - A resolved person shows their name and email; the id moves to the
 *   details, where it is useful for joining rather than in the way of reading.
 * - An id the server could not resolve stays the id, verbatim. A
 *   system-generated event, a hard-deleted row and a payload naming something
 *   that was never a user are all real states; "Unknown user" printed over
 *   them would claim a fact nobody has. The tip says which you are looking at.
 * - A soft-deleted account is still named — a log's most valuable row is
 *   often about an account that is gone — and is marked as deleted.
 */
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { UserAvatar } from '@/components/ui/UserAvatar'
import type { ActivityPersonRef } from '@/services/activityService'

import { personHref } from './activityLinks'

export function ActivityPerson({ person, caption, size = 'sm', link = true }: {
    person?: ActivityPersonRef | null
    /** A second line, e.g. "who it happened to". */
    caption?: string
    size?: 'sm' | 'md'
    /** Off inside a row that is itself a button. */
    link?: boolean
}) {
    if (!person?.id) {
        return <span className="text-ink-muted">—</span>
    }
    const { id, name, email, deleted } = person
    const resolved = !!name || !!email
    const label = name || email || id
    const avatar = size === 'md' ? 'h-8 w-8 text-[11px]' : 'h-6 w-6 text-[10px]'
    const text = (
        <span
            className={cn(
                'block truncate',
                resolved ? 'text-xs font-semibold text-ink' : 'font-mono text-[11px] text-ink-secondary',
                link && 'hover:text-accent-lineage hover:underline',
            )}
        >
            {label}
        </span>
    )

    return (
        <HoverTip
            label={resolved ? label : 'Not in the user directory'}
            detail={
                resolved
                    ? `${email ? email + ' · ' : ''}${id}${deleted ? ' · this account has been deleted' : ''}`
                    : `${id} — no user record matches this id. It may be a system-generated `
                      + `event, or an account that has been permanently removed.`
            }
        >
            <span className="flex items-center gap-2 min-w-0">
                {/* Only a resolved id gets the real avatar: an id matching no
                    account would fire a 404 avatar request per row. */}
                {resolved ? (
                    <UserAvatar userId={id} name={label} shape="gradient" className={cn(avatar, 'font-bold')} />
                ) : (
                    <span
                        aria-hidden
                        className={cn(
                            'shrink-0 grid place-items-center rounded-full font-bold bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted',
                            avatar,
                        )}
                    >
                        ?
                    </span>
                )}
                <span className="min-w-0 leading-tight">
                    {link ? (
                        <a href={personHref(id)} onClick={(e) => e.stopPropagation()}>{text}</a>
                    ) : text}
                    {resolved && email && name && (
                        <span className="block truncate text-[10px] text-ink-muted">{email}</span>
                    )}
                    {caption && <span className="block truncate text-[10px] text-ink-muted">{caption}</span>}
                    {deleted && (
                        <span className="mt-0.5 inline-flex items-center gap-1 rounded-full border border-red-500/20 bg-red-500/[0.08] px-1.5 text-[9px] font-semibold text-red-600 dark:text-red-400">
                            Deleted
                        </span>
                    )}
                </span>
            </span>
        </HoverTip>
    )
}

/** A raw identifier, shown where it is useful to copy rather than to read. */
export function IdField({ label, value, href }: { label: string; value?: string | null; href?: string }) {
    const [copied, setCopied] = useState(false)
    if (!value) return null
    return (
        <div className="min-w-0">
            <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">{label}</dt>
            <dd className="mt-0.5 flex items-center gap-1.5 min-w-0">
                {href ? (
                    <a href={href} onClick={(e) => e.stopPropagation()}
                       className="font-mono text-[11px] text-ink-secondary truncate hover:text-accent-lineage hover:underline">
                        {value}
                    </a>
                ) : (
                    <span className="font-mono text-[11px] text-ink-secondary truncate">{value}</span>
                )}
                <button
                    type="button"
                    aria-label={`Copy ${label}`}
                    onClick={(e) => {
                        e.stopPropagation()
                        // Best effort: a denied clipboard must not throw in a log row.
                        navigator.clipboard?.writeText(value).then(
                            () => { setCopied(true); setTimeout(() => setCopied(false), 1200) },
                            () => {},
                        )
                    }}
                    className="shrink-0 rounded p-0.5 text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                >
                    {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                </button>
            </dd>
        </div>
    )
}
