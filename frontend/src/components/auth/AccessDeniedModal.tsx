/**
 * Global access-denied notice — listens for ``'auth:access-denied'``
 * events dispatched by ``fetchWithTimeout`` on every 403 and surfaces
 * them as a non-blocking floating card.
 *
 * Mounted once in ``AppLayout`` so every authenticated route inherits
 * the behaviour. The card matches the toast visual language (rounded
 * panel, layered border, accent-coloured icon box) and auto-dismisses
 * after ~6 seconds. The backend's request path is collapsed behind a
 * "Details" disclosure so end-users see a clean message; engineers
 * can expand it for debugging.
 */
import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ShieldAlert, ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'


interface DenialEvent {
    detail: string | null
    path: string
    status: number
}


export function AccessDeniedModal() {
    const [event, setEvent] = useState<DenialEvent | null>(null)
    const [showDetails, setShowDetails] = useState(false)

    useEffect(() => {
        function onDenied(e: Event) {
            const ce = e as CustomEvent<DenialEvent>
            setEvent(ce.detail)
            setShowDetails(false)
        }
        window.addEventListener('auth:access-denied', onDenied)
        return () => window.removeEventListener('auth:access-denied', onDenied)
    }, [])

    // Auto-dismiss after 6 s. Pause when the user expands details so
    // they have time to read the path.
    useEffect(() => {
        if (!event) return
        if (showDetails) return
        const t = setTimeout(() => setEvent(null), 6_000)
        return () => clearTimeout(t)
    }, [event, showDetails])

    // ``Missing permission: workspace:view:edit`` — surface just the
    // human-friendly part for non-developers.
    const headlineMessage = event
        ? (event.detail ?? `Access denied (HTTP ${event.status})`)
        : ''

    return (
        <AnimatePresence>
            {event && (
                <motion.div
                    role="alertdialog"
                    aria-live="assertive"
                    initial={{ opacity: 0, y: 12, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.96 }}
                    transition={{ type: 'spring', damping: 22, stiffness: 320 }}
                    className={cn(
                        'fixed bottom-6 left-1/2 -translate-x-1/2 z-[80]',
                        'w-[min(420px,calc(100vw-2rem))] pointer-events-auto',
                        'bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg shadow-black/15 dark:shadow-black/40',
                        'overflow-hidden',
                    )}
                >
                    <div className="flex items-start gap-3 px-4 py-3.5">
                        <div className="w-9 h-9 rounded-lg border border-amber-500/20 bg-amber-500/10 flex items-center justify-center shrink-0">
                            <ShieldAlert className="w-4 h-4 text-amber-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-ink leading-snug">Access denied</p>
                            <p className="text-xs text-ink-secondary mt-0.5 leading-snug break-words">{headlineMessage}</p>
                            <button
                                onClick={() => setShowDetails(d => !d)}
                                className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors"
                            >
                                <ChevronDown className={cn('w-3 h-3 transition-transform', showDetails && 'rotate-180')} />
                                Details
                            </button>
                            <AnimatePresence>
                                {showDetails && (
                                    <motion.div
                                        initial={{ opacity: 0, height: 0, marginTop: 0 }}
                                        animate={{ opacity: 1, height: 'auto', marginTop: 6 }}
                                        exit={{ opacity: 0, height: 0, marginTop: 0 }}
                                        transition={{ duration: 0.18 }}
                                    >
                                        <code
                                            className="block px-2 py-1.5 rounded-md text-[10px] font-mono bg-glass-base/60 border border-glass-border text-ink-muted truncate"
                                            title={event.path}
                                        >
                                            HTTP {event.status} · {event.path}
                                        </code>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                        <button
                            onClick={() => setEvent(null)}
                            className="opacity-50 hover:opacity-100 transition-opacity flex-shrink-0 rounded-md p-0.5 hover:bg-black/5 dark:hover:bg-white/5 mt-0.5"
                            aria-label="Dismiss"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>

                    {/* Auto-dismiss progress bar — hidden while details are
                        expanded so the user has time to read */}
                    {!showDetails && (
                        <div className="h-0.5 w-full bg-black/5 dark:bg-white/5">
                            <motion.div
                                className="h-full bg-amber-500/60"
                                initial={{ width: '100%' }}
                                animate={{ width: '0%' }}
                                transition={{ duration: 6, ease: 'linear' }}
                            />
                        </div>
                    )}
                </motion.div>
            )}
        </AnimatePresence>
    )
}
