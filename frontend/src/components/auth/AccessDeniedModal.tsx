/**
 * Global access-denied notice — listens for ``'auth:access-denied'``
 * events dispatched by ``fetchWithTimeout`` on every 403 and surfaces
 * them as a non-blocking floating card.
 *
 * Mounted once in ``AppLayout`` so every authenticated route inherits
 * the behaviour. The card matches the toast visual language (rounded
 * panel, layered border, accent-coloured icon box).
 *
 * Phase 4.3 — when the failing path is workspace-scoped (the URL
 * contains a ``ws_xxx`` segment), the card surfaces a "Request
 * access" primary action that expands an inline composer: pick a
 * role, add an optional justification, submit. The card stays open
 * while the composer is in use; auto-dismiss only fires while the
 * card is in its compact display state.
 */
import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    ShieldAlert, ChevronDown, X, Send, Check, Loader2, AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import {
    permissionsService,
    type RoleDefinitionResponse,
} from '@/services/permissionsService'
import {
    accessRequestsService,
} from '@/services/accessRequestsService'


interface DenialEvent {
    detail: string | null
    path: string
    status: number
}


/** Pull a workspace id (``ws_*`` prefix) out of the failing path.
 *  Returns ``null`` when the request wasn't workspace-scoped — in
 *  that case we don't surface the request-access composer. */
function extractWorkspaceId(path: string): string | null {
    // Tolerate query strings and trailing fragments.
    const cleanPath = path.split('?')[0].split('#')[0]
    const match = cleanPath.match(/\/(ws_[a-zA-Z0-9_-]+)(?:\/|$)/)
    return match ? match[1] : null
}


export function AccessDeniedModal() {
    const [event, setEvent] = useState<DenialEvent | null>(null)
    const [showDetails, setShowDetails] = useState(false)
    const [composerOpen, setComposerOpen] = useState(false)

    useEffect(() => {
        function onDenied(e: Event) {
            const ce = e as CustomEvent<DenialEvent>
            setEvent(ce.detail)
            setShowDetails(false)
            setComposerOpen(false)
        }
        window.addEventListener('auth:access-denied', onDenied)
        return () => window.removeEventListener('auth:access-denied', onDenied)
    }, [])

    // Auto-dismiss after 6 s. Pause when the user expands details OR
    // opens the request-access composer.
    useEffect(() => {
        if (!event) return
        if (showDetails || composerOpen) return
        const t = setTimeout(() => setEvent(null), 6_000)
        return () => clearTimeout(t)
    }, [event, showDetails, composerOpen])

    // ``Missing permission: workspace:view:edit`` — surface just the
    // human-friendly part for non-developers.
    const headlineMessage = event
        ? (event.detail ?? `Access denied (HTTP ${event.status})`)
        : ''

    const wsId = useMemo(
        () => (event ? extractWorkspaceId(event.path) : null),
        [event],
    )

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
                        'w-[min(440px,calc(100vw-2rem))] pointer-events-auto',
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

                            {wsId && !composerOpen && (
                                <button
                                    onClick={() => setComposerOpen(true)}
                                    className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/15 transition-colors"
                                >
                                    <Send className="w-3 h-3" />
                                    Request access
                                </button>
                            )}

                            <button
                                onClick={() => setShowDetails(d => !d)}
                                className="mt-1.5 ml-2 inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors"
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

                    <AnimatePresence>
                        {composerOpen && wsId && (
                            <RequestAccessComposer
                                wsId={wsId}
                                onClose={() => setComposerOpen(false)}
                                onSubmitted={() => {
                                    setComposerOpen(false)
                                    setEvent(null)
                                }}
                            />
                        )}
                    </AnimatePresence>

                    {/* Auto-dismiss progress bar — hidden while details
                        are expanded or the composer is in use */}
                    {!showDetails && !composerOpen && (
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


function RequestAccessComposer({
    wsId, onClose, onSubmitted,
}: {
    wsId: string
    onClose: () => void
    onSubmitted: () => void
}) {
    const [roles, setRoles] = useState<RoleDefinitionResponse[] | null>(null)
    const [selectedRole, setSelectedRole] = useState<string>('')
    const [justification, setJustification] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [loadError, setLoadError] = useState<string | null>(null)
    const { showToast } = useToast()

    useEffect(() => {
        let cancelled = false
        permissionsService.listRoles({ workspaceId: wsId })
            .then(rs => {
                if (cancelled) return
                setRoles(rs)
                // Default to the lowest-privilege role we can offer —
                // gives the user the path of least resistance.
                const preferred = rs.find(r => r.name === 'viewer')
                    ?? rs.find(r => r.name === 'user')
                    ?? rs[0]
                if (preferred) setSelectedRole(preferred.name)
            })
            .catch(err => {
                if (cancelled) return
                setLoadError(err instanceof Error ? err.message : String(err))
            })
        return () => { cancelled = true }
    }, [wsId])

    const handleSubmit = async () => {
        if (!selectedRole) return
        setSubmitting(true)
        try {
            await accessRequestsService.submit({
                targetType: 'workspace',
                targetId: wsId,
                requestedRole: selectedRole,
                justification: justification.trim() || null,
            })
            showToast('success', 'Access request submitted. The workspace admin will review it.')
            onSubmitted()
        } catch (err) {
            showToast(
                'error',
                err instanceof Error ? err.message : 'Failed to submit request',
            )
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-glass-border bg-glass-base/30"
        >
            <div className="p-3 space-y-3">
                <div className="flex items-center justify-between">
                    <span className="text-[11px] uppercase tracking-wider font-bold text-ink-muted">
                        Request access to <code className="font-mono font-semibold text-ink normal-case tracking-normal">{wsId}</code>
                    </span>
                    <button
                        onClick={onClose}
                        className="text-[11px] font-medium text-ink-muted hover:text-ink transition-colors"
                    >
                        Cancel
                    </button>
                </div>

                {loadError ? (
                    <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                        <span>Couldn't load roles — {loadError}</span>
                    </div>
                ) : roles === null ? (
                    <div className="flex items-center gap-2 text-xs text-ink-muted">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Loading roles…
                    </div>
                ) : roles.length === 0 ? (
                    <p className="text-xs text-ink-muted">No bindable roles in this workspace.</p>
                ) : (
                    <>
                        <div>
                            <label className="text-[10px] uppercase tracking-wider font-bold text-ink-muted block mb-1">
                                Role
                            </label>
                            <div className="flex flex-wrap gap-1.5">
                                {roles.map(r => (
                                    <button
                                        key={r.name}
                                        type="button"
                                        onClick={() => setSelectedRole(r.name)}
                                        disabled={submitting}
                                        className={cn(
                                            'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors',
                                            selectedRole === r.name
                                                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                                                : 'bg-canvas-elevated text-ink-secondary border-glass-border hover:border-emerald-500/30',
                                        )}
                                    >
                                        {selectedRole === r.name && <Check className="w-3 h-3" />}
                                        {r.name}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div>
                            <label className="text-[10px] uppercase tracking-wider font-bold text-ink-muted block mb-1">
                                Why do you need this? <span className="normal-case font-normal opacity-70">(optional)</span>
                            </label>
                            <textarea
                                value={justification}
                                onChange={e => setJustification(e.target.value)}
                                disabled={submitting}
                                rows={2}
                                placeholder="Helps the admin decide quickly."
                                className="w-full text-xs px-2.5 py-1.5 rounded-lg bg-canvas-elevated border border-glass-border focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/30 outline-none resize-none"
                            />
                        </div>

                        <div className="flex items-center gap-2 justify-end">
                            <button
                                onClick={onClose}
                                disabled={submitting}
                                className="text-xs font-semibold px-3 py-1.5 rounded-lg text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                Not now
                            </button>
                            <button
                                onClick={handleSubmit}
                                disabled={submitting || !selectedRole}
                                className={cn(
                                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors',
                                    'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/20',
                                    'disabled:opacity-50 disabled:cursor-not-allowed',
                                )}
                            >
                                {submitting
                                    ? <Loader2 className="w-3 h-3 animate-spin" />
                                    : <Send className="w-3 h-3" />}
                                Submit request
                            </button>
                        </div>
                    </>
                )}
            </div>
        </motion.div>
    )
}
