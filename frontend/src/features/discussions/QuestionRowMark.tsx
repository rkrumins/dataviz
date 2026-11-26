/**
 * QuestionRowMark — an amber "?" on a canvas row or card that questions were asked about, with how
 * many are still open (a quiet one once all are answered or closed). Clicking it opens the
 * questions drawer on just those questions.
 *
 * Each row reads only its own entry in the anchor store: on a view with no questions it is one
 * lookup and nothing drawn.
 */
import { HoverTip } from '@/components/ui/HoverTip'
import { cn } from '@/lib/utils'
import { useGraphProviderIfAvailable } from '@/providers/GraphProviderContext'
import { useAnchorCount, useAnchorStore } from './anchorStore'
import { useDiscussionsDrawer } from './drawerStore'
import { anchorOf, completeAnchorPath } from './anchorOf'

export function QuestionRowMark({ urn, label, className }: {
    urn: string | null | undefined
    /** The row's name, for the drawer's filter chip when the canvas doesn't hold the row's node. */
    label?: string | null
    className?: string
}) {
    const count = useAnchorCount(urn)
    const provider = useGraphProviderIfAvailable()
    if (!urn || !count || count.total === 0) return null
    const open = count.open
    const show = () => {
        const viewId = useAnchorStore.getState().viewId
        if (!viewId) return
        const entity = anchorOf(urn, { label })
        useDiscussionsDrawer.getState().open({ subject: { type: 'view', id: viewId }, entity })
        completeAnchorPath(entity, provider)
    }
    const words = open > 0
        ? `${open.toLocaleString()} open ${open === 1 ? 'question' : 'questions'} about this`
        : `${count.total.toLocaleString()} ${count.total === 1 ? 'question' : 'questions'} about this, all answered or closed`
    return (
        <HoverTip className={cn('flex', className)} label={words} detail="Click to read them, or ask another">
            <button type="button" aria-label={words}
                onClick={(e) => { e.stopPropagation(); show() }}
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                className={cn('nodrag nopan inline-flex h-5 items-center gap-0.5 rounded-full border px-1.5 text-[10.5px] font-bold tabular-nums leading-none flex-shrink-0',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 transition-colors',
                    open > 0
                        ? 'border-amber-500/35 bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300'
                        : 'border-glass-border/70 bg-black/[0.04] text-ink-muted hover:text-ink dark:bg-white/[0.06]')}>
                <span aria-hidden className="text-[11px] leading-none">?</span>
                {open > 0 ? open : count.total}
            </button>
        </HoverTip>
    )
}
