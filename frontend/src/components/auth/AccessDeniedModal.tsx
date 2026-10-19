/**
 * Global access-denied notice — listens for ``'auth:access-denied'``
 * events dispatched by ``fetchWithTimeout`` on every 403 and surfaces
 * them as a non-blocking floating card.
 *
 * Mounted once in ``AppLayout`` so every authenticated route inherits
 * the behaviour. The card matches the notification visual language (rounded
 * panel, layered border, accent-coloured icon box).
 *
 * Phase 4.3 — when the failing path is workspace-scoped (the URL
 * contains a ``ws_xxx`` segment), the card surfaces a "Request
 * access" primary action that opens Request access — the same guided
 * dialog Find a workspace uses. A refused edit in a view shared
 * read-only preselects the level that edits.
 */
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import {
    ShieldAlert, ChevronDown, X, Send, Eye,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { RequestAccessDialog } from '@/components/access/RequestAccessDialog'
import { VIEW_QUERY_KEY } from '@/hooks/useViewMetadata'
import type { View } from '@/services/viewApiService'
import { MOTION } from '@/lib/motion'


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



/** Plain-language for the permissions users actually hit. The raw
 *  ``Missing permission: workspace:datasource:read`` is accurate and
 *  useless to the person reading it — it names our internal grammar,
 *  not what they were trying to do. The permission id stays available
 *  under "Details". */
const PERMISSION_COPY: Record<string, string> = {
    'workspace:datasource:read': "You don't have access to this workspace's data.",
    'workspace:datasource:manage': 'Changing data in this workspace needs edit access.',
    'workspace:view:edit': 'Editing views in this workspace needs edit access.',
    'workspace:view:publish': 'Publishing views to everyone needs the "Publish views" permission.',
    'workspace:view:delete': 'Deleting views in this workspace needs delete access.',
    'workspace:admin': 'This action is limited to workspace admins.',
}

function permissionFrom(detail: string | null): string | null {
    if (!detail) return null
    const m = detail.match(/([a-z]+:[a-z-]+(?::[a-z-]+)*)/i)
    return m ? m[1] : null
}


export function AccessDeniedModal() {
    const [event, setEvent] = useState<DenialEvent | null>(null)
    const location = useLocation()
    const queryClient = useQueryClient()
    const [showDetails, setShowDetails] = useState(false)
    /** Request access, open on its own: the card goes, the dialog stays. */
    const [asking, setAsking] = useState<{ wsId: string; edit: boolean } | null>(null)

    useEffect(() => {
        function onDenied(e: Event) {
            const ce = e as CustomEvent<DenialEvent>
            setEvent(ce.detail)
            setShowDetails(false)
        }
        window.addEventListener('auth:access-denied', onDenied)
        return () => window.removeEventListener('auth:access-denied', onDenied)
    }, [])

    // Auto-dismiss after 6 s. Pause when the user expands details.
    useEffect(() => {
        if (!event) return
        if (showDetails) return
        const t = setTimeout(() => setEvent(null), 6_000)
        return () => clearTimeout(t)
    }, [event, showDetails])

    // Is the caller sitting in a view that was SHARED with them (read-only
    // reach)? Then the denial isn't a fault to fix — it's the expected
    // shape of their access, and the card should say so instead of
    // reciting a permission id. Read from the cached view rather than new
    // state: the open view is already in React Query under ['view', id].
    const readOnlyShare = useMemo(() => {
        const m = location.pathname.match(/^\/views\/([^/]+)/)
        if (!m) return null
        const cached = queryClient.getQueryData<View>([...VIEW_QUERY_KEY, m[1]])
        if (cached?.access?.dataAccess !== 'readonly') return null
        return cached
    }, [location.pathname, queryClient, event])

    const permission = event ? permissionFrom(event.detail) : null

    const headline = readOnlyShare ? 'Read-only view' : 'Access denied'
    const sharedFrom = readOnlyShare?.workspaceName
        ? ` from ${readOnlyShare.workspaceName}`
        : ''
    const headlineMessage = !event
        ? ''
        : readOnlyShare
            ? `You're exploring a view shared with you${sharedFrom}. Everything here is read-only — changing anything needs access to the workspace.`
            : (permission ? PERMISSION_COPY[permission] : undefined)
                ?? event.detail
                ?? `Access denied (HTTP ${event.status})`

    const wsId = useMemo(
        () => (event ? extractWorkspaceId(event.path) : null),
        [event],
    )

    return (
        <>
        {asking && (
            <RequestAccessDialog
                workspaceId={asking.wsId}
                defaultRole={asking.edit ? 'workspace_member' : undefined}
                onClose={() => setAsking(null)}
            />
        )}
        <AnimatePresence>
            {event && (
                <motion.div
                    role="alertdialog"
                    aria-live="assertive"
                    initial={{ opacity: 0, y: 12, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.96 }}
                    transition={MOTION.modalSpring}
                    className={cn(
                        'fixed bottom-6 left-1/2 -translate-x-1/2 z-[80]',
                        'w-[min(440px,calc(100vw-2rem))] pointer-events-auto',
                        'bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg shadow-black/15 dark:shadow-black/40',
                        'overflow-hidden',
                    )}
                >
                    <div className="flex items-start gap-3 px-4 py-3.5">
                        <div className={cn(
                            'w-9 h-9 rounded-lg border flex items-center justify-center shrink-0',
                            readOnlyShare
                                ? 'border-sky-500/20 bg-sky-500/10'
                                : 'border-amber-500/20 bg-amber-500/10',
                        )}>
                            {readOnlyShare
                                ? <Eye className="w-4 h-4 text-sky-500" />
                                : <ShieldAlert className="w-4 h-4 text-amber-500" />}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-ink leading-snug">{headline}</p>
                            <p className="text-xs text-ink-secondary mt-0.5 leading-snug break-words">{headlineMessage}</p>

                            {wsId && (
                                <button
                                    onClick={() => {
                                        setAsking({ wsId, edit: !!readOnlyShare })
                                        setEvent(null)
                                    }}
                                    className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/15 transition-colors"
                                >
                                    <Send className="w-3 h-3" />
                                    {readOnlyShare ? 'Request edit access' : 'Request access'}
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

                    {/* Auto-dismiss progress bar — hidden while details
                        are expanded */}
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
        </>
    )
}

