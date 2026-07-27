/**
 * Confirmation for a bulk visibility change that WIDENS access.
 *
 * Changing several views' visibility at once is the single gesture in the
 * product that can expose N views to the whole organisation in one click.
 * It used to happen immediately, with no confirmation, and report partial
 * failure as "Some views could not be updated".
 *
 * Narrowing needs no confirmation — it can only reduce reach, and making
 * people confirm a safe action teaches them to click through the dialog
 * that matters.
 */
import { AlertTriangle, X } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { cn } from '@/lib/utils'
import { VISIBILITY_META } from '@/types/viewVisibility'
import type { ViewVisibility } from '@/types/viewVisibility'

interface BulkVisibilityConfirmDialogProps {
    isOpen: boolean
    /** The tier being applied. */
    visibility: ViewVisibility
    /** How many views are selected in total. */
    count: number
    /** How many of them this actually widens. */
    wideningCount: number
    onCancel: () => void
    onConfirm: () => void
}

export function BulkVisibilityConfirmDialog({
    isOpen,
    visibility,
    count,
    wideningCount,
    onCancel,
    onConfirm,
}: BulkVisibilityConfirmDialogProps) {
    if (!isOpen) return null

    const meta = VISIBILITY_META[visibility]
    const Icon = meta.icon
    const plural = count !== 1 ? 's' : ''

    return (
        <>
            <Backdrop open onClick={onCancel} />
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="bulk-visibility-title"
                className={cn(
                    'fixed left-1/2 top-1/2 z-[60] w-[min(30rem,calc(100vw-2rem))]',
                    '-translate-x-1/2 -translate-y-1/2 rounded-2xl p-6',
                    'bg-white dark:bg-slate-900 border border-glass-border shadow-xl',
                )}
            >
                <button
                    onClick={onCancel}
                    aria-label="Cancel"
                    className="absolute right-4 top-4 rounded-lg p-1.5 text-ink-muted hover:bg-black/5 dark:hover:bg-white/5"
                >
                    <X className="h-4 w-4" />
                </button>

                <div className="flex items-start gap-3">
                    <span className="mt-0.5 rounded-xl bg-amber-500/10 p-2 text-amber-500">
                        <AlertTriangle className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                        <h2
                            id="bulk-visibility-title"
                            className="text-base font-semibold text-ink"
                        >
                            Widen access for {wideningCount} view{wideningCount !== 1 ? 's' : ''}?
                        </h2>
                        <p className="mt-2 text-sm text-ink-muted">
                            You're setting {count} view{plural} to{' '}
                            <span className="inline-flex items-center gap-1 font-medium text-ink">
                                <Icon className="h-3.5 w-3.5" />
                                {meta.label}
                            </span>
                            .{' '}
                            {wideningCount === count
                                ? 'This'
                                : `${wideningCount} of them`}{' '}
                            will become visible to {meta.reach}.
                        </p>
                        <p className="mt-2 text-xs text-ink-muted/80">
                            Narrowing it again later won't un-share anything
                            people have already seen.
                        </p>
                    </div>
                </div>

                <div className="mt-6 flex justify-end gap-2">
                    <button
                        onClick={onCancel}
                        className="rounded-xl px-4 py-2 text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600"
                    >
                        Set to {meta.label}
                    </button>
                </div>
            </div>
        </>
    )
}
