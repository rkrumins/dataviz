/**
 * RetentionDialog — how much history is kept, and for how long.
 *
 * Reached from the coverage strip's retention chip, which is where a reader
 * has just been told how far back the series goes. Putting the control at the
 * point the number is read, rather than in a settings page three clicks away,
 * is the difference between a knob someone finds and one they never do.
 *
 * Every field is `persisted ?? envDefault`: blank means "inherit", and the
 * placeholder shows what inheriting currently gets you. A no-op save
 * round-trips the real default instead of pinning whatever the UI happened to
 * render — the same contract the aggregation settings editor honours.
 *
 * Read-only for non-admins rather than hidden. The explanation of what is kept
 * and why is the valuable half, and someone reading a short series needs it
 * whether or not they can change it.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Clock, Database, Loader2, Save, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { useAnyPermission } from '@/store/auth'
import {
    INHERIT_ENV_DEFAULT, insightsHistoryService,
} from '@/services/insightsHistoryService'
import type { HistoryRetentionPolicy } from '@/types/insights'

export const RETENTION_QUERY_KEY = 'insights-history-retention' as const

interface FieldSpec {
    key: 'retentionDays' | 'maxRowsPerSource' | 'heartbeatSecs'
    envKey: 'envRetentionDays' | 'envMaxRowsPerSource' | 'envHeartbeatSecs'
    label: string
    unit: string
    hint: string
    min: number
}

const FIELDS: FieldSpec[] = [
    {
        key: 'retentionDays', envKey: 'envRetentionDays',
        label: 'Keep history for', unit: 'days', min: 1,
        hint: 'Snapshots older than this are purged. The age cutoff bounds how far back the series goes.',
    },
    {
        key: 'maxRowsPerSource', envKey: 'envMaxRowsPerSource',
        label: 'Keep at most', unit: 'snapshots per source', min: 1,
        hint: 'Applied alongside the age cutoff, not instead of it — it bounds what one source thrashing under a broken loader can contribute.',
    },
    {
        key: 'heartbeatSecs', envKey: 'envHeartbeatSecs',
        label: 'Checkpoint every', unit: 'seconds', min: 60,
        hint: 'A continuity snapshot when nothing changed, so an idle stretch reads as idle rather than missing.',
    },
]

type Draft = Record<FieldSpec['key'], string>

function toDraft(policy: HistoryRetentionPolicy): Draft {
    return {
        retentionDays: policy.retentionDays?.toString() ?? '',
        maxRowsPerSource: policy.maxRowsPerSource?.toString() ?? '',
        heartbeatSecs: policy.heartbeatSecs?.toString() ?? '',
    }
}

export function RetentionDialog({ onClose }: { onClose: () => void }) {
    const isAdmin = useAnyPermission(['system:admin'])
    const queryClient = useQueryClient()
    // `edits` holds ONLY what the user typed; the rendered draft is the
    // persisted policy with those laid over it. Deriving rather than syncing
    // means there is no effect to keep the two in step, and no window where a
    // freshly-loaded policy is on screen but not yet in state.
    const [edits, setEdits] = useState<Partial<Draft>>({})
    const [error, setError] = useState<string | null>(null)

    const { data: policy, isLoading } = useQuery({
        queryKey: [RETENTION_QUERY_KEY],
        queryFn: () => insightsHistoryService.getRetention(),
        staleTime: 60_000,
    })

    const draft: Draft | null = policy ? { ...toDraft(policy), ...edits } : null

    const save = useMutation({
        mutationFn: () => {
            // A blank field means "inherit", which the API spells as the
            // sentinel rather than null — absent and null are the same thing
            // over JSON, and "don't touch this" has to stay distinguishable
            // from "reset this".
            const body: Record<string, number> = {}
            for (const field of FIELDS) {
                const raw = draft?.[field.key]?.trim() ?? ''
                body[field.key] = raw === '' ? INHERIT_ENV_DEFAULT : Number(raw)
            }
            return insightsHistoryService.setRetention(body)
        },
        onSuccess: (next) => {
            queryClient.setQueryData([RETENTION_QUERY_KEY], next)
            // Coverage and the retention chip are rendered from the history
            // payload, so it has to be re-read for the new value to show.
            queryClient.invalidateQueries({ queryKey: ['insights-history'] })
            setEdits({})
            onClose()
        },
        onError: (err: Error) => setError(err.message || 'Could not save retention'),
    })

    const invalid = FIELDS.some((field) => {
        const raw = draft?.[field.key]?.trim() ?? ''
        if (raw === '') return false
        const value = Number(raw)
        return !Number.isFinite(value) || value < field.min
    })

    // Portaled, and deliberately NOT inside AnimatePresence: an interrupted
    // exit there can strand an invisible click-blocker over the page. Matches
    // FleetRefreshDialog, which records the same reasoning.
    return createPortal(
        <>
            <Backdrop open onClick={onClose} zClassName="z-50" className="bg-black/50" />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
            <motion.div
                initial={{ scale: 0.96, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.12 }}
                role="dialog"
                aria-modal="true"
                aria-label="History retention"
                onClick={(e) => e.stopPropagation()}
                className={cn(
                    'pointer-events-auto w-full max-w-lg rounded-2xl border border-glass-border',
                    'bg-canvas-elevated shadow-lg overflow-hidden',
                )}
            >
                <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <span className="w-9 h-9 rounded-xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0">
                            <Clock className="w-4.5 h-4.5" />
                        </span>
                        <div className="min-w-0">
                            <h2 className="text-sm font-bold text-ink">History retention</h2>
                            <p className="text-xs text-ink-muted mt-0.5">
                                {isAdmin
                                    ? 'What is kept, and for how long. Blank inherits the deployment default.'
                                    : 'What is kept, and for how long. Changing this needs system admin.'}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="p-1.5 rounded-lg text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 shrink-0"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {isLoading || !policy || !draft ? (
                    <div className="px-5 py-10 flex items-center justify-center">
                        <Loader2 className="w-5 h-5 animate-spin text-ink-muted" />
                    </div>
                ) : (
                    <>
                        {!policy.enabled && (
                            <div className="mx-5 mb-3 flex items-start gap-2 px-3 py-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06]">
                                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
                                <p className="text-[11px] text-ink-secondary">
                                    Capture is switched off for this deployment
                                    (<code className="font-mono">INSIGHTS_HISTORY_ENABLED</code>),
                                    so nothing is being recorded. These settings apply once it is on.
                                </p>
                            </div>
                        )}

                        <div className="px-5 pb-1 space-y-4">
                            {FIELDS.map((field) => {
                                const envDefault = policy[field.envKey]
                                const raw = draft[field.key].trim()
                                const inheriting = raw === ''
                                return (
                                    <div key={field.key}>
                                        <label className="flex items-center justify-between gap-3">
                                            <span className="text-xs font-semibold text-ink">
                                                {field.label}
                                            </span>
                                            <span className="flex items-center gap-2 shrink-0">
                                                <input
                                                    type="number"
                                                    inputMode="numeric"
                                                    min={field.min}
                                                    value={draft[field.key]}
                                                    disabled={!isAdmin}
                                                    placeholder={String(envDefault)}
                                                    onChange={(e) => {
                                                        setError(null)
                                                        setEdits((prev) => ({
                                                            ...prev, [field.key]: e.target.value,
                                                        }))
                                                    }}
                                                    className={cn(
                                                        'w-28 px-2.5 py-1.5 rounded-lg border text-sm text-ink text-right tabular-nums',
                                                        'bg-canvas-elevated outline-none transition-colors',
                                                        'focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                                        'disabled:opacity-60 disabled:pointer-events-none',
                                                        !inheriting && Number(raw) < field.min
                                                            ? 'border-red-500/50'
                                                            : 'border-glass-border',
                                                    )}
                                                />
                                                <span className="text-[11px] text-ink-muted w-36">
                                                    {field.unit}
                                                </span>
                                            </span>
                                        </label>
                                        <p className="text-[11px] text-ink-muted mt-1 pr-2">
                                            {field.hint}
                                        </p>
                                        <p className="text-[10px] text-ink-muted mt-0.5">
                                            {inheriting
                                                ? `Inheriting the deployment default (${envDefault.toLocaleString()}).`
                                                : `Overriding the deployment default of ${envDefault.toLocaleString()}.`}
                                        </p>
                                    </div>
                                )
                            })}
                        </div>

                        <div className="mx-5 mt-4 mb-4 px-3 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03]">
                            <p className="text-[11px] text-ink-secondary flex items-start gap-1.5">
                                <Database className="w-3.5 h-3.5 text-ink-muted mt-px shrink-0" />
                                <span>
                                    In force now:{' '}
                                    <strong className="text-ink font-semibold tabular-nums">
                                        {policy.effectiveRetentionDays} days
                                    </strong>{' '}
                                    or{' '}
                                    <strong className="text-ink font-semibold tabular-nums">
                                        {policy.effectiveMaxRowsPerSource.toLocaleString()}
                                    </strong>{' '}
                                    snapshots per source, whichever bites first. Purging runs
                                    in the background; shortening a window frees space over the
                                    next few passes rather than all at once.
                                </span>
                            </p>
                        </div>

                        {error && (
                            <p className="px-5 pb-3 text-[11px] text-red-600 dark:text-red-400">
                                {error}
                            </p>
                        )}

                        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-glass-border">
                            <button
                                type="button"
                                onClick={onClose}
                                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
                            >
                                {isAdmin ? 'Cancel' : 'Close'}
                            </button>
                            {isAdmin && (
                                <button
                                    type="button"
                                    disabled={invalid || save.isPending}
                                    onClick={() => save.mutate()}
                                    className={cn(
                                        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg',
                                        'text-xs font-semibold bg-indigo-500 text-white shadow-sm',
                                        'hover:bg-indigo-600 transition-colors outline-none',
                                        'focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                        'disabled:opacity-50 disabled:pointer-events-none',
                                    )}
                                >
                                    {save.isPending
                                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        : <Save className="w-3.5 h-3.5" />}
                                    Save
                                </button>
                            )}
                        </div>
                    </>
                )}
            </motion.div>
            </div>
        </>,
        document.body,
    )
}
