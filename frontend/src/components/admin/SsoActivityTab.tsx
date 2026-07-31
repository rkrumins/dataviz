/**
 * SSO activity — the bridge between "it didn't work" and the reason.
 *
 * Every SSO failure sends the user to a deliberately generic login page:
 * telling them whether the assertion expired, the claim mapping resolved no
 * email, or JIT is disabled would leak configuration to anyone who can reach
 * /login. The reason IS recorded — it just had no reader, so debugging meant
 * SSH and grep.
 *
 * The page now shows the user a short ``ref``. Paste it here and the real
 * reason is one row away.
 *
 * This is a lens over the existing ``/admin/audit`` endpoint (category=sso),
 * not a new store: the summary builders, severities and cursor pagination
 * already exist there. Mirrors AdminAudit's hand-rolled useCallback + effect,
 * which is the house pattern for audit tables.
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, RefreshCw, Search, ShieldAlert } from 'lucide-react'

import { auditService, type AuditEvent } from '@/services/auditService'
import { ReasonHint } from './sso/tabs/diagnostics/ReasonHint'
import { usePermission } from '@/store/auth'
import { cn } from '@/lib/utils'

type Window = '24h' | '7d' | '30d' | 'all'

const WINDOW_LABELS: Record<Window, string> = {
    '24h': 'Last 24 hours',
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
    all: 'All time',
}

function windowStart(w: Window): string | undefined {
    if (w === 'all') return undefined
    const hours = w === '24h' ? 24 : w === '7d' ? 24 * 7 : 24 * 30
    return new Date(Date.now() - hours * 3600_000).toISOString()
}

/** Severity as a labelled pill rather than coloured prose. Hue alone is
 *  not a signal for everyone, and a wall of amber sentences is harder to
 *  scan than a column of short tags beside plain text. */
const SEVERITY_PILL: Record<string, { label: string; cls: string }> = {
    critical: {
        label: 'Critical',
        cls: 'bg-red-500/15 text-red-600 dark:text-red-400',
    },
    warning: {
        label: 'Warning',
        cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    },
    info: {
        label: 'Info',
        cls: 'bg-black/[0.06] dark:bg-white/[0.10] text-ink-muted',
    },
}

export function SsoActivityTab() {
    // AdminSso as a page is gated on system:admin, which does NOT imply
    // audit access — the two are separate grants, so this tab checks its own.
    const canReadAudit = usePermission('system:audit:read')

    const [events, setEvents] = useState<AuditEvent[]>([])
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    // Starts true so the effect-driven first load needs no synchronous
    // setState — only the Refresh button (an event handler) raises it again.
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [win, setWin] = useState<Window>('7d')
    const [refQuery, setRefQuery] = useState('')
    const [appliedRef, setAppliedRef] = useState('')

    const filters = useMemo(() => ({
        category: 'sso' as const,
        fromTs: windowStart(win),
        limit: 50,
    }), [win])

    // Promise-chain rather than an awaited call, so no state is set
    // synchronously in the effect body. ``reloadToken`` is what the Refresh
    // button bumps; the cancel flag drops a response that lost the race to a
    // filter change.
    const [reloadToken, setReloadToken] = useState(0)

    useEffect(() => {
        if (!canReadAudit) return
        let cancelled = false
        auditService.list(filters)
            .then((resp) => {
                if (cancelled) return
                setEvents(resp.events)
                setNextCursor(resp.nextCursor ?? null)
                setError(null)
            })
            .catch((err: Error) => {
                if (!cancelled) setError(err.message)
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => { cancelled = true }
    }, [filters, canReadAudit, reloadToken])

    function refresh() {
        setLoading(true)
        setReloadToken((n) => n + 1)
    }

    async function loadMore() {
        if (!nextCursor) return
        setLoadingMore(true)
        try {
            const resp = await auditService.list({ ...filters, cursor: nextCursor })
            setEvents((prev) => [...prev, ...resp.events])
            setNextCursor(resp.nextCursor ?? null)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setLoadingMore(false)
        }
    }

    // Filtering by ref happens client-side on purpose. The backend applies
    // payload predicates after the page is sliced, so a server-side ref
    // filter would return under-filled pages that look like "not found".
    // Matching within what we've loaded is honest about its scope.
    const visible = useMemo(() => {
        const q = appliedRef.trim().toLowerCase()
        if (!q) return events
        return events.filter((e) =>
            String(e.payload?.ref ?? '').toLowerCase().includes(q)
            || e.summary.toLowerCase().includes(q),
        )
    }, [events, appliedRef])

    if (!canReadAudit) {
        return (
            <div className="flex items-start gap-3 p-5 rounded-xl border border-amber-500/25 bg-amber-500/[0.05]">
                <div className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center shrink-0">
                    <ShieldAlert className="w-4 h-4 text-amber-500" />
                </div>
                <div>
                    <p className="text-sm font-bold text-ink">Audit access required</p>
                    <p className="mt-1 text-xs text-ink-muted leading-relaxed">
                        Sign-in history is part of the audit log, which is a
                        separate grant from SSO administration. Ask for{' '}
                        <span className="font-mono">system:audit:read</span>.
                    </p>
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-4">
            {error && (
                <div className="flex items-start gap-2 p-4 rounded-xl border border-red-500/25 bg-red-500/[0.05] text-red-500 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-sm font-bold text-ink">Sign-in activity</h2>
                    <p className="text-xs text-ink-muted mt-1 max-w-2xl leading-relaxed">
                        Provider and mapping changes, identity links, and every
                        sign-in outcome. A user who hit an error was shown a
                        reference — search it here.
                    </p>
                </div>
                <button
                    onClick={refresh}
                    disabled={loading}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-glass-border bg-canvas-elevated text-sm font-medium text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                >
                    <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
                    Refresh
                </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" />
                    <input
                        value={refQuery}
                        onChange={(e) => setRefQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') setAppliedRef(refQuery)
                        }}
                        onBlur={() => setAppliedRef(refQuery)}
                        placeholder="reference from the error page, e.g. a1b2c3d4"
                        aria-label="Search by reference"
                        className="pl-9 pr-3 h-10 w-80 rounded-xl bg-canvas border border-glass-border font-mono text-sm outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                    />
                </div>
                <div
                    role="tablist"
                    aria-label="Time window"
                    className="inline-flex p-1 rounded-xl bg-black/[0.04] dark:bg-white/[0.06]"
                >
                    {(Object.keys(WINDOW_LABELS) as Window[]).map((w) => (
                        <button
                            key={w}
                            role="tab"
                            aria-selected={win === w}
                            onClick={() => setWin(w)}
                            className={cn(
                                'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150',
                                win === w
                                    ? 'bg-canvas-elevated text-ink shadow-sm'
                                    : 'text-ink-muted hover:text-ink',
                            )}
                        >
                            {WINDOW_LABELS[w]}
                        </button>
                    ))}
                </div>
            </div>

            {/* The table lives in a card like every other Admin surface, and
                scrolls inside it — a long reference or a wide summary must
                not make the page scroll sideways. */}
            <div className="rounded-xl border border-glass-border bg-canvas-elevated overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-ink-muted bg-black/[0.02] dark:bg-white/[0.03]">
                                <th className="px-4 py-2.5 w-44 font-semibold">When</th>
                                <th className="px-4 py-2.5 w-24 font-semibold">Ref</th>
                                <th className="px-4 py-2.5 w-24 font-semibold">Severity</th>
                                <th className="px-4 py-2.5 font-semibold">What happened</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-glass-border">
                            {visible.map((e) => {
                                const pill = SEVERITY_PILL[e.severity] ?? SEVERITY_PILL.info
                                return (
                                    <tr
                                        key={e.eventId}
                                        className="align-top hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
                                    >
                                        <td className="px-4 py-3 text-xs text-ink-muted whitespace-nowrap">
                                            {new Date(e.createdAt).toLocaleString()}
                                        </td>
                                        <td className="px-4 py-3 font-mono text-[11px] text-ink-secondary">
                                            {String(e.payload?.ref ?? '') || '—'}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className={cn(
                                                'inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold',
                                                pill.cls,
                                            )}>
                                                {pill.label}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-sm text-ink">
                                            {e.summary}
                                            {/* The code is precise and opaque.
                                                Explain it on the row rather
                                                than sending the reader to an
                                                article mid-incident. */}
                                            <ReasonHint summary={e.summary} />
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>

                {!loading && visible.length === 0 && (
                    <div className="flex flex-col items-center text-center py-10 px-4">
                        <div className="w-10 h-10 rounded-full bg-black/[0.04] dark:bg-white/[0.05] flex items-center justify-center mb-3">
                            <Search className="w-4 h-4 text-ink-muted" />
                        </div>
                        <p className="text-[13px] text-ink-muted max-w-sm">
                            {appliedRef
                                ? `Nothing matching “${appliedRef}” in ${WINDOW_LABELS[win].toLowerCase()}. Try a wider window.`
                                : 'No SSO activity in this window.'}
                        </p>
                    </div>
                )}
            </div>

            {nextCursor && (
                <button
                    onClick={() => { void loadMore() }}
                    disabled={loadingMore}
                    className="w-full py-2.5 rounded-xl border border-glass-border bg-canvas-elevated text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                >
                    {loadingMore ? 'Loading…' : 'Load more'}
                </button>
            )}
        </div>
    )
}
