/**
 * TemplateDialogShell — portal modal scaffolding shared by every
 * template management dialog (Save, Duplicate, Delete, Import).
 *
 * Mirrors the anatomy of components/explorer/DeleteViewDialog.tsx
 * (portal + Framer Motion spring + backdrop close) so the surface
 * feels consistent with the rest of the app.
 */
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface TemplateDialogShellProps {
    isOpen: boolean
    onClose: () => void
    title: string
    subtitle?: string
    icon?: ReactNode
    accentColor?: string
    /** Disable close when an async action is in flight. */
    busy?: boolean
    children: ReactNode
    footer?: ReactNode
    size?: 'sm' | 'md' | 'lg'
}

export function TemplateDialogShell({
    isOpen, onClose, title, subtitle, icon, accentColor,
    busy, children, footer, size = 'md',
}: TemplateDialogShellProps) {
    if (!isOpen) return null

    const handleBackdrop = () => {
        if (busy) return
        onClose()
    }

    const maxWidth = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-2xl' : 'max-w-xl'

    const node = (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60"
                onClick={handleBackdrop}
            >
                <motion.div
                    initial={{ scale: 0.96, opacity: 0, y: 8 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.96, opacity: 0, y: 8 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 350 }}
                    onClick={(e) => e.stopPropagation()}
                    className={cn(
                        'w-full bg-white dark:bg-slate-900 rounded-2xl shadow-lg shadow-black/20 overflow-hidden flex flex-col',
                        maxWidth,
                    )}
                >
                    {/* Accent strip */}
                    {accentColor && (
                        <div className="h-1" style={{ backgroundColor: accentColor }} />
                    )}

                    {/* Header */}
                    <div className="flex items-start gap-3 px-5 pt-5 pb-3 border-b border-glass-border">
                        {icon && (
                            <div
                                className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                                style={accentColor ? {
                                    backgroundColor: `${accentColor}15`,
                                    color: accentColor,
                                    border: `1px solid ${accentColor}30`,
                                } : undefined}
                            >
                                {icon}
                            </div>
                        )}
                        <div className="min-w-0 flex-1">
                            <h2 className="text-base font-semibold text-ink leading-tight">{title}</h2>
                            {subtitle && (
                                <p className="text-xs text-ink-muted mt-0.5 leading-snug">{subtitle}</p>
                            )}
                        </div>
                        <button
                            onClick={handleBackdrop}
                            disabled={busy}
                            className="w-7 h-7 rounded-md flex items-center justify-center text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink transition-colors disabled:opacity-50"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Body */}
                    <div className="px-5 py-4 overflow-y-auto custom-scrollbar">
                        {children}
                    </div>

                    {/* Footer */}
                    {footer && (
                        <div className="px-5 py-3 border-t border-glass-border bg-canvas-elevated/50">
                            {footer}
                        </div>
                    )}
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )

    return createPortal(node, document.body)
}
