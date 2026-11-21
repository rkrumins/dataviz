/**
 * QuestionCountChip — a card's amber "?" with how many of the questions about it are open, and a
 * dot when one has something the reader hasn't read (a quiet chip, counting them all, once every
 * one is answered or closed but one is still unread). Clicking it opens the questions — never the
 * card it sits on. Nothing at all when there is nothing to say.
 *
 * The counts come from the list (`useSubjectCounts`), fetched once for every card on screen.
 */
import { MessageCircleQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { SubjectCount } from '@/services/discussionsService'

const questions = (n: number, what = '') => `${n.toLocaleString()} ${what}${n === 1 ? 'question' : 'questions'}`

/** "3 open questions, 1 unread"; once none is open, "2 questions, all answered or closed, 1 unread". */
function questionCountLabel(c: SubjectCount): string {
    const head = c.open > 0 ? questions(c.open, 'open ') : `${questions(c.total)}, all answered or closed`
    return c.unread > 0 ? `${head}, ${c.unread.toLocaleString()} unread` : head
}

export function QuestionCountChip({ count, onOpen, className }: {
    count?: SubjectCount
    onOpen: () => void
    className?: string
}) {
    if (!count || (count.open === 0 && count.unread === 0)) return null
    const open = count.open > 0
    const shown = open ? count.open : count.total
    const label = questionCountLabel(count)
    return (
        <HoverTip className={cn('inline-flex shrink-0', className)} label={label} detail="Click to read them, or ask another">
            <button type="button" aria-label={label}
                onClick={(e) => { e.stopPropagation(); onOpen() }}
                // The card opens on Enter too: the key is the chip's.
                onKeyDown={(e) => e.stopPropagation()}
                className={cn(
                    'relative inline-flex h-5 items-center gap-1 rounded-full border pl-1.5 pr-2 text-[10.5px] font-bold tabular-nums leading-none',
                    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50',
                    open
                        ? 'border-amber-500/35 bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300'
                        : 'border-glass-border/70 bg-black/[0.04] text-ink-muted hover:text-ink dark:bg-white/[0.06]',
                )}>
                <MessageCircleQuestion aria-hidden className="h-3 w-3" />
                {shown > 99 ? '99+' : shown}
                {count.unread > 0 && (
                    <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent-lineage ring-2 ring-canvas-elevated" />
                )}
            </button>
        </HoverTip>
    )
}
