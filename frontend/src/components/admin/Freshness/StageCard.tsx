/**
 * StageCard — one stage of the automation pipeline: what it does, what it
 * costs, how often it runs, and what it has actually been doing.
 *
 * The three cards are identical in shape on purpose. The dialog this replaces
 * gave each policy its own box, its own vocabulary and its own units, so a
 * reader could not line them up; here the only thing that changes between ①,
 * ② and ③ is the words.
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

import { STAGES } from './automationCopy'

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

    return (
        <section
            aria-label={s.name}
            className={cn(
                'flex-1 min-w-0 rounded-xl border px-3 py-2.5',
                on === false
                    ? 'border-glass-border/60 bg-glass-base/20'
                    : 'border-glass-border bg-canvas',
            )}
        >
            <header className="flex items-center gap-2">
                <span aria-hidden className="text-[13px] text-ink-muted">{s.n}</span>
                <h4 className="text-[13px] font-semibold text-ink">{s.name}</h4>
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

            <p className="mt-1 text-[12px] text-ink-secondary leading-snug">{s.means}</p>
            <p className="mt-0.5 text-[11px] text-ink-muted leading-snug">{s.costs}</p>

            {children != null && <div className="mt-2.5 space-y-2.5">{children}</div>}

            {stat != null && (
                <p className="mt-2.5 pt-2 border-t border-glass-border/60 text-[11px] text-ink-muted tabular-nums">
                    {stat}
                </p>
            )}
        </section>
    )
}
