/**
 * Inline error card for the Results pane when a search request fails.
 * Lighter visual weight than the legacy full-stage error — the user
 * still has the query in view above and can refine and retry.
 */
import { AlertCircle } from 'lucide-react'

import { cn } from '@/lib/utils'

import { readableSearchError } from './errorPaths'


export function ErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
    return (
        <div className="p-4">
            <div className={cn(
                "rounded-xl p-3.5",
                "bg-gradient-to-br from-rose-500/10 to-amber-500/5",
                "border border-rose-500/30",
            )}>
                <div className="flex items-start gap-2.5">
                    <div className={cn(
                        "shrink-0 w-7 h-7 rounded-lg flex items-center justify-center",
                        "bg-rose-500/15 text-rose-600 dark:text-rose-400",
                        "border border-rose-500/30",
                    )}>
                        <AlertCircle className="w-3.5 h-3.5" strokeWidth={2.2} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-rose-700 dark:text-rose-300">
                            Search failed
                        </div>
                        <div className="mt-1.5 text-[12px] text-ink leading-relaxed whitespace-pre-wrap break-words">
                            {readableSearchError(message)}
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                            {onRetry && (
                                <button
                                    type="button"
                                    onClick={onRetry}
                                    className={cn(
                                        'shrink-0 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold text-ink',
                                        'border border-glass-border hover:bg-glass/40 transition-colors',
                                    )}
                                >
                                    Try again
                                </button>
                            )}
                            <span className="text-[10.5px] text-ink-muted leading-snug">
                                {onRetry ? 'Or refine the query above.' : 'Refine the query above and click Run again.'}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
