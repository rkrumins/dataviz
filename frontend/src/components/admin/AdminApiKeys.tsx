/**
 * AdminApiKeys — every API key on the platform, and who it acts as.
 *
 * For the questions an administrator brings to a credential inventory: how
 * many keys are live, which expire this week or never, which nobody has used
 * in months, whose they are and what they can reach — and how do I stop one,
 * or all of one person's, now. Ending a person's sessions does not touch
 * their keys, which is why revoking all of theirs sits beside every key here.
 *
 * The cards are filters: each count is a question, and clicking it asks it.
 * The owner filter arrives from a person's record (`?ownerId=`), read once
 * from `window.location` rather than through the router, like AdminUsers —
 * the page has never needed a Router to render, and its tests rely on that.
 *
 * Auditors (`system:audit:read`) see the inventory; revoking needs
 * `system:users:manage`, as the server enforces.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Download, Hourglass, Infinity as InfinityIcon,
    KeySquare, MoonStar, PauseCircle, RefreshCw, Search, Trash2, UserX, X,
} from 'lucide-react'

import { KeyDetailDrawer } from '@/components/apiKeys/KeyDetailDrawer'
import { RevokeKeyDialog } from '@/components/apiKeys/RevokeKeyDialog'
import { describePermissions, describeResources } from '@/components/apiKeys/apiKeyFormat'
import { ExpiryFact, KeyStatusBadge } from '@/components/apiKeys/parts'
import { PageContainer } from '@/components/layout/PageContainer'
import { Button, IconButton } from '@/components/ui/Button'
import { DateTime } from '@/components/ui/DateTime'
import { EmptyState } from '@/components/ui/EmptyState'
import { HoverTip } from '@/components/ui/HoverTip'
import { PersonChip } from '@/components/ui/PersonChip'
import { Skeleton } from '@/components/ui/Skeleton'
import { Sparkline } from '@/components/ui/Sparkline'
import { TablePagination } from '@/components/ui/TablePagination'
import { useAppNotifications } from '@/components/ui/notifications'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { cn } from '@/lib/utils'
import {
    apiKeyService,
    type AdminApiKey,
    type AdminApiKeyStats,
    type AdminKeyFocus,
    type AdminKeySort,
    type AdminKeyStatus,
    type KeyRef,
} from '@/services/apiKeyService'
import { usePermission } from '@/store/auth'

const PAGE_SIZE = 25

type Tab = AdminKeyStatus | 'all'

const TABS: { value: Tab; label: string; count: (s: AdminApiKeyStats) => number }[] = [
    { value: 'active', label: 'Active', count: (s) => s.byStatus.active },
    { value: 'paused', label: 'Paused', count: (s) => s.byStatus.paused },
    { value: 'owner_inactive', label: 'Owner suspended', count: (s) => s.byStatus.ownerInactive },
    { value: 'expired', label: 'Expired', count: (s) => s.byStatus.expired },
    { value: 'revoked', label: 'Revoked', count: (s) => s.byStatus.revoked },
    { value: 'all', label: 'All', count: (s) => s.total },
]

/** Each card is a question; clicking it asks it of the list. */
const KPIS: {
    id: 'active' | 'paused' | AdminKeyFocus
    label: string
    hint: string
    icon: typeof KeySquare
    value: (s: AdminApiKeyStats) => number
    tone: { icon: string; on: string; text: string }
}[] = [
    {
        id: 'active', label: 'Active', hint: 'Keys that work right now', icon: CheckCircle2,
        value: (s) => s.byStatus.active,
        tone: { icon: 'bg-emerald-500/10 text-emerald-500', on: 'border-emerald-500 ring-emerald-500/15', text: 'text-emerald-600 dark:text-emerald-400' },
    },
    {
        id: 'expiring_soon', label: 'Expiring within 7 days', hint: 'Live keys that stop this week', icon: Hourglass,
        value: (s) => s.expiringSoon,
        tone: { icon: 'bg-amber-500/10 text-amber-500', on: 'border-amber-500 ring-amber-500/15', text: 'text-amber-600 dark:text-amber-400' },
    },
    {
        id: 'never_expires', label: 'Never expire', hint: 'Live keys with no end date', icon: InfinityIcon,
        value: (s) => s.neverExpires,
        tone: { icon: 'bg-violet-500/10 text-violet-500', on: 'border-violet-500 ring-violet-500/15', text: 'text-violet-600 dark:text-violet-400' },
    },
    {
        id: 'unused', label: 'Unused for 90 days', hint: 'Live keys nothing has called lately', icon: MoonStar,
        value: (s) => s.unused90,
        tone: { icon: 'bg-slate-500/10 text-slate-500', on: 'border-slate-500 ring-slate-500/15', text: 'text-ink' },
    },
    {
        id: 'paused', label: 'Paused', hint: 'Waiting for their owner to sign in again', icon: PauseCircle,
        value: (s) => s.byStatus.paused,
        tone: { icon: 'bg-amber-500/10 text-amber-500', on: 'border-amber-500 ring-amber-500/15', text: 'text-amber-600 dark:text-amber-400' },
    },
]

const FOCUS_LABEL: Record<AdminKeyFocus, string> = {
    expiring_soon: 'Expiring within 7 days',
    never_expires: 'Never expire',
    unused: 'Unused for 90 days',
    recently_revoked: 'Revoked in the last 30 days',
}

export function AdminApiKeys() {
    const { notify } = useAppNotifications()
    const canRevoke = usePermission('system:users:manage')

    // `?ownerId=` is a person's record linking to their keys. Read once:
    // after that the filter belongs to the administrator.
    const [ownerId, setOwnerId] = useState<string | null>(() => {
        try {
            return new URLSearchParams(window.location.search).get('ownerId')
        } catch {
            return null
        }
    })
    const [tab, setTab] = useState<Tab>('active')
    const [focus, setFocus] = useState<AdminKeyFocus | null>(null)
    const [q, setQ] = useState('')
    const search = useDebouncedValue(q.trim(), 250)
    const [sort, setSort] = useState<AdminKeySort>('created')
    const [order, setOrder] = useState<'asc' | 'desc'>('desc')
    const [page, setPage] = useState(0)
    const [version, setVersion] = useState(0)
    const reload = useCallback(() => setVersion((v) => v + 1), [])

    const [items, setItems] = useState<AdminApiKey[]>([])
    const [total, setTotal] = useState(0)
    const [answered, setAnswered] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [stats, setStats] = useState<AdminApiKeyStats | null>(null)
    const [ownerName, setOwnerName] = useState<string | null>(null)

    const [drawerKey, setDrawerKey] = useState<AdminApiKey | null>(null)
    const closeDrawer = useCallback(() => setDrawerKey(null), [])
    const [revoking, setRevoking] = useState<{ apiKey: AdminApiKey; scope: 'one' | 'all' } | null>(null)

    const filters = useMemo(() => ({
        ownerId: ownerId ?? undefined,
        status: tab === 'all' ? undefined : tab,
        focus: focus ?? undefined,
        q: search || undefined,
        sort,
        order,
    }), [ownerId, tab, focus, search, sort, order])
    const request = JSON.stringify([filters, page, version])
    const loading = answered !== request

    useEffect(() => {
        let live = true
        apiKeyService.adminList({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
            .then((res) => {
                if (!live) return
                setItems(res.items)
                setTotal(res.total)
                setError(null)
                setAnswered(request)
                const owner = res.items.find((k) => k.owner.id === filters.ownerId)?.owner
                if (owner) setOwnerName(owner.displayName)
            })
            .catch((err: unknown) => {
                if (!live) return
                setError(err instanceof Error ? err.message : 'The keys could not be loaded.')
                setAnswered(request)
            })
        return () => { live = false }
    }, [filters, page, request])

    useEffect(() => {
        let live = true
        apiKeyService.adminStats({ ownerId: ownerId ?? undefined, q: search || undefined })
            .then((s) => { if (live) setStats(s) })
            .catch(() => { if (live) setStats(null) })
        return () => { live = false }
    }, [ownerId, search, version])

    const pickKpi = (id: (typeof KPIS)[number]['id']) => {
        setPage(0)
        if (id === 'active' || id === 'paused') {
            setTab(id)
            setFocus(null)
        } else {
            setFocus(focus === id ? null : id)
            setTab('all')
        }
    }
    const kpiOn = (id: (typeof KPIS)[number]['id']) => (id === 'active' || id === 'paused' ? !focus && tab === id : focus === id)

    const handleSort = (field: AdminKeySort) => {
        setPage(0)
        if (sort === field) setOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
        else { setSort(field); setOrder('asc') }
    }

    const openKey = useCallback((ref: KeyRef) => {
        apiKeyService.adminGet(ref.id).then(setDrawerKey).catch(() => notify('error', 'That key could not be loaded.'))
    }, [notify])

    const exportHref = apiKeyService.adminExportUrl(filters)
    const from = total === 0 ? 0 : page * PAGE_SIZE + 1
    const to = Math.min(total, (page + 1) * PAGE_SIZE)

    return (
        <PageContainer gutter="shell" className="py-8 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-md shadow-indigo-500/20 shrink-0">
                        <KeySquare className="w-6 h-6 text-white" aria-hidden />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-2xl font-bold text-ink">API keys</h1>
                        <p className="text-sm text-ink-muted">
                            Every key, who it acts as, what it can reach, and when it was last used.
                        </p>
                    </div>
                </div>
                <Button variant="secondary" size="sm" leftIcon={RefreshCw} onClick={reload} loading={loading} className="border-black/[0.10] dark:border-white/[0.12] shadow-sm">
                    Refresh
                </Button>
            </div>

            <div role="group" aria-label="Key counts" className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
                {KPIS.map((k, i) => {
                    const Icon = k.icon
                    const on = kpiOn(k.id)
                    return (
                        // Five cards in two columns: the first takes a row of its own.
                        <HoverTip key={k.id} label={on ? 'Show every key again' : `Show ${k.label.toLowerCase()} keys`} detail={k.hint} className={cn('block h-full', i === 0 && 'col-span-2 sm:col-span-1')}>
                            <button
                                type="button"
                                aria-pressed={on}
                                onClick={() => pickKpi(k.id)}
                                className={cn(
                                    'w-full h-full flex flex-col items-start text-left rounded-2xl border p-4 bg-canvas-elevated transition-colors duration-150',
                                    on ? cn('ring-4', k.tone.on) : 'border-black/[0.07] dark:border-white/[0.08] hover:border-indigo-500/40',
                                )}
                            >
                                <span className={cn('w-8 h-8 rounded-lg flex items-center justify-center', k.tone.icon)}>
                                    <Icon className="w-4 h-4" aria-hidden />
                                </span>
                                <span className={cn('block mt-auto pt-3 text-2xl font-bold tabular-nums', k.tone.text)}>
                                    {stats ? k.value(stats).toLocaleString() : '—'}
                                </span>
                                {' '}
                                <span className="block mt-0.5 text-xs text-ink-muted">{k.label}</span>
                            </button>
                        </HoverTip>
                    )
                })}
            </div>

            <div role="tablist" aria-label="Status" className="flex w-fit max-w-full gap-1 p-1 rounded-xl bg-black/[0.05] dark:bg-white/[0.05] overflow-x-auto">
                {TABS.map((t) => {
                    const on = tab === t.value
                    return (
                        <button
                            key={t.value}
                            type="button"
                            role="tab"
                            aria-selected={on}
                            onClick={() => { setTab(t.value); setPage(0) }}
                            className={cn(
                                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors duration-150',
                                on ? 'bg-canvas-elevated text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                            )}
                        >
                            {t.label}
                            {stats && (
                                <span className={cn(
                                    'px-1.5 py-0.5 rounded-full text-[10px] font-bold leading-none tabular-nums',
                                    on ? 'bg-accent-lineage/10 text-accent-lineage' : 'bg-black/5 dark:bg-white/10 text-ink-muted',
                                )}>
                                    {t.count(stats).toLocaleString()}
                                </span>
                            )}
                        </button>
                    )
                })}
            </div>

            {error && (
                <div role="alert" className="flex items-start gap-2 p-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] text-rose-700 dark:text-rose-300 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            <div className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-canvas-elevated overflow-hidden shadow-sm">
                <div className="flex flex-wrap items-center gap-2.5 px-4 py-3 border-b border-black/[0.07] dark:border-white/[0.08]">
                    <div className="relative flex-1 min-w-[12rem] max-w-sm">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" />
                        <input
                            aria-label="Search keys"
                            value={q}
                            onChange={(e) => { setQ(e.target.value); setPage(0) }}
                            placeholder="Key name, prefix or owner email"
                            className="w-full h-9 pl-9 pr-8 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas text-sm text-ink placeholder:text-ink-muted outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                        />
                        {q && (
                            <button
                                type="button"
                                onClick={() => { setQ(''); setPage(0) }}
                                aria-label="Clear the search"
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-ink-muted hover:text-ink"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </div>
                    {ownerId && (
                        <FilterChip label={`Keys of ${ownerName ?? ownerId}`} onClear={() => { setOwnerId(null); setOwnerName(null); setPage(0) }} />
                    )}
                    {focus && <FilterChip label={FOCUS_LABEL[focus]} onClear={() => { setFocus(null); setPage(0) }} />}
                    <HoverTip label="Download these keys as CSV" detail="With the filters and order you have set here." className="ml-auto">
                        <a
                            href={exportHref}
                            download
                            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-xl text-xs font-semibold bg-canvas-elevated text-ink border border-black/[0.10] dark:border-white/[0.12] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] shadow-sm transition-colors"
                        >
                            <Download className="w-3.5 h-3.5" aria-hidden />
                            Export CSV
                        </a>
                    </HoverTip>
                </div>
                {items.length === 0 && !loading ? (
                    <EmptyState
                        icon={KeySquare}
                        title="No keys match"
                        description="Nothing on the platform fits these filters. Clear them to see every key."
                        action={{ label: 'Clear filters', onClick: () => { setTab('all'); setFocus(null); setQ(''); setOwnerId(null); setPage(0) } }}
                    />
                ) : items.length === 0 ? (
                    <div className="p-4 space-y-3" aria-busy="true">
                        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)}
                    </div>
                ) : (
                    <>
                        {/* A phone gets cards; the table needs more width than it has. */}
                        <ul className="md:hidden divide-y divide-black/[0.06] dark:divide-white/[0.07]" aria-label="Keys">
                            {items.map((key) => (
                                <li key={key.id}>
                                    <button type="button" onClick={() => setDrawerKey(key)} className="w-full text-left p-4 space-y-3 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                                        <span className="flex items-center gap-2">
                                            <span className="min-w-0 flex-1 text-sm font-semibold text-ink truncate">{key.name}</span>
                                            <KeyStatusBadge apiKey={key} short />
                                        </span>
                                        <span className="flex items-center gap-2">
                                            <PersonChip id={key.owner.id} person={key.owner} size="sm" link={false} />
                                        </span>
                                        <span className="grid grid-cols-2 gap-3">
                                            <span className="text-xs text-ink-secondary tabular-nums">{key.usage.requests30d.toLocaleString()} requests · 30 d</span>
                                            {key.revokedAt
                                                ? <DateTime at={key.revokedAt} prefix="Ended " className="text-xs text-ink-muted" />
                                                : <ExpiryFact expiresAt={key.expiresAt} compact />}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                        <div className="hidden md:block overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead className="bg-black/[0.025] dark:bg-white/[0.03]">
                                    <tr className="text-left border-b border-black/[0.07] dark:border-white/[0.08]">
                                        <SortHeader label="Key" field="name" sort={sort} order={order} onSort={handleSort} />
                                        <th className="px-3 py-3"><HeaderText>Owner</HeaderText></th>
                                        <th className="px-3 py-3">
                                            <HeaderText>Requests</HeaderText>
                                            <span className="block text-[10px] font-medium text-ink-muted normal-case tracking-normal">30 days</span>
                                        </th>
                                        <SortHeader label="Last used" field="lastUsed" sort={sort} order={order} onSort={handleSort} />
                                        <SortHeader label="Expires" field="expires" sort={sort} order={order} onSort={handleSort} />
                                        <SortHeader label="Created" field="created" sort={sort} order={order} onSort={handleSort} className="hidden 2xl:table-cell" />
                                        <th className="px-3 py-3 w-10"><span className="sr-only">Actions</span></th>
                                    </tr>
                                </thead>
                                <tbody className={cn('transition-opacity', loading && 'opacity-60')}>
                                    {items.map((key) => (
                                        <Row
                                            key={key.id}
                                            apiKey={key}
                                            onOpen={() => setDrawerKey(key)}
                                            onRevoke={canRevoke && key.status !== 'revoked' ? () => setRevoking({ apiKey: key, scope: 'one' }) : undefined}
                                        />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
                {total > 0 && (
                    <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-black/[0.07] dark:border-white/[0.08] text-xs text-ink-muted">
                        <span className="tabular-nums">Showing {from}–{to} of {total.toLocaleString()}</span>
                        <TablePagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
                    </div>
                )}
            </div>

            <KeyDetailDrawer
                apiKey={drawerKey}
                variant="admin"
                load={apiKeyService.adminGet}
                layered={revoking !== null}
                onClose={closeDrawer}
                onOpenKey={openKey}
                actions={drawerKey && canRevoke ? (
                    <>
                        <Button variant="ghost" size="sm" leftIcon={UserX} onClick={() => setRevoking({ apiKey: drawerKey, scope: 'all' })} className="mr-auto">
                            Revoke all of theirs…
                        </Button>
                        {drawerKey.status !== 'revoked' && (
                            <Button variant="danger" size="sm" leftIcon={Trash2} onClick={() => setRevoking({ apiKey: drawerKey, scope: 'one' })}>
                                Revoke key…
                            </Button>
                        )}
                    </>
                ) : undefined}
            />

            {revoking && (
                <RevokeKeyDialog
                    apiKey={revoking.apiKey}
                    initialScope={revoking.scope}
                    onClose={() => setRevoking(null)}
                    onRevoked={({ scope, revoked }) => {
                        const { apiKey } = revoking
                        setRevoking(null)
                        setDrawerKey(null)
                        notify('success', scope === 'one'
                            ? `“${apiKey.name}” revoked. Its owner has been told.`
                            : `${revoked} key${revoked === 1 ? '' : 's'} of ${apiKey.owner.displayName} revoked.`)
                        reload()
                    }}
                />
            )}
        </PageContainer>
    )
}

function HeaderText({ children }: { children: React.ReactNode }) {
    return <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted whitespace-nowrap">{children}</span>
}

function SortHeader({ label, field, sort, order, onSort, className }: {
    label: string
    field: AdminKeySort
    sort: AdminKeySort
    order: 'asc' | 'desc'
    onSort: (field: AdminKeySort) => void
    className?: string
}) {
    const active = sort === field
    return (
        <th className={cn('px-3 py-3', className)} aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>
            <button
                type="button"
                onClick={() => onSort(field)}
                className={cn(
                    'flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap transition-colors',
                    active ? 'text-ink' : 'text-ink-muted hover:text-ink-secondary',
                )}
            >
                {label}
                {active && (order === 'asc' ? <ChevronUp className="w-3 h-3" aria-hidden /> : <ChevronDown className="w-3 h-3" aria-hidden />)}
            </button>
        </th>
    )
}

function Row({ apiKey: key, onOpen, onRevoke }: { apiKey: AdminApiKey; onOpen: () => void; onRevoke?: () => void }) {
    return (
        <tr onClick={onOpen} className="border-b border-black/[0.06] dark:border-white/[0.07] last:border-0 align-top cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
            <td className="px-3 py-3.5 max-w-[14rem]">
                <div className="flex items-center gap-2 min-w-0">
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpen() }}
                        className="min-w-0 truncate text-left text-sm font-semibold text-ink hover:text-indigo-600 dark:hover:text-indigo-400 focus-visible:outline-none focus-visible:underline"
                    >
                        {key.name}
                    </button>
                    <KeyStatusBadge apiKey={key} short />
                </div>
                <p className="mt-1 font-mono text-[11px] text-ink-muted truncate">{key.prefix}…</p>
                <p className="text-ink-secondary truncate">
                    {describePermissions(key.permissions)} · {describeResources(key.resources)}
                    {key.allowedCidrs.length > 0 && ` · only from ${key.allowedCidrs.join(', ')}`}
                </p>
            </td>
            <td className="px-3 py-3.5">
                <PersonChip id={key.owner.id} person={key.owner} size="md" showEmail className="max-w-[11rem]" />
            </td>
            <td className="px-3 py-3.5">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ink tabular-nums">{key.usage.requests30d.toLocaleString()}</span>
                    {Math.max(...key.usage.daily14) > 0 && (
                        <Sparkline points={key.usage.daily14} width={40} height={18} tone={key.status === 'active' ? 'indigo' : 'slate'} />
                    )}
                </div>
                {key.usage.refused30d > 0 && (
                    <p className="mt-0.5 text-amber-600 dark:text-amber-400 tabular-nums">{key.usage.refused30d.toLocaleString()} refused</p>
                )}
            </td>
            <td className="px-3 py-3.5">
                <DateTime at={key.lastUsedAt} empty="Never used" className="font-medium text-ink" />
                {key.lastUsedIp && <p className="text-ink-muted font-mono text-[11px]">{key.lastUsedIp}</p>}
            </td>
            <td className="px-3 py-3.5">
                {key.revokedAt
                    ? <DateTime at={key.revokedAt} prefix="Ended " className="text-ink-muted" />
                    : <ExpiryFact expiresAt={key.expiresAt} compact />}
            </td>
            <td className="px-3 py-3.5 hidden 2xl:table-cell text-ink-secondary"><DateTime at={key.createdAt} /></td>
            <td className="px-2 py-3 text-right">
                {onRevoke && (
                    <IconButton
                        icon={Trash2}
                        variant="danger"
                        label={`Revoke “${key.name}”…`}
                        detail="Stop it now, with a note to its owner"
                        onClick={(e) => { e.stopPropagation(); onRevoke() }}
                    />
                )}
            </td>
        </tr>
    )
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
    return (
        <span className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-lg text-xs font-semibold bg-indigo-500/10 text-indigo-700 dark:text-indigo-300">
            {label}
            <button type="button" onClick={onClear} aria-label={`Stop showing only ${label.toLowerCase()}`} className="p-0.5 rounded hover:bg-indigo-500/15">
                <X className="w-3 h-3" />
            </button>
        </span>
    )
}
