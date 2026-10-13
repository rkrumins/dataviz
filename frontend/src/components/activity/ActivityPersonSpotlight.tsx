/**
 * One person, when the selection is theirs: who they are, what they do most
 * and when, above figures that are now all about them.
 *
 * Shown only for a person picked by id (a leaderboard row, a link someone
 * sent). Typed text can match several people, and a spotlight on a guess
 * would name the wrong one.
 */
import { X } from 'lucide-react'

import { PersonChip } from '@/components/ui/PersonChip'
import { WEEKDAYS, busiestSlot, hourLabel } from '@/components/analytics/charts/punchcard'
import { exact } from '@/lib/formatMetric'
import type { ActivitySummary, PersonRole } from '@/services/activityService'

const ROLE_LINE: Record<PersonRole, string> = {
    any: 'What they did, and what was done to them',
    actor: 'What they did',
    subject: 'What was done to them',
}

const LABEL = 'text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted'

export function ActivityPersonSpotlight({ personId, role, summary, onPickAction, onClear }: {
    personId: string
    role: PersonRole
    /** The summary of their selection; absent while it loads. */
    summary?: ActivitySummary
    onPickAction: (type: string) => void
    onClear: () => void
}) {
    const slot = summary ? busiestSlot(summary.punchcard) : null
    const actions = summary?.topActions.slice(0, 3) ?? []

    return (
        <section
            aria-label="Person in focus"
            className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-2xl border border-indigo-500/20 bg-indigo-500/[0.04] px-4 py-3"
        >
            <PersonChip id={personId} size="md" showEmail caption={ROLE_LINE[role]} className="min-w-[12rem] flex-1" />
            {slot && (
                <div>
                    <p className={LABEL}>Busiest</p>
                    <p className="mt-0.5 text-xs font-semibold text-ink">
                        {WEEKDAYS[slot.day]}s, {hourLabel(slot.hour)} UTC
                    </p>
                </div>
            )}
            {actions.length > 0 && (
                <div className="min-w-0">
                    <p className={LABEL}>Most often</p>
                    <ul className="mt-1 flex flex-wrap gap-1.5">
                        {actions.map((a) => (
                            <li key={a.type}>
                                <button
                                    type="button"
                                    onClick={() => onPickAction(a.type)}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-canvas-elevated px-2 py-0.5 text-[11px] font-medium text-ink hover:border-indigo-500/40 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                                >
                                    {a.label}
                                    <span className="text-[10px] font-semibold tabular-nums text-ink-muted">×{exact(a.count)}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            <button
                type="button"
                onClick={onClear}
                aria-label="Clear the person filter"
                className="shrink-0 self-start rounded-lg p-1.5 text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
            >
                <X className="h-4 w-4" />
            </button>
        </section>
    )
}
