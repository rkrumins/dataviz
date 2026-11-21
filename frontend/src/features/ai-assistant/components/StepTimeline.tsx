/**
 * StepTimeline — "How I got this": what the assistant did to answer, step by step, as it does
 * it. Open while the answer is being worked out; folded to one line once it is, a click away.
 */
import { useId, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, ChevronRight, CircleAlert, Loader2 } from 'lucide-react'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'
import type { Step } from '../api/types'

export function StepTimeline({ steps, live }: { steps: Step[]; live: boolean }) {
    const listId = useId()
    // Null follows the answer: open while it streams, folded once done. A click decides for good.
    const [chosen, setChosen] = useState<boolean | null>(null)
    if (steps.length === 0) return null
    const open = chosen ?? live
    const failed = steps.filter((s) => s.status === 'error').length
    const running = steps.find((s) => s.status === 'running')

    return (
        <div className="rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
            <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => setChosen(!open)}
                className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
            >
                <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform duration-150', open && 'rotate-90')} aria-hidden />
                <span className="font-medium text-ink-secondary">How I got this</span>
                <span className="truncate">
                    · {running && live ? running.label : `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`}
                </span>
                {failed > 0 && (
                    <span className="ml-auto shrink-0 text-amber-600 dark:text-amber-400">{failed} didn’t work</span>
                )}
            </button>
            {open && (
                <motion.ol
                    id={listId}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={MOTION.fadeIn}
                    className="relative space-y-1.5 px-2.5 pb-2.5 pt-0.5"
                >
                    {steps.map((s, i) => (
                        <li key={s.id} className="relative flex gap-2 pl-0.5">
                            {i < steps.length - 1 && (
                                <span aria-hidden className="absolute left-[0.6rem] top-5 h-[calc(100%-0.5rem)] w-px bg-glass-border" />
                            )}
                            <StepIcon status={s.status} />
                            <div className="min-w-0 flex-1">
                                <div className={cn('text-xs', s.status === 'running' ? 'font-medium text-ink' : 'text-ink-secondary')}>
                                    {s.label}
                                    <span className="sr-only">
                                        {s.status === 'running' ? ' — in progress' : s.status === 'error' ? ' — didn’t work' : ' — done'}
                                    </span>
                                </div>
                                {s.detail && <div className="break-words text-xs text-ink-muted">{s.detail}</div>}
                            </div>
                        </li>
                    ))}
                </motion.ol>
            )}
        </div>
    )
}

function StepIcon({ status }: { status: Step['status'] }) {
    return (
        <span aria-hidden className={cn('relative z-[1] mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
            status === 'done' && 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
            status === 'running' && 'bg-accent-lineage/15 text-accent-lineage',
            status === 'error' && 'bg-amber-500/15 text-amber-600 dark:text-amber-400')}>
            {status === 'done' && <Check className="h-2.5 w-2.5" />}
            {status === 'running' && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
            {status === 'error' && <CircleAlert className="h-2.5 w-2.5" />}
        </span>
    )
}
