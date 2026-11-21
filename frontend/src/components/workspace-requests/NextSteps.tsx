/**
 * What happens to a workspace request, as three steps — Sent, Reviewed, Ready — with
 * the one it has reached lit. Shown before sending (what will happen), after (where
 * it is) and on the request's status card.
 */
import { Check, Rocket, Send, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

const STEPS = [
    { icon: Send, title: 'Sent', detail: 'The platform team is told straight away.' },
    { icon: ShieldCheck, title: 'Reviewed', detail: 'They may rename it, ask you a question, or approve it.' },
    { icon: Rocket, title: 'Ready', detail: 'You’re its admin, your teammates join, and your graphs move over.' },
]

/** `reached`: how many steps are done (0 before sending; 1 once sent; 3 when ready). `attention`
 *  marks the review step as waiting on the requester (a question). */
export function NextSteps({ reached, attention = false, compact = false }: {
    reached: number
    attention?: boolean
    compact?: boolean
}) {
    return (
        <ol className={cn('relative', compact ? 'flex items-start gap-2' : 'space-y-4')}>
            {STEPS.map((s, i) => {
                const done = i < reached
                const current = i === reached
                const Icon = done ? Check : s.icon
                return (
                    <li key={s.title} className={cn('relative flex gap-3', compact && 'flex-1 flex-col items-center text-center gap-1.5')}>
                        {!compact && i < STEPS.length - 1 && (
                            <span aria-hidden className={cn('absolute left-[15px] top-8 h-[calc(100%-8px)] w-0.5 rounded-full',
                                done ? 'bg-gradient-to-b from-emerald-500 to-emerald-400' : 'bg-black/[0.08] dark:bg-white/[0.10]')} />
                        )}
                        <span className={cn(
                            'relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                            done ? 'border-emerald-500 bg-emerald-500 text-white'
                                : current && attention ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                                    : current ? 'border-violet-500 bg-violet-500/10 text-violet-600 dark:text-violet-300'
                                        : 'border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated text-ink-muted',
                        )}>
                            <Icon className="h-4 w-4" aria-hidden />
                        </span>
                        <span className={cn('min-w-0', !compact && 'pt-1')}>
                            <span className={cn('block text-sm font-semibold', done || current ? 'text-ink' : 'text-ink-muted')}>
                                {s.title}
                                <span className="sr-only">{done ? ' — done' : current ? ' — now' : ''}</span>
                            </span>
                            {!compact && <span className="block text-xs text-ink-muted">{s.detail}</span>}
                        </span>
                    </li>
                )
            })}
        </ol>
    )
}
