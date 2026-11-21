/**
 * QuestionsButton — "Questions (n)": opens the questions drawer on a view or a data source. The
 * count is the open questions; a dot says one of them has something the reader hasn't read.
 * Nothing at all while the switch is off.
 */
import { MessageCircleQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { useConversationsEnabled, useSubjectSummary } from './useDiscussions'
import { useDiscussionsDrawer, type DrawerSubject } from './drawerStore'
import { subjectNoun } from './discussionText'

export function QuestionsButton({ subject, className, labelClassName }: {
    subject: DrawerSubject
    className?: string
    /** The word "Questions" (e.g. `hidden lg:inline` in a cramped header). */
    labelClassName?: string
}) {
    const on = useConversationsEnabled()
    const summary = useSubjectSummary(on ? subject : null).data
    const open = useDiscussionsDrawer((s) => s.open)
    if (!on) return null
    const count = summary?.open ?? 0
    const unread = (summary?.unread ?? 0) > 0
    const noun = subjectNoun(subject)
    return (
        <HoverTip className="inline-flex" label={`Ask the people who look after ${noun}, and read what others asked`}
            detail={summary ? `${count.toLocaleString()} open · ${summary.answered.toLocaleString()} answered${unread ? ` · ${summary.unread} unread` : ''}` : undefined}>
            <button type="button" onClick={() => open({ subject })}
                aria-label={`Questions${count ? `, ${count} open` : ''}${unread ? `, ${summary!.unread} unread` : ''}`}
                className={cn('relative', className)}>
                <MessageCircleQuestion className="w-3.5 h-3.5" aria-hidden />
                <span className={labelClassName}>Questions</span>
                {count > 0 && (
                    <span aria-hidden className="min-w-[1.125rem] h-[1.125rem] px-1 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[10px] font-bold tabular-nums leading-[1.125rem] text-center">
                        {count > 99 ? '99+' : count}
                    </span>
                )}
                {unread && <span aria-hidden className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-accent-lineage ring-2 ring-canvas-elevated" />}
            </button>
        </HoverTip>
    )
}
