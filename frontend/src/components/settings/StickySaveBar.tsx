/**
 * StickySaveBar — the reminder that something is staged and not saved, with the two ways out:
 * Review (and save) or Discard. It rises into view with the first staged change and stays at the
 * bottom of the page while you scroll; the count is announced politely as it changes.
 */
import { ArrowRight, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

export function StickySaveBar({ count, onReview, onDiscard, problems = 0, saving = false, className }: {
    count: number
    onReview: () => void
    onDiscard: () => void
    /** Staged values that need a fix before they can be saved. */
    problems?: number
    saving?: boolean
    className?: string
}) {
    const visible = count > 0
    const words = `${count} ${count === 1 ? 'change' : 'changes'} not saved yet`
    return (
        <>
            <p className="sr-only" aria-live="polite">{visible ? `${words}${problems ? `, ${problems} to fix` : ''}.` : ''}</p>
            <div
                role="region"
                aria-label="Unsaved changes"
                className={cn(
                    'sticky bottom-4 z-30 px-0 sm:px-4 transition-[opacity,transform,visibility] duration-200 ease-out motion-reduce:transition-none',
                    visible ? 'visible translate-y-0 opacity-100' : 'invisible translate-y-3 opacity-0',
                    className,
                )}
            >
                <div className={cn(
                    'mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-accent-lineage/25 px-4 py-3',
                    // Opaque: it sits in the page's scroller, where a backdrop-filter re-samples every frame.
                    'bg-canvas-elevated',
                    'shadow-[0_1px_2px_rgba(15,23,42,0.08),0_18px_48px_-18px_rgba(15,23,42,0.45)] dark:shadow-[0_18px_48px_-18px_rgba(0,0,0,0.9)]',
                )}>
                    <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-accent-lineage" />
                    <p className="min-w-0 flex-1 text-[13px] font-medium text-ink">
                        {words}
                        {problems > 0 && <span className="ml-2 text-xs font-medium text-rose-600 dark:text-rose-400">· {problems} to fix</span>}
                    </p>
                    <div className="flex flex-1 basis-full items-center justify-end gap-2 sm:basis-auto sm:flex-none">
                        <Button variant="ghost" leftIcon={Undo2} disabled={saving} onClick={onDiscard}>Discard</Button>
                        <Button variant="primary" rightIcon={ArrowRight} disabled={problems > 0} loading={saving} onClick={onReview}>
                            Review changes
                        </Button>
                    </div>
                </div>
            </div>
        </>
    )
}
