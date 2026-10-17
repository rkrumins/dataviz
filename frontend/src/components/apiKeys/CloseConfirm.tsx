/**
 * "Close anyway?" above a dialog — for a half-filled form, and for a key that
 * has not been stored yet. The house shape: a CSS <Backdrop> sibling, and an
 * inert full-viewport wrapper outside the presence tree, so an interrupted
 * exit can never leave a click-blocker behind. Escape belongs to the dialog
 * underneath, which closes this first.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'

import { Backdrop } from '@/components/ui/Backdrop'
import { MOTION } from '@/lib/motion'

export function CloseConfirm({ open, title, body, keepLabel, leaveLabel, onKeep, onLeave }: {
    open: boolean
    title: string
    body: string
    keepLabel: string
    leaveLabel: string
    onKeep: () => void
    onLeave: () => void
}) {
    return (
        <>
            <Backdrop open={open} onClick={onKeep} zClassName="z-[90]" className="bg-black/40" />
            <div className="fixed inset-0 z-[91] flex items-center justify-center p-4 pointer-events-none">
                <AnimatePresence>
                    {open && (
                        <motion.div
                            key="api-key-close-confirm"
                            role="alertdialog"
                            aria-modal="true"
                            aria-label={title}
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            transition={MOTION.fadeIn}
                            className="pointer-events-auto w-full max-w-sm bg-canvas-elevated border border-black/[0.08] dark:border-white/[0.10] rounded-2xl shadow-xl p-6 space-y-5"
                        >
                            <div className="flex items-start gap-3">
                                <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center shrink-0">
                                    <AlertTriangle className="w-5 h-5 text-amber-500" aria-hidden />
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-ink">{title}</h3>
                                    <p className="text-xs text-ink-muted mt-1 leading-relaxed">{body}</p>
                                </div>
                            </div>
                            <div className="flex items-center justify-end gap-2">
                                <button
                                    type="button"
                                    autoFocus
                                    onClick={onKeep}
                                    className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                >
                                    {keepLabel}
                                </button>
                                <button
                                    type="button"
                                    onClick={onLeave}
                                    className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-rose-600 hover:bg-rose-500 transition-colors"
                                >
                                    {leaveLabel}
                                </button>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </>
    )
}
