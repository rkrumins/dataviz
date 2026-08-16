/**
 * OverlayIntegrity — the Freshness command center's identity card.
 *
 * Integrity Pulse + windowed blotter. Cadence and Reload live here, not
 * in a right-aligned button row above seven generic tiles.
 */
import { useState } from 'react'
import { Clock, RefreshCw, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePermission } from '@/store/auth'
import { useToast } from '@/components/ui/toast'
import type { FreshnessSummary, ReconcileRun } from '@/services/freshnessService'
import type { StatusFacet } from './freshnessTriage'
import { IntegrityPulse } from './IntegrityPulse'
import { OvernightLedger } from './OvernightLedger'
import { ReconcilePreviewDialog } from './ReconcilePreviewDialog'
import {
    useReconcileActivity, useReconcileNow, useReconciliation, FRESHNESS_KEYS,
} from './useFreshness'
import { useQueryClient } from '@tanstack/react-query'
import {
    DRIFT_WINDOWS, checkNowToast, parseDriftWindow, pickLastPassRun, windowDriftCounts, windowPhrase,
    type DriftWindow,
} from './reconcileHealth'

export function OverlayIntegrity({
    summary, activeFacet, onFacet, onOpenCadence, onReload, reloading,
    onRefreshAll, onOpenSource, window: windowProp, onWindowChange,
}: {
    summary: FreshnessSummary | null | undefined
    activeFacet: StatusFacet
    onFacet: (facet: StatusFacet) => void
    onOpenCadence?: () => void
    onReload: () => void
    reloading: boolean
    onRefreshAll?: () => void
    onOpenSource: (id: string) => void
    window?: DriftWindow
    onWindowChange?: (w: DriftWindow) => void
}) {
    const isAdmin = usePermission('system:admin')
    const { showToast } = useToast()
    const qc = useQueryClient()
    const recon = useReconciliation()
    const driftWindow = parseDriftWindow(windowProp)
    const activity = useReconcileActivity(driftWindow)
    const reconcileNow = useReconcileNow()
    const [previewOpen, setPreviewOpen] = useState(false)
    const [lastCheck, setLastCheck] = useState<ReconcileRun | null>(null)

    const items = activity.data?.items ?? []
    const windowCounts = windowDriftCounts(items)

    const runNow = () => {
        reconcileNow.mutate({}, {
            onSuccess: (res) => {
                if (res.run) setLastCheck(res.run)
                void qc.invalidateQueries({ queryKey: FRESHNESS_KEYS.activityPrefix })
                showToast('success', checkNowToast(res, summary?.total))
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
                    latestRun={lastCheck ?? recon.data?.runs[0]}
                    lastPassRun={pickLastPassRun(recon.data?.runs, lastCheck)}
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
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                        <h3 className="text-[10px] uppercase tracking-wide text-ink-muted">
                            Drift in this window
                        </h3>
                        <div
                            role="group"
                            aria-label="Drift window"
                            className="inline-flex items-center rounded-lg border border-glass-border p-0.5"
                        >
                            {DRIFT_WINDOWS.map(({ key, label }) => {
                                const active = driftWindow === key
                                return (
                                    <button
                                        key={key}
                                        type="button"
                                        aria-pressed={active}
                                        onClick={() => onWindowChange?.(key)}
                                        className={cn(
                                            'h-6 px-1.5 rounded-md text-[10px] font-semibold tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                            active
                                                ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                                                : 'text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                                        )}
                                    >
                                        {label}
                                    </button>
                                )
                            })}
                        </div>
                        {items.length > 0 && (
                            <span className="text-[11px] text-ink-muted tabular-nums ml-auto">
                                {windowCounts.drifted.toLocaleString()} drifted
                                {windowCounts.rebuilt > 0 && (
                                    <> · {windowCounts.rebuilt.toLocaleString()} rebuilt</>
                                )}
                            </span>
                        )}
                    </div>
                    <OvernightLedger
                        items={items}
                        isError={activity.isError}
                        isLoading={activity.isLoading}
                        onOpenSource={onOpenSource}
                        emptyLabel={`No drift findings in ${windowPhrase(driftWindow)}.`}
                    />
                </div>
            </div>

            <ReconcilePreviewDialog
                open={previewOpen}
                onClose={() => setPreviewOpen(false)}
                fleetTotal={summary?.total}
            />
        </section>
    )
}
