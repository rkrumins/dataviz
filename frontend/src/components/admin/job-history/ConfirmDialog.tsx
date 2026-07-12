import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'

export function ConfirmDialog({
    open,
    title,
    message,
    confirmLabel,
    confirmColor = 'bg-red-500 hover:bg-red-600 shadow-md',
    confirmIcon: ConfirmIcon,
    onConfirm,
    onCancel,
    loading,
}: {
    open: boolean
    title: string
    message: string
    confirmLabel: string
    confirmColor?: string
    confirmIcon: typeof Play
    onConfirm: () => void
    onCancel: () => void
    loading?: boolean
}) {
    if (!open) return null
    return createPortal(
        <>
            <Backdrop open={open} onClick={() => !loading && onCancel()} zClassName="z-50" className="bg-black/50" />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
            <AnimatePresence>
                <motion.div
                    initial={{ scale: 0.96, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.96, opacity: 0 }}
                    transition={{ duration: 0.12 }}
                    onClick={e => e.stopPropagation()}
                    className="pointer-events-auto w-full max-w-md rounded-2xl bg-canvas-elevated border border-glass-border shadow-lg overflow-hidden"
                    role="dialog"
                    aria-modal="true"
                >
                    <div className="h-1 bg-gradient-to-r from-red-500 to-red-400" />
                    <div className="p-6">
                        <h3 className="text-lg font-bold text-ink mb-2">{title}</h3>
                        <p className="text-sm text-ink-muted leading-relaxed">{message}</p>
                    </div>
                    <div className="flex justify-end gap-3 px-6 pb-6">
                        <button
                            onClick={onCancel}
                            disabled={loading}
                            className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={onConfirm}
                            disabled={loading}
                            className={cn('px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors disabled:opacity-50 flex items-center gap-2', confirmColor)}
                        >
                            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ConfirmIcon className="w-4 h-4" />}
                            {confirmLabel}
                        </button>
                    </div>
                </motion.div>
            </AnimatePresence>
            </div>
        </>,
        document.body,
    )
}
