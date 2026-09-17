/**
 * Every graph store this deployment talks to, one row each, before any of
 * them is opened.
 *
 * The page used to stack every store's shard cards on top of each other, so
 * a deployment with more than one had to be read end to end to answer "which
 * of them is in trouble". A store is the unit an operator compares — its
 * nodes, its memory, its coverage, its findings — and only then the unit
 * they open.
 */
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { GraphStoreInstance } from '@/services/graphStoreService'
import { compactBytes } from '../shared/aggregationKnobs'

/** The fullest master on a store — the one that decides when it stops taking
 *  rollups, whatever the average across the others says. */
function worstMasterPct(instance: GraphStoreInstance): number | null {
    const pcts = instance.shards
        .map(s => {
            const m = s.master.memory
            if (m?.usedPct != null) return m.usedPct
            if (m?.used != null && m?.maxmemory) return (m.used * 100) / m.maxmemory
            return null
        })
        .filter((v): v is number => v != null)
    return pcts.length ? Math.max(...pcts) : null
}

function severityOf(instance: GraphStoreInstance): 'critical' | 'warn' | null {
    const all = instance.shards.flatMap(s => s.replication.findings)
    if (all.some(f => f.severity === 'critical')) return 'critical'
    if (all.some(f => f.severity === 'warn')) return 'warn'
    return null
}

export function StoreRow({ instance, onOpen }: {
    instance: GraphStoreInstance
    onOpen: (instanceId: string) => void
}) {
    const t = instance.totals
    const pct = worstMasterPct(instance)
    const severity = severityOf(instance)
    const findings = instance.shards.reduce((n, s) => n + s.replication.findings.length, 0)
    const coverageShort = instance.mode === 'cluster'
        && instance.slotsCovered != null && instance.slotsCovered < 16_384
    const nodesShort = t.nodesUp < t.nodesTotal

    return (
        <button
            type="button"
            onClick={() => onOpen(instance.id)}
            data-testid={`store-row-${instance.id}`}
            className="w-full text-left rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
        >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[13px] font-semibold text-ink">
                    {instance.providers.map(p => p.name ?? p.id).join(', ')
                        || instance.seeds[0] || instance.id}
                </span>
                <span className="text-[11px] text-ink-muted">{instance.mode}</span>
                {instance.providers.length > 1 && (
                    <HoverTip
                        label="One store, several provider rows"
                        detail="These rows reach the same servers, so the figures on this line are the store's — not each row's."
                    >
                        <span className="rounded-full border border-glass-border px-1.5 py-0.5 text-[10px] text-ink-muted">
                            {instance.providers.length} rows
                        </span>
                    </HoverTip>
                )}
                {severity && (
                    <span className={cn(
                        'rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                        severity === 'critical'
                            ? 'border-red-500/30 text-red-600 dark:text-red-400'
                            : 'border-amber-500/30 text-amber-600 dark:text-amber-400',
                    )}>
                        {findings} finding{findings === 1 ? '' : 's'}
                    </span>
                )}
                <ChevronRight className="w-3.5 h-3.5 text-ink-muted ml-auto shrink-0" />
            </div>

            <p className="mt-1 text-[11px] text-ink-muted tabular-nums">
                {t.masters} master{t.masters === 1 ? '' : 's'} · {t.replicas} replica{t.replicas === 1 ? '' : 's'}
                {' · '}
                <span className={cn(nodesShort && 'text-amber-600 dark:text-amber-400 font-semibold')}>
                    {t.nodesUp}/{t.nodesTotal} answering
                </span>
                {instance.mode === 'cluster' && instance.slotsCovered != null && (
                    <span className={cn(coverageShort && 'text-red-600 dark:text-red-400 font-semibold')}>
                        {' · '}{instance.slotsCovered.toLocaleString()}/16,384 slots
                    </span>
                )}
                {t.usedMemory != null && ` · ${compactBytes(t.usedMemory)} of ${compactBytes(t.maxmemory)} on masters`}
                {' · '}{t.graphs.toLocaleString()} graph{t.graphs === 1 ? '' : 's'}
                {t.unregisteredGraphs > 0 && ` (${t.unregisteredGraphs} unregistered)`}
            </p>

            {pct != null && (
                <div className="mt-1.5 flex items-center gap-2">
                    <div
                        role="meter"
                        aria-valuenow={Math.round(pct)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`fullest master ${Math.round(pct)}% used`}
                        className="h-1.5 flex-1 rounded-full overflow-hidden bg-black/5 dark:bg-white/10"
                    >
                        <div
                            className={cn('h-full rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500')}
                            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                        />
                    </div>
                    <span className="text-[10px] text-ink-muted tabular-nums shrink-0">
                        fullest master {Math.round(pct)}%
                    </span>
                </div>
            )}

            {!instance.reachable && (
                <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                    Could not be reached: {instance.error ?? 'no seed answered'}.
                </p>
            )}
        </button>
    )
}

export function StoresOverview({ instances, onOpen }: {
    instances: GraphStoreInstance[]
    onOpen: (instanceId: string) => void
}) {
    if (instances.length === 0) {
        return (
            <p className="py-6 text-[12px] text-ink-muted">
                No graph store is configured yet. Add a provider under{' '}
                <Link to="/ingestion?tab=providers" className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                    Ingestion → Providers
                </Link>.
            </p>
        )
    }
    return (
        <div className="space-y-2" data-testid="stores-overview">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                Graph stores · open one for its shards, memory and capacity
            </h2>
            {instances.map(instance => (
                <StoreRow key={instance.id} instance={instance} onOpen={onOpen} />
            ))}
        </div>
    )
}
