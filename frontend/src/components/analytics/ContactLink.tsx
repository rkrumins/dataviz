/**
 * A colleague's address, where the server chose to send one.
 *
 * Reads no feature flag. The address is in the payload or it is not, and that
 * decision was made server-side against the reader's own scope — a client that
 * re-checked would be a second opinion on a question already answered, and the
 * two would eventually disagree.
 *
 * Only ever appears where a person is attached to something the reader can
 * already open: the creator of a view, a contributor in their own workspace.
 * The platform-wide activity ranking never carries addresses, whatever the
 * operator has set.
 */
import { Mail } from 'lucide-react'

import { cn } from '@/lib/utils'

export function ContactLink({ email, name, className }: {
    email?: string | null
    /** Whose address it is — the accessible label needs to say. */
    name?: string | null
    className?: string
}) {
    if (!email) return null
    return (
        <a
            href={`mailto:${email}`}
            // The row it sits in is often itself clickable (a leaderboard row
            // opens a drill-in), so this must not also trigger that.
            onClick={(e) => e.stopPropagation()}
            title={name ? `Email ${name}` : `Email ${email}`}
            aria-label={name ? `Email ${name} at ${email}` : `Email ${email}`}
            className={cn(
                'inline-flex max-w-full items-center gap-1 truncate rounded text-ink-muted',
                'outline-none transition-colors hover:text-indigo-600 dark:hover:text-indigo-400',
                'focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                className,
            )}
        >
            <Mail className="h-2.5 w-2.5 shrink-0" aria-hidden />
            <span className="truncate">{email}</span>
        </a>
    )
}
