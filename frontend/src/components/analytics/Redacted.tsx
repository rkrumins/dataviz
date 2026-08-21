/**
 * The look of something withheld.
 *
 * A redacted dashboard has one job beyond hiding data: it must not read as
 * BROKEN. An empty leaderboard and a hidden leaderboard render identically
 * unless you say which is which, and the empty one is a lie — "nobody was
 * active" instead of "you may not see who was".
 *
 * WHY THE SILHOUETTE IS SYNTHETIC
 * The obvious premium treatment is to render the real component behind frosted
 * glass. It is also a security bug: CSS blur is a paint effect, so every value
 * is still in the DOM and one view-source away. Everything below draws a FAKE
 * shape — deterministic, valueless bars that mimic the real layout — so the
 * reader learns what kind of thing is missing and how much of it there is
 * without a single real number reaching their browser.
 *
 * TWO KINDS OF LOCK, TWO AFFORDANCES
 *   * **Policy** — an operator chose a privacy level. Nothing the reader can
 *     do; say so plainly and don't offer a button that leads nowhere.
 *   * **Access** — they are not a member. That IS actionable, and the product
 *     already has an access-request flow, so the lock becomes its entry point.
 *
 * Deliberately quiet throughout. Most people are not supposed to see most
 * workspaces; that is unremarkable, and styling it like a failure would make a
 * normal state feel like one.
 */
import type { ReactNode } from 'react'
import { Lock, ShieldQuestion, Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { AnalyticsSummary } from '@/services/analyticsService'

type Redaction = NonNullable<AnalyticsSummary['redaction']>

/** Silhouette shapes, matching the geometry of the real components. */
type Shape = 'leaderboard' | 'stats' | 'chart' | 'none'

/**
 * Deterministic pseudo-widths. `Math.random` would re-roll on every render and
 * make the placeholder shimmer as the page updates, which reads as loading
 * rather than as locked.
 */
function pseudo(i: number, min: number, max: number): number {
    const t = (Math.sin(i * 12.9898) * 43758.5453) % 1
    return min + Math.abs(t) * (max - min)
}

function Silhouette({ shape }: { shape: Shape }) {
    if (shape === 'none') return null

    const bar = 'rounded-full bg-black/[0.055] dark:bg-white/[0.07]'

    if (shape === 'stats') {
        // Mirrors `KpiCard`'s geometry — icon square, figure, label, delta
        // chip — so the panel occupies the same box the real row would and the
        // page does not change height depending on who is reading it.
        return (
            <div aria-hidden className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 4 }, (_, i) => (
                    <div key={i} className="rounded-2xl border border-glass-border p-4">
                        <div className={cn(bar, 'mb-3 h-8 w-8 rounded-xl')} />
                        <div className={cn(bar, 'h-6')} style={{ width: `${pseudo(i, 40, 62)}%` }} />
                        <div className={cn(bar, 'mt-1.5 h-2.5')} style={{ width: `${pseudo(i + 9, 55, 85)}%` }} />
                        <div className={cn(bar, 'mt-2 h-3 w-11 rounded-md opacity-60')} />
                    </div>
                ))}
            </div>
        )
    }

    if (shape === 'chart') {
        return (
            <div aria-hidden className="flex h-28 items-end gap-1.5">
                {Array.from({ length: 16 }, (_, i) => (
                    <div
                        key={i}
                        className="flex-1 rounded-t-[3px] bg-black/[0.055] dark:bg-white/[0.07]"
                        style={{ height: `${pseudo(i, 20, 95)}%` }}
                    />
                ))}
            </div>
        )
    }

    // leaderboard — rank chip, name, value. The shape people recognise.
    return (
        <div aria-hidden className="space-y-2.5">
            {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex items-center gap-3">
                    <div className={cn(bar, 'h-5 w-5 shrink-0 rounded-md')} />
                    <div className="min-w-0 flex-1 space-y-1.5">
                        <div className={cn(bar, 'h-2.5')} style={{ width: `${pseudo(i, 35, 70)}%` }} />
                        <div className={cn(bar, 'h-1.5 opacity-60')} style={{ width: `${pseudo(i + 40, 20, 45)}%` }} />
                    </div>
                    <div className={cn(bar, 'h-2.5 w-10 shrink-0')} />
                </div>
            ))}
        </div>
    )
}

/**
 * A whole panel the viewer may not have. Occupies the box the real thing
 * would, so the page does not reflow into a different layout depending on who
 * is reading it.
 */
export function WithheldPanel({
    title, reason, shape = 'leaderboard', action, className,
}: {
    title: string
    /** Why it is hidden, in a sentence a non-admin can act on or accept. */
    reason: string
    shape?: Shape
    /** Only for locks the reader can actually do something about. */
    action?: ReactNode
    className?: string
}) {
    return (
        <section
            aria-label={title}
            className={cn(
                'relative overflow-hidden rounded-xl border border-glass-border bg-canvas-elevated p-4',
                className,
            )}
        >
            {/* The shape of what is missing, drawn from nothing — pushed back
                far enough that it reads as texture rather than as content that
                failed to load.

                Deliberately NOT a scrim over a full-strength silhouette: the
                `canvas-*` tokens hold complete colours rather than channel
                triples, so Tailwind's opacity modifier is inert on them (see
                tailwind.config.js) and `bg-canvas-elevated/80` would either
                paint solid or paint nothing. Fading the silhouette itself needs
                no alpha on a token, and there is nothing to hide behind a scrim
                anyway — every bar here is invented. */}
            <div className="pointer-events-none select-none opacity-[0.45] blur-[1px]">
                <Silhouette shape={shape} />
            </div>

            {/* The explanation sits in a real card on top, so the panel reads as
                one considered object rather than as text floating in a gap. */}
            <div className="absolute inset-0 flex items-center justify-center px-4">
                <div className="flex max-w-lg items-start gap-3 rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3 text-left shadow-md">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-glass-border bg-canvas-base">
                        <Lock className="h-3.5 w-3.5 text-ink-muted" />
                    </span>
                    <div className="min-w-0">
                        <p className="text-xs font-bold text-ink">{title}</p>
                        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                            {reason}
                        </p>
                        {action && <div className="mt-2">{action}</div>}
                    </div>
                </div>
            </div>
        </section>
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
 * Turn the server's redaction record into a sentence. Precise rather than
 * generic: "some things are hidden" teaches people the dashboard is
 * unreliable, where naming exactly what is missing teaches them it is scoped.
 */
export function describeRedaction(r: Redaction): string {
    if (r.showsPeople && r.showsOperations && r.reportsAllWorkspaces) {
        return 'Everything except workspaces you cannot open.'
    }
    const parts: string[] = []
    if (!r.showsPeople) parts.push('who did what')
    if (!r.reportsAllWorkspaces) parts.push("names of workspaces you're not in")
    if (!r.showsOperations) parts.push('access requests and data-refresh health')
    return parts.length ? `Hidden: ${parts.join(', ')}.` : ''
}

/**
 * The page-level notice, shown once at the top rather than repeated beside
 * every hidden thing.
 */
export function RedactionNotice({
    redaction, className,
}: {
    redaction: Redaction
    className?: string
}) {
    // An unresolved workspace map is a different message. Presenting a
    // confident redaction we cannot stand behind would have someone believe
    // they are locked out of workspaces they are actually in.
    if (!redaction.accessResolved) {
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

    const scope = redaction.reportsAllWorkspaces
        ? 'every workspace on the platform'
        : redaction.visibleWorkspaces === null
            ? 'every workspace on the platform'
            : redaction.visibleWorkspaces === 0
                ? 'the whole platform, though you are not a member of any workspace yet'
                : `the whole platform, with full detail for the ${
                    redaction.visibleWorkspaces === 1
                        ? 'workspace' : `${redaction.visibleWorkspaces} workspaces`
                } you belong to`
    const hidden = describeRedaction(redaction)

    return (
        <div
            role="note"
            className={cn(
                'flex items-start gap-3 rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3',
                className,
            )}
        >
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" />
            <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-ink">
                    You're seeing figures for {scope}
                </p>
                {hidden && (
                    <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                        {hidden} Totals and trends always count everything, so the
                        numbers describe the whole platform either way.
                    </p>
                )}
            </div>
        </div>
    )
}
