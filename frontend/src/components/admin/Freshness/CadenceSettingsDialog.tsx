/**
 * CadenceSettingsDialog — the platform-admin editor for the two GLOBAL
 * policies that govern automatic rebuilds (system:admin only; the caller
 * hides the entry point).
 *
 * **Rebuild cadence** — the minimum minutes between automatic rebuilds of a
 * data source, plus whether the scheduler auto-rebuilds on detected drift.
 *
 * **Automatic reconciliation** — how often each source is checked for rollups
 * that no longer match its data, how many rebuilds one check may queue, and
 * which findings are acted on.
 *
 * Both live here rather than in two dialogs because they are stored in the
 * same record: a second editor would be a second source of truth for one
 * setting, and whichever saved last would win.
 *
 * Every field is optional — blank/unset falls through to the deploy's env
 * default, which the server reports so the controls seed from the real
 * current value rather than a hardcoded guess. The pipeline tuning defaults
 * are never touched. Takes effect within a minute (the consumers read a
 * short-lived in-process cache — no restart).
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, Loader2 } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { useToast } from '@/components/ui/toast'
import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { aggregationService, type AggregationCadence } from '@/services/aggregationService'
import { freshnessService } from '@/services/freshnessService'
import { FRESHNESS_KEYS, useSetReconciliationPolicy } from './useFreshness'

const MAX_MINUTES = 1440 // 86400s / 60 — the backend's hard ceiling

/** The four detectors, in the order the backend evaluates them. Each says
 *  what it looks for in the operator's terms, not the detector's. */
const DETECTORS: { key: string; label: string; hint: string }[] = [
    {
        key: 'overlay_missing',
        label: 'Rollups went missing',
        hint: 'A source that had rolled-up lineage now has none — usually a reload wiped it.',
    },
    {
        key: 'overlay_shrunk',
        label: 'Rollups shrank',
        hint: 'Far fewer rollups than the last build produced, with the underlying data unchanged.',
    },
    {
        key: 'never_aggregated',
        label: 'Never built',
        hint: 'An onboarded source with data and an ontology that has never had lineage built.',
    },
    {
        key: 'raw_drift',
        label: 'Counts changed',
        hint: 'Something outside the app changed the node or edge counts.',
    },
]

export function CadenceSettingsDialog({ isOpen, onClose }: {
    isOpen: boolean
    onClose: () => void
}) {
    const qc = useQueryClient()
    const { showToast } = useToast()

    const settingsQ = useQuery({
        queryKey: ['aggregation', 'settings'],
        queryFn: () => aggregationService.getAggregationSettings(),
        enabled: isOpen,
    })

    const [mins, setMins] = useState('')
    const [driftAuto, setDriftAuto] = useState(true)
    const [reconEnabled, setReconEnabled] = useState(true)
    const [reconMins, setReconMins] = useState('')
    const [reconCap, setReconCap] = useState('')
    const [detectors, setDetectors] = useState<string[]>([])

    // Seed from the persisted cadence, falling back to the EFFECTIVE env
    // defaults (never a hardcoded assumption). This is load-bearing for the
    // toggle: seeding it from the real current default means a save that only
    // meant to change the interval round-trips the actual drift-auto state
    // instead of silently flipping it on.
    const cadence = settingsQ.data?.cadence
    const envDriftAuto = settingsQ.data?.envDriftAutoRebuild
    const envMins = settingsQ.data?.envRebuildMinIntervalSecs != null
        ? Math.round(settingsQ.data.envRebuildMinIntervalSecs / 60)
        : null
    useEffect(() => {
        if (!settingsQ.data) return
        setMins(cadence?.rebuildMinIntervalSecs != null
            ? String(Math.round(cadence.rebuildMinIntervalSecs / 60))
            : '')
        setDriftAuto(cadence?.driftAutoRebuild ?? envDriftAuto ?? true)
    }, [settingsQ.data, cadence, envDriftAuto])

    // The reconciliation policy comes from its own endpoint (it carries the
    // env defaults and the detector vocabulary), but is STORED alongside the
    // cadence and saved in the same click — so this dialog owns both.
    const reconQ = useQuery({
        queryKey: FRESHNESS_KEYS.reconciliation,
        queryFn: () => freshnessService.getReconciliation(),
        enabled: isOpen,
    })
    const policy = reconQ.data?.policy
    const envReconMins = policy?.envCheckIntervalSecs != null
        ? Math.round(policy.envCheckIntervalSecs / 60)
        : null
    useEffect(() => {
        if (!policy) return
        setReconEnabled(policy.enabled ?? policy.envEnabled)
        setReconMins(policy.checkIntervalSecs != null
            ? String(Math.round(policy.checkIntervalSecs / 60))
            : '')
        setReconCap(policy.maxActionsPerRun != null ? String(policy.maxActionsPerRun) : '')
        // Unset means every detector is on — so seed the boxes from the full
        // list, not from an empty one. An EMPTY stored array is a real
        // configuration ("act on nothing") and must survive as such.
        setDetectors(policy.detectors ?? policy.allDetectors)
    }, [policy])

    const save = useMutation({
        mutationFn: (body: AggregationCadence) => aggregationService.putAggregationCadence(body),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['aggregation', 'settings'] })
            void qc.invalidateQueries({ queryKey: FRESHNESS_KEYS.fleetPrefix })
            showToast('success', 'Rebuild cadence saved. Takes effect within a minute.')
            onClose()
        },
        onError: (e: Error) => showToast('error', e.message || 'Could not save cadence.'),
    })
    const saveRecon = useSetReconciliationPolicy()

    if (!isOpen) return null

    const onSave = () => {
        const n = mins.trim() === '' ? null : Number(mins)
        if (n != null && (!Number.isFinite(n) || n < 0 || n > MAX_MINUTES)) {
            showToast('error', 'Enter a whole number of minutes between 0 and 1440.')
            return
        }
        const rn = reconMins.trim() === '' ? null : Number(reconMins)
        if (rn != null && (!Number.isFinite(rn) || rn < 5 || rn > MAX_MINUTES)) {
            showToast('error', 'Check frequency must be between 5 and 1440 minutes.')
            return
        }
        const cap = reconCap.trim() === '' ? null : Number(reconCap)
        if (cap != null && (!Number.isFinite(cap) || cap < 0 || cap > 200)) {
            showToast('error', 'Rebuilds per check must be between 0 and 200.')
            return
        }
        // Both writes land in the same stored record, so they are sequenced
        // rather than raced: the policy first, then the cadence, each merging
        // into what the other left.
        saveRecon.mutate(
            {
                enabled: reconEnabled,
                checkIntervalSecs: rn == null ? null : Math.round(rn * 60),
                maxActionsPerRun: cap,
                // Sent as an explicit list, never omitted: an empty list means
                // "act on nothing", which is a real choice, not an unset one.
                detectors,
            },
            {
                onSuccess: () => save.mutate({
                    rebuildMinIntervalSecs: n == null ? null : Math.round(n * 60),
                    driftAutoRebuild: driftAuto,
                }),
                onError: (e: Error) =>
                    showToast('error', e.message || 'Could not save reconciliation settings.'),
            },
        )
    }

    return createPortal(
        <>
            <Backdrop open={isOpen} onClick={onClose} zClassName="z-50" className="bg-black/50" />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
                <motion.div
                    initial={{ scale: 0.96, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.12 }}
                    onClick={(e) => e.stopPropagation()}
                    className="pointer-events-auto w-full max-w-md rounded-2xl bg-canvas-elevated border border-glass-border shadow-lg overflow-hidden"
                    role="dialog" aria-modal="true" aria-label="Cadence and reconciliation settings"
                >
                    <div className="h-1 bg-gradient-to-r from-indigo-500 to-violet-600" />
                    <div className="p-6">
                        <div className="flex items-center gap-2 mb-1">
                            <Clock className="w-4 h-4 text-indigo-500" />
                            <h3 className="text-lg font-bold text-ink">Cadence &amp; reconciliation</h3>
                        </div>
                        <p className="text-sm text-ink-muted mb-5">
                            The default rebuild cadence for every data source. A source can override it in its detail panel.
                        </p>

                        {settingsQ.isLoading ? (
                            <div className="flex items-center gap-2 justify-center py-8 text-sm text-ink-muted">
                                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-sm font-semibold text-ink mb-1">
                                        Minimum time between automatic rebuilds
                                    </label>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="number" min={0} max={MAX_MINUTES} step={1}
                                            value={mins}
                                            onChange={(e) => setMins(e.target.value)}
                                            placeholder={envMins != null ? `Default (${envMins})` : 'Default'}
                                            aria-label="Minimum minutes between automatic rebuilds"
                                            className="w-32 h-9 px-2.5 rounded-lg border border-glass-border bg-canvas text-sm text-ink"
                                        />
                                        <span className="text-sm text-ink-muted">minutes</span>
                                    </div>
                                    <p className="text-[11px] text-ink-muted mt-1">
                                        Leave blank to use the system default{envMins != null ? ` (${envMins} minutes)` : ''}. Set 0 to rebuild on every change.
                                    </p>
                                </div>

                                <label className="flex items-center gap-2.5 text-sm text-ink-secondary cursor-pointer">
                                    <input
                                        type="checkbox" checked={driftAuto}
                                        onChange={(e) => setDriftAuto(e.target.checked)}
                                        className="accent-indigo-500"
                                    />
                                    Automatically rebuild a source when drift is detected
                                </label>

                                {/* ── Automatic reconciliation ────────────
                                    Lives in this dialog because it is stored
                                    in the same record and saved through the
                                    same request. A second dialog would be a
                                    second source of truth for one setting. */}
                                <div className="pt-4 border-t border-glass-border space-y-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="text-sm font-semibold text-ink">Automatic reconciliation</p>
                                            <p className="text-[11px] text-ink-muted mt-0.5">
                                                Checks every source for rollups that no longer
                                                match its data and rebuilds them. Uses the
                                                statistics already collected, so a check costs
                                                nothing on the graph.
                                            </p>
                                        </div>
                                        <ToggleSwitch
                                            checked={reconEnabled}
                                            onChange={setReconEnabled}
                                            aria-label="Automatic reconciliation"
                                        />
                                    </div>

                                    {reconEnabled && (
                                        <>
                                            <div className="flex items-center gap-2">
                                                <label className="text-sm text-ink-secondary" htmlFor="recon-interval">
                                                    Check every
                                                </label>
                                                <input
                                                    id="recon-interval"
                                                    type="number" min={5} max={MAX_MINUTES} step={1}
                                                    value={reconMins}
                                                    onChange={(e) => setReconMins(e.target.value)}
                                                    placeholder={envReconMins != null ? `Default (${envReconMins})` : 'Default'}
                                                    className="w-32 h-9 px-2.5 rounded-lg border border-glass-border bg-canvas text-sm text-ink"
                                                />
                                                <span className="text-sm text-ink-muted">minutes</span>
                                            </div>

                                            <div className="flex items-center gap-2">
                                                <label className="text-sm text-ink-secondary" htmlFor="recon-cap">
                                                    At most
                                                </label>
                                                <input
                                                    id="recon-cap"
                                                    type="number" min={0} max={200} step={1}
                                                    value={reconCap}
                                                    onChange={(e) => setReconCap(e.target.value)}
                                                    placeholder={`Default (${policy?.envMaxActionsPerRun ?? 10})`}
                                                    className="w-32 h-9 px-2.5 rounded-lg border border-glass-border bg-canvas text-sm text-ink"
                                                />
                                                <span className="text-sm text-ink-muted">rebuilds per check</span>
                                            </div>
                                            <p className="text-[11px] text-ink-muted -mt-1">
                                                Anything over the cap waits for the next check, so
                                                turning this on cannot rebuild the whole fleet at once.
                                            </p>

                                            <fieldset className="space-y-1.5">
                                                <legend className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted mb-1">
                                                    What to act on
                                                </legend>
                                                {DETECTORS.map(d => (
                                                    <label key={d.key} className="flex items-start gap-2.5 text-sm text-ink-secondary cursor-pointer">
                                                        <input
                                                            type="checkbox"
                                                            checked={detectors.includes(d.key)}
                                                            onChange={(e) => setDetectors(prev => e.target.checked
                                                                ? [...prev, d.key]
                                                                : prev.filter(k => k !== d.key))}
                                                            className="accent-indigo-500 mt-0.5"
                                                        />
                                                        <span className="min-w-0">
                                                            {d.label}
                                                            <span className="block text-[11px] text-ink-muted">{d.hint}</span>
                                                        </span>
                                                    </label>
                                                ))}
                                                <p className="text-[11px] text-ink-muted pt-1">
                                                    Unchecking one stops rebuilds for it — the problem is
                                                    still detected and shown in the table.
                                                </p>
                                            </fieldset>
                                        </>
                                    )}
                                </div>

                                <p className="text-[11px] text-ink-muted">
                                    Changes take effect within a minute — no restart needed.
                                </p>
                            </div>
                        )}

                        <div className="flex items-center justify-end gap-2 mt-6">
                            <button
                                onClick={onClose}
                                className="h-9 px-3 rounded-lg text-sm font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={onSave}
                                disabled={save.isPending || saveRecon.isPending || settingsQ.isLoading}
                                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors disabled:opacity-50"
                            >
                                {(save.isPending || saveRecon.isPending) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                Save
                            </button>
                        </div>
                    </div>
                </motion.div>
            </div>
        </>,
        document.body,
    )
}
