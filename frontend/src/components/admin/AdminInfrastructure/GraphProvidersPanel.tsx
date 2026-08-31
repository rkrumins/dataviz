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
 */
import { Boxes } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GraphProvider, ServiceEntry } from '@/services/systemStatusService'
import { STATUS_META, formatBytes, num, obj, str } from './meta'

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

/** One graph node's used-memory headroom. */
interface ShardMemory {
    endpoint: string
    usedMemory: number | null
    maxmemory: number | null
    usedPct: number | null
    level: 'warn' | 'critical' | null
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
 * Per-node memory for the graph tier — EMPTY unless at least one node is
 * genuinely under pressure, so a page read at a glance stays quiet while
 * every shard has headroom. A node with no cap (``maxmemory: 0`` is
 * unlimited, not full) or no memory section reports no percentage and is
 * never rendered. One node is one row, not a manufactured list.
 */
function graphShardMemory(services: ServiceEntry[] | null | undefined): ShardMemory[] {
    const svc = services?.find(s => s.key === 'falkordb')
    if (!svc) return []
    const raw = Array.isArray(svc.detail.shards)
        ? (svc.detail.shards as unknown[]).filter(
            (s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s))
        : [svc.detail]
    const rows = raw.map(r => ({
        endpoint: str(r, 'endpoint') ?? svc.label,
        usedMemory: num(r, 'usedMemory'),
        maxmemory: num(r, 'maxmemory'),
        usedPct: num(r, 'memoryUsedPct'),
        level: shardLevel(r),
    })).filter(r => r.usedPct != null)
    return rows.some(r => r.level) ? rows : []
}

function ShardMemoryRow({ shard }: { shard: ShardMemory }) {
    const level = shard.level ? LEVEL_META[shard.level] : null
    const Icon = level?.meta.icon
    const used = formatBytes(shard.usedMemory)
    const cap = formatBytes(shard.maxmemory)
    const pct = shard.usedPct != null ? `${Math.round(shard.usedPct)}%` : null
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
            <div aria-hidden="true" className="mt-1 h-1 rounded-full bg-black/5 dark:bg-white/10 overflow-hidden">
                <div
                    className={cn('h-full rounded-full', level ? level.meta.dot : 'bg-emerald-500')}
                    style={{ width: `${Math.min(100, Math.max(0, shard.usedPct ?? 0))}%` }}
                />
            </div>
        </div>
    )
}

/** Rendered only when a node is filling — see ``graphShardMemory``. The
 *  nodes that still have room are listed alongside it, because "move a
 *  graph to another shard" is unanswerable without them. */
function MemoryHeadroom({ shards }: { shards: ShardMemory[] }) {
    if (shards.length === 0) return null
    const filling = shards.filter(s => s.level)
    const worst = filling.some(s => s.level === 'critical') ? 'critical' : 'warn'
    const { meta } = LEVEL_META[worst]
    const HeadIcon = meta.icon
    return (
        <div className="px-4 pb-4">
            <div className="border border-glass-border rounded-xl p-3 bg-black/[0.02] dark:bg-white/[0.03]">
                <div className="flex items-center gap-2">
                    <HeadIcon className={cn('w-3.5 h-3.5 shrink-0', meta.text)} />
                    <h3 className="text-xs font-semibold text-ink">Memory headroom</h3>
                    {shards.length > 1 && (
                        <span className="ml-auto text-[11px] text-ink-muted">
                            {filling.length} of {shards.length} shards filling
                        </span>
                    )}
                </div>
                <div className="mt-2 space-y-2">
                    {shards.map(s => <ShardMemoryRow key={s.endpoint} shard={s} />)}
                </div>
                {worst === 'critical' && (
                    <p className={cn('mt-2 text-[11px] leading-snug', meta.text)}>{CRITICAL_CONSEQUENCE}</p>
                )}
            </div>
        </div>
    )
}

export function GraphProvidersPanel({ providers, services }: {
    providers: GraphProvider[] | null
    services?: ServiceEntry[] | null
}) {
    const shards = graphShardMemory(services)
    const list = providers ?? []
    // A filling shard is never hidden because no provider rows are registered.
    if (list.length === 0 && shards.length === 0) return null
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
            <MemoryHeadroom shards={shards} />
        </div>
    )
}
