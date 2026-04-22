/**
 * RetriggerDialog — Modal for re-triggering (or resuming) an aggregation job
 * with user-overridable knobs (batch size, projection mode, retries, timeout).
 *
 * Visual contract follows `ConfirmDialog.tsx` — same z-index, backdrop,
 * spring/scale animation, button shapes — so it slots into existing flows
 * without visual drift.
 *
 * Two confirm paths:
 *   • "Re-trigger from scratch" — always shown; fresh job from offset 0.
 *   • "Resume from cursor"     — only shown when an `originatingJob` was
 *                                supplied AND it has a non-null `lastCursor`
 *                                AND its status is failed/cancelled.
 *
 * On confirm, the dialog awaits the parent's promise. Success → close.
 * Failure → propagate so the parent's toast can render; the dialog stays
 * open so the user can retry without losing their overrides.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, Play, RotateCcw, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    AggregationOverridesForm,
    type AggregationOverridesValue,
} from '../shared/AggregationOverridesForm'

export interface RetriggerDialogProps {
    isOpen: boolean
    onClose: () => void
    /** Pre-populates the form. */
    initialValue: AggregationOverridesValue
    /** Title (e.g. "Re-trigger aggregation" or "Trigger aggregation"). */
    title: string
    /** When provided AND originatingJob.lastCursor is non-null, show the Resume button. */
    originatingJob?: {
        id: string
        lastCursor: string | null
        status: string  // "completed" | "failed" | "cancelled" | "running" | "pending"
    }
    /** Always shown. */
    onConfirmRetrigger: (overrides: AggregationOverridesValue) => Promise<void>
    /** Only shown when originatingJob exists with non-null lastCursor. */
    onConfirmResume?: (overrides: AggregationOverridesValue) => Promise<void>
}

export function RetriggerDialog({
    isOpen,
    onClose,
    initialValue,
    title,
    originatingJob,
    onConfirmRetrigger,
    onConfirmResume,
}: RetriggerDialogProps) {
    const [value, setValue] = useState<AggregationOverridesValue>(initialValue)
    const [loading, setLoading] = useState<'resume' | 'retrigger' | null>(null)

    // Reset form to fresh `initialValue` each time the dialog re-opens.
    // We compare on `isOpen` (not `initialValue`) so that prop reference churn
    // while the dialog is open doesn't clobber what the user is editing.
    const prevOpenRef = useRef(false)
    useEffect(() => {
        if (isOpen && !prevOpenRef.current) {
            setValue(initialValue)
            setLoading(null)
        }
        prevOpenRef.current = isOpen
    }, [isOpen, initialValue])

    // Lock background scroll while the modal is mounted.
    useEffect(() => {
        if (!isOpen) return
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => { document.body.style.overflow = prev }
    }, [isOpen])

    if (!isOpen) return null

    const canResume =
        !!originatingJob
        && originatingJob.lastCursor !== null
        && originatingJob.lastCursor !== undefined
        && (originatingJob.status === 'failed' || originatingJob.status === 'cancelled')
        && !!onConfirmResume

    const isLoading = loading !== null

    const handleConfirm = async (kind: 'resume' | 'retrigger') => {
        if (isLoading) return
        setLoading(kind)
        try {
            if (kind === 'resume' && onConfirmResume) {
                await onConfirmResume(value)
            } else {
                await onConfirmRetrigger(value)
            }
            onClose()
        } catch {
            // Parent owns the toast/error surface. Keep dialog open + form intact.
        } finally {
            setLoading(null)
        }
    }

    return createPortal(
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
                onClick={() => !isLoading && onClose()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="retrigger-dialog-title"
            >
                <motion.div
                    initial={{ scale: 0.96, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.96, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    onClick={e => e.stopPropagation()}
                    className="w-full max-w-2xl rounded-2xl bg-canvas-elevated border border-glass-border shadow-xl overflow-hidden flex flex-col max-h-[90vh]"
                >
                    {/* Accent bar */}
                    <div className="h-1 bg-gradient-to-r from-indigo-500 to-violet-500" />

                    {/* Header */}
                    <div className="px-6 pt-5 pb-3 flex items-start gap-3 border-b border-glass-border/40">
                        <div className="w-9 h-9 rounded-xl bg-indigo-500/10 flex items-center justify-center flex-shrink-0">
                            <Settings2 className="w-4 h-4 text-indigo-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3
                                id="retrigger-dialog-title"
                                className="text-base font-bold text-ink"
                            >
                                {title}
                            </h3>
                            <p className="text-xs text-ink-muted mt-0.5">
                                {canResume
                                    ? 'Resume from the last checkpoint or start a fresh run with these settings.'
                                    : 'Tune the run parameters before kicking off the job.'}
                            </p>
                        </div>
                    </div>

                    {/* Body — scrollable form */}
                    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
                        <AggregationOverridesForm
                            value={value}
                            onChange={setValue}
                            disabled={isLoading}
                        />
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-glass-border/40 bg-black/[0.02] dark:bg-white/[0.01]">
                        <button
                            onClick={onClose}
                            disabled={isLoading}
                            className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                        >
                            Cancel
                        </button>

                        {canResume && (
                            <button
                                onClick={() => handleConfirm('resume')}
                                disabled={isLoading}
                                className={cn(
                                    'px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors disabled:opacity-50 flex items-center gap-2',
                                    'bg-indigo-500 hover:bg-indigo-600 shadow-lg shadow-indigo-500/25',
                                )}
                            >
                                {loading === 'resume'
                                    ? <Loader2 className="w-4 h-4 animate-spin" />
                                    : <RotateCcw className="w-4 h-4" />}
                                Resume from cursor
                            </button>
                        )}

                        <button
                            onClick={() => handleConfirm('retrigger')}
                            disabled={isLoading}
                            className={cn(
                                'px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors disabled:opacity-50 flex items-center gap-2',
                                'bg-emerald-500 hover:bg-emerald-600 shadow-lg shadow-emerald-500/25',
                            )}
                        >
                            {loading === 'retrigger'
                                ? <Loader2 className="w-4 h-4 animate-spin" />
                                : <Play className="w-4 h-4" />}
                            Re-trigger from scratch
                        </button>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>,
        document.body,
    )
}

export default RetriggerDialog
