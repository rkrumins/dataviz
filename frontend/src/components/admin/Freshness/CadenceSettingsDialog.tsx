/**
 * CadenceSettingsDialog — the platform-admin editor for the GLOBAL rebuild
 * cadence (system:admin only; the caller hides the entry point).
 *
 * Edits the persisted global: the minimum minutes between automatic rebuilds
 * of a data source, plus whether the scheduler auto-rebuilds on detected
 * drift. Both are optional — blank/unset falls through to the deploy's env
 * default (shipped at 15 minutes). Writes only the cadence, so the pipeline
 * tuning defaults are never touched. Takes effect within a minute (the
 * consumers read a short-lived in-process cache — no restart).
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, Loader2 } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { useToast } from '@/components/ui/toast'
import { aggregationService, type AggregationCadence } from '@/services/aggregationService'
import { FRESHNESS_KEYS } from './useFreshness'

const MAX_MINUTES = 1440 // 86400s / 60 — the backend's hard ceiling

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

    if (!isOpen) return null

    const onSave = () => {
        const n = mins.trim() === '' ? null : Number(mins)
        if (n != null && (!Number.isFinite(n) || n < 0 || n > MAX_MINUTES)) {
            showToast('error', 'Enter a whole number of minutes between 0 and 1440.')
            return
        }
        save.mutate({
            rebuildMinIntervalSecs: n == null ? null : Math.round(n * 60),
            driftAutoRebuild: driftAuto,
        })
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
                    role="dialog" aria-modal="true" aria-label="Cadence settings"
                >
                    <div className="h-1 bg-gradient-to-r from-indigo-500 to-violet-600" />
                    <div className="p-6">
                        <div className="flex items-center gap-2 mb-1">
                            <Clock className="w-4 h-4 text-indigo-500" />
                            <h3 className="text-lg font-bold text-ink">Cadence settings</h3>
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
                                disabled={save.isPending || settingsQ.isLoading}
                                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors disabled:opacity-50"
                            >
                                {save.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
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
