/**
 * StageCard — one stage of the automation pipeline: what it does, what it
 * costs, how often it runs, and what it has actually been doing.
 *
 * The three cards are identical in shape on purpose. The dialog this replaces
 * gave each policy its own box, its own vocabulary and its own units, so a
 * reader could not line them up; here the only thing that changes between ①,
 * ② and ③ is the words and one accent.
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

import { STAGES, STAGE_ACCENT } from './automationCopy'

export function StageCard({ stage, on, muted = false, stat, children }: {
    stage: keyof typeof STAGES
    /** null = this reader is not allowed to see the setting. Saying "off"
     *  would be a lie, and saying "on" a worse one. */
    on: boolean | null
    /** The stage feeding this one is off, so its cadence buys less than it
     *  claims — worth showing on the stage itself, not only in a warning. */
    muted?: boolean
    /** What this stage has actually been doing: the live count. */
    stat?: ReactNode
    children?: ReactNode
}) {
    const s = STAGES[stage]
    const accent = STAGE_ACCENT[stage]

    return (
        <section
            aria-label={s.name}
            className={cn(
                'flex-1 min-w-0 rounded-xl border border-l-2 px-3.5 py-3',
                on === false
                    ? 'border-glass-border/60 bg-glass-base/20'
                    : 'border-glass-border bg-canvas',
                // Last, because ``cn`` is tailwind-merge and a whole-border
                // colour listed after a left-border colour would drop it — and
                // the accent has to survive the "off" surface, which is the
                // state the reader most needs to place in the sequence.
                accent.rule,
            )}
        >
            <header className="flex items-center gap-2.5">
                <span
                    aria-hidden
                    className={cn('text-2xl font-bold tabular-nums leading-none', accent.numeral)}
                >
                    {s.n}
                </span>
                <h4 className="text-sm font-semibold uppercase tracking-wide text-ink">{s.name}</h4>
                <span
                    aria-hidden
                    className={cn(
                        'ml-auto w-2 h-2 rounded-full shrink-0',
                        on == null ? 'border border-ink-muted/50'
                            : !on ? 'bg-slate-400/60'
                                : muted ? 'bg-amber-500' : 'bg-emerald-500',
                    )}
                />
                <span className="sr-only">
                    {on == null ? 'Not visible to you'
                        : !on ? 'Off'
                            : muted ? 'On, but starved' : 'On'}
                </span>
            </header>

            {/* Starved dims what this stage DELIVERS — its promise and its
                numbers — and never its controls: they still work, and greying
                a live control would be the lie the dimming exists to expose. */}
            <div className={cn(muted && 'opacity-60')}>
                <p className="mt-1.5 text-[13px] text-ink-secondary leading-snug">{s.means}</p>
                <p className="mt-1 text-[11px] text-ink-muted leading-snug">{s.costs}</p>
            </div>

            {children != null && <div className="mt-3 space-y-3">{children}</div>}

            {stat != null && (
                <p className={cn(
                    'mt-3 pt-2.5 border-t border-glass-border/60 text-[11px] text-ink-muted tabular-nums',
                    muted && 'opacity-60',
                )}>
                    {stat}
                </p>
            )}
        </section>
    )
}
