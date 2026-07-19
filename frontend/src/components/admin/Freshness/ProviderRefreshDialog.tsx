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
import { AnimatePresence, motion } from 'framer-motion'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Loader2, XCircle, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { ProgressBar } from '@/components/ui/ProgressBar'
import type { RefreshScope } from '@/services/freshnessService'
import { FRESHNESS_KEYS, useRefreshBatch, useRefreshProvider } from './useFreshness'

const SCOPES: { scope: RefreshScope; label: string; desc: string }[] = [
    { scope: 'auto', label: 'Only changed sources', desc: 'Refresh sources whose data changed since their last run.' },
    { scope: 'read-caches', label: 'Refresh caches', desc: 'Clear cached figures for every source. No lineage rebuild.' },
    { scope: 'rollups', label: 'Rebuild lineage', desc: 'Rebuild aggregated lineage for every source.' },
    { scope: 'full', label: 'Full refresh', desc: 'Refresh caches and rebuild lineage for every source.' },
]

export function ProviderRefreshDialog({ providerId, providerName, sourceCount, isOpen, onClose }: {
    providerId: string | null
    providerName: string
    sourceCount: number
    isOpen: boolean
    onClose: () => void
}) {
    const qc = useQueryClient()
    // The host keys this component on the provider, so each open remounts with
    // these defaults — no reset effect needed.
    const [scope, setScope] = useState<RefreshScope>('auto')
    const [force, setForce] = useState(false)
    const [batchId, setBatchId] = useState<string | null>(null)

    const refreshProvider = useRefreshProvider()
    const { data: batch } = useRefreshBatch(batchId, isOpen)
    const done = batch?.state === 'done'

    // Refresh the fleet table once the batch finishes.
    useEffect(() => {
        if (done) void qc.invalidateQueries({ queryKey: FRESHNESS_KEYS.fleetPrefix })
    }, [done, qc])

    if (!isOpen || !providerId) return null

    const rebuilds = scope === 'rollups' || scope === 'full' || (scope === 'auto' && force)
    const running = batchId != null && !done
    const total = batch?.total ?? sourceCount
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
            <Backdrop open={isOpen} onClick={() => !running && onClose()} zClassName="z-50" className="bg-black/50" />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
                <AnimatePresence>
                    <motion.div
                        initial={{ scale: 0.96, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.96, opacity: 0 }}
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
                                Runs across {sourceCount} {sourceCount === 1 ? 'data source' : 'data sources'} using this provider.
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

                                    {rebuilds && (
                                        <div className="flex items-start gap-2 mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200">
                                            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                                            Rebuilding lineage across these sources can take several minutes and adds load on the provider.
                                        </div>
                                    )}

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
                                            onClick={start}
                                            disabled={refreshProvider.isPending}
                                            className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors disabled:opacity-50 flex items-center gap-2"
                                        >
                                            {refreshProvider.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                                            Start refresh
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="flex items-center justify-between mb-2 text-sm">
                                        <span className="font-semibold text-ink flex items-center gap-2">
                                            {done
                                                ? <><CheckCircle2 className="w-4 h-4 text-emerald-500" /> Refresh complete</>
                                                : <><Loader2 className="w-4 h-4 animate-spin text-indigo-500" /> Refreshing…</>}
                                        </span>
                                        <span className="text-ink-muted tabular-nums">{completed} / {total}</span>
                                    </div>
                                    <ProgressBar value={pct} label="Provider refresh progress" className="mb-4" />

                                    {batch && batch.results.length > 0 && (
                                        <ul className="max-h-48 overflow-y-auto space-y-1 mb-4">
                                            {batch.results.map((r) => (
                                                <li key={r.dataSourceId} className="flex items-center gap-2 text-xs text-ink-secondary">
                                                    {r.outcome === 'error'
                                                        ? <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                                                        : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />}
                                                    <span className="truncate">{r.dataSourceId}</span>
                                                    {r.outcome === 'error' && <span className="text-red-500">failed</span>}
                                                </li>
                                            ))}
                                        </ul>
                                    )}

                                    <div className="flex justify-end">
                                        <button
                                            onClick={onClose}
                                            disabled={running}
                                            className="px-4 py-2 rounded-xl text-sm font-semibold text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                        >
                                            {done ? 'Close' : 'Running…'}
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </motion.div>
                </AnimatePresence>
            </div>
        </>,
        document.body,
    )
}
