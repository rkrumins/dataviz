/**
 * The frame the key dialogs share — rotate, edit, revoke: a header with the
 * subject, a scrolling body, a footer of actions. A sheet from the bottom on
 * a phone, a centred card elsewhere, above the detail drawer (z-[80]).
 *
 * The page mounts it to open it and unmounts it to close it, so there is no
 * exit to strand. Escape and the backdrop go through `onClose`, which the
 * dialog may answer with a question first (a key not yet stored); it is read
 * through a ref, so a new handler on every render does not re-run the focus
 * handling and pull focus out of the field being typed in.
 */
import { useCallback, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'

import { Backdrop } from '@/components/ui/Backdrop'
import { useModalA11y } from '@/hooks/useModalA11y'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'

const TONE = {
    indigo: 'from-indigo-500 to-violet-600 shadow-indigo-500/20',
    danger: 'from-rose-500 to-red-600 shadow-rose-500/20',
}

export function KeyDialog({ icon: Icon, tone = 'indigo', title, subtitle, wide, onClose, footer, children }: {
    icon: typeof X
    tone?: keyof typeof TONE
    title: string
    subtitle?: string
    wide?: boolean
    onClose: () => void
    footer: React.ReactNode
    children: React.ReactNode
}) {
    const titleId = useId()
    const latest = useRef(onClose)
    useEffect(() => { latest.current = onClose })
    const close = useCallback(() => latest.current(), [])
    const panelRef = useModalA11y(true, close)

    return createPortal(
        <>
            <Backdrop open onClick={close} zClassName="z-[80]" className="bg-black/50" />
            <div className="fixed inset-0 z-[81] flex items-end sm:items-center justify-center sm:p-4 pointer-events-none">
                <motion.div
                    ref={panelRef}
                    tabIndex={-1}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    initial={{ opacity: 0, y: 16, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={MOTION.modalSpring}
                    className={cn(
                        'pointer-events-auto w-full max-h-[92vh] sm:max-h-[88vh] flex flex-col overflow-hidden outline-none',
                        'bg-canvas-elevated rounded-t-2xl sm:rounded-2xl shadow-2xl border border-black/[0.08] dark:border-white/[0.08]',
                        wide ? 'sm:max-w-2xl' : 'sm:max-w-lg',
                    )}
                >
                    {tone === 'danger' && <div aria-hidden className="h-1 shrink-0 bg-gradient-to-r from-rose-500 to-red-500" />}
                    <header className="flex items-center gap-3.5 px-5 sm:px-6 pt-5 pb-4 border-b border-black/[0.07] dark:border-white/[0.08] shrink-0">
                        <span className={cn('w-11 h-11 rounded-xl bg-gradient-to-br text-white flex items-center justify-center shrink-0 shadow-md', TONE[tone])}>
                            <Icon className="w-5 h-5" aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                            <h2 id={titleId} className="text-base sm:text-lg font-bold text-ink line-clamp-2 sm:line-clamp-1 break-words">{title}</h2>
                            {subtitle && <p className="text-xs sm:text-sm text-ink-muted">{subtitle}</p>}
                        </div>
                        <button
                            type="button"
                            onClick={close}
                            aria-label="Close"
                            className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </header>
                    <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 py-5">{children}</div>
                    <footer className="flex flex-wrap items-center justify-end gap-2 px-5 sm:px-6 py-4 border-t border-black/[0.07] dark:border-white/[0.08] bg-black/[0.015] dark:bg-white/[0.02] shrink-0">
                        {footer}
                    </footer>
                </motion.div>
            </div>
        </>,
        document.body,
    )
}
