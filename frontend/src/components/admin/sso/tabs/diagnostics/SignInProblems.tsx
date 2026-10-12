/**
 * Sign-in problems — who could not sign in, why, and whether they have since.
 *
 * One row per person, not per attempt: an operator is asked about a person,
 * and twenty identical failures are one problem. Grouping, counting and the
 * person search all run on the server over a bounded read, so the page
 * costs the same however large the audit trail grows.
 *
 * People still failing come first — they are the ones waiting on someone.
 * A row opens onto everything recorded about their attempts: the reason in
 * words, the detail behind it, where each attempt came from, and why their
 * session ended before it, which is usually why they were signing in at all.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import {
    AlertTriangle, ChevronDown, ChevronRight, Loader2, RefreshCw, Search,
    ShieldCheck, UserSearch, UserX,
} from 'lucide-react'

import {
    ssoAdminService,
    type FailureAttempt,
    type FailureDigest,
    type PersonFailures,
} from '@/services/ssoAdminService'
import { Segmented } from '@/components/ui/Segmented'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { formatUtc, timeAgo } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'
import { SsoCard, SsoEmpty } from '../../ui/SsoCard'
import { SsoListSkeleton } from '../../ui/SsoSkeleton'
import { ErrorBanner } from '../ErrorBanner'
import { explainReason } from './ReasonHint'

type Window = '24h' | '7d' | '30d'

const WINDOWS: { value: Window; label: string }[] = [
    { value: '24h', label: '24 hours' },
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
]

const WINDOW_HOURS: Record<Window, number> = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 }

/** Password sign-ins have no connection; the digest groups them here. */
const PASSWORD = 'password'

function viaLabel(slug: string, name?: string | null): string {
    if (slug === PASSWORD) return 'Password'
    return name || slug
}

function whoLabel(p: PersonFailures): string {
    if (p.kind === 'unidentified') return 'Unidentified browsers'
    return p.name || p.email || p.userId || '—'
}

function Chip({ active, onClick, children, title }: {
    active: boolean
    onClick: () => void
    children: React.ReactNode
    title?: string
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            title={title}
            className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] transition-colors',
                active
                    ? 'border-indigo-500/40 bg-indigo-500/10 text-ink'
                    : 'border-glass-border bg-canvas text-ink-secondary hover:text-ink',
            )}
        >
            {children}
        </button>
    )
}

function Stat({ label, value, tone }: {
    label: string
    value: number | string
    tone?: 'danger' | 'muted'
}) {
    return (
        <div className="rounded-xl border border-glass-border bg-canvas px-4 py-3">
            <p className={cn(
                'text-xl font-bold tabular-nums',
                tone === 'danger' ? 'text-red-500' : 'text-ink',
            )}>
                {value}
            </p>
            <p className="text-[11px] text-ink-muted mt-0.5">{label}</p>
        </div>
    )
}

function StatePill({ person }: { person: PersonFailures }) {
    if (person.kind === 'unidentified') {
        return <span className="text-[11px] text-ink-muted">—</span>
    }
    if (person.kind === 'no_account') {
        return (
            <span className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-400">
                No account
            </span>
        )
    }
    if (person.stillFailing) {
        return (
            <span className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/15 text-red-600 dark:text-red-400">
                Still failing
            </span>
        )
    }
    return (
        <span
            className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            title={formatUtc(person.lastSignInAt)}
        >
            Signed in {person.lastSignInAt ? timeAgo(person.lastSignInAt) : 'since'}
        </span>
    )
}

/** The code in words, with what to do about it. */
function Explained({ code }: { code: string }) {
    const r = explainReason(code)
    if (!r) return null
    return (
        <p className="text-[11px] text-ink-muted leading-relaxed">
            {r.what}{' '}
            <span className="text-ink-secondary">{r.next}</span>
        </p>
    )
}

function shortAgent(agent?: string | null): string {
    if (!agent) return ''
    const m = agent.match(/(Edg|Firefox|Chrome|Safari)\/[\d.]+/)
    return m ? m[0] : agent.slice(0, 40)
}

/** One attempt, on lines that wrap rather than a table that scrolls. */
function AttemptLine({ attempt: a, names, explain = false }: {
    attempt: FailureAttempt
    names: Record<string, string | null | undefined>
    explain?: boolean
}) {
    return (
        <li>
            <p className="text-xs text-ink break-words">
                <span className="text-ink-muted" title={formatUtc(a.at)}>{timeAgo(a.at)}</span>
                {' · '}{viaLabel(a.provider, a.providerName ?? names[a.provider])}
                {' · '}<span className="font-mono break-all">{a.code}</span>
                {a.detail && <>{' · '}<span className="font-mono text-ink-secondary break-all">{a.detail}</span></>}
                {a.ref && <>{' · ref '}<span className="font-mono">{a.ref}</span></>}
            </p>
            {(a.clientIp || a.userAgent) && (
                <p className="text-[11px] text-ink-muted break-words" title={a.userAgent ?? undefined}>
                    from {a.clientIp || 'an unrecorded address'}
                    {a.userAgent && ` · ${shortAgent(a.userAgent)}`}
                </p>
            )}
            {explain && <Explained code={a.code} />}
        </li>
    )
}

function PersonDetail({ person, onInspect, providerNames }: {
    person: PersonFailures
    onInspect?: (email: string) => void
    providerNames: Record<string, string | null | undefined>
}) {
    return (
        <div className="grid lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)] gap-6 px-4 py-4 bg-black/[0.015] dark:bg-white/[0.02]">
            <div className="space-y-3">
                <dl className="space-y-2 text-xs">
                    {person.kind === 'account' && (
                        <>
                            <div>
                                <dt className="text-ink-muted">Account</dt>
                                <dd className="text-ink">
                                    {person.status ?? '—'}
                                    {person.deleted && ' · deleted'}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-ink-muted">Password</dt>
                                <dd className="text-ink">
                                    {person.passwordSet
                                        ? 'Set'
                                        : person.waysIn.length
                                            ? `None — signs in only through ${person.waysIn.map(w => w.name || w.slug).join(', ')}`
                                            : 'None, and no linked sign-in either'}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-ink-muted">Last successful sign-in</dt>
                                <dd className="text-ink">
                                    {person.lastSignInAt
                                        ? `${formatUtc(person.lastSignInAt)} (${timeAgo(person.lastSignInAt)})`
                                        : 'Never recorded'}
                                </dd>
                            </div>
                        </>
                    )}
                    {person.kind === 'no_account' && (
                        <div>
                            <dt className="text-ink-muted">Account</dt>
                            <dd className="text-ink">No account uses this address.</dd>
                        </div>
                    )}
                    {person.externalId && (
                        <div>
                            <dt className="text-ink-muted">Provider subject</dt>
                            <dd className="font-mono text-[11px] text-ink break-all">{person.externalId}</dd>
                        </div>
                    )}
                    <div>
                        <dt className="text-ink-muted">Attempts</dt>
                        <dd className="text-ink">
                            {person.attempts} between {formatUtc(person.firstAt)} and {formatUtc(person.lastAt)},
                            from {person.clients || 'an unrecorded number of'} network address{person.clients === 1 ? '' : 'es'}
                        </dd>
                    </div>
                </dl>
                {person.email && onInspect && (
                    <button
                        type="button"
                        onClick={() => onInspect(person.email!)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-glass-border bg-canvas-elevated text-xs font-medium text-ink hover:bg-black/5 dark:hover:bg-white/5"
                    >
                        <UserSearch className="w-3.5 h-3.5" />
                        Open account
                    </button>
                )}
            </div>

            <div className="space-y-4 min-w-0">
                <section>
                    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-2">Why</h4>
                    <ul className="space-y-2">
                        {person.reasons.map(r => (
                            <li key={r.code}>
                                <p className="text-xs text-ink">
                                    <span className="font-mono break-all">{r.code}</span>
                                    <span className="text-ink-muted"> × {r.count}</span>
                                </p>
                                <Explained code={r.code} />
                            </li>
                        ))}
                    </ul>
                </section>

                {person.sessionEnds.length > 0 && (
                    <section>
                        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-2">
                            Session ended before this
                        </h4>
                        <ul className="space-y-2">
                            {person.sessionEnds.map(e => (
                                <li key={`${e.at}-${e.reason}`}>
                                    <p className="text-xs text-ink">
                                        <span className="text-ink-muted">{formatUtc(e.at)} · </span>
                                        <span className="font-mono break-all">{e.reason}</span>
                                        {e.provider && <span className="text-ink-muted"> · {viaLabel(e.provider, providerNames[e.provider])}</span>}
                                    </p>
                                    <Explained code={e.reason} />
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {person.related.length > 0 && (
                    <section>
                        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1">
                            Just before, from the same browser
                        </h4>
                        <p className="text-[11px] text-ink-muted mb-2">
                            Failed before anyone could be named — same network
                            address and browser, so probably them, though an office
                            can share an address.
                        </p>
                        <ul className="space-y-2">
                            {person.related.map((a, i) => (
                                <AttemptLine
                                    key={`${a.at}-${i}`} attempt={a} names={providerNames}
                                    // Each code explained once, at its first line.
                                    explain={person.related.findIndex(x => x.code === a.code) === i}
                                />
                            ))}
                        </ul>
                    </section>
                )}

                <section>
                    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-2">
                        Recent attempts
                    </h4>
                    <ul className="space-y-2">
                        {person.recent.map((a, i) => (
                            <AttemptLine key={`${a.at}-${i}`} attempt={a} names={providerNames} />
                        ))}
                    </ul>
                </section>
            </div>
        </div>
    )
}

export function SignInProblems({ onInspect }: {
    /** Open this person in the account lookup. */
    onInspect?: (email: string) => void
}) {
    const [win, setWin] = useState<Window>('7d')
    const [reason, setReason] = useState<string | null>(null)
    const [provider, setProvider] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const [appliedSearch, setAppliedSearch] = useState('')
    const [data, setData] = useState<FailureDigest | null>(null)
    // Starts true so the first load sets no state synchronously in the
    // effect; filter changes raise it from their own handlers.
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [open, setOpen] = useState<string | null>(null)
    const [reloadToken, setReloadToken] = useState(0)

    // Typing settles before it searches.
    useEffect(() => {
        const t = setTimeout(() => {
            if (search.trim() !== appliedSearch) {
                setLoading(true)
                setAppliedSearch(search.trim())
            }
        }, 350)
        return () => clearTimeout(t)
    }, [search, appliedSearch])

    // Promise chain, so nothing is set synchronously in the effect body;
    // ``reloadToken`` is what Refresh bumps, and the window's start is
    // recomputed on every load.
    useEffect(() => {
        let cancelled = false
        ssoAdminService.failureDigest({
            fromTs: new Date(Date.now() - WINDOW_HOURS[win] * 3600_000).toISOString(),
            reason: reason ?? undefined,
            provider: provider ?? undefined,
            q: appliedSearch || undefined,
        })
            .then(d => {
                if (cancelled) return
                setData(d)
                setError(null)
            })
            .catch((err: Error) => { if (!cancelled) setError(err.message) })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [win, reason, provider, appliedSearch, reloadToken])

    const change = (fn: () => void) => { setLoading(true); setOpen(null); fn() }

    const people = data?.people ?? []
    const providerNames = useMemo(
        () => Object.fromEntries((data?.providers ?? []).map(p => [p.slug, p.name])),
        [data],
    )

    return (
        <SsoCard
            icon={AlertTriangle}
            title="Sign-in problems"
            blurb="Everyone who could not sign in, grouped by person: why, how often, and whether they have got in since."
            actions={
                <button
                    type="button"
                    onClick={() => change(() => setReloadToken(n => n + 1))}
                    disabled={loading}
                    aria-label="Refresh sign-in problems"
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-glass-border bg-canvas-elevated text-xs font-medium text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                >
                    <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
                    Refresh
                </button>
            }
        >
            <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                    <Segmented
                        label="Time window"
                        options={WINDOWS}
                        value={win}
                        onChange={v => change(() => setWin(v))}
                    />
                    <div className="relative flex-1 min-w-[14rem] max-w-md">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" />
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Find a person — name, email, id"
                            aria-label="Find a person in sign-in problems"
                            className="w-full pl-9 pr-3 h-9 rounded-xl bg-canvas border border-glass-border text-sm outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                        />
                    </div>
                    {loading && data && <Loader2 className="w-4 h-4 animate-spin text-ink-muted" />}
                </div>

                {error && <ErrorBanner message={error} />}

                {data && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <Stat label="Failed attempts" value={data.totals.attempts} />
                        <Stat label="People affected" value={data.totals.people} />
                        <Stat
                            label="Still failing"
                            value={data.totals.stillFailing}
                            tone={data.totals.stillFailing ? 'danger' : undefined}
                        />
                        <Stat label="Attempts nobody could be named for" value={data.totals.unidentified} />
                    </div>
                )}

                {data && (data.reasons.length > 0 || data.providers.length > 0) && (
                    <div className="space-y-2">
                        {data.reasons.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by reason">
                                <span className="text-[11px] text-ink-muted mr-1">Reason</span>
                                {data.reasons.map(r => (
                                    <Chip
                                        key={r.code}
                                        active={reason === r.code}
                                        title={explainReason(r.code)?.what}
                                        onClick={() => change(() => setReason(reason === r.code ? null : r.code))}
                                    >
                                        <span className="font-mono break-all">{r.code}</span>
                                        <span className="text-ink-muted tabular-nums">{r.count}</span>
                                    </Chip>
                                ))}
                            </div>
                        )}
                        {data.providers.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by sign-in method">
                                <span className="text-[11px] text-ink-muted mr-1">Via</span>
                                {data.providers.map(p => (
                                    <Chip
                                        key={p.slug}
                                        active={provider === p.slug}
                                        onClick={() => change(() => setProvider(provider === p.slug ? null : p.slug))}
                                    >
                                        {viaLabel(p.slug, p.name)}
                                        <span className="text-ink-muted tabular-nums">{p.count}</span>
                                    </Chip>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {data?.window.truncated && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">
                        Showing the most recent {data.window.scanned.toLocaleString()} records in
                        this window. Narrow the window, or find the person by name, to see past them.
                    </p>
                )}

                {!data && loading && <SsoListSkeleton rows={3} />}

                {data && people.length === 0 && !loading && (
                    <SsoEmpty icon={appliedSearch || reason || provider ? UserX : ShieldCheck}>
                        {appliedSearch || reason || provider
                            ? 'Nobody matches these filters in this window.'
                            : 'No failed sign-ins in this window.'}
                    </SsoEmpty>
                )}

                {people.length > 0 && (
                    <div className="rounded-xl border border-glass-border bg-canvas-elevated overflow-hidden">
                        <div className="overflow-x-auto">
                            {/* Fixed layout: the columns share the card's width and
                                long codes wrap, so an opened row's details fit
                                the card instead of scrolling off beside it. */}
                            <table className="w-full min-w-[44rem] table-fixed text-sm">
                                <colgroup>
                                    <col className="w-8" />
                                    <col className="w-[22%]" />
                                    <col className="w-[12%]" />
                                    <col />
                                    <col className="w-20" />
                                    <col className="w-24" />
                                    <col className="w-28" />
                                </colgroup>
                                <thead>
                                    <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-ink-muted bg-black/[0.02] dark:bg-white/[0.03]">
                                        <th />
                                        <th className="px-3 py-2.5 font-semibold">Person</th>
                                        <th className="px-3 py-2.5 font-semibold">Via</th>
                                        <th className="px-3 py-2.5 font-semibold">Latest problem</th>
                                        <th className="px-3 py-2.5 font-semibold text-right">Attempts</th>
                                        <th className="px-3 py-2.5 font-semibold">Last attempt</th>
                                        <th className="px-3 py-2.5 font-semibold">State</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-glass-border">
                                    {people.map(p => {
                                        const expanded = open === p.key
                                        return (
                                            <Fragment key={p.key}>
                                                <tr
                                                    onClick={() => setOpen(expanded ? null : p.key)}
                                                    className="align-top cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                                >
                                                    <td className="pl-3 py-3">
                                                        <button
                                                            type="button"
                                                            aria-expanded={expanded}
                                                            aria-label={`${expanded ? 'Hide' : 'Show'} details for ${whoLabel(p)}`}
                                                            onClick={e => { e.stopPropagation(); setOpen(expanded ? null : p.key) }}
                                                            className="text-ink-muted hover:text-ink"
                                                        >
                                                            {expanded
                                                                ? <ChevronDown className="w-4 h-4" />
                                                                : <ChevronRight className="w-4 h-4" />}
                                                        </button>
                                                    </td>
                                                    <td className="px-3 py-3">
                                                        <div className="flex items-center gap-2.5">
                                                            {p.kind === 'account' ? (
                                                                <UserAvatar
                                                                    userId={p.userId}
                                                                    name={whoLabel(p)}
                                                                    avatarId={p.avatarId}
                                                                    className="w-7 h-7 text-[10px]"
                                                                />
                                                            ) : (
                                                                <div className="w-7 h-7 rounded-full bg-black/[0.05] dark:bg-white/[0.06] flex items-center justify-center">
                                                                    <UserX className="w-3.5 h-3.5 text-ink-muted" />
                                                                </div>
                                                            )}
                                                            <div className="min-w-0">
                                                                <p className="text-sm text-ink truncate">{whoLabel(p)}</p>
                                                                <p className="text-[11px] text-ink-muted truncate">
                                                                    {p.kind === 'unidentified'
                                                                        ? `${p.clients || 'unknown'} network address${p.clients === 1 ? '' : 'es'}`
                                                                        : (p.name ? p.email : null) ?? (p.kind === 'no_account' ? 'no account' : '')}
                                                                </p>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="px-3 py-3 text-xs text-ink-secondary break-words">
                                                        {viaLabel(p.latest.provider, p.latest.providerName)}
                                                    </td>
                                                    <td className="px-3 py-3">
                                                        <p className="font-mono text-[11px] text-ink break-all">{p.latest.code}</p>
                                                        <p className="text-[11px] text-ink-muted line-clamp-2">
                                                            {explainReason(p.latest.code)?.what ?? p.latest.detail ?? ''}
                                                        </p>
                                                        {p.related.length > 0 && (
                                                            <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400 break-words">
                                                                After a failed {viaLabel(p.related[0].provider, providerNames[p.related[0].provider])}{' '}
                                                                sign-in from the same browser
                                                            </p>
                                                        )}
                                                    </td>
                                                    <td className="px-3 py-3 text-right tabular-nums text-ink">{p.attempts}</td>
                                                    <td className="px-3 py-3 text-xs text-ink-muted whitespace-nowrap" title={formatUtc(p.lastAt)}>
                                                        {timeAgo(p.lastAt)}
                                                    </td>
                                                    <td className="px-3 py-3"><StatePill person={p} /></td>
                                                </tr>
                                                {expanded && (
                                                    <tr>
                                                        <td colSpan={7} className="p-0">
                                                            <PersonDetail person={p} onInspect={onInspect} providerNames={providerNames} />
                                                        </td>
                                                    </tr>
                                                )}
                                            </Fragment>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>
        </SsoCard>
    )
}
