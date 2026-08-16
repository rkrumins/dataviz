/**
 * "What would be reconciled right now" — the blast-radius preview.
 *
 * The reason this exists: turning automatic reconciliation on across an
 * established fleet can queue a lot of heavy rebuilds, and until you have
 * seen the list you are guessing. The dry run evaluates every source exactly
 * as a real sweep would and queues nothing, so the answer is free.
 *
 * It is also the honest way to read the cockpit's Drifting count: that number
 * says how many sources are wrong, this says what automation would do about
 * each one and why.
 *
 * Modal conventions are the house ones, and deliberately not Radix Dialog —
 * a Radix modal unmounting while open strands `body { pointer-events: none }`
 * and freezes the app (see hooks/useModalA11y.ts). createPortal + a
 * persistent <Backdrop> + useModalA11y instead.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
    AlertTriangle, CheckCircle2, Loader2, ShieldCheck, X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { Backdrop } from '@/components/ui/Backdrop'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useToast } from '@/components/ui/toast'
import type { ReconcileFinding, ReconcileRun } from '@/services/freshnessService'
import { DRIFT_SPEC, REASON_LABEL } from './DriftStateBadge'
import { EvidencePair, reconcileEvidenceRows } from './reconcileEvidence'
import { lastPassLabel } from './reconcileHealth'
import { useReconcileNow } from './useFreshness'

/** Detector code → the drift state it implies, so the preview wears the same
 *  tone and icon the cockpit will show once the sweep runs for real.
 *  Mirrors ``reconcile._REASON_STATE``. */
const REASON_STATE: Record<string, keyof typeof DRIFT_SPEC> = {
    overlay_missing: 'overlayMissing',
    overlay_shrunk: 'overlayMissing',
    never_aggregated: 'neverBuilt',
    raw_drift: 'drifting',
}

function FindingRow({ finding }: { finding: ReconcileFinding }) {
    const spec = DRIFT_SPEC[REASON_STATE[finding.reason] ?? 'drifting']
    const rows = reconcileEvidenceRows(finding.evidence)
    const Icon = spec.Icon

    return (
        <li className="flex items-start gap-2.5 px-3 py-2 rounded-lg hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
            <span className={cn(
                'mt-0.5 w-6 h-6 rounded-lg flex items-center justify-center shrink-0',
                spec.tone,
            )}>
                <Icon className="w-3.5 h-3.5" />
            </span>
            <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-ink truncate">
                    {finding.name || finding.dataSourceId}
                </p>
                <p className="text-[11px] text-ink-muted">
                    {REASON_LABEL[finding.reason] ?? finding.reason}
                    {finding.providerName ? ` · ${finding.providerName}` : ''}
                </p>
                {rows.length > 0 && (
                    <dl className="mt-1 space-y-0.5">
                        {rows.map(r => (
                            <div key={r.label} className="flex items-baseline justify-between gap-3">
                                <dt className="text-[10px] uppercase tracking-wide text-ink-muted">
                                    {r.label}
                                </dt>
                                <dd><EvidencePair before={r.before} after={r.after} /></dd>
                            </div>
                        ))}
                    </dl>
                )}
            </div>
        </li>
    )
}

export function ReconcilePreviewDialog({ open, onClose, fleetTotal }: {
    open: boolean
    onClose: () => void
    fleetTotal?: number | null
}) {
    useModalA11y(open, onClose)
    const { showToast } = useToast()
    const preview = useReconcileNow()
    const [findings, setFindings] = useState<ReconcileFinding[] | null>(null)
    const [scanned, setScanned] = useState(0)
    const [passSummary, setPassSummary] = useState('')

    // Run the dry sweep on open, once. Re-opening re-runs it, which is right:
    // a preview of a stale fleet state would be worse than no preview.
    useEffect(() => {
        if (!open) { setFindings(null); setPassSummary(''); return }
        preview.mutate({ dryRun: true }, {
            onSuccess: (res) => {
                const next = res.findings ?? []
                const n = res.run?.scanned ?? 0
                setFindings(next)
                setScanned(n)
                const run = res.run as Pick<ReconcileRun, 'scanned' | 'findings' | 'actions' | 'bySkip'> | undefined
                setPassSummary(run
                    ? lastPassLabel({
                        scanned: run.scanned,
                        findings: run.findings ?? next.length,
                        actions: run.actions ?? 0,
                        bySkip: run.bySkip ?? {},
                    }, fleetTotal)
                    : '')
            },
            onError: (e) => {
                showToast('error', e.message || 'Could not run the preview.')
                onClose()
            },
        })
        // preview/showToast/onClose are stable enough for this one-shot; adding
        // them re-fires the sweep on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open])

    const byReason = useMemo(() => {
        const out = new Map<string, number>()
        for (const f of findings ?? []) {
            out.set(f.reason, (out.get(f.reason) ?? 0) + 1)
        }
        return [...out.entries()].sort((a, b) => b[1] - a[1])
    }, [findings])

    return createPortal(
        <>
            <Backdrop open={open} onClick={onClose} zClassName="z-[60]" />
            {open && (
                <div className="fixed inset-0 z-[61] flex items-center justify-center p-4 pointer-events-none">
                    <motion.div
                        {...MOTION.cardEntry}
                        role="dialog"
                        aria-modal="true"
                        aria-label="Reconciliation preview"
                        className="pointer-events-auto w-full max-w-lg max-h-[85vh] flex flex-col rounded-2xl border border-glass-border bg-canvas shadow-glass-lg overflow-hidden"
                    >
                        <div className="flex items-start justify-between gap-3 p-4 border-b border-glass-border">
                            <div className="flex items-start gap-2.5 min-w-0">
                                <div className="w-9 h-9 rounded-xl bg-sky-500/10 flex items-center justify-center shrink-0">
                                    <ShieldCheck className="w-4 h-4 text-sky-500" />
                                </div>
                                <div className="min-w-0">
                                    <h3 className="text-base font-bold text-ink">
                                        What would be reconciled
                                    </h3>
                                    <p className="text-[11px] text-ink-muted">
                                        A full check that queues nothing. Nothing here has
                                        been rebuilt.
                                    </p>
                                </div>
                            </div>
                            <button
                                onClick={onClose}
                                aria-label="Close preview"
                                className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-ink-muted hover:bg-black/5 dark:hover:bg-white/5"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto custom-scrollbar">
                            {findings === null ? (
                                <div className="flex items-center gap-2 justify-center py-10 text-sm text-ink-muted">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Checking every source…
                                </div>
                            ) : findings.length === 0 ? (
                                <div className="flex flex-col items-center gap-2 py-10 px-6 text-center">
                                    <CheckCircle2 className="w-8 h-8 text-emerald-500" />
                                    <p className="text-sm font-semibold text-ink">
                                        {scanned === 0
                                            ? 'No sources were eligible to check'
                                            : 'Nothing would rebuild'}
                                    </p>
                                    <p className="text-[11px] text-ink-muted">
                                        {scanned === 0
                                            ? 'Nothing in the reconcile set yet — sources appear here after their first aggregation state is recorded.'
                                            : passSummary
                                                ? `${passSummary}. Turning automation on would queue no rebuilds right now.`
                                                : `All ${scanned.toLocaleString()} source${scanned === 1 ? '' : 's'} checked. Turning automation on would queue no rebuilds right now.`}
                                    </p>
                                </div>
                            ) : (
                                <>
                                    <div className="flex items-start gap-2 m-3 p-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.05]">
                                        <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                                        <p className="text-[11px] text-ink-secondary leading-relaxed">
                                            <span className="font-semibold text-ink">
                                                {passSummary || `${scanned.toLocaleString()} checked · ${findings.length.toLocaleString()} would rebuild`}
                                            </span>
                                            . Each rebuild is a full aggregation job — on a
                                            large graph that is real work, and the per-sweep
                                            action cap spreads them across several checks
                                            rather than queueing them all at once.
                                        </p>
                                    </div>
                                    {byReason.length > 1 && (
                                        <div className="flex flex-wrap gap-1.5 px-3 pb-1">
                                            {byReason.map(([reason, n]) => (
                                                <span
                                                    key={reason}
                                                    className="px-1.5 py-0.5 rounded-full border border-glass-border text-[10px] font-semibold text-ink-secondary"
                                                >
                                                    {REASON_LABEL[reason] ?? reason} · {n}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                    <ul className="p-1.5">
                                        {findings.map(f => (
                                            <FindingRow key={f.dataSourceId} finding={f} />
                                        ))}
                                    </ul>
                                </>
                            )}
                        </div>

                        <div className="flex items-center justify-end gap-2 p-3 border-t border-glass-border">
                            <button
                                onClick={onClose}
                                className="h-8 px-3 rounded-lg text-xs font-semibold text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
                            >
                                Close
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </>,
        document.body,
    )
}
