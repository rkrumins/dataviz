/**
 * VersionedGraphsPanel — the fleet inventory of versioned graphs.
 *
 * The projection panel shows only its worst eight, and only graphs whose
 * data source is live. This lists every one, by graph id and a page at a
 * time — forks and orphans (whose data source is gone) included — with the
 * FalkorDB provider and key it projects into and whether the platform owns
 * that key. Filters run on the server. Each row can rebuild the graph's
 * cache, check it against Postgres, or open its data source; a fork's row
 * can also move the fork to the trash. A platform copy can be moved to
 * another FalkorDB provider or key, and the old key a move left behind is
 * listed under the key until it is dropped.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Database, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    systemStatusService,
    type GraphProvider,
    type VersionedGraphRow,
    type VersionedGraphsFilter,
} from '@/services/systemStatusService'
import { deleteFork, rebuildProjection, reconcileProjection } from '@/services/versioningApiService'
import { formatSince } from './meta'
import { MoveProjectionDialog } from './MoveProjectionDialog'

const STATUS_OPTIONS: { value: NonNullable<VersionedGraphsFilter['status']>; label: string }[] = [
    { value: 'fresh', label: 'In sync' },
    { value: 'lagging', label: 'Catching up' },
    { value: 'projecting', label: 'Projecting' },
    { value: 'rebuilding', label: 'Rebuilding' },
    { value: 'evicted', label: 'Evicted' },
    { value: 'failed', label: 'Failed' },
]

const KIND_OPTIONS: { value: NonNullable<VersionedGraphsFilter['kind']>; label: string }[] = [
    { value: 'main', label: 'Data source graphs' },
    { value: 'fork', label: 'Forks' },
    { value: 'orphan', label: 'Orphans' },
]

const SELECT_CLS = 'px-2 py-1 rounded-lg border border-glass-border bg-canvas-elevated text-xs text-ink'
const ACTION_CLS = 'px-2 py-0.5 rounded-md border border-glass-border text-[11px] text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed'

type RowNote = { tone: 'ok' | 'warn' | 'bad'; text: string }

const NOTE_CLS: Record<RowNote['tone'], string> = {
    ok: 'text-emerald-600 dark:text-emerald-400',
    warn: 'text-amber-600 dark:text-amber-400',
    bad: 'text-red-600 dark:text-red-400',
}

function stateLabel(row: VersionedGraphRow): string {
    if (row.lastError) return 'failed'
    if (row.status === 'idle') return row.lag > 0 ? 'catching up' : 'in sync'
    return row.status
}

interface Props {
    providers: GraphProvider[] | null
    onClose: () => void
}

export function VersionedGraphsPanel({ providers, onClose }: Props) {
    const navigate = useNavigate()
    const [filter, setFilter] = useState<VersionedGraphsFilter>({})
    const [search, setSearch] = useState('')
    const [busy, setBusy] = useState<string | null>(null)
    const [notes, setNotes] = useState<Record<string, RowNote>>({})
    const [moving, setMoving] = useState<VersionedGraphRow | null>(null)
    const providerName = new Map((providers ?? []).map(p => [p.id, p.name]))

    const query = useInfiniteQuery({
        queryKey: ['admin', 'versioned-graphs', filter],
        queryFn: ({ pageParam }) => systemStatusService.versionedGraphs(filter, pageParam),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
        retry: 1,
        refetchOnWindowFocus: false,
    })
    const rows = query.data?.pages.flatMap(p => p.graphs) ?? []

    const setField = <K extends keyof VersionedGraphsFilter>(key: K, value: VersionedGraphsFilter[K] | '') =>
        setFilter(prev => {
            const next = { ...prev }
            if (value) next[key] = value as VersionedGraphsFilter[K]
            else delete next[key]
            return next
        })

    const act = async (row: VersionedGraphRow, action: 'rebuild' | 'check' | 'delete') => {
        if (action === 'delete' && !window.confirm('Move this fork to the trash? It can be restored for 30 days.')) return
        setBusy(`${row.graphId}:${action}`)
        let note: RowNote
        try {
            if (action === 'rebuild') {
                const res = await rebuildProjection(row.workspaceId, row.graphId)
                note = res.alreadyRunning
                    ? { tone: 'warn', text: 'A rebuild is already running' }
                    : { tone: 'ok', text: 'Rebuild started' }
            } else if (action === 'delete') {
                await deleteFork(row.workspaceId, row.graphId)
                note = { tone: 'ok', text: 'Moved to the trash; restorable for 30 days' }
                void query.refetch()   // the inventory lists live graphs only, so the row drops out
            } else {
                const r = await reconcileProjection(row.workspaceId, row.graphId)
                if (r.skippedReason) note = { tone: 'warn', text: `Not checked: ${r.skippedReason}` }
                else if (r.inSync) note = { tone: 'ok', text: 'In sync with Postgres' }
                else {
                    const missing = r.missingNodes.length + r.missingEdges.length
                    const extra = r.extraNodes.length + r.extraEdges.length
                    const parts = [
                        missing && `${missing} missing`,
                        extra && `${extra} extra`,
                        r.mismatched.length && `${r.mismatched.length} different`,
                    ].filter(Boolean)
                    note = { tone: 'bad', text: `Out of sync: ${parts.join(', ')}` }
                }
            }
        } catch (e) {
            note = { tone: 'bad', text: (e as Error).message }
        }
        setNotes(prev => ({ ...prev, [row.graphId]: note }))
        setBusy(null)
    }

    return (
        <div id="versioned-graphs" className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden">
            <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-indigo-500" />
                    <div>
                        <h2 className="text-sm font-semibold text-ink">Versioned graphs</h2>
                        <p className="text-[11px] text-ink-muted">Every versioned graph, the FalkorDB key it projects into, and its state — forks and orphans included.</p>
                    </div>
                </div>
                <button onClick={onClose} className="p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5" aria-label="Close versioned graphs">
                    <X className="w-4 h-4" />
                </button>
            </div>

            <div className="px-5 pb-3 flex flex-wrap items-center gap-2">
                <select aria-label="Provider" className={SELECT_CLS} value={filter.provider ?? ''} onChange={e => setField('provider', e.target.value)}>
                    <option value="">All providers</option>
                    <option value="default">default</option>
                    {(providers ?? []).filter(p => p.type === 'falkordb').map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </select>
                <select aria-label="Status" className={SELECT_CLS} value={filter.status ?? ''} onChange={e => setField('status', e.target.value as VersionedGraphsFilter['status'] | '')}>
                    <option value="">Any state</option>
                    {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <select aria-label="Kind" className={SELECT_CLS} value={filter.kind ?? ''} onChange={e => setField('kind', e.target.value as VersionedGraphsFilter['kind'] | '')}>
                    <option value="">All graphs</option>
                    {KIND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <form onSubmit={e => { e.preventDefault(); setField('q', search.trim()) }}>
                    <input
                        aria-label="Search"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Name, id or key — Enter to search"
                        className={cn(SELECT_CLS, 'w-64')}
                    />
                </form>
            </div>

            {query.isLoading ? (
                <p className="px-5 pb-4 text-xs text-ink-muted flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading graphs…</p>
            ) : query.error ? (
                <p className="px-5 pb-4 text-xs text-red-600 dark:text-red-400">{(query.error as Error).message}</p>
            ) : rows.length === 0 ? (
                <p className="px-5 pb-4 text-xs text-ink-muted">No versioned graph matches.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead className="bg-black/5 dark:bg-white/5">
                            <tr className="text-left text-[10px] uppercase tracking-wider text-ink-muted">
                                <th className="px-5 py-2 font-semibold">Graph</th>
                                <th className="px-3 py-2 font-semibold">Read cache</th>
                                <th className="px-3 py-2 font-semibold">State</th>
                                <th className="px-3 py-2 font-semibold">Last projected</th>
                                <th className="px-5 py-2 font-semibold">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(row => {
                                const note = notes[row.graphId]
                                const hasSource = !row.orphan && !row.forkParentGraphId
                                return (
                                    <tr key={row.graphId} className="border-t border-glass-border align-top">
                                        <td className="px-5 py-2.5">
                                            <div className="flex items-center gap-2">
                                                <span className={cn('truncate max-w-[220px]', row.dataSourceLabel ? 'font-semibold text-ink' : 'font-mono text-[11px] text-ink-secondary')} title={row.graphId}>
                                                    {row.dataSourceLabel ?? row.dataSourceId}
                                                </span>
                                                {row.forkParentGraphId && (
                                                    <span className="inline-flex px-1.5 py-px rounded-full border border-indigo-500/20 bg-indigo-500/10 text-[9px] uppercase tracking-wide text-indigo-600 dark:text-indigo-400 shrink-0" title={`Fork of ${row.forkParentGraphId}`}>Fork</span>
                                                )}
                                                {row.orphan && (
                                                    <span className="inline-flex px-1.5 py-px rounded-full border border-amber-500/20 bg-amber-500/10 text-[9px] uppercase tracking-wide text-amber-600 dark:text-amber-400 shrink-0" title="Its data source no longer exists">Orphan</span>
                                                )}
                                            </div>
                                            <span className="text-[10px] text-ink-muted">{row.workspaceName ?? row.workspaceId}</span>
                                        </td>
                                        <td className="px-3 py-2.5">
                                            <span className="text-ink-secondary">{row.falkorProvider ? (providerName.get(row.falkorProvider) ?? row.falkorProvider) : 'default'}</span>
                                            <span className="ml-1.5 text-[10px] text-ink-muted">{row.owned ? 'Platform copy' : 'Customer graph'}</span>
                                            <br />
                                            <span className="font-mono text-[10px] text-ink-muted">{row.falkorGraphName ?? 'not yet projected'}</span>
                                            {row.retiredKeys.map(k => (
                                                <span key={`${k.provider}:${k.name}`} className="block text-[10px] text-ink-muted">
                                                    old key {k.name} on {k.provider ? (providerName.get(k.provider) ?? k.provider) : 'default'} — removed after it catches up
                                                </span>
                                            ))}
                                        </td>
                                        <td className="px-3 py-2.5">
                                            <span className="font-medium text-ink-secondary">{stateLabel(row)}</span>
                                            {row.lag > 0 && <span className="text-[10px] text-ink-muted"> · {row.lag} behind</span>}
                                            {row.lastError && (
                                                <span className="block font-mono text-[10px] text-red-600 dark:text-red-400 line-clamp-2 break-all max-w-[220px]">{row.lastError}</span>
                                            )}
                                        </td>
                                        <td className="px-3 py-2.5 text-ink-muted whitespace-nowrap">{formatSince(row.lastProjectedAt) ?? 'never'}</td>
                                        <td className="px-5 py-2.5">
                                            <div className="flex flex-wrap gap-1.5">
                                                <button className={ACTION_CLS} disabled={busy !== null} onClick={() => act(row, 'rebuild')}>Rebuild</button>
                                                <button className={ACTION_CLS} disabled={busy !== null} onClick={() => act(row, 'check')}>Check sync</button>
                                                <button
                                                    className={ACTION_CLS}
                                                    disabled={!hasSource}
                                                    title={hasSource ? undefined : 'Forks and orphans have no data source to open'}
                                                    onClick={() => navigate(`/workspaces/${row.workspaceId}?ds=${encodeURIComponent(row.dataSourceId)}&dstab=versioning`)}
                                                >
                                                    Open source
                                                </button>
                                                {row.forkParentGraphId && (
                                                    <button className={ACTION_CLS} disabled={busy !== null} onClick={() => act(row, 'delete')}>Delete</button>
                                                )}
                                                <button
                                                    className={ACTION_CLS}
                                                    disabled={!row.owned || row.orphan || busy !== null}
                                                    title={!row.owned ? "Only platform copies can be moved; this is the customer's graph"
                                                        : row.orphan ? 'Its data source no longer exists' : undefined}
                                                    onClick={() => setMoving(row)}
                                                >
                                                    Move…
                                                </button>
                                            </div>
                                            {busy?.startsWith(`${row.graphId}:`) && <Loader2 className="mt-1 w-3 h-3 animate-spin text-ink-muted" />}
                                            {note && <p className={cn('mt-1 text-[11px]', NOTE_CLS[note.tone])}>{note.text}</p>}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {query.hasNextPage && (
                <div className="px-5 py-3 border-t border-glass-border">
                    <button className={ACTION_CLS} disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
                        {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                    </button>
                </div>
            )}

            {moving && (
                <MoveProjectionDialog
                    row={moving}
                    providers={providers ?? []}
                    onClose={() => setMoving(null)}
                    onMoved={res => {
                        setMoving(null)
                        setNotes(prev => ({
                            ...prev,
                            [res.graphId]: res.changed
                                ? { tone: 'ok', text: `Moving to ${res.to.key} — reads come from Postgres until it catches up` }
                                : { tone: 'ok', text: 'Already there' },
                        }))
                        void query.refetch()
                    }}
                />
            )}
        </div>
    )
}
