/**
 * Surfaced when ``viewId`` is empty — ContextViewCanvas hasn't settled
 * an active view yet. Avoids silently sending ``viewId=''`` to the
 * backend which returns 400 with no FE-visible signal.
 */
import { SearchX } from 'lucide-react'

import { cn } from '@/lib/utils'


export function NoViewState({ onClose }: { onClose: () => void }) {
    return (
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-glass/40 border border-glass-border flex items-center justify-center">
                <SearchX className="w-5 h-5 text-ink-muted" />
            </div>
            <div>
                <div className="text-sm font-semibold text-ink">No active view</div>
                <p className="mt-1 text-xs text-ink-muted leading-snug max-w-[18rem]">
                    Advanced Search needs a Context View to scope against.
                    Open or create one, then re-open this panel.
                </p>
            </div>
            <button
                type="button"
                onClick={onClose}
                className={cn(
                    "mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg",
                    "bg-glass/40 hover:bg-glass/60",
                    "text-xs font-medium text-ink-muted hover:text-ink",
                    "transition-colors",
                )}
            >
                Close
            </button>
        </div>
    )
}
