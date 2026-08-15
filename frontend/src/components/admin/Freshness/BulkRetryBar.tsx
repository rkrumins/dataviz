/**
 * BulkRetryBar — floating selection dock (WorkspaceBulkBar shape).
 * Safe refresh for any selection; confirmed rebuild / retry by state.
 */
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Database, Loader2, RotateCcw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { freshnessService } from '@/services/freshnessService'
import type { FreshnessRow, RefreshScope } from '@/services/freshnessService'
import { FAILURE_CATEGORY_LABEL, asFailureCategory, countFailuresByCategory } from './failureGuidance'
import { freshnessState } from './freshnessTriage'

const CONCURRENCY = 3
const CAP = 50

type ConfirmKind = 'retry' | 'rebuild' | null

async function fanOutRefresh(
    ids: string[],
    scope: RefreshScope,
    onProgress: (p: { done: number; total: number; errors: number }) => void,
): Promise<{ errors: number; total: number }> {
    const capped = ids.slice(0, CAP)
    let errors = 0
    let done = 0
    const queue = [...capped]
    onProgress({ done: 0, total: capped.length, errors: 0 })
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
            const id = queue.shift()
            if (!id) break
            try {
                await freshnessService.refreshSource(id, { scope })
            } catch {
                errors += 1
            }
            done += 1
            onProgress({ done, total: capped.length, errors })
        }
    })
    await Promise.all(workers)
    return { errors, total: capped.length }
}

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
    const [confirming, setConfirming] = useState<ConfirmKind>(null)
    const [progress, setProgress] = useState<{ done: number; total: number; errors: number } | null>(null)

    const selected = rows.filter(r => selectedIds.includes(r.dataSourceId))
    const failedIds = selected
        .filter(r => freshnessState(r) === 'failed')
        .map(r => r.dataSourceId)
    const rebuildIds = selected
        .filter(r => freshnessState(r) !== 'failed' && freshnessState(r) !== 'recomputing')
        .map(r => r.dataSourceId)
    const causes = countFailuresByCategory(selected.filter(r => freshnessState(r) === 'failed'))
    const top = causes[0]
    const n = Math.min(selectedIds.length, CAP)
    const pct = progress && progress.total > 0
        ? Math.round((progress.done / progress.total) * 100)
        : 0

    const finish = (errors: number, total: number, okMsg: string) => {
        setRunning(false)
        showToast(
            errors === 0 ? 'success' : 'error',
            errors === 0
                ? okMsg
                : `Finished with ${errors} error${errors === 1 ? '' : 's'} of ${total}.`,
        )
        onDone()
        onClear()
        setProgress(null)
        setConfirming(null)
    }

    const runCaches = async () => {
        setConfirming(null)
        setRunning(true)
        const { errors, total } = await fanOutRefresh(
            selectedIds, 'read-caches', setProgress,
        )
        finish(
            errors,
            total,
            `Cache refresh queued for ${total} source${total === 1 ? '' : 's'}.`,
        )
    }

    const runRetry = async () => {
        setConfirming(null)
        setRunning(true)
        const { errors, total } = await fanOutRefresh(failedIds, 'rollups', setProgress)
        finish(
            errors,
            total,
            `Retry queued for ${total} source${total === 1 ? '' : 's'}.`,
        )
    }

    const runRebuild = async () => {
        setConfirming(null)
        setRunning(true)
        const { errors, total } = await fanOutRefresh(rebuildIds, 'rollups', setProgress)
        finish(
            errors,
            total,
            `Rebuild queued for ${total} source${total === 1 ? '' : 's'}.`,
        )
    }

    const subtitle = () => {
        if (progress) {
            return `${progress.done}/${progress.total} queued`
                + (progress.errors > 0 ? ` · ${progress.errors} failed to start` : '')
        }
        if (confirming === 'retry') {
            return (
                <>
                    Retry rebuild on {failedIds.length === 1 ? 'this failed source' : `${failedIds.length} failed sources`}?
                    {selected.some(r => asFailureCategory(r.lastFailureCategory) === 'out_of_memory') && (
                        <> Free graph-store memory first if these are OOM.</>
                    )}
                </>
            )
        }
        if (confirming === 'rebuild') {
            return `Rebuild lineage on ${rebuildIds.length === 1 ? 'this source' : `${rebuildIds.length} sources`}?`
        }
        if (top) return <>Mostly {FAILURE_CATEGORY_LABEL[top.category].toLowerCase()}</>
        if (failedIds.length > 0 && rebuildIds.length > 0) {
            return `${failedIds.length} failed · ${rebuildIds.length} ready to rebuild`
        }
        if (failedIds.length > 0) return 'Failed sources — retry or refresh caches'
        return 'Refresh caches or rebuild lineage'
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
                                <p className="text-[11px] text-ink-muted truncate max-w-[240px] sm:max-w-sm">
                                    {subtitle()}
                                </p>
                            </div>

                            <span className="hidden sm:block w-px h-5 bg-glass-border mx-1" />

                            <button
                                type="button"
                                onClick={() => void runCaches()}
                                disabled={running || confirming !== null}
                                className={cn(
                                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold',
                                    'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors',
                                    'disabled:opacity-50',
                                )}
                            >
                                {running && !confirming
                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    : <Database className="w-3.5 h-3.5" />}
                                Refresh caches
                            </button>

                            {failedIds.length > 0 && (
                                confirming === 'retry' ? (
                                    <button
                                        type="button"
                                        onClick={() => void runRetry()}
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
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => setConfirming('retry')}
                                        disabled={running || confirming !== null}
                                        className={cn(
                                            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold',
                                            'text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 transition-colors',
                                            'disabled:opacity-50',
                                        )}
                                    >
                                        <RotateCcw className="w-3.5 h-3.5" />
                                        Retry rebuild
                                    </button>
                                )
                            )}

                            {rebuildIds.length > 0 && (
                                confirming === 'rebuild' ? (
                                    <button
                                        type="button"
                                        onClick={() => void runRebuild()}
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
                                        Confirm rebuild
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => setConfirming('rebuild')}
                                        disabled={running || confirming !== null}
                                        className={cn(
                                            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold',
                                            'text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 transition-colors',
                                            'disabled:opacity-50',
                                        )}
                                    >
                                        <RotateCcw className="w-3.5 h-3.5" />
                                        Rebuild lineage
                                    </button>
                                )
                            )}

                            <button
                                type="button"
                                onClick={() => { setConfirming(null); onClear() }}
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
