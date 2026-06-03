/**
 * The prominent "Run" affordance between sections 02 and 03.
 *
 * Replaces the old shrink-wrapped QueryFooter row. Same gating logic
 * (conditionCount > 0 AND no validation errors), but visually it's the
 * primary CTA — full-width gradient button with the condition count
 * pill and "Clear" inline.
 */
import { Loader2, Play, RotateCcw } from 'lucide-react'
import { type FC, useMemo } from 'react'

import { cn } from '@/lib/utils'
import {
    useBuilderValidation,
    useDraftPredicate,
    useSearchStore,
} from '@/store/searchStore'
import type { Predicate } from '@/types/search'


export interface RunBarProps {
    isRunning: boolean
    onRun: () => void
}


export const RunBar: FC<RunBarProps> = ({ isRunning, onRun }) => {
    const draft = useDraftPredicate()
    const issues = useBuilderValidation()
    const seedDraftPredicate = useSearchStore((s) => s.seedDraftPredicate)

    const conditionCount = useMemo(() => countConditions(draft), [draft])
    const firstErrorMsg = useMemo(() => {
        const err = issues.find((i) => i.severity === 'error')
        if (err) return err.message
        const warn = issues.find((i) => i.severity === 'warn')
        return warn?.message ?? null
    }, [issues])

    const canRun = conditionCount > 0 && !firstErrorMsg && !isRunning && draft !== null

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 min-w-0">
                {draft && conditionCount > 0 && (
                    <>
                        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-glass/40 text-[11px] font-medium text-ink-muted">
                            <span className="tabular-nums text-ink">{conditionCount}</span>
                            {conditionCount === 1 ? 'condition' : 'conditions'}
                        </span>
                        <button
                            type="button"
                            onClick={() => seedDraftPredicate(null)}
                            title="Clear all conditions"
                            className={cn(
                                "inline-flex items-center gap-1 px-2 py-1 rounded-md",
                                "text-[11px] font-medium text-ink-muted",
                                "hover:bg-rose-500/10 hover:text-rose-500 transition-colors",
                            )}
                        >
                            <RotateCcw className="w-3 h-3" strokeWidth={2.4} />
                            Clear
                        </button>
                    </>
                )}
                {firstErrorMsg && conditionCount > 0 && (
                    <span
                        className="ml-auto text-[10.5px] text-amber-500/90 dark:text-amber-300/90 max-w-[18rem] truncate"
                        title={firstErrorMsg}
                    >
                        {firstErrorMsg}
                    </span>
                )}
            </div>

            <button
                type="button"
                onClick={onRun}
                disabled={!canRun}
                title={!canRun && firstErrorMsg ? firstErrorMsg : undefined}
                className={cn(
                    "w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl",
                    "text-[13px] font-display font-semibold tracking-tight",
                    "transition-all duration-150 shadow-sm",
                    canRun
                        ? cn(
                            "bg-gradient-to-r from-accent-lineage to-cyan-500 text-white",
                            "hover:brightness-110 active:brightness-95",
                            "shadow-lg shadow-accent-lineage/30",
                            "focus:outline-none focus:ring-2 focus:ring-accent-lineage/50 focus:ring-offset-2 focus:ring-offset-canvas-elevated",
                        )
                        : "bg-glass/40 text-ink-muted cursor-not-allowed",
                )}
            >
                {isRunning
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Running…</>
                    : <><Play className="w-3.5 h-3.5 fill-current" /> Run search</>
                }
            </button>
        </div>
    )
}


function countConditions(predicate: Predicate | null): number {
    if (!predicate) return 0
    if (predicate.kind === 'group') {
        return predicate.children.reduce<number>(
            (sum, child) => sum + countConditions(child),
            0,
        )
    }
    return 1
}
