/**
 * ProviderRefreshDialog — the guarded batch refresh across every live source
 * under a provider (system:admin only; the caller hides the entry point).
 *
 * Flow: pick a scope, kick off the batch, then poll its progress every 2s
 * until it reports ``done``. The provider guards against concurrent batches
 * (409), surfaced here as an inline error.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { ProgressBar } from '@/components/ui/ProgressBar'
import type { RefreshScope } from '@/services/freshnessService'
import { FRESHNESS_KEYS, useRefreshBatch, useRefreshProvider } from './useFreshness'
import { BatchResultsList } from './BatchResultsList'
import { RefreshImpact, scopeRebuilds } from './RefreshImpact'

const SCOPES: { scope: RefreshScope; label: string; desc: string }[] = [
    { scope: 'auto', label: 'Only changed sources', desc: 'Refresh sources whose data changed since their last run.' },
    { scope: 'read-caches', label: 'Refresh caches', desc: 'Re-read cached figures for every source. No lineage rebuild.' },
    { scope: 'clear', label: 'Clear cache', desc: 'Reset cached data for every source, no rebuild (safe).' },
    { scope: 'rollups', label: 'Rebuild lineage', desc: 'Rebuild aggregated lineage for every source.' },
    { scope: 'full', label: 'Full refresh', desc: 'Refresh caches and rebuild lineage for every source.' },
]

export function ProviderRefreshDialog({ providerId, providerName, isOpen, onClose }: {
    providerId: string | null
    providerName: string
    isOpen: boolean
    onClose: () => void
}) {
    const qc = useQueryClient()
    // The host keys this component on the provider, so each open remounts with
    // these defaults — no reset effect needed.
    const [scope, setScope] = useState<RefreshScope>('auto')
    const [force, setForce] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const [batchId, setBatchId] = useState<string | null>(null)

    const refreshProvider = useRefreshProvider()
    const { data: batch } = useRefreshBatch(batchId, isOpen)
    const done = batch?.state === 'done'

    // Refresh the fleet table once the batch finishes.
    useEffect(() => {
        if (done) void qc.invalidateQueries({ queryKey: FRESHNESS_KEYS.fleetPrefix })
    }, [done, qc])

    // A scope switch can never inherit a prior confirmation.
    useEffect(() => { setConfirming(false) }, [scope, force])

    if (!isOpen || !providerId) return null

    // The batch enumerates ALL live sources under the provider fleet-wide — a
    // count derived from the (possibly filtered) table would understate it, so
    // we only show the authoritative total once the batch reports it.
    const total = batch?.total ?? 0
    const completed = batch?.done ?? 0
    const pct = total > 0 ? (completed / total) * 100 : 0

    const start = () => {
        refreshProvider.mutate(
            { providerId, scope, force: scope === 'auto' ? force : undefined },
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
                        role="dialog" aria-modal="true" aria-label="Refresh provider"
                    >
                        <div className="h-1 bg-gradient-to-r from-indigo-500 to-violet-600" />
                        <div className="p-6">
                            <div className="flex items-center gap-2 mb-1">
                                <Zap className="w-4 h-4 text-indigo-500" />
                                <h3 className="text-lg font-bold text-ink">Refresh {providerName}</h3>
                            </div>
                            <p className="text-sm text-ink-muted mb-5">
                                Runs across every live data source using this provider.
                            </p>

                            {batchId == null ? (
                                <>
                                    <div className="space-y-2 mb-4">
                                        {SCOPES.map(({ scope: s, label, desc }) => (
                                            <label key={s} className={cn(
                                                'flex items-start gap-3 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors',
                                                scope === s ? 'border-indigo-500/50 bg-indigo-500/5' : 'border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                                            )}>
                                                <input
                                                    type="radio" name="freshness-scope" value={s}
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

                                    {scope === 'auto' && (
                                        <label className="flex items-center gap-2 mb-4 text-sm text-ink-secondary cursor-pointer">
                                            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="accent-indigo-500" />
                                            Include sources with no detected changes
                                        </label>
                                    )}

                                    <RefreshImpact scope={scope} force={force} sourceCount={total > 0 ? total : null} />

                                    {refreshProvider.isError && (
                                        <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-300">
                                            {refreshProvider.error.message || 'Could not start the refresh.'}
                                        </div>
                                    )}

                                    <div className="flex justify-end gap-3">
                                        <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                                            Cancel
                                        </button>
                                        <button
                                            onClick={() => {
                                                if (scopeRebuilds(scope, force) && !confirming) { setConfirming(true); return }
                                                start()
                                            }}
                                            disabled={refreshProvider.isPending}
                                            className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors disabled:opacity-50 flex items-center gap-2"
                                        >
                                            {refreshProvider.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                                            {scopeRebuilds(scope, force) && confirming
                                                ? (total > 0 ? `Yes, rebuild ${total} sources` : 'Yes, rebuild every source')
                                                : 'Start refresh'}
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
                                    <ProgressBar value={pct} label="Provider refresh progress" className="mb-2" />
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
