/**
 * BulkRetryBar — floating selection dock (same shape as WorkspaceBulkBar /
 * ExplorerBulkActions). Appears only when failed sources are selected.
 */
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, RotateCcw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { freshnessService } from '@/services/freshnessService'
import type { FreshnessRow } from '@/services/freshnessService'
import { FAILURE_CATEGORY_LABEL, asFailureCategory, countFailuresByCategory } from './failureGuidance'

const CONCURRENCY = 3
const CAP = 50

export function BulkRetryBar({
    selectedIds, rows, onClear, onDone,
}: {
    selectedIds: string[]
    rows: FreshnessRow[]
    onClear: () => void
    onDone: () => void
}) {
    const { showToast } = useToast()
    const [running, setRunning] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const [progress, setProgress] = useState<{ done: number; total: number; errors: number } | null>(null)

    const selected = rows.filter(r => selectedIds.includes(r.dataSourceId))
    const causes = countFailuresByCategory(selected)
    const top = causes[0]
    const n = Math.min(selectedIds.length, CAP)
    const pct = progress && progress.total > 0
        ? Math.round((progress.done / progress.total) * 100)
        : 0

    const run = async () => {
        setConfirming(false)
        setRunning(true)
        const ids = selectedIds.slice(0, CAP)
        setProgress({ done: 0, total: ids.length, errors: 0 })
        let errors = 0
        let done = 0
        const queue = [...ids]
        const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
            while (queue.length) {
                const id = queue.shift()
                if (!id) break
                try {
                    await freshnessService.refreshSource(id, { scope: 'rollups' })
                } catch {
                    errors += 1
                }
                done += 1
                setProgress({ done, total: ids.length, errors })
            }
        })
        await Promise.all(workers)
        setRunning(false)
        showToast(
            errors === 0 ? 'success' : 'error',
            errors === 0
                ? `Retry queued for ${ids.length} source${ids.length === 1 ? '' : 's'}.`
                : `Retry finished with ${errors} error${errors === 1 ? '' : 's'} of ${ids.length}.`,
        )
        onDone()
        onClear()
        setProgress(null)
    }

    return (
        <AnimatePresence>
            {selectedIds.length > 0 && (
                <motion.div
                    initial={{ y: 80, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 80, opacity: 0 }}
                    transition={{ type: 'spring', damping: 26, stiffness: 320 }}
                    className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 px-3"
                >
                    <div
                        className={cn(
                            'overflow-hidden rounded-2xl border border-glass-border',
                            'bg-canvas-elevated/95 backdrop-blur-xl',
                            'shadow-2xl shadow-black/20',
                        )}
                    >
                        {progress && (
                            <div className="h-0.5 bg-indigo-500/10">
                                <div
                                    className="h-full bg-indigo-500 transition-[width] duration-200 ease-out"
                                    style={{ width: `${pct}%` }}
                                />
                            </div>
                        )}
                        <div className="flex flex-wrap items-center gap-2 pl-4 pr-2 py-2">
                            <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-lg bg-indigo-500 px-2 text-[12px] font-bold tabular-nums text-white shrink-0">
                                {n}
                            </span>
                            <div className="min-w-0 pr-1">
                                <p className="text-sm font-semibold text-ink whitespace-nowrap">
                                    {n === 1 ? '1 source selected' : `${n.toLocaleString()} sources selected`}
                                </p>
                                <p className="text-[11px] text-ink-muted truncate max-w-[220px] sm:max-w-xs">
                                    {progress
                                        ? `${progress.done}/${progress.total} queued`
                                            + (progress.errors > 0 ? ` · ${progress.errors} failed to start` : '')
                                        : confirming
                                            ? (
                                                <>
                                                    Retry rebuild?
                                                    {selected.some(r => asFailureCategory(r.lastFailureCategory) === 'out_of_memory') && (
                                                        <> Free graph-store memory first if these are OOM.</>
                                                    )}
                                                </>
                                            )
                                            : top
                                                ? <>Mostly {FAILURE_CATEGORY_LABEL[top.category].toLowerCase()}</>
                                                : 'Ready to retry lineage rebuilds'}
                                </p>
                            </div>

                            <span className="hidden sm:block w-px h-5 bg-glass-border mx-1" />

                            {!confirming ? (
                                <button
                                    type="button"
                                    onClick={() => setConfirming(true)}
                                    disabled={running}
                                    className={cn(
                                        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold',
                                        'text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 transition-colors',
                                        'disabled:opacity-50',
                                    )}
                                >
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    Retry rebuild
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => void run()}
                                    disabled={running}
                                    className={cn(
                                        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold',
                                        'text-white bg-indigo-600 hover:bg-indigo-700 shadow-sm shadow-indigo-600/20 transition-colors',
                                        'disabled:opacity-50',
                                    )}
                                >
                                    {running
                                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        : <RotateCcw className="w-3.5 h-3.5" />}
                                    Confirm retry
                                </button>
                            )}

                            <button
                                type="button"
                                onClick={() => { setConfirming(false); onClear() }}
                                disabled={running}
                                title="Clear selection"
                                className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}
