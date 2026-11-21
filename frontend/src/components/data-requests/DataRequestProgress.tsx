/**
 * Where a data request stands, as three steps — Asked, In progress, Connected — in the
 * style of the workspace request's `NextSteps`. Shown before sending (what will happen),
 * after (where it is), on each request in a workspace's list (compact) and in review.
 * A declined or withdrawn request has left the path: it reads as that, not as a step.
 */
import { Check, Database, Loader2, Plug, Send, Undo2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataRequestStatus } from '@/services/dataRequestsService'

const STEPS = [
    { icon: Send, title: 'Asked', detail: 'The platform team is told straight away, and so are this workspace’s admins.' },
    { icon: Plug, title: 'In progress', detail: 'Someone takes it on and may ask the people you named about access.' },
    { icon: Database, title: 'Connected', detail: 'It shows under Data → Sources, ready for views — and you hear in your Inbox.' },
]

/** `status` null: not sent yet. */
export function DataRequestProgress({ status, assigneeName, compact = false }: {
    status: DataRequestStatus | null
    assigneeName?: string | null
    compact?: boolean
}) {
    if (status === 'declined' || status === 'withdrawn') {
        const Icon = status === 'declined' ? XCircle : Undo2
        return (
            <p className={cn('inline-flex items-center gap-1.5 text-xs font-semibold',
                status === 'declined' ? 'text-rose-600 dark:text-rose-400' : 'text-ink-muted')}>
                <Icon className="h-3.5 w-3.5" aria-hidden /> {status === 'declined' ? 'Declined' : 'Withdrawn'}
            </p>
        )
    }
    const done = status === 'connected' ? 3 : status ? 1 : 0
    const working = status === 'in_progress'
    return (
        <ol aria-label="Progress" className={cn('relative', compact ? 'flex items-center gap-1' : 'space-y-4')}>
            {STEPS.map((s, i) => {
                const isDone = i < done
                const current = i === done
                const Icon = isDone ? Check : current && working ? Loader2 : s.icon
                const detail = i !== 1 || !status ? s.detail
                    : working ? `${assigneeName || 'Someone'} is on it.` : status === 'pending' ? 'Waiting for someone to take it on.' : s.detail
                const state = isDone ? ' — done' : current && working ? ' — now' : current ? ' — next' : ''
                if (compact) {
                    return (
                        <li key={s.title} className="flex items-center gap-1">
                            {i > 0 && <span aria-hidden className={cn('h-0.5 w-4 rounded-full', isDone || current ? 'bg-emerald-500/60' : 'bg-black/[0.08] dark:bg-white/[0.10]')} />}
                            <span title={s.title} className={cn(
                                'flex h-5 w-5 items-center justify-center rounded-full border',
                                isDone ? 'border-emerald-500 bg-emerald-500 text-white'
                                    : current ? 'border-violet-500 bg-violet-500/10 text-violet-600 dark:text-violet-300'
                                        : 'border-black/[0.10] dark:border-white/[0.12] text-ink-muted',
                            )}>
                                <Icon className={cn('h-3 w-3', current && working && 'animate-spin')} aria-hidden />
                                <span className="sr-only">{s.title}{state}</span>
                            </span>
                        </li>
                    )
                }
                return (
                    <li key={s.title} className="relative flex gap-3">
                        {i < STEPS.length - 1 && (
                            <span aria-hidden className={cn('absolute left-[15px] top-8 h-[calc(100%-8px)] w-0.5 rounded-full',
                                isDone ? 'bg-gradient-to-b from-emerald-500 to-emerald-400' : 'bg-black/[0.08] dark:bg-white/[0.10]')} />
                        )}
                        <span className={cn(
                            'relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                            isDone ? 'border-emerald-500 bg-emerald-500 text-white'
                                : current ? 'border-violet-500 bg-violet-500/10 text-violet-600 dark:text-violet-300'
                                    : 'border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated text-ink-muted',
                        )}>
                            <Icon className={cn('h-4 w-4', current && working && 'animate-spin')} aria-hidden />
                        </span>
                        <span className="min-w-0 pt-1">
                            <span className={cn('block text-sm font-semibold', isDone || current ? 'text-ink' : 'text-ink-muted')}>
                                {s.title}
                                <span className="sr-only">{state}</span>
                            </span>
                            <span className="block text-xs text-ink-muted">{detail}</span>
                        </span>
                    </li>
                )
            })}
        </ol>
    )
}
