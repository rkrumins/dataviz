/**
 * GraphProvidersPanel — every registered graph data provider and its
 * reachability, whatever the type (FalkorDB, Neo4j, Spanner, DataHub…).
 * Fully data-driven from the snapshot's ``graphProviders`` list; status
 * comes from the shared provider resolver, so this reflects exactly what
 * the app experiences — no per-type checks here.
 *
 * Plus the graph tier's per-node memory headroom, which is silent until a
 * node is actually filling: under ``noeviction`` crossing ``maxmemory``
 * does not slow writes down, it REFUSES them.
 *
 * And beneath that, the fleet answer to "is it RIGHT" — how many versioned
 * graphs are behind or erroring, which ones, and how far. It sits here on
 * purpose: a full node and a stalled publish are the same incident seen from
 * two ends, and an operator has to read that pair in one glance.
 */
import { Boxes, GitBranch, MemoryStick, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GraphProvider, ProjectionSection, ServiceEntry } from '@/services/systemStatusService'
import { STATUS_META, formatBytes, num, obj, str } from './meta'
import type { AggregationCapacityResponse } from '@/services/aggregationService'
import { compactBytes, compactEdges, heldByRebuilds } from '../shared/aggregationKnobs'

/** Neutral type badge — no privileged provider. */
const TYPE_LABEL: Record<string, string> = {
    falkordb: 'FalkorDB',
    neo4j: 'Neo4j',
    spanner: 'Spanner',
    datahub: 'DataHub',
    mock: 'Mock',
}

function ProviderCard({ p }: { p: GraphProvider }) {
    const meta = STATUS_META[p.status] ?? STATUS_META.unknown
    const Icon = meta.icon
    return (
        <div className={cn(
            'border rounded-xl p-3 bg-canvas-elevated',
            p.status === 'down' ? 'border-red-500/30'
                : p.status === 'healthy' ? 'border-glass-border'
                    : 'border-glass-border',
        )}>
            <div className="flex items-center gap-2">
                <span className={cn('w-2 h-2 rounded-full shrink-0', meta.dot, p.status === 'down' && 'animate-pulse')} />
                <span className="text-sm font-semibold text-ink truncate">{p.name}</span>
                <span className="ml-auto inline-flex px-1.5 py-0.5 rounded-full border border-glass-border bg-black/5 dark:bg-white/5 text-[10px] font-medium text-ink-muted shrink-0">
                    {TYPE_LABEL[p.type] ?? p.type}
                </span>
            </div>
            <div className={cn('mt-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide', meta.chip)}>
                <Icon className="w-3 h-3" />
                {p.status === 'healthy' ? 'Reachable' : p.status === 'down' ? 'Unreachable' : p.status === 'unknown' ? 'Not probed' : meta.label}
            </div>
            {p.error && (
                <p className="mt-1.5 text-[10px] font-mono text-red-600 dark:text-red-400 break-all">{p.error}</p>
            )}
        </div>
    )
}

/** One graph node's used-memory headroom. The capacity fields ride along
 *  when the aggregation capacity sweep has measured the same node. */
interface ShardMemory {
    endpoint: string
    usedMemory: number | null
    maxmemory: number | null
    usedPct: number | null
    level: 'warn' | 'critical' | null
    /** Share of maxmemory the rollup write budget keeps free. */
    reservePct?: number | null
    /** How many more rollup edges fit under that reserve, at bytesPerEdge. */
    fitsEdges?: number | null
    bytesPerEdge?: number | null
    /** What running rebuilds hold in the node's reservation ledger — already
     *  off fitsEdges. */
    reservedBytes?: number | null
    reservedByJobs?: number | null
    /** The node's own limits, when the capacity sweep read them: the
     *  per-query memory ceiling, the per-query time cap, the thread count. */
    queryMemCapacity?: number | null
    timeoutMaxMs?: number | null
    threadCount?: number | null
    /** True when the capacity sweep placed this node — the only rows a
     *  limits change can reach (it goes through the provider on that node). */
    capacityKnown?: boolean
}

/** Memory pressure is its own signal, not a fifth status word — warn and
 *  critical borrow the page's existing degraded/down colours. */
const LEVEL_META = {
    warn: { meta: STATUS_META.degraded, label: 'Warning' },
    critical: { meta: STATUS_META.down, label: 'Critical' },
} as const

/** What the operator otherwise meets as "a user says lineage vanished". */
const CRITICAL_CONSEQUENCE =
    'At the cap FalkorDB refuses writes — publishes fail and projections stall '
    + 'behind the watermark, so a data source\u2019s lineage silently disappears '
    + 'until memory is freed or a graph moves to another shard.'

function shardLevel(row: Record<string, unknown>): 'warn' | 'critical' | null {
    // Cluster shards carry a flat ``memoryLevel``; a standalone/sentinel node
    // carries the whole verdict object.
    const raw = str(row, 'memoryLevel') ?? str(obj(row, 'memoryPressure') ?? {}, 'level')
    return raw === 'warn' || raw === 'critical' ? raw : null
}

/**
 * Per-node memory for the graph tier: every MEASURABLE node, always — the
 * rollup write budget reads this same used/maxmemory pair before every
 * rebuild, so a page that hid it until a node was 85% full left the operator
 * without the one number that decides whether a rebuild fits. A node with no
 * cap (``maxmemory: 0`` is unlimited, not full) or no memory section reports
 * no percentage and is never rendered. One node is one row.
 *
 * The status probe and the capacity sweep can name the same node differently
 * (the probe reads the env topology, the sweep the provider's own client,
 * after any address remap), so the two are UNIONED by endpoint, never joined:
 * a node either source knows is shown, and the capacity figures ride along
 * where the names agree.
 */
export function graphShardMemory(
    services: ServiceEntry[] | null | undefined,
    capacity?: AggregationCapacityResponse | null,
): ShardMemory[] {
    const svc = services?.find(s => s.key === 'falkordb')
    const raw = !svc ? [] : Array.isArray(svc.detail.shards)
        ? (svc.detail.shards as unknown[]).filter(
            (s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s))
        : [svc.detail]
    const rows: ShardMemory[] = raw.map(r => ({
        endpoint: str(r, 'endpoint') ?? svc?.label ?? 'graph store',
        usedMemory: num(r, 'usedMemory'),
        maxmemory: num(r, 'maxmemory'),
        usedPct: num(r, 'memoryUsedPct'),
        level: shardLevel(r),
    })).filter(r => r.usedPct != null)
    const bytesPerEdge = typeof capacity?.limits.bytesPerEdge.value === 'number'
        ? capacity.limits.bytesPerEdge.value : null
    for (const shard of capacity?.shards ?? []) {
        if (!shard.measurable) continue
        const limits = {
            queryMemCapacity: shard.queryMemCapacity ?? null,
            timeoutMaxMs: shard.timeoutMaxMs ?? null,
            threadCount: shard.threadCount ?? null,
            capacityKnown: true as const,
        }
        const row = rows.find(r => r.endpoint === shard.endpoint)
        if (row) {
            Object.assign(row, limits)
            row.reservePct = shard.reservePct
            row.fitsEdges = shard.allowedGrowthEdges ?? null
            row.bytesPerEdge = bytesPerEdge
            row.reservedBytes = shard.reservedBytes ?? null
            row.reservedByJobs = shard.reservedByJobs ?? null
        } else {
            rows.push({
                endpoint: shard.endpoint,
                usedMemory: shard.used ?? null,
                maxmemory: shard.maxmemory ?? null,
                usedPct: shard.usedPct ?? null,
                level: null,
                reservePct: shard.reservePct,
                fitsEdges: shard.allowedGrowthEdges ?? null,
                bytesPerEdge,
                reservedBytes: shard.reservedBytes ?? null,
                reservedByJobs: shard.reservedByJobs ?? null,
                ...limits,
            })
        }
    }
    return rows
}

/** The node's own per-query limits, as one line: what the rebuild's queries
 *  are bounded by on this node, and — for a system administrator — the way
 *  to change them. */
function limitsLine(shard: ShardMemory): string | null {
    const parts = [
        shard.queryMemCapacity != null && `per-query memory ${compactBytes(shard.queryMemCapacity)}`,
        shard.timeoutMaxMs != null && `query time cap ${shard.timeoutMaxMs / 1000} s`,
        shard.threadCount != null && `${shard.threadCount} thread${shard.threadCount === 1 ? '' : 's'}`,
    ].filter((p): p is string => typeof p === 'string')
    return parts.length ? parts.join(' \u00b7 ') : null
}

function ShardMemoryRow({ shard, onAdjustLimits }: {
    shard: ShardMemory
    onAdjustLimits?: (endpoint: string) => void
}) {
    const level = shard.level ? LEVEL_META[shard.level] : null
    const Icon = level?.meta.icon
    const used = formatBytes(shard.usedMemory)
    const cap = formatBytes(shard.maxmemory)
    const pct = shard.usedPct != null ? `${Math.round(shard.usedPct)}%` : null
    const limits = limitsLine(shard)
    const adjustable = !!shard.capacityKnown && !!onAdjustLimits
    return (
        <div>
            <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-[11px] font-mono text-ink-secondary">{shard.endpoint}</span>
                <span className="text-[11px] text-ink tabular-nums">
                    {used && cap ? `${used} of ${cap}${pct ? ` (${pct})` : ''}` : pct}
                </span>
                {level && Icon && (
                    <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide', level.meta.chip)}>
                        <Icon className="w-3 h-3" />
                        {level.label}
                    </span>
                )}
            </div>
            <div aria-hidden="true" className="relative mt-1 h-1.5 rounded-full bg-black/5 dark:bg-white/10 overflow-hidden">
                <div
                    className={cn('h-full rounded-full', level ? level.meta.dot : 'bg-emerald-500')}
                    style={{ width: `${Math.min(100, Math.max(0, shard.usedPct ?? 0))}%` }}
                />
                {shard.reservePct != null && (
                    <div className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: `${100 - shard.reservePct}%` }} />
                )}
            </div>
            {shard.reservePct != null && (
                <p className="mt-1 text-[11px] text-ink-muted tabular-nums">
                    Rollups keep {shard.reservePct}% in reserve
                    {heldByRebuilds(shard) && ` \u00b7 ${heldByRebuilds(shard)}`}
                    {shard.fitsEdges != null && ` \u00b7 fits ~${compactEdges(shard.fitsEdges)} more rollup edges`}
                    {shard.bytesPerEdge != null && ` at ${shard.bytesPerEdge} B each`}
                </p>
            )}
            {(limits || adjustable) && (
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-muted tabular-nums">
                    {limits && <span>Limits: {limits}</span>}
                    {adjustable && (
                        <button
                            type="button"
                            onClick={() => onAdjustLimits?.(shard.endpoint)}
                            className="inline-flex items-center gap-1 font-semibold text-indigo-600 dark:text-indigo-400 hover:underline outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 rounded"
                        >
                            <SlidersHorizontal className="w-3 h-3" /> Adjust graph store limits
                        </button>
                    )}
                </p>
            )}
        </div>
    )
}

/** Every measurable node — see ``graphShardMemory``. A filling node names
 *  itself with a level word; the nodes that still have room are listed
 *  alongside it, because "move a graph to another shard" is unanswerable
 *  without them, and the rollup reserve is marked on each. */
function MemoryHeadroom({ shards, onAdjustLimits }: {
    shards: ShardMemory[]
    onAdjustLimits?: (endpoint: string) => void
}) {
    if (shards.length === 0) return null
    const filling = shards.filter(s => s.level)
    const worst = filling.some(s => s.level === 'critical') ? 'critical' : filling.length > 0 ? 'warn' : null
    const meta = worst ? LEVEL_META[worst].meta : null
    const HeadIcon = meta?.icon ?? MemoryStick
    return (
        <div className="px-4 pb-4">
            <div className="border border-glass-border rounded-xl p-3 bg-black/[0.02] dark:bg-white/[0.03]">
                <div className="flex items-center gap-2">
                    <HeadIcon className={cn('w-3.5 h-3.5 shrink-0', meta ? meta.text : 'text-ink-muted')} />
                    <h3 className="text-xs font-semibold text-ink">Memory headroom</h3>
                    <span className="ml-auto text-[11px] text-ink-muted">
                        {filling.length > 0
                            ? `${filling.length} of ${shards.length} shard${shards.length === 1 ? '' : 's'} filling`
                            : `${shards.length} shard${shards.length === 1 ? '' : 's'} with headroom`}
                    </span>
                </div>
                <div className="mt-2 space-y-2">
                    {shards.map(s => <ShardMemoryRow key={s.endpoint} shard={s} onAdjustLimits={onAdjustLimits} />)}
                </div>
                {worst === 'critical' && meta && (
                    <p className={cn('mt-2 text-[11px] leading-snug', meta.text)}>{CRITICAL_CONSEQUENCE}</p>
                )}
            </div>
        </div>
    )
}

/** One versioned graph whose read cache is not keeping up. */
interface StalledGraph {
    graphId: string
    name: string
    workspace: string | null
    lag: number
    /** The provider hosting this graph's read cache — the same identity the
     *  cards above are keyed by, so the two halves name one thing. */
    host: string | null
    error: string | null
}

/**
 * The graphs that are stuck — behind with nothing running, or erroring.
 * A graph mid-``projecting``/``rebuilding`` is WORKING, not wedged, and is
 * deliberately excluded so the block stays silent while the fleet catches
 * itself up.
 *
 * Rows come from the probe's worst list, which is capped server-side; the
 * COUNT comes from the fleet aggregate. The two are reported separately and
 * neither is derived from the other — deriving the count from the rows would
 * under-report a wide outage as exactly the cap.
 */
function stalledGraphs(projection: ProjectionSection | null | undefined, providers: GraphProvider[]): StalledGraph[] {
    const byId = new Map(providers.map(p => [p.id, p.name]))
    return (projection?.worst ?? [])
        .filter(r => r.lastError != null || (r.lag > 0 && r.status === 'idle'))
        .map(r => ({
            graphId: r.graphId,
            name: r.dataSourceLabel ?? r.dataSourceId,
            workspace: r.workspaceName ?? r.workspaceId,
            lag: r.lag,
            host: r.falkorProvider ? (byId.get(r.falkorProvider) ?? r.falkorProvider) : null,
            error: r.lastError,
        }))
}

/** Why a stalled publish and a full node are one incident — the 14-hour
 *  outage this adjacency exists to prevent. Only claimed when a node is
 *  ACTUALLY at its cap; otherwise the cause is unknown and goes unstated. */
const WEDGE_WITH_MEMORY =
    'A graph node above is at its memory cap, so FalkorDB is refusing writes: every publish and '
    + 'every heal fails while reads keep working, which is why these graphs stopped catching up. '
    + 'Free memory or move a graph to another shard — they then catch up on their own.'

/** No node is full, so the cause is elsewhere and is not guessed at here. */
const WEDGE_ALONE =
    'While a graph is behind, reads fall back to the version log, which carries no rolled-up '
    + 'connections — so aggregated lineage is missing from its canvases until it catches up. '
    + 'Check the projector for the graphs listed.'

function StalledRow({ g }: { g: StalledGraph }) {
    return (
        <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[11px] font-semibold text-ink truncate max-w-[240px]" title={g.graphId}>{g.name}</span>
            {g.workspace && <span className="text-[10px] text-ink-muted truncate max-w-[160px]">{g.workspace}</span>}
            <span className="text-[11px] text-ink-secondary tabular-nums">
                {g.lag > 0 ? `${g.lag} commit${g.lag === 1 ? '' : 's'} behind` : 'not publishing'}
            </span>
            {g.host && <span className="text-[10px] text-ink-muted">on {g.host}</span>}
            {g.error && (
                <span className="w-full font-mono text-[10px] text-red-600 dark:text-red-400 break-all line-clamp-2">{g.error}</span>
            )}
        </div>
    )
}

/**
 * Rendered ONLY when at least one versioned graph is behind or erroring —
 * the same silent-unless-wrong contract the memory block holds to.
 */
function PublishingStalled({ projection, providers, nodeFilling }: {
    projection: ProjectionSection | null | undefined
    providers: GraphProvider[]
    nodeFilling: boolean
}) {
    if (!projection) return null
    const count = projection.lagging + projection.failed
    if (count === 0) return null
    const rows = stalledGraphs(projection, providers)
    const notListed = Math.max(0, count - rows.length)
    // Erroring is worse than merely behind, and borrows the page's down colour.
    const meta = projection.failed > 0 ? STATUS_META.down : STATUS_META.degraded
    return (
        <div className="px-4 pb-4">
            <div className="border border-glass-border rounded-xl p-3 bg-black/[0.02] dark:bg-white/[0.03]">
                <div className="flex items-center gap-2">
                    <GitBranch className={cn('w-3.5 h-3.5 shrink-0', meta.text)} />
                    <h3 className="text-xs font-semibold text-ink">Graphs not publishing</h3>
                    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide', meta.chip)}>
                        {projection.failed > 0
                            ? `${projection.failed} erroring${projection.lagging > 0 ? ` · ${projection.lagging} behind` : ''}`
                            : `${projection.lagging} behind`}
                    </span>
                    <span className="ml-auto text-[11px] text-ink-muted">
                        {count} of {projection.totalGraphs} versioned graph{projection.totalGraphs === 1 ? '' : 's'}
                    </span>
                </div>
                {rows.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                        {rows.map(g => <StalledRow key={g.graphId} g={g} />)}
                    </div>
                )}
                {notListed > 0 && (
                    <p className="mt-1.5 text-[10px] text-ink-muted">
                        {notListed} more not listed — the full table is in Versioned graph projection below.
                    </p>
                )}
                <p className={cn('mt-2 text-[11px] leading-snug', nodeFilling ? meta.text : 'text-ink-secondary')}>
                    {nodeFilling ? WEDGE_WITH_MEMORY : WEDGE_ALONE}
                </p>
            </div>
        </div>
    )
}

export function GraphProvidersPanel({ providers, services, projection, capacity, onAdjustLimits }: {
    providers: GraphProvider[] | null
    services?: ServiceEntry[] | null
    projection?: ProjectionSection | null
    /** The aggregation capacity sweep, when the page has it: the rollup
     *  reserve, what fits and the node's own limits ride onto the matching
     *  shard rows. */
    capacity?: AggregationCapacityResponse | null
    /** Offered on every row the sweep placed, when the viewer may change a
     *  node's limits (system administrators); absent otherwise. */
    onAdjustLimits?: (endpoint: string) => void
}) {
    const shards = graphShardMemory(services, capacity)
    const list = providers ?? []
    const stalledCount = projection ? projection.lagging + projection.failed : 0
    // Neither a filling shard nor a stalled publish is hidden because no
    // provider rows happen to be registered.
    if (list.length === 0 && shards.length === 0 && stalledCount === 0) return null
    const down = list.filter(p => p.status === 'down').length

    return (
        <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden">
            <div className="px-5 pt-4 pb-3 flex items-center gap-2">
                <Boxes className="w-4 h-4 text-indigo-500" />
                <div>
                    <h2 className="text-sm font-semibold text-ink">Graph data providers</h2>
                    <p className="text-[11px] text-ink-muted">Reachability of every registered graph backend, by type.</p>
                </div>
                <span className="ml-auto text-[11px] text-ink-muted">
                    {list.length} provider{list.length === 1 ? '' : 's'}{down > 0 ? ` · ${down} unreachable` : ''}
                </span>
            </div>
            {list.length > 0 && (
                <div className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {list.map(p => <ProviderCard key={p.id} p={p} />)}
                </div>
            )}
            <MemoryHeadroom shards={shards} onAdjustLimits={onAdjustLimits} />
            <PublishingStalled
                projection={projection}
                providers={list}
                nodeFilling={shards.some(s => s.level)}
            />
        </div>
    )
}
