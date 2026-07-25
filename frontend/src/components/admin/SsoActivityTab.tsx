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

const SEVERITY_STYLES: Record<string, string> = {
    critical: 'text-red-400',
    warning: 'text-yellow-400',
    info: 'text-ink-muted',
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
            <div className="flex items-start gap-2 p-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 text-yellow-300 text-sm">
                <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                    <p className="font-medium">Audit access required</p>
                    <p className="mt-1 text-yellow-300/80">
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
                <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">Sign-in activity</h2>
                    <p className="text-xs text-ink-muted mt-0.5">
                        Provider and mapping changes, identity links, and every
                        sign-in outcome. A user who hit an error was shown a
                        reference — search it here.
                    </p>
                </div>
                <button
                    onClick={refresh}
                    disabled={loading}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-white/10 text-xs text-ink-muted hover:bg-white/5 disabled:opacity-50"
                >
                    <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
                    Refresh
                </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                    <input
                        value={refQuery}
                        onChange={(e) => setRefQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') setAppliedRef(refQuery)
                        }}
                        onBlur={() => setAppliedRef(refQuery)}
                        placeholder="reference from the error page, e.g. a1b2c3d4"
                        aria-label="Search by reference"
                        className="pl-7 pr-2 py-1.5 w-72 rounded bg-canvas border border-white/10 font-mono text-xs"
                    />
                </div>
                {(Object.keys(WINDOW_LABELS) as Window[]).map((w) => (
                    <button
                        key={w}
                        onClick={() => setWin(w)}
                        className={cn(
                            'px-2.5 py-1 rounded-full border text-[11px]',
                            win === w
                                ? 'border-accent-lineage/50 text-accent-lineage bg-accent-lineage/10'
                                : 'border-white/10 text-ink-muted hover:bg-white/5',
                        )}
                    >
                        {WINDOW_LABELS[w]}
                    </button>
                ))}
            </div>

            <table className="w-full text-sm">
                <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-ink-muted">
                        <th className="py-2 w-44">When</th>
                        <th className="w-24">Ref</th>
                        <th>What happened</th>
                    </tr>
                </thead>
                <tbody>
                    {visible.map((e) => (
                        <tr key={e.eventId} className="border-t border-white/10 align-top">
                            <td className="py-2 text-xs text-ink-muted whitespace-nowrap">
                                {new Date(e.createdAt).toLocaleString()}
                            </td>
                            <td className="py-2 font-mono text-[11px]">
                                {String(e.payload?.ref ?? '') || '—'}
                            </td>
                            <td className={cn('py-2', SEVERITY_STYLES[e.severity] ?? '')}>
                                {e.summary}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {!loading && visible.length === 0 && (
                <p className="text-sm text-ink-muted py-6 text-center">
                    {appliedRef
                        ? `No sign-in event matching "${appliedRef}" in ${WINDOW_LABELS[win].toLowerCase()}. Try a wider window.`
                        : 'No SSO activity in this window.'}
                </p>
            )}

            {nextCursor && (
                <button
                    onClick={() => { void loadMore() }}
                    disabled={loadingMore}
                    className="w-full py-2 rounded-lg border border-white/10 text-xs text-ink-muted hover:bg-white/5 disabled:opacity-50"
                >
                    {loadingMore ? 'Loading…' : 'Load more'}
                </button>
            )}
        </div>
    )
}
