/**
 * The look of something withheld.
 *
 * A redacted dashboard has one job beyond hiding data: it must not read as
 * BROKEN. An empty leaderboard and a hidden leaderboard render identically
 * unless you say which is which, and the empty one is a lie — "nobody was
 * active" instead of "you may not see who was".
 *
 * So every withheld thing here states three facts: that something is hidden,
 * why, and what would change it. A lock with no explanation is just a wall.
 *
 * Deliberately quiet. These sit next to real data, and a loud "ACCESS DENIED"
 * would make a normal state feel like a failure — most people are not supposed
 * to see most workspaces, and that is unremarkable.
 */
import { Lock, ShieldQuestion } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * A whole panel the viewer may not have — a leaderboard, an operational
 * section. Occupies the same box the real thing would, so the page does not
 * reflow into a different layout depending on who is reading it.
 */
export function WithheldPanel({
    title, reason, className,
}: {
    title: string
    /** Why it is hidden, in a sentence a non-admin can act on. */
    reason: string
    className?: string
}) {
    return (
        <div
            role="note"
            className={cn(
                'flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-glass-border bg-black/[0.015] dark:bg-white/[0.015] px-6 py-10 text-center',
                className,
            )}
        >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-glass-border bg-canvas-elevated">
                <Lock className="h-4 w-4 text-ink-muted" />
            </span>
            <p className="text-xs font-bold text-ink">{title}</p>
            <p className="max-w-xs text-[11px] leading-relaxed text-ink-muted">
                {reason}
            </p>
        </div>
    )
}

/** Inline stand-in for a single withheld value inside an otherwise real row. */
export function WithheldValue({ label = 'Hidden' }: { label?: string }) {
    return (
        <span
            className="inline-flex items-center gap-1 text-ink-muted/70"
            title="You are not a member of this workspace"
        >
            {/* A dash, not a zero. Zero is a measurement; this is a refusal,
                and rendering it as 0 would drag every average down. */}
            <span aria-hidden>—</span>
            <span className="sr-only">{label}</span>
        </span>
    )
}

/**
 * The page-level notice: this document has been redacted, and here is what was
 * taken out. Shown once, at the top, rather than repeating a caveat beside
 * every hidden thing.
 */
export function RedactionNotice({
    visibleWorkspaces, accessResolved, hidden, className,
}: {
    visibleWorkspaces: number
    accessResolved: boolean
    hidden: string[]
    className?: string
}) {
    // An unresolved workspace map is a different message. Presenting a
    // confident redaction we cannot stand behind would have someone believe
    // they are locked out of workspaces they are actually in.
    if (!accessResolved) {
        return (
            <div
                role="status"
                className={cn(
                    'flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3',
                    className,
                )}
            >
                <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="min-w-0">
                    <p className="text-xs font-bold text-amber-900 dark:text-amber-100">
                        We couldn't confirm your workspace access
                    </p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-amber-900/80 dark:text-amber-100/80">
                        Platform-wide numbers below are correct. Anything shown as
                        locked may not actually be — reload in a moment to get a
                        definitive answer.
                    </p>
                </div>
            </div>
        )
    }

    return (
        <div
            role="note"
            className={cn(
                'flex items-start gap-3 rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3',
                className,
            )}
        >
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
            <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-ink">
                    You're seeing the platform-wide view
                </p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                    Totals and trends below cover the whole platform, including{' '}
                    {visibleWorkspaces === 0
                        ? 'workspaces you are not a member of'
                        : `the ${visibleWorkspaces === 1 ? 'workspace' : `${visibleWorkspaces} workspaces`} you belong to and others you don't`}
                    . Hidden: {hidden.join(' · ').toLowerCase()}.
                </p>
            </div>
        </div>
    )
}
