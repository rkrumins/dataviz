/**
 * FleetRefreshDialog — the guarded batch refresh across every live data source
 * in the whole fleet (system:admin only; the caller hides the entry point).
 *
 * Confirm first (naming the fleet size), then kick off the batch and poll its
 * progress every 2s until it reports ``done``. Default scope is the cheap gated
 * pass ("Refresh"); "Full refresh" sits behind an advanced disclosure. Closing
 * never cancels the batch — the runner is server-side — so it stays dismissable
 * mid-run, same rule as the provider dialog.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { Backdrop } from '@/components/ui/Backdrop'
import { ProgressBar } from '@/components/ui/ProgressBar'
import type { RefreshScope } from '@/services/freshnessService'
import { FRESHNESS_KEYS, useRefreshBatch, useRefreshFleet } from './useFreshness'
import { BatchResultsList } from './BatchResultsList'
import { RefreshImpact, scopeRebuilds } from './RefreshImpact'

export function FleetRefreshDialog({ fleetTotal, isOpen, onClose }: {
    /** Sources in the fleet, from the server ``summary.total`` (null when the
     *  fleet is too large to summarise — the copy then omits the count). */
    fleetTotal: number | null
    isOpen: boolean
    onClose: () => void
}) {
    const qc = useQueryClient()
    const { showToast } = useToast()
    // The host keys this component on open, so each open remounts with these
    // defaults — no reset effect needed.
    const [scope, setScope] = useState<RefreshScope>('auto')
    const [showAdvanced, setShowAdvanced] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const [batchId, setBatchId] = useState<string | null>(null)

    const refreshFleet = useRefreshFleet()
    const { data: batch } = useRefreshBatch(batchId, isOpen)
    const done = batch?.state === 'done'

    // Refresh the fleet table + toast once the batch finishes.
    useEffect(() => {
        if (!done) return
        void qc.invalidateQueries({ queryKey: FRESHNESS_KEYS.fleetPrefix })
        showToast('success', 'Fleet refresh complete.')
    }, [done, qc, showToast])

    // A scope switch can never inherit a prior confirmation.
    useEffect(() => { setConfirming(false) }, [scope])

    if (!isOpen) return null

    const total = batch?.total ?? 0
    const completed = batch?.done ?? 0
    const pct = total > 0 ? (completed / total) * 100 : 0

    const start = () => {
        refreshFleet.mutate(
            { scope },
            { onSuccess: (res) => setBatchId(res.batchId) },
        )
    }

    return createPortal(
        <>
            {/* Closing never cancels the batch — the runner is server-side — so
                the backdrop always dismisses, even mid-run. */}
            <Backdrop open={isOpen} onClick={onClose} zClassName="z-50" className="bg-black/50" />
            {/* No AnimatePresence: this portaled popover unmounts instantly on close so an interrupted exit can't strand an invisible click-blocker over the page. It still animates in. */}
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
                    <motion.div
                        initial={{ scale: 0.96, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ duration: 0.12 }}
                        onClick={(e) => e.stopPropagation()}
                        className="pointer-events-auto w-full max-w-lg rounded-2xl bg-canvas-elevated border border-glass-border shadow-lg overflow-hidden"
                        role="dialog" aria-modal="true" aria-label="Refresh all sources"
                    >
                        <div className="h-1 bg-gradient-to-r from-indigo-500 to-violet-600" />
                        <div className="p-6">
                            <div className="flex items-center gap-2 mb-1">
                                <Zap className="w-4 h-4 text-indigo-500" />
                                <h3 className="text-lg font-bold text-ink">Refresh all sources</h3>
                            </div>
                            <p className="text-sm text-ink-muted mb-5">
                                Runs across every data source{fleetTotal != null ? ` (${fleetTotal.toLocaleString()})` : ''}; each keeps
                                serving its current data while it refreshes. This can take a while on large fleets.
                            </p>

                            {batchId == null ? (
                                <>
                                    {!showAdvanced ? (
                                        <button
                                            type="button"
                                            onClick={() => setShowAdvanced(true)}
                                            className="mb-4 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                                        >
                                            Advanced options
                                        </button>
                                    ) : (
                                        <div className="space-y-2 mb-4">
                                            {([
                                                { s: 'auto' as RefreshScope, label: 'Refresh (recommended)', desc: 'Refresh each source that has changed since its last run. Skips sources already up to date.' },
                                                { s: 'clear' as RefreshScope, label: 'Clear cache', desc: 'Reset cached data for every source, no rebuild (safe).' },
                                                { s: 'full' as RefreshScope, label: 'Full refresh', desc: 'Refresh caches and rebuild aggregated lineage for every source, changed or not.' },
                                            ]).map(({ s, label, desc }) => (
                                                <label key={s} className={cn(
                                                    'flex items-start gap-3 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors',
                                                    scope === s ? 'border-indigo-500/50 bg-indigo-500/5' : 'border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                                                )}>
                                                    <input
                                                        type="radio" name="fleet-scope" value={s}
                                                        checked={scope === s} onChange={() => setScope(s)}
                                                        className="mt-0.5 accent-indigo-500"
                                                    />
                                                    <span className="min-w-0">
                                                        <span className="block text-sm font-semibold text-ink">{label}</span>
                                                        <span className="block text-[11px] text-ink-muted">{desc}</span>
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                    )}

                                    {/* Fleet-wide, not provider-scoped — RefreshImpact's default
                                        fallback text ("this provider") has no antecedent here. */}
                                    <RefreshImpact scope={scope} force={false} emptyLabel="every live source in the fleet" />

                                    {refreshFleet.isError && (
                                        <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-300">
                                            {refreshFleet.error.message || 'Could not start the refresh.'}
                                        </div>
                                    )}

                                    <div className="flex justify-end gap-3">
                                        <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                                            Cancel
                                        </button>
                                        <button
                                            onClick={() => {
                                                if (scopeRebuilds(scope, false) && !confirming) { setConfirming(true); return }
                                                start()
                                            }}
                                            disabled={refreshFleet.isPending}
                                            className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors disabled:opacity-50 flex items-center gap-2"
                                        >
                                            {refreshFleet.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                                            {/* No source count in the confirm label: the only pre-batch
                                                totals are workspace/provider-filterable while the batch
                                                itself is not, so a number here could understate what will
                                                actually run. */}
                                            {scopeRebuilds(scope, false) && confirming
                                                ? 'Yes, rebuild every source'
                                                : (scopeRebuilds(scope, false) ? 'Run full refresh' : 'Refresh all sources')}
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="flex items-center justify-between mb-2 text-sm">
                                        <span className="font-semibold text-ink flex items-center gap-2">
                                            {done
                                                ? <><CheckCircle2 className="w-4 h-4 text-emerald-500" /> Refresh dispatched</>
                                                : <><Loader2 className="w-4 h-4 animate-spin text-indigo-500" /> Refreshing…</>}
                                        </span>
                                        <span className="text-ink-muted tabular-nums">{completed} / {total}</span>
                                    </div>
                                    <ProgressBar value={pct} label="Fleet refresh progress" className="mb-2" />
                                    {!done && (
                                        <p className="text-[11px] text-ink-muted mb-4">
                                            The refresh continues in the background if you close this.
                                        </p>
                                    )}

                                    {batch && <BatchResultsList results={batch.results} />}

                                    <div className="flex justify-end">
                                        {/* Never disabled: closing dismisses the view, it does not
                                            cancel the server-side batch, so a stranded "running"
                                            batch must still be dismissable. */}
                                        <button
                                            onClick={onClose}
                                            className="px-4 py-2 rounded-xl text-sm font-semibold text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                        >
                                            Close
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </motion.div>
            </div>
        </>,
        document.body,
    )
}
