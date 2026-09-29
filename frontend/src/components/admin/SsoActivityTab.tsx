/**
 * SSO activity — every sign-in, failure, session ending and change on the
 * SSO surface, as a table an operator can filter.
 *
 * Built for hundreds of people signing in a day, so everything that
 * narrows the list runs on the server (`GET /admin/sso/activity`): the
 * outcome, the connection, the window, and one search box that finds a
 * person, an email, a reference someone quoted, or a network address.
 * Pages come back full whatever is filtered, and "Load more" continues
 * from where the last one ended.
 *
 * Who, through what, what happened, why, the reference and where from are
 * columns — they were buried in a sentence and a raw payload before. A row
 * still opens onto the whole record.
 */
import { Fragment, useEffect, useState } from 'react'
import {
    AlertCircle, ChevronDown, ChevronRight, Copy, RefreshCw, Search, ShieldAlert,
} from 'lucide-react'

import {
    ssoAdminService,
    type ActivityOutcome,
    type ActivityPage,
    type ActivityParams,
    type ActivityPerson,
    type ActivityRow,
} from '@/services/ssoAdminService'
import { Segmented } from '@/components/ui/Segmented'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { usePermission } from '@/store/auth'
import { formatUtc, timeAgo } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'
import { explainReason } from './sso/tabs/diagnostics/ReasonHint'

type Window = '24h' | '7d' | '30d' | 'all'

const WINDOWS: { value: Window; label: string }[] = [
    { value: '24h', label: '24 hours' },
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: 'all', label: 'All time' },
]

function windowStart(w: Window): string | undefined {
    if (w === 'all') return undefined
    const hours = w === '24h' ? 24 : w === '7d' ? 24 * 7 : 24 * 30
    return new Date(Date.now() - hours * 3600_000).toISOString()
}

/** Each outcome's label, and the pill it wears in the table. Labelled, not
 *  colour alone: hue is not a signal for everyone. */
const OUTCOME: Record<ActivityOutcome, { label: string; chip: string; pill: string }> = {
    signed_in: {
        label: 'Signed in', chip: 'Sign-ins',
        pill: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    },
    failed: {
        label: 'Failed', chip: 'Failures',
        pill: 'bg-red-500/15 text-red-600 dark:text-red-400',
    },
    session_ended: {
        label: 'Session ended', chip: 'Session ends',
        pill: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    },
    signed_out: {
        label: 'Signed out', chip: 'Sign-outs',
        pill: 'bg-black/[0.06] dark:bg-white/[0.10] text-ink-muted',
    },
    account: {
        label: 'Account', chip: 'Account links',
        pill: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
    },
    trust: {
        label: 'Unverified', chip: 'Unverified logins',
        pill: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    },
    config: {
        label: 'Config', chip: 'Config changes',
        pill: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
    },
}

const OUTCOME_ORDER = Object.keys(OUTCOME) as ActivityOutcome[]

function shortAgent(agent?: string | null): string {
    if (!agent) return ''
    const m = agent.match(/(Edg|Firefox|Chrome|Safari)\/[\d.]+/)
    return m ? m[0] : agent.slice(0, 32)
}

/** A machine code that may wrap after its separators, never mid-word. */
function Code({ text }: { text: string }) {
    const parts = text.split(/(?<=[_:=.])/)
    return <>{parts.map((part, i) => <Fragment key={i}>{part}<wbr /></Fragment>)}</>
}

function personLabel(p?: ActivityPerson | null): string {
    return p?.name || p?.email || p?.userId || ''
}

/** Payload fields shown by name in an opened row, above the raw record. */
const DETAIL_FIELDS: { key: string; label: string }[] = [
    { key: 'email', label: 'Email' },
    { key: 'external_id', label: 'Provider subject' },
    { key: 'reason', label: 'Reason' },
    { key: 'detail', label: 'Detail' },
    { key: 'status', label: 'Account status' },
    { key: 'client_ip', label: 'Network address' },
    { key: 'user_agent', label: 'Browser' },
    { key: 'path', label: 'Endpoint' },
]

function RowDetail({ row }: { row: ActivityRow }) {
    const p = row.payload ?? {}
    const fields = DETAIL_FIELDS
        .map(f => ({ ...f, value: p[f.key] }))
        .filter(f => f.value !== undefined && f.value !== null && f.value !== '')
    const explained = row.reason ? explainReason(row.reason) : null
    return (
        <div className="px-4 py-3 space-y-3 bg-black/[0.015] dark:bg-white/[0.02]">
            <p className="text-xs text-ink">{row.summary}</p>
            {explained && (
                <p className="text-[11px] text-ink-muted leading-relaxed">
                    {explained.what}{' '}
                    <span className="text-ink-secondary">{explained.next}</span>
                </p>
            )}
            <dl className="grid sm:grid-cols-[10rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
                {row.person && (
                    <>
                        <dt className="text-ink-muted">Account</dt>
                        <dd className="text-ink">
                            {personLabel(row.person)}
                            {row.person.name && row.person.email && (
                                <span className="text-ink-muted"> · {row.person.email}</span>
                            )}
                            {row.person.deleted && <span className="text-ink-muted"> · deleted</span>}
                        </dd>
                    </>
                )}
                {row.actor && (
                    <>
                        <dt className="text-ink-muted">Done by</dt>
                        <dd className="text-ink">{personLabel(row.actor)}</dd>
                    </>
                )}
                {fields.map(f => (
                    <Fragment key={f.key}>
                        <dt className="text-ink-muted">{f.label}</dt>
                        <dd className="font-mono text-[11px] text-ink break-all">{String(f.value)}</dd>
                    </Fragment>
                ))}
                <dt className="text-ink-muted">Event</dt>
                <dd className="font-mono text-[11px] text-ink-secondary">{row.eventType} · {row.id}</dd>
            </dl>
            <details>
                <summary className="text-[11px] text-ink-muted cursor-pointer">Raw event payload</summary>
                <pre className="mt-2 p-3 rounded-lg bg-canvas border border-glass-border text-[11px] overflow-x-auto">
                    {JSON.stringify(p, null, 2)}
                </pre>
            </details>
        </div>
    )
}

export function SsoActivityTab({ connections = [], initialQuery = '' }: {
    /** The connections to offer as a filter. */
    connections?: { slug: string; displayName: string }[]
    /** Open with this search applied — a reference someone quoted. */
    initialQuery?: string
}) {
    // AdminSso as a page is gated on system:admin, which does NOT imply
    // audit access — the two are separate grants, so this tab checks its own.
    const canReadAudit = usePermission('system:audit:read')

    const [win, setWin] = useState<Window>('7d')
    const [outcome, setOutcome] = useState<ActivityOutcome | null>(null)
    const [connection, setConnection] = useState('')
    const [search, setSearch] = useState(initialQuery)
    const [applied, setApplied] = useState(initialQuery)
    const [page, setPage] = useState<ActivityPage | null>(null)
    // The query the current page answers — "Load more" continues it.
    const [pageQuery, setPageQuery] = useState<ActivityParams | null>(null)
    // Starts true so the first load sets no state synchronously in the
    // effect; filter changes raise it from their own handlers.
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [openId, setOpenId] = useState<string | null>(null)
    const [reloadToken, setReloadToken] = useState(0)
    const [copied, setCopied] = useState<string | null>(null)

    // Typing settles before it searches.
    useEffect(() => {
        const t = setTimeout(() => {
            if (search.trim() !== applied) {
                setLoading(true)
                setApplied(search.trim())
            }
        }, 350)
        return () => clearTimeout(t)
    }, [search, applied])

    // Promise chain, so nothing is set synchronously in the effect body.
    // The window's start is taken at each load, so Refresh (which bumps
    // ``reloadToken``) also moves the window's end to now.
    useEffect(() => {
        if (!canReadAudit) return
        let cancelled = false
        const query: ActivityParams = {
            fromTs: windowStart(win),
            outcome: outcome ?? undefined,
            connection: connection || undefined,
            q: applied || undefined,
            limit: 50,
        }
        ssoAdminService.activity(query)
            .then(p => {
                if (cancelled) return
                setPage(p)
                setPageQuery(query)
                setError(null)
            })
            .catch((err: Error) => { if (!cancelled) setError(err.message) })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [win, outcome, connection, applied, reloadToken, canReadAudit])

    const change = (fn: () => void) => { setLoading(true); setOpenId(null); fn() }

    async function loadMore() {
        if (!page?.nextCursor || !pageQuery) return
        setLoadingMore(true)
        try {
            const next = await ssoAdminService.activity({ ...pageQuery, cursor: page.nextCursor })
            setPage(prev => prev && {
                ...next, rows: [...prev.rows, ...next.rows], counts: prev.counts,
            })
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setLoadingMore(false)
        }
    }

    function copyRef(ref: string) {
        void navigator.clipboard?.writeText(ref).then(() => {
            setCopied(ref)
            setTimeout(() => setCopied(c => (c === ref ? null : c)), 1500)
        }).catch(() => {})
    }

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

    const rows = page?.rows ?? []
    const counts = page?.counts
    const total = counts ? OUTCOME_ORDER.reduce((n, o) => n + counts[o], 0) : 0
    const shownOf = counts ? (outcome ? counts[outcome] : total) : 0

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-sm font-bold text-ink">Sign-in activity</h2>
                    <p className="text-xs text-ink-muted mt-1 max-w-2xl leading-relaxed">
                        Every sign-in, failure, session ending and SSO change. Search
                        by person, email, the reference someone was shown, or a
                        network address.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => change(() => setReloadToken(n => n + 1))}
                    disabled={loading}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-glass-border bg-canvas-elevated text-sm font-medium text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                >
                    <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
                    Refresh
                </button>
            </div>

            {error && (
                <div className="flex items-start gap-2 p-4 rounded-xl border border-red-500/25 bg-red-500/[0.05] text-red-500 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[16rem] max-w-lg">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" />
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Person, email, reference or address"
                        aria-label="Search activity"
                        className="w-full pl-9 pr-3 h-10 rounded-xl bg-canvas border border-glass-border text-sm outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                    />
                </div>
                <select
                    value={connection}
                    onChange={e => change(() => setConnection(e.target.value))}
                    aria-label="Connection"
                    className="h-10 px-3 rounded-xl bg-canvas border border-glass-border text-sm text-ink outline-none focus:border-indigo-500"
                >
                    <option value="">Every connection</option>
                    <option value="password">Password</option>
                    {connections.map(c => (
                        <option key={c.slug} value={c.slug}>{c.displayName}</option>
                    ))}
                </select>
                <Segmented
                    label="Time window"
                    options={WINDOWS}
                    value={win}
                    onChange={v => change(() => setWin(v))}
                />
            </div>

            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by outcome">
                <button
                    type="button"
                    aria-pressed={outcome === null}
                    onClick={() => change(() => setOutcome(null))}
                    className={cn(
                        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] transition-colors',
                        outcome === null
                            ? 'border-indigo-500/40 bg-indigo-500/10 text-ink'
                            : 'border-glass-border bg-canvas text-ink-secondary hover:text-ink',
                    )}
                >
                    Everything
                    {counts && <span className="text-ink-muted tabular-nums">{total.toLocaleString()}</span>}
                </button>
                {OUTCOME_ORDER.map(o => (
                    <button
                        key={o}
                        type="button"
                        aria-pressed={outcome === o}
                        onClick={() => change(() => setOutcome(outcome === o ? null : o))}
                        className={cn(
                            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] transition-colors',
                            outcome === o
                                ? 'border-indigo-500/40 bg-indigo-500/10 text-ink'
                                : 'border-glass-border bg-canvas text-ink-secondary hover:text-ink',
                            o === 'failed' && counts && counts.failed > 0 && outcome !== o
                                && 'border-red-500/30',
                        )}
                    >
                        {OUTCOME[o].chip}
                        {counts && (
                            <span className={cn(
                                'tabular-nums',
                                o === 'failed' && counts.failed > 0 ? 'text-red-500' : 'text-ink-muted',
                            )}>
                                {counts[o].toLocaleString()}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {/* A card, like every other Admin surface, scrolling inside
                itself; fixed column widths so codes wrap rather than push
                an opened row off the side. */}
            <div className="rounded-xl border border-glass-border bg-canvas-elevated overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[60rem] table-fixed text-sm">
                        <colgroup>
                            <col className="w-8" />
                            <col className="w-28" />
                            <col className="w-[20%]" />
                            <col className="w-[13%]" />
                            <col className="w-28" />
                            <col />
                            <col className="w-24" />
                            <col className="w-[14%]" />
                        </colgroup>
                        <thead>
                            <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-ink-muted bg-black/[0.02] dark:bg-white/[0.03]">
                                <th />
                                <th className="px-3 py-2.5 font-semibold">When</th>
                                <th className="px-3 py-2.5 font-semibold">Person</th>
                                <th className="px-3 py-2.5 font-semibold">Via</th>
                                <th className="px-3 py-2.5 font-semibold">Outcome</th>
                                <th className="px-3 py-2.5 font-semibold">Reason</th>
                                <th className="px-3 py-2.5 font-semibold">Ref</th>
                                <th className="px-3 py-2.5 font-semibold">From</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-glass-border">
                            {rows.map(r => {
                                const expanded = openId === r.id
                                const who = r.person ?? r.actor
                                return (
                                    <Fragment key={r.id}>
                                        <tr
                                            onClick={() => setOpenId(expanded ? null : r.id)}
                                            className="align-top cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
                                        >
                                            <td className="pl-3 py-3">
                                                <button
                                                    type="button"
                                                    aria-expanded={expanded}
                                                    aria-label={expanded ? 'Hide details' : 'Show details'}
                                                    onClick={ev => { ev.stopPropagation(); setOpenId(expanded ? null : r.id) }}
                                                    className="text-ink-muted hover:text-ink"
                                                >
                                                    {expanded
                                                        ? <ChevronDown className="w-4 h-4" />
                                                        : <ChevronRight className="w-4 h-4" />}
                                                </button>
                                            </td>
                                            <td className="px-3 py-3 text-xs text-ink-muted" title={formatUtc(r.at)}>
                                                {timeAgo(r.at)}
                                            </td>
                                            <td className="px-3 py-3">
                                                {who ? (
                                                    <button
                                                        type="button"
                                                        onClick={ev => {
                                                            ev.stopPropagation()
                                                            setSearch(who.email || who.userId || '')
                                                        }}
                                                        title="Show only this person"
                                                        className="flex items-center gap-2 min-w-0 max-w-full text-left group"
                                                    >
                                                        <UserAvatar
                                                            userId={who.userId}
                                                            name={personLabel(who)}
                                                            avatarId={who.avatarId}
                                                            className="w-6 h-6 text-[9px] shrink-0"
                                                        />
                                                        <span className="min-w-0">
                                                            <span className="block text-sm text-ink truncate group-hover:underline">
                                                                {personLabel(who)}
                                                            </span>
                                                            {!r.person && r.actor ? (
                                                                <span className="block text-[11px] text-ink-muted truncate">admin</span>
                                                            ) : who.name && who.email ? (
                                                                <span className="block text-[11px] text-ink-muted truncate">{who.email}</span>
                                                            ) : null}
                                                        </span>
                                                    </button>
                                                ) : (
                                                    <span className="text-xs text-ink-muted">Not identified</span>
                                                )}
                                            </td>
                                            <td className="px-3 py-3 text-xs text-ink-secondary break-words">
                                                {r.connection ? (
                                                    <button
                                                        type="button"
                                                        onClick={ev => {
                                                            ev.stopPropagation()
                                                            change(() => setConnection(r.connection!.slug))
                                                        }}
                                                        title="Show only this connection"
                                                        className="hover:underline text-left"
                                                    >
                                                        {r.connection.name || r.connection.slug}
                                                    </button>
                                                ) : '—'}
                                            </td>
                                            <td className="px-3 py-3">
                                                <span className={cn(
                                                    'inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-semibold',
                                                    OUTCOME[r.outcome].pill,
                                                )}>
                                                    {OUTCOME[r.outcome].label}
                                                </span>
                                            </td>
                                            <td className="px-3 py-3">
                                                {r.reason ? (
                                                    <>
                                                        <p className="font-mono text-[11px] text-ink break-words"><Code text={r.reason} /></p>
                                                        {r.detail && (
                                                            <p className="font-mono text-[11px] text-ink-muted break-words"><Code text={r.detail} /></p>
                                                        )}
                                                    </>
                                                ) : r.outcome === 'signed_in' || r.outcome === 'signed_out' ? (
                                                    // Who, via and the outcome already say it all.
                                                    <span className="text-ink-muted">—</span>
                                                ) : (
                                                    <p className="text-xs text-ink-secondary line-clamp-2">{r.summary}</p>
                                                )}
                                            </td>
                                            <td className="px-3 py-3">
                                                {r.ref ? (
                                                    <button
                                                        type="button"
                                                        onClick={ev => { ev.stopPropagation(); copyRef(r.ref!) }}
                                                        title="Copy the reference"
                                                        className="inline-flex items-center gap-1 font-mono text-[11px] text-ink hover:text-indigo-500"
                                                    >
                                                        {copied === r.ref ? 'copied' : r.ref}
                                                        <Copy className="w-3 h-3 opacity-60" />
                                                    </button>
                                                ) : <span className="text-ink-muted">—</span>}
                                            </td>
                                            <td className="px-3 py-3 text-[11px] text-ink-secondary" title={r.userAgent ?? undefined}>
                                                {r.clientIp || r.userAgent ? (
                                                    <>
                                                        <span className="block font-mono truncate">{r.clientIp || '—'}</span>
                                                        {r.userAgent && (
                                                            <span className="block text-ink-muted truncate">{shortAgent(r.userAgent)}</span>
                                                        )}
                                                    </>
                                                ) : <span className="text-ink-muted">—</span>}
                                            </td>
                                        </tr>
                                        {expanded && (
                                            <tr>
                                                <td colSpan={8} className="p-0">
                                                    <RowDetail row={r} />
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                )
                            })}
                        </tbody>
                    </table>
                </div>

                {!loading && page && rows.length === 0 && (
                    <div className="flex flex-col items-center text-center py-10 px-4">
                        <div className="w-10 h-10 rounded-full bg-black/[0.04] dark:bg-white/[0.05] flex items-center justify-center mb-3">
                            <Search className="w-4 h-4 text-ink-muted" />
                        </div>
                        <p className="text-[13px] text-ink-muted max-w-sm">
                            {applied || outcome || connection
                                ? 'Nothing matches these filters in this window. Try a wider window.'
                                : 'No SSO activity in this window.'}
                        </p>
                    </div>
                )}
            </div>

            {page && rows.length > 0 && (
                <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] text-ink-muted">
                        Showing {rows.length.toLocaleString()} of {shownOf.toLocaleString()}
                    </p>
                    {page.nextCursor && (
                        <button
                            type="button"
                            onClick={() => { void loadMore() }}
                            disabled={loadingMore}
                            className="px-4 py-2 rounded-xl border border-glass-border bg-canvas-elevated text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                        >
                            {loadingMore ? 'Loading…' : 'Load more'}
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}
