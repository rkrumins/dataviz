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
 *
 * Residency (doc 17): each graph's class and whether it is in memory show as
 * chips; a system administrator sets the class (Always may be refused when its
 * master has no room, with the reason), asks for an evicted graph's load (Load
 * now), and adopts a customer's key onto a platform key after a confirmation
 * that says what changes. "Residency & eviction" opens the policy card, "Draft retention" the
 * card that says how long a merged or abandoned draft keeps its changes, and "New-version builds"
 * the card of settings for building a graph's next version beside the key that serves it.
 *
 * Read mode: each graph shows what its readers get while a newer version lands — the platform's
 * default or its own — and "Read mode…" opens the guided choice for that graph.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Database, Gauge, Hourglass, Layers, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    systemStatusService,
    type GraphProvider,
    type ResidencyClass,
    type ResidencyState,
    type VersionedGraphRow,
    type VersionedGraphsFilter,
} from '@/services/systemStatusService'
import { deleteFork, rebuildProjection, reconcileProjection } from '@/services/versioningApiService'
import { formatSince } from './meta'
import { MoveProjectionDialog } from './MoveProjectionDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { ResidencyPolicyCard } from './ResidencyPolicyCard'
import { DraftRetentionCard } from './DraftRetentionCard'
import { BuildPolicyCard } from './BuildPolicyCard'
import { GraphReadModeDialog } from './GraphReadModeDialog'
import { READ_MODE } from './readModes'

const STATUS_OPTIONS: { value: NonNullable<VersionedGraphsFilter['status']>; label: string }[] = [
    { value: 'fresh', label: 'In sync' },
    { value: 'lagging', label: 'Catching up' },
    { value: 'projecting', label: 'Projecting' },
    { value: 'rebuilding', label: 'Rebuilding' },
    { value: 'evicted', label: 'Evicted' },
    { value: 'rehydrating', label: 'Loading' },
    { value: 'waiting_capacity', label: 'Waiting for room' },
    { value: 'failed', label: 'Failed' },
]

const CLASS_LABEL: Record<ResidencyClass, string> = { always: 'Always', standard: 'Standard', coldline: 'Coldline' }

const STATE_CHIP: Record<ResidencyState, { label: string; cls: string }> = {
    resident: { label: 'In memory', cls: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
    evicted: { label: 'Evicted', cls: 'border-glass-border bg-black/5 dark:bg-white/5 text-ink-muted' },
    rehydrating: { label: 'Loading', cls: 'border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-400' },
    waiting_capacity: { label: 'Waiting for room', cls: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400' },
}

const CHIP_CLS = 'inline-flex px-1.5 py-px rounded-full border text-[9px] uppercase tracking-wide shrink-0'

/** A build beside the serving key (read mode beside), by step: what its row says. */
const BUILD_CHIP: Record<string, string> = {
    queued: 'Build waiting', copying: 'Copying for a build', seeding: 'Seeding a build',
    catching_up: 'Building new version', switching: 'Switching to new version',
}

/** The build's chip's tooltip: what readers see meanwhile, and why it waits or failed. */
function buildTitle(b: { step: string; waiting?: string | null; error?: string | null; attempts?: number;
                         progress?: { done?: number; total?: number } | null }): string {
    return [
        'Readers keep exactly the version served now until the new one is built and checked, then switch at once.',
        b.step === 'seeding' ? 'Its key is written from Postgres, as no copy fits or one is not wanted.' : '',
        b.step === 'seeding' && b.progress?.total
            ? `${Math.round(((b.progress.done ?? 0) / b.progress.total) * 100)}% written.` : '',
        b.waiting ? `Waiting: ${b.waiting}.` : '',
        b.error ? `Attempt ${b.attempts ?? 1} failed: ${b.error}.` : '',
    ].filter(Boolean).join(' ')
}

type Refusal = { type?: string; reason?: string; message?: string }

/** Why a key cannot be adopted, by the refusal's reason. */
const NOT_ADOPTED: Record<string, string> = {
    unpinned: 'This graph has no FalkorDB key yet, so there is nothing to adopt.',
    shared: 'Other data sources read this key, so it cannot be adopted.',
}

/** A refusal in words: the server's own message where it gives one. */
function explain(e: Error & { detail?: unknown }): string {
    const d: Refusal = typeof e.detail === 'object' && e.detail ? e.detail as Refusal : {}
    if (d.type === 'projection_not_adopted') return NOT_ADOPTED[d.reason ?? ''] ?? d.message ?? e.message
    if (d.type === 'projection_mode_unsupported') return 'A data source with a dedicated rollup graph cannot be adopted.'
    if (d.type === 'job_active') return 'A rollup rebuild is running; try again when it finishes.'
    if (d.type === 'already_adopted') return 'This graph already uses a platform key.'
    return d.message ?? e.message
}

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
    const [adopting, setAdopting] = useState<VersionedGraphRow | null>(null)
    const [readModeFor, setReadModeFor] = useState<VersionedGraphRow | null>(null)
    const [showPolicy, setShowPolicy] = useState(false)
    const [showRetention, setShowRetention] = useState(false)
    const [showBuilds, setShowBuilds] = useState(false)
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

    /** A residency action on one graph: its class, Load now, or Adopt (confirmed first). */
    const reside = async (row: VersionedGraphRow, action: 'class' | 'load' | 'adopt', cls?: ResidencyClass) => {
        setBusy(`${row.graphId}:${action}`)
        let note: RowNote
        try {
            if (action === 'class') {
                await systemStatusService.setGraphResidency(row.graphId, cls!)
                note = { tone: 'ok', text: `Set to ${CLASS_LABEL[cls!]}` }
                void query.refetch()
            } else if (action === 'load') {
                const res = await systemStatusService.loadGraph(row.graphId)
                note = res.loadRequested
                    ? { tone: 'ok', text: 'Load asked for — it starts when its master has room' }
                    : { tone: 'warn', text: 'Already in memory, or being loaded' }
            } else {
                const res = await systemStatusService.adoptGraph(row.graphId)
                note = { tone: 'ok', text: `Adopting onto ${res.to.key} — reads come from Postgres until it catches up` }
                setAdopting(null)
                void query.refetch()
            }
        } catch (e) {
            note = { tone: 'bad', text: explain(e as Error) }
            if (action === 'adopt') setAdopting(null)
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
                <div className="flex items-center gap-2 shrink-0">
                    <button
                        onClick={() => setShowPolicy(open => !open)}
                        aria-expanded={showPolicy}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                        <Gauge className="w-3.5 h-3.5" /> Residency &amp; eviction
                    </button>
                    <button
                        onClick={() => setShowRetention(open => !open)}
                        aria-expanded={showRetention}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                        <Hourglass className="w-3.5 h-3.5" /> Draft retention
                    </button>
                    <button
                        onClick={() => setShowBuilds(open => !open)}
                        aria-expanded={showBuilds}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                        <Layers className="w-3.5 h-3.5" /> New-version builds
                    </button>
                    <button onClick={onClose} className="p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5" aria-label="Close versioned graphs">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {showPolicy && <ResidencyPolicyCard />}
            {showRetention && <DraftRetentionCard />}
            {showBuilds && <BuildPolicyCard />}

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
                                // A fork has a data source of its own, which opens like any other.
                                const hasSource = !row.orphan
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
                                            {!row.forkParentGraphId && row.residency && row.residencyState && (
                                                <div className="mt-1 flex items-center gap-1">
                                                    <span className={cn(CHIP_CLS, 'border-indigo-500/20 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400')}>
                                                        {CLASS_LABEL[row.residency] ?? row.residency}
                                                    </span>
                                                    <span
                                                        className={cn(CHIP_CLS, STATE_CHIP[row.residencyState]?.cls)}
                                                        title={row.rehydratingSince ? `Loading since ${row.rehydratingSince}` : undefined}
                                                    >
                                                        {STATE_CHIP[row.residencyState]?.label ?? row.residencyState}
                                                    </span>
                                                </div>
                                            )}
                                            {!row.forkParentGraphId && row.readModeEffective && (
                                                <div className="mt-1">
                                                    <span
                                                        className={cn(CHIP_CLS, row.readMode
                                                            ? 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-400'
                                                            : 'border-glass-border bg-black/5 dark:bg-white/5 text-ink-muted')}
                                                        title={READ_MODE[row.readModeEffective].promise}
                                                    >
                                                        Reads: {READ_MODE[row.readModeEffective].short}{row.readMode ? '' : ' · default'}
                                                    </span>
                                                    {row.build && (
                                                        <span
                                                            className={cn(CHIP_CLS, 'ml-1', row.build.error
                                                                ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                                                                : 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300')}
                                                            title={buildTitle(row.build)}
                                                        >
                                                            {BUILD_CHIP[row.build.step] ?? row.build.step}
                                                        </span>
                                                    )}
                                                </div>
                                            )}
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
                                                    title={hasSource ? undefined : 'Its data source no longer exists'}
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
                                                {!row.forkParentGraphId && row.readModeEffective && (
                                                    <button className={ACTION_CLS} disabled={busy !== null} onClick={() => setReadModeFor(row)}>
                                                        Read mode…
                                                    </button>
                                                )}
                                                {!row.forkParentGraphId && row.residency && (
                                                    <select
                                                        aria-label="Residency class"
                                                        className={cn(SELECT_CLS, 'py-0.5 text-[11px]')}
                                                        value={row.residency}
                                                        disabled={busy !== null}
                                                        onChange={e => reside(row, 'class', e.target.value as ResidencyClass)}
                                                    >
                                                        {(Object.keys(CLASS_LABEL) as ResidencyClass[]).map(c => (
                                                            <option key={c} value={c}>{CLASS_LABEL[c]}</option>
                                                        ))}
                                                    </select>
                                                )}
                                                {!row.forkParentGraphId && (row.residencyState === 'evicted' || row.residencyState === 'waiting_capacity') && (
                                                    <button className={ACTION_CLS} disabled={busy !== null} onClick={() => reside(row, 'load')}>Load now</button>
                                                )}
                                                {!row.owned && !row.forkParentGraphId && !row.orphan && row.falkorGraphName
                                                    && row.falkorGraphName !== `gv_${row.graphId}` && (
                                                    <button className={ACTION_CLS} disabled={busy !== null} onClick={() => setAdopting(row)}>Adopt…</button>
                                                )}
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

            {adopting && (
                <ConfirmDialog
                    title="Adopt onto a platform key"
                    confirmLabel="Adopt"
                    pending={busy === `${adopting.graphId}:adopt`}
                    onClose={() => setAdopting(null)}
                    onConfirm={() => reside(adopting, 'adopt')}
                >
                    <p>
                        {adopting.dataSourceLabel ?? adopting.dataSourceId} is copied from Postgres into a new platform key on the
                        same provider, a page at a time; reads come from Postgres until the copy catches up. From then the
                        platform reads its own copy, and the graph's residency class applies.
                    </p>
                    <p>
                        <span className="font-mono">{adopting.falkorGraphName}</span> is left exactly as it is: never written,
                        dropped or renamed. It keeps its memory too, so the graph then takes the room of two copies until
                        that key is cleared.
                    </p>
                    <p className="text-amber-700 dark:text-amber-400">
                        Changes other tools keep making to {adopting.falkorGraphName} no longer show here, and Bring into history
                        no longer sees them.
                    </p>
                    <p className="text-amber-700 dark:text-amber-400">
                        The platform key holds the ontology's spelling of each type: a native query or a saved query written
                        against the customer's own spelling (<span className="font-mono">:table</span> for
                        <span className="font-mono"> :Table</span>) needs the ontology's from then.
                    </p>
                </ConfirmDialog>
            )}

            {readModeFor && (
                <GraphReadModeDialog
                    row={readModeFor}
                    onClose={() => setReadModeFor(null)}
                    onSaved={res => {
                        setReadModeFor(null)
                        setNotes(prev => ({
                            ...prev,
                            [res.graphId]: {
                                tone: 'ok',
                                text: `Readers now get: ${READ_MODE[res.readModeEffective].title}${res.readMode ? '' : ' (the platform default)'}`,
                            },
                        }))
                        void query.refetch()
                    }}
                />
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
