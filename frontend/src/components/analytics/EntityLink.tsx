/**
 * A name that becomes a link exactly when following it would work.
 *
 * The link is driven by the SAME predicate the API uses to decide what it will
 * serve (`can_open` on the server). That is the point: a link can never point
 * somewhere the product then refuses, because the two answers come from one
 * decision made in one place.
 *
 * So there are three states, not two:
 *   * openable  — a real link
 *   * named but not openable — plain text with a quiet lock, because an
 *     operator has opened workspace REPORTING without granting access
 *   * redacted  — handled upstream; this never sees it
 */
import { Link } from 'react-router-dom'
import { Lock } from 'lucide-react'

import { cn } from '@/lib/utils'

export function WorkspaceLink({
    workspaceId, name, canOpen, className,
}: {
    workspaceId: string
    name: string
    canOpen?: boolean
    className?: string
}) {
    return (
        <EntityLink
            to={`/workspaces/${encodeURIComponent(workspaceId)}`}
            name={name}
            canOpen={canOpen}
            lockedHint="Reported here, but you are not a member — opening it needs access"
            className={className}
        />
    )
}

export function ViewLink({
    viewId, name, canOpen, className,
}: {
    viewId: string
    name: string
    canOpen?: boolean
    className?: string
}) {
    return (
        <EntityLink
            to={`/views/${encodeURIComponent(viewId)}`}
            name={name}
            canOpen={canOpen}
            lockedHint="Counted here, but you do not have access to open it"
            className={className}
        />
    )
}

function EntityLink({
    to, name, canOpen, lockedHint, className,
}: {
    to: string
    name: string
    canOpen?: boolean
    lockedHint: string
    className?: string
}) {
    if (!canOpen) {
        return (
            <span
                title={lockedHint}
                className={cn('inline-flex items-center gap-1 text-ink', className)}
            >
                {name}
                <Lock className="h-2.5 w-2.5 shrink-0 text-ink-muted/60" aria-hidden />
                <span className="sr-only"> — {lockedHint}</span>
            </span>
        )
    }
    return (
        <Link
            to={to}
            // The row behind a leaderboard entry may itself be clickable.
            onClick={(e) => e.stopPropagation()}
            className={cn(
                'rounded underline-offset-2 outline-none hover:underline hover:text-indigo-600 dark:hover:text-indigo-400 focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                className,
            )}
        >
            {name}
        </Link>
    )
}
