/**
 * Find a workspace — every workspace you could ask to join, and where you
 * stand with each.
 *
 * A summary banner (how many there are, which are yours, what you've asked
 * for), a search and a filter, then a card per workspace: what it is for,
 * how many people and data sources it has, who answers its requests, how
 * people get in — and the one thing to do: Open it, see where your request
 * is, or Request access.
 *
 * Behind the Find a workspace switch; the Workspaces page only offers the
 * tab while it is on.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
    AlertTriangle, ArrowRight, Boxes, Clock, Database, EyeOff, KeyRound, Search, Send, ShieldCheck, Users,
} from 'lucide-react'

import { StatTile } from '@/components/explorer/ExplorerStatsBar'
import { PersonChip } from '@/components/ui/PersonChip'
import { Segmented } from '@/components/ui/Segmented'
import { RequestAccessDialog } from '@/components/access/RequestAccessDialog'
import { STATUS_META, idpInstruction, roleLabel } from '@/components/access/accessRequestCopy'
import { useWorkspaceDirectory } from '@/hooks/useWorkspaceAccess'
import type { WorkspaceDirectoryEntry } from '@/services/workspaceService'
import { timeAgo } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'

type Filter = 'all' | 'available' | 'yours' | 'requested'

const FILTERS: Record<Filter, (e: WorkspaceDirectoryEntry) => boolean> = {
    all: () => true,
    available: e => !e.canOpen && !e.openRequest,
    yours: e => e.canOpen,
    requested: e => !!e.openRequest,
}

export function WorkspaceDirectory() {
    const { entries, isLoading, error, refetch } = useWorkspaceDirectory()
    const [query, setQuery] = useState('')
    const [filter, setFilter] = useState<Filter>('all')
    const [asking, setAsking] = useState<WorkspaceDirectoryEntry | null>(null)

    const all = useMemo(() => entries ?? [], [entries])
    const counts = useMemo(
        () => Object.fromEntries(
            (Object.keys(FILTERS) as Filter[]).map(f => [f, all.filter(FILTERS[f]).length]),
        ) as Record<Filter, number>,
        [all],
    )
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase()
        return all.filter(FILTERS[filter]).filter(e =>
            !q || e.name.toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q),
        )
    }, [all, filter, query])

    if (error) {
        return (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 flex items-center gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                <p className="text-sm text-ink-muted flex-1">Couldn’t load the workspaces you can ask to join. {error.message}</p>
                <button type="button" onClick={() => void refetch()} className="text-xs font-semibold text-amber-600 dark:text-amber-400 hover:underline">
                    Retry
                </button>
            </div>
        )
    }

    return (
        <div className="space-y-5">
            <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
                <div className="h-1 w-full bg-gradient-to-r from-emerald-500 via-teal-500 to-sky-500" />
                <div className="p-5 grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatTile
                        icon={Boxes}
                        iconClass="bg-indigo-500/10 text-indigo-500 border-indigo-500/20"
                        label="Workspaces"
                        value={counts.all}
                        loading={isLoading}
                        onClick={() => setFilter('all')}
                    />
                    <StatTile
                        icon={Send}
                        iconClass="bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                        label="Not yours yet"
                        value={counts.available}
                        loading={isLoading}
                        onClick={() => setFilter('available')}
                    />
                    <StatTile
                        icon={ShieldCheck}
                        iconClass="bg-sky-500/10 text-sky-500 border-sky-500/20"
                        label="Yours"
                        value={counts.yours}
                        loading={isLoading}
                        onClick={() => setFilter('yours')}
                    />
                    <StatTile
                        icon={Clock}
                        iconClass="bg-amber-500/10 text-amber-500 border-amber-500/20"
                        label="Requested"
                        value={counts.requested}
                        loading={isLoading}
                        highlight={counts.requested > 0}
                        onClick={() => setFilter('requested')}
                    />
                </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <label className="relative flex-1">
                    <span className="sr-only">Search workspaces</span>
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" aria-hidden />
                    <input
                        type="search"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search by name or what it’s for"
                        className="input w-full pl-9 py-2 text-sm"
                    />
                </label>
                <Segmented
                    label="Show"
                    value={filter}
                    onChange={setFilter}
                    options={[
                        { value: 'all', label: 'All', count: counts.all },
                        { value: 'available', label: 'Not yours yet', count: counts.available },
                        { value: 'yours', label: 'Yours', count: counts.yours },
                        { value: 'requested', label: 'Requested', count: counts.requested },
                    ]}
                />
            </div>

            {isLoading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="h-56 rounded-2xl border border-glass-border bg-canvas-elevated animate-pulse" />
                    ))}
                </div>
            ) : shown.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-glass-border rounded-2xl text-center px-6">
                    <Boxes className="w-10 h-10 text-ink-muted mb-3" />
                    <h3 className="text-base font-bold text-ink">
                        {all.length === 0 ? 'No workspaces are listed yet' : 'Nothing matches'}
                    </h3>
                    <p className="text-sm text-ink-muted mt-1 max-w-md">
                        {all.length === 0
                            ? 'When workspaces are listed here you can ask to join them. Until then, ask a colleague for a link to theirs.'
                            : 'Try another search, or show all workspaces.'}
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {shown.map((entry, i) => (
                        <div key={entry.id} className="ws-card-stagger" style={{ animationDelay: `${Math.min(i * 40, 300)}ms` }}>
                            <DirectoryCard entry={entry} onAsk={() => setAsking(entry)} />
                        </div>
                    ))}
                </div>
            )}

            {asking && (
                <RequestAccessDialog
                    workspaceId={asking.id}
                    workspaceName={asking.name}
                    accessMode={asking.accessMode}
                    accessNote={asking.accessNote}
                    heldRoles={asking.yourRoles}
                    onClose={() => setAsking(null)}
                />
            )}
        </div>
    )
}

function DirectoryCard({ entry, onAsk }: { entry: WorkspaceDirectoryEntry; onAsk: () => void }) {
    const idp = entry.accessMode === 'idp'
    const request = entry.openRequest
    const extra = entry.approverCount - entry.approverIds.length
    return (
        <article className="group h-full flex flex-col rounded-2xl border border-glass-border bg-canvas-elevated p-5 transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5 hover:border-emerald-500/30">
            <header className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white font-bold flex items-center justify-center shrink-0 shadow-md shadow-indigo-500/20">
                    {entry.name.slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-base font-bold text-ink truncate" title={entry.name}>{entry.name}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                            idp
                                ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20'
                                : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
                        )}>
                            {idp ? <KeyRound className="w-2.5 h-2.5" /> : <ShieldCheck className="w-2.5 h-2.5" />}
                            {idp ? 'Through your identity provider' : 'Approved in the app'}
                        </span>
                        {!entry.directoryListed && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-slate-500/20 bg-slate-500/10 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:text-slate-400">
                                <EyeOff className="w-2.5 h-2.5" /> Hidden from this list
                            </span>
                        )}
                    </div>
                </div>
            </header>

            <p className={cn('mt-3 text-sm line-clamp-2', entry.description ? 'text-ink-secondary' : 'text-ink-muted italic')}>
                {entry.description || 'No description yet.'}
            </p>

            <dl className="mt-3 flex items-center gap-4 text-xs text-ink-muted">
                <div className="flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5" aria-hidden />
                    <dt className="sr-only">People</dt>
                    <dd><span className="font-semibold text-ink tabular-nums">{entry.peopleCount}</span> {entry.peopleCount === 1 ? 'person' : 'people'}</dd>
                </div>
                <div className="flex items-center gap-1.5">
                    <Database className="w-3.5 h-3.5" aria-hidden />
                    <dt className="sr-only">Data sources</dt>
                    <dd><span className="font-semibold text-ink tabular-nums">{entry.dataSourceCount}</span> {entry.dataSourceCount === 1 ? 'data source' : 'data sources'}</dd>
                </div>
            </dl>

            <div className="mt-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Answered by</p>
                {entry.approverIds.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        {entry.approverIds.map(id => <PersonChip key={id} id={id} size="xs" link={false} />)}
                        {extra > 0 && <span className="text-[11px] text-ink-muted">+{extra} more</span>}
                    </div>
                ) : (
                    <p className="mt-1 text-xs text-ink-muted">Your organization’s admins</p>
                )}
            </div>

            {entry.accessNote && (
                <p className="mt-3 rounded-lg bg-sky-500/[0.05] border border-sky-500/15 px-2.5 py-1.5 text-[11px] text-ink-secondary line-clamp-2" title={entry.accessNote}>
                    {entry.accessNote}
                </p>
            )}

            <footer className="mt-auto pt-4">
                {entry.canOpen ? (
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-ink-muted truncate">
                            {entry.yourRoles.length > 0
                                ? `You’re ${entry.yourRoles.map(roleLabel).join(', ')}`
                                : 'You can open it'}
                        </span>
                        <Link
                            to={`/workspaces/${entry.id}`}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 hover:bg-indigo-500/15"
                        >
                            Open <ArrowRight className="w-3.5 h-3.5" />
                        </Link>
                    </div>
                ) : request ? (
                    <RequestState request={request} />
                ) : (
                    <button
                        type="button"
                        onClick={onAsk}
                        className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-md shadow-emerald-500/20 hover:shadow-lg transition-shadow"
                    >
                        <Send className="w-4 h-4" /> Request access
                    </button>
                )}
            </footer>
        </article>
    )
}

function RequestState({ request }: { request: NonNullable<WorkspaceDirectoryEntry['openRequest']> }) {
    const meta = STATUS_META[request.status]
    const Icon = meta.icon
    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
                <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold', meta.pill)}>
                    <Icon className="w-3 h-3" /> {meta.label}
                </span>
                <Link to="/my/access" className="text-[11px] font-semibold text-ink-muted hover:text-ink hover:underline">
                    Follow it
                </Link>
            </div>
            <p className="text-[11px] text-ink-muted">
                {request.status === 'awaiting_idp' && request.idpGroup
                    ? idpInstruction(request.idpGroup)
                    : `You asked for ${roleLabel(request.requestedRole)} ${timeAgo(request.createdAt)}.`}
            </p>
        </div>
    )
}
