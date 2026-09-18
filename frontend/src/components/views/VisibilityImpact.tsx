/**
 * VisibilityImpact — "here is what this choice actually does".
 *
 * Every surface that offers a visibility tier used to offer three words
 * (Private / Workspace / Enterprise) and one sentence. That is enough to
 * pick a tier and not nearly enough to feel safe picking one, which is
 * why people default to Private and their work never leaves their
 * screen. The two questions nobody could answer from the tiles were:
 *
 *   "Who is 'everyone', exactly?"   → an abstraction until it has a
 *      number attached. The browser cannot count it: the workspace list
 *      it holds is scoped to the caller's own memberships and carries no
 *      member counts. The server answers it (`audience`).
 *
 *   "What can they DO to it?"       → the fear that stops people
 *      publishing is losing control of the thing. Saying plainly that
 *      nobody else can change it, delete it, or reach the rest of the
 *      workspace is what makes the choice safe to make. So `cannot` is
 *      given the same weight as `can`, not tucked into a tooltip.
 *
 * It also states the DELTA. "12 → about 1,240 people" is the sentence a
 * person weighs; "Enterprise" is not.
 *
 * Rendered from `lib/viewVisibility` so the wizard, the Share dialog and
 * the Details panel cannot drift into describing the same tier
 * differently — the drift that had eight surfaces carrying three
 * conflicting descriptions before.
 */
import { useMemo } from 'react'
import { ArrowRight, Check, Info, Minus, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
    VISIBILITY_ACCENT,
    visibilityGrants,
    visibilityLabel,
    VISIBILITY_ICON,
    isKnownVisibility,
    type ViewVisibility,
} from '@/lib/viewVisibility'
import { useBrand } from '@/store/branding'

export interface AudienceCounts {
    /** People bound to the view's workspace, group bindings expanded. */
    workspaceMemberCount?: number
    /** Active accounts on the whole deployment. */
    platformUserCount?: number
    /** People and groups this view is shared with directly. */
    explicitGrantCount?: number
}

/** How many people a tier reaches. `null` = not knowable yet (counts
 *  still loading) — rendered as a phrase rather than a wrong number,
 *  because a count that arrives late and contradicts itself is worse
 *  than no count at all. */
function reachOf(
    tier: ViewVisibility, counts: AudienceCounts,
): number | null {
    const grants = counts.explicitGrantCount ?? 0
    switch (tier) {
        // You, plus whoever it is shared with directly. Workspace admins
        // also reach it, but they are not a number the sharer can see.
        // With no counts at all the share total is unknown, and "1
        // person" would understate a view that may be shared with ten —
        // an error in the direction that matters for a sharing decision.
        case 'private':
            return counts.explicitGrantCount == null ? null : 1 + grants
        case 'workspace':
            return counts.workspaceMemberCount == null
                ? null
                : Math.max(counts.workspaceMemberCount, 1) + grants
        case 'enterprise':
            return counts.platformUserCount ?? null
    }
}

/** Round to something a person reads as an estimate rather than a
 *  ledger. 1,247 people is not a fact anyone needs to the unit, and a
 *  precise-looking number invites someone to check it against a user
 *  list that moves every day. */
function approximate(n: number): string {
    if (n < 100) return String(n)
    if (n < 1000) return `~${Math.round(n / 10) * 10}`
    return `~${(Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, '')}k`
}

function peopleLabel(n: number | null): string {
    if (n == null) return 'people'
    return `${approximate(n)} ${n === 1 ? 'person' : 'people'}`
}

export function VisibilityImpact({
    selected,
    saved,
    counts: rawCounts,
    workspaceName,
    requiresApproval,
    approvalHint,
    className,
}: {
    /** The tier currently chosen in the form. */
    selected: ViewVisibility
    /** The tier the view is SAVED at — omitted while creating, which is
     *  what makes the delta line disappear rather than claim a change
     *  from a tier that was never set. */
    saved?: ViewVisibility
    /** Null where a payload predates the counts — rendered as a
     *  phrase, never as the number zero. */
    counts?: AudienceCounts | null
    workspaceName?: string
    /** Choosing this tier files a request instead of applying it. */
    requiresApproval?: boolean
    approvalHint?: string
    className?: string
}) {
    const { appName } = useBrand()
    const counts = rawCounts ?? {}

    // The database's domain is wider than this app's: `ck_views_visibility`
    // still permits 'public', and live rows carry it. Every per-tier map here
    // has three keys, so an unknown tier used to reach `accent.chipBg` on
    // undefined and take the whole Details panel down with it.
    //
    // It renders a statement of what is known instead of a guess. Deliberately
    // NOT mapped onto the nearest tier: 'public' may be MORE exposed than
    // 'Anyone signed in', and under-stating the audience on the panel whose one
    // job is naming the audience is the one wrong answer here.
    if (!isKnownVisibility(selected)) {
        return (
            <section
                aria-label="Who will see this view"
                className={cn(
                    'rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden',
                    className,
                )}
            >
                <header className="flex items-start gap-3 px-4 py-3.5">
                    <span className="w-9 h-9 rounded-xl border border-amber-500/30 bg-canvas-elevated flex items-center justify-center shrink-0">
                        <Info className="w-4.5 h-4.5 text-amber-400" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                            Who will see this
                        </p>
                        <p className="text-sm font-bold text-ink leading-snug mt-0.5">
                            Set to &ldquo;{String(selected)}&rdquo;, which isn&rsquo;t one of the sharing options
                        </p>
                        <p className="text-[11px] text-ink-muted mt-1 leading-relaxed">
                            This view predates the current sharing settings, so its audience can&rsquo;t be
                            shown here. Choosing one of the options above will replace it.
                        </p>
                    </div>
                </header>
            </section>
        )
    }

    const accent = VISIBILITY_ACCENT[selected]
    const Icon = VISIBILITY_ICON[selected]

    const grants = useMemo(
        () => visibilityGrants(selected, { appName, workspaceName }),
        [selected, appName, workspaceName],
    )

    const reach = reachOf(selected, counts)
    const savedReach = saved ? reachOf(saved, counts) : null
    const changed = saved != null && saved !== selected
    const delta = changed && reach != null && savedReach != null
        ? reach - savedReach
        : null

    return (
        <section
            aria-label="Who will see this view"
            className={cn(
                'rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden',
                className,
            )}
        >
            {/* ── Headline: the audience, with its size ───────────── */}
            <header className={cn(
                'flex items-start gap-3 px-4 py-3.5 border-b border-glass-border',
                accent.chipBg,
            )}>
                <span className={cn(
                    'w-9 h-9 rounded-xl border flex items-center justify-center shrink-0',
                    accent.chipBorder, 'bg-canvas-elevated',
                )}>
                    <Icon className={cn('w-4.5 h-4.5', accent.iconText)} />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                        Who will see this
                    </p>
                    <p className="text-sm font-bold text-ink leading-snug mt-0.5">
                        {selected === 'private'
                            ? 'Only you and people you choose'
                            : selected === 'workspace'
                                ? `Everyone in ${workspaceName ?? 'this workspace'}`
                                : `Anyone signed in to ${appName}`}
                    </p>
                    <p className="text-[11px] text-ink-muted mt-0.5 tabular-nums">
                        {reach == null
                            ? 'Counting…'
                            : `About ${peopleLabel(reach)}`}
                        {(counts.explicitGrantCount ?? 0) > 0 && selected !== 'enterprise' && (
                            <span> · including {counts.explicitGrantCount} shared directly</span>
                        )}
                    </p>
                </div>
            </header>

            {/* ── The delta: the sentence a person actually weighs ── */}
            {changed && (
                <div className={cn(
                    'flex items-center gap-2 px-4 py-2 text-[11px] font-medium border-b border-glass-border',
                    delta != null && delta > 0
                        ? 'text-amber-600 dark:text-amber-400 bg-amber-500/[0.06]'
                        : delta != null && delta < 0
                            ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/[0.06]'
                            : 'text-ink-muted',
                )}>
                    <span className="text-ink-muted">{visibilityLabel(saved!)}</span>
                    <ArrowRight className="w-3 h-3 text-ink-muted shrink-0" />
                    <span className="text-ink font-semibold">{visibilityLabel(selected)}</span>
                    {delta != null && delta !== 0 && (
                        <span className="ml-auto inline-flex items-center gap-1 tabular-nums">
                            {delta > 0
                                ? <>+{approximate(delta)} more people</>
                                : <><Minus className="w-3 h-3" />{approximate(-delta)} fewer people</>}
                        </span>
                    )}
                </div>
            )}

            {/* ── What they can and can't do ──────────────────────── */}
            <div className="p-4 grid gap-3 sm:grid-cols-2">
                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1.5">
                        They can
                    </p>
                    <ul className="space-y-1.5">
                        {grants.can.map(line => (
                            <li key={line} className="flex items-start gap-1.5 text-[11px] text-ink leading-relaxed">
                                <Check className="w-3 h-3 mt-0.5 shrink-0 text-emerald-500" />
                                <span>{line}</span>
                            </li>
                        ))}
                    </ul>
                </div>
                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
                        They can&rsquo;t
                    </p>
                    <ul className="space-y-1.5">
                        {grants.cannot.map(line => (
                            <li key={line} className="flex items-start gap-1.5 text-[11px] text-ink-muted leading-relaxed">
                                <X className="w-3 h-3 mt-0.5 shrink-0 text-ink-muted/60" />
                                <span>{line}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>

            {/* ── What happens when you save ──────────────────────── */}
            {requiresApproval && approvalHint && (
                <footer className={cn(
                    'flex items-start gap-2 px-4 py-2.5 border-t text-[11px] leading-relaxed',
                    VISIBILITY_ACCENT.enterprise.chipBorder,
                    VISIBILITY_ACCENT.enterprise.chipBg,
                    'text-amber-700 dark:text-amber-300',
                )}>
                    <Info className="w-3.5 h-3.5 mt-px shrink-0" />
                    <span>
                        <strong className="font-semibold">Nothing is published yet.</strong>{' '}
                        {approvalHint.replace(/^Needs approval — /, '')}. You&rsquo;ll be
                        notified when it&rsquo;s answered.
                    </span>
                </footer>
            )}
        </section>
    )
}
