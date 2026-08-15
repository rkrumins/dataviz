/**
 * OverlayIntegrity — the Freshness command center's identity card.
 *
 * Integrity Pulse + overnight blotter. Cadence and Reload live here, not
 * in a right-aligned button row above seven generic tiles.
 */
import { useState } from 'react'
import { Clock, RefreshCw, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePermission } from '@/store/auth'
import { useToast } from '@/components/ui/toast'
import type { FreshnessSummary } from '@/services/freshnessService'
import type { StatusFacet } from './freshnessTriage'
import { IntegrityPulse } from './IntegrityPulse'
import { OvernightLedger } from './OvernightLedger'
import { ReconcilePreviewDialog } from './ReconcilePreviewDialog'
import {
    useReconcileActivity, useReconcileNow, useReconciliation, FRESHNESS_KEYS,
} from './useFreshness'
import { useQueryClient } from '@tanstack/react-query'

export function OverlayIntegrity({
    summary, activeFacet, onFacet, onOpenCadence, onReload, reloading,
    onRefreshAll, onOpenSource,
}: {
    summary: FreshnessSummary | null | undefined
    activeFacet: StatusFacet
    onFacet: (facet: StatusFacet) => void
    onOpenCadence?: () => void
    onReload: () => void
    reloading: boolean
    onRefreshAll?: () => void
    onOpenSource: (id: string) => void
}) {
    const isAdmin = usePermission('system:admin')
    const { showToast } = useToast()
    const qc = useQueryClient()
    const recon = useReconciliation()
    const activity = useReconcileActivity()
    const reconcileNow = useReconcileNow()
    const [previewOpen, setPreviewOpen] = useState(false)

    const runNow = () => {
        reconcileNow.mutate({}, {
            onSuccess: (res) => {
                void qc.invalidateQueries({ queryKey: FRESHNESS_KEYS.activity })
                showToast(
                    'success',
                    res.skipped ? 'A sweep is already running.'
                        : `Checked ${res.run?.scanned ?? 0} source${res.run?.scanned === 1 ? '' : 's'} — ${res.run?.actions ?? 0} reconciled.`,
                )
            },
            onError: (e) => showToast('error', e.message || 'Could not run reconciliation.'),
        })
    }

    return (
        <section className="rounded-xl border border-glass-border bg-canvas-elevated overflow-hidden">
            <header className="flex flex-wrap items-start gap-3 px-4 pt-4 pb-3">
                <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold text-ink">Overlay integrity</h2>
                    <p className="text-[12px] text-ink-muted mt-0.5">
                        Rolled-up lineage that a source reload can wipe.
                    </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {isAdmin && onRefreshAll && (
                        <button
                            type="button"
                            onClick={onRefreshAll}
                            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-glass-border text-xs font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors"
                        >
                            <Zap className="w-3.5 h-3.5" />
                            Refresh all sources
                        </button>
                    )}
                    {isAdmin && onOpenCadence && (
                        <button
                            type="button"
                            onClick={onOpenCadence}
                            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-glass-border text-xs font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors"
                        >
                            <Clock className="w-3.5 h-3.5" />
                            Cadence
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onReload}
                        disabled={reloading}
                        aria-label="Reload freshness"
                        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-glass-border text-xs font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors disabled:opacity-50"
                    >
                        <RefreshCw className={cn('w-3.5 h-3.5', reloading && 'animate-spin')} />
                        Reload
                    </button>
                </div>
            </header>

            <div className="px-4 pb-4 space-y-3">
                <IntegrityPulse
                    summary={summary}
                    policy={recon.data?.policy}
                    latestRun={recon.data?.runs[0]}
                    isError={recon.isError}
                    isLoading={recon.isLoading}
                    isAdmin={isAdmin}
                    onCheckNow={runNow}
                    checking={reconcileNow.isPending}
                    onPreview={() => setPreviewOpen(true)}
                    onFacet={onFacet}
                    activeFacet={activeFacet}
                />
                <div>
                    <h3 className="text-[10px] uppercase tracking-wide text-ink-muted mb-1.5">
                        Overnight blotter
                    </h3>
                    <OvernightLedger
                        items={activity.data?.items ?? []}
                        isError={activity.isError}
                        isLoading={activity.isLoading}
                        onOpenSource={onOpenSource}
                    />
                </div>
            </div>

            <ReconcilePreviewDialog
                open={previewOpen}
                onClose={() => setPreviewOpen(false)}
            />
        </section>
    )
}
