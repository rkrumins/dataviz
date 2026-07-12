/**
 * ViewActivityDrawer — reusable slide-over hosting a view's activity timeline.
 * Opened from anywhere a view is actioned (overflow menu, list row, view page).
 */
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X, History } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { ViewActivityTimeline } from '@/components/views/ViewActivityTimeline'

export function ViewActivityDrawer({ viewId, viewName, isOpen, onClose }: {
    viewId: string | null
    viewName?: string | null
    isOpen: boolean
    onClose: () => void
}) {
    return createPortal(
        <>
            <Backdrop open={isOpen && !!viewId} onClick={onClose} zClassName="z-[70]" />
            {/* No AnimatePresence: this portaled popover unmounts instantly on close so an interrupted exit can't strand an invisible click-blocker over the page. It still animates in. */}
            <>
                {isOpen && viewId && (
                    <motion.aside
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        transition={{ type: 'spring', stiffness: 360, damping: 38 }}
                        className="fixed right-0 top-0 bottom-0 z-[71] w-full max-w-lg bg-canvas-elevated border-l border-glass-border shadow-2xl flex flex-col"
                    >
                        <div className="flex items-center gap-3 px-5 py-4 border-b border-glass-border shrink-0">
                            <div className="w-9 h-9 rounded-xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0">
                                <History className="w-4 h-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <h2 className="text-sm font-bold text-ink truncate">Activity</h2>
                                {viewName && <p className="text-xs text-ink-muted truncate">{viewName}</p>}
                            </div>
                            <button
                                onClick={onClose}
                                className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
                                aria-label="Close activity"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto px-5 py-4">
                            <ViewActivityTimeline viewId={viewId} />
                        </div>
                    </motion.aside>
                )}
            </>
        </>,
        document.body,
    )
}
