/**
 * What a provider's connection actually reaches: how many shards, how many
 * replicas, how many nodes are answering — and, expanded, every one of them.
 *
 * A provider row says "cluster" and lists seeds. That is what was CONFIGURED.
 * This says what is there.
 */
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'
import type { ProviderTopologyResponse } from '@/services/graphStoreService'
import { useProviderTopology } from '../shared/useGraphStoreTopology'
import { NodesTable } from './NodesTable'

export function ProviderTopologyLine({ providerId, className }: { providerId: string; className?: string }) {
    const { data } = useProviderTopology(providerId)
    const instance = data?.instance
    if (!data) return null
    if (!instance) {
        return (
            <p className={cn('text-[11px] text-ink-muted', className)} data-testid="provider-topology-line">
                {data.lastError ?? 'This provider is not in the graph store topology yet.'}
            </p>
        )
    }
    const t = instance.totals
    const missing = instance.mode === 'cluster'
        && instance.slotsCovered != null && instance.slotsCovered < 16_384
    return (
        <p
            className={cn('text-[11px]', missing || t.nodesUp < t.nodesTotal ? 'text-amber-600 dark:text-amber-400' : 'text-ink-muted', className)}
            data-testid="provider-topology-line"
        >
            {instance.mode}
            {' · '}{t.masters} master shard{t.masters === 1 ? '' : 's'}
            {' · '}{t.replicas} replica{t.replicas === 1 ? '' : 's'}
            {' · '}{t.nodesUp}/{t.nodesTotal} nodes up
            {instance.mode === 'cluster' && instance.slotsCovered != null
                && ` · ${instance.slotsCovered.toLocaleString()}/16,384 slots`}
            {!instance.reachable && ` · unreachable: ${instance.error ?? 'no seed answered'}`}
            {readsLabel(data.reads) && ` · ${readsLabel(data.reads)}`}
        </p>
    )
}

/** "62% of reads from replicas" — the one thing that says whether replica
 *  routing is actually happening. A replica read and a master read look
 *  identical from the outside, so without this an operator cannot tell. */
function readsLabel(reads: ProviderTopologyResponse['reads']): string | null {
    if (!reads) return null
    const total = reads.replicaReads + reads.masterReads
    if (total < 20) return null                      // too few to mean anything
    const pct = Math.round((reads.replicaReads * 100) / total)
    const fallbacks = reads.replicaFallbacks > 0
        ? `, ${reads.replicaFallbacks} fell back` : ''
    return `${pct}% of reads from replicas${fallbacks}`
}

export function ProviderTopologyBlock({ providerId }: { providerId: string }) {
    const { data } = useProviderTopology(providerId)
    const instance = data?.instance
    if (!instance || instance.shards.length === 0) return null
    return (
        <div data-testid="provider-topology-block">
            <div className="flex items-center justify-between gap-2 mb-1">
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Nodes</h4>
                <Link
                    /* Straight to THIS provider's store: with more than one,
                       a bare link lands on the picker and asks the operator
                       to find again what they were already looking at. */
                    to={`/admin/graph-store?store=${encodeURIComponent(instance.id)}`}
                    className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                    Open in Graph store
                </Link>
            </div>
            <NodesTable instance={instance} compact />
        </div>
    )
}
