/**
 * Admin → Graph store: every node of every graph store this deployment
 * talks to, and what lives on each.
 *
 * Before this page there was no way to see a graph store as it actually is.
 * The Infrastructure probe counted masters from the environment's own
 * topology; the capacity card read only the nodes that happened to own an
 * aggregated graph. On a nine-node cluster that meant three nodes were
 * visible and six — every replica — were not, so replica memory, replication
 * lag and the graphs on each shard could not be looked at at all.
 *
 * The page answers, in order: how much of the fleet is up, how each instance
 * is laid out, how the load is spread across its shards, what each node
 * holds and allows, how replication is really going, and which graph belongs
 * to which data source. Everything comes from one snapshot the server builds
 * per TTL, so a page full of viewers costs one pass over the nodes.
 */
import { useCallback, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronRight, HardDrive, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePermission } from '@/store/auth'
import { PageContainer } from '@/components/layout/PageContainer'
import { DocsLink } from '@/components/help/DocsLink'
import { GraphStoreLimitsDialog } from '../AdminInfrastructure/GraphStoreLimitsDialog'
import { compactBytes } from '../shared/aggregationKnobs'
import { useGraphStoreTopology, useRemeasureGraphStore } from '../shared/useGraphStoreTopology'
import type { FleetSummary } from '@/services/graphStoreService'
import { InstanceSection } from './InstanceSection'
import { UnreachableNodes } from './NodesTable'
import { GLOSSARY } from './meta'

function OverviewStrip({ summary }: { summary: FleetSummary }) {
    const items: { label: string; value: string; sub?: string }[] = [
        { label: 'Graph stores', value: String(summary.instances), sub: `${summary.providers} provider${summary.providers === 1 ? '' : 's'}` },
        { label: 'Master shards', value: String(summary.masters), sub: 'one owner per slot range' },
        { label: 'Replicas', value: String(summary.replicas), sub: 'standing by for promotion' },
        {
            label: 'Nodes answering',
            value: `${summary.nodesUp}/${summary.nodesTotal}`,
            sub: summary.unreachableNodes > 0 ? `${summary.unreachableNodes} did not answer` : 'all of them',
        },
        {
            label: 'Memory held',
            value: summary.usedMemory != null ? compactBytes(summary.usedMemory) : '—',
            sub: summary.maxmemory != null ? `of ${compactBytes(summary.maxmemory)}` : 'no ceiling reported',
        },
        {
            label: 'Graphs',
            value: summary.graphs.toLocaleString(),
            sub: summary.unregisteredGraphs > 0 ? `${summary.unregisteredGraphs} unregistered` : 'all claimed',
        },
    ]
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {items.map(i => (
                <div key={i.label} className="border border-glass-border rounded-xl bg-canvas-elevated px-4 py-3">
                    <p className="text-xl font-bold text-ink tabular-nums">{i.value}</p>
                    <p className="text-[10px] text-ink-muted mt-0.5 uppercase tracking-wide">{i.label}</p>
                    {i.sub && <p className="text-[10px] text-ink-muted/70 mt-0.5">{i.sub}</p>}
                </div>
            ))}
        </div>
    )
}

function HowToRead() {
    const [open, setOpen] = useState(false)
    return (
        <div className="rounded-xl border border-glass-border bg-canvas-elevated">
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[12px] font-semibold text-ink"
            >
                {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                How to read this page
                <span className="font-normal text-ink-muted">every term on it, in plain language</span>
            </button>
            {open && (
                <dl className="px-4 pb-3 space-y-2" data-testid="graph-store-glossary">
                    {GLOSSARY.map(g => (
                        <div key={g.term}>
                            <dt className="text-[11px] font-semibold text-ink-secondary">{g.term}</dt>
                            <dd className="text-[11px] text-ink-muted leading-snug">{g.text}</dd>
                        </div>
                    ))}
                </dl>
            )}
        </div>
    )
}

export function AdminGraphStore() {
    const isSystemAdmin = usePermission('system:admin')
    const [searchParams, setSearchParams] = useSearchParams()
    const topology = useGraphStoreTopology(true)
    const remeasure = useRemeasureGraphStore()
    const [remeasuring, setRemeasuring] = useState(false)

    const data = topology.data
    const view = searchParams.get('view') === 'nodes' ? 'nodes' : 'shards'
    const focusedShard = searchParams.get('shard')
    const limitsFor = searchParams.get('limits')

    const setParam = useCallback((key: string, value: string | null) => {
        setSearchParams(prev => {
            const p = new URLSearchParams(prev)
            if (value == null) p.delete(key)
            else p.set(key, value)
            return p
        }, { replace: true })
    }, [setSearchParams])

    const closeLimits = useCallback(() => setParam('limits', null), [setParam])

    const reservePct = useMemo(() => {
        const v = data?.limits?.shardReservePct?.value
        return typeof v === 'number' ? v : null
    }, [data])

    const onRemeasure = async () => {
        setRemeasuring(true)
        try { await remeasure() } catch { /* the query's own error state says so */ } finally { setRemeasuring(false) }
    }

    const ageLabel = data
        ? (data.cacheAgeMs < 1000 ? 'just now' : `${Math.round(data.cacheAgeMs / 1000)}s ago`)
        : null

    return (
        <PageContainer gutter="shell" className="py-8 animate-in fade-in duration-500">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                        <HardDrive className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-ink flex items-center gap-2">
                            Graph store
                            <DocsLink slug="graph-store-topology" variant="icon" />
                        </h1>
                        <p className="text-sm text-ink-muted mt-1 max-w-3xl">
                            Every node of every graph store this deployment talks to — masters and replicas — with what each
                            one holds, how far its replicas have fallen behind, and which data source owns each graph.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    {ageLabel && (
                        <span className="text-[11px] text-ink-muted">
                            Measured {ageLabel} · refreshes every {Math.round((data?.ttlS ?? 30))}s
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={onRemeasure}
                        disabled={remeasuring}
                        className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-glass-border text-xs font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors disabled:opacity-50"
                    >
                        <RefreshCw className={cn('w-3.5 h-3.5', remeasuring && 'animate-spin')} />
                        Re-measure
                    </button>
                </div>
            </div>

            {(data?.stale || (topology.isError && data)) && (
                <p
                    data-testid="graph-store-stale-note"
                    className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400"
                >
                    Last refresh failed — showing the reading from {ageLabel}
                    {data?.lastError ? `: ${data.lastError}` : '.'}
                </p>
            )}

            {!data && topology.isLoading ? (
                <div className="flex items-center gap-2 py-8 text-[12px] text-ink-muted">
                    <Loader2 className="w-4 h-4 animate-spin" /> Reading every node…
                </div>
            ) : !data ? (
                <p className="py-8 text-[12px] text-ink-muted">
                    The graph store could not be read right now. Rebuilds still measure the shard they write to before
                    every run; this page will fill in as soon as a node answers.
                </p>
            ) : (
                <div className="space-y-4">
                    <OverviewStrip summary={data.summary} />
                    <HowToRead />
                    <UnreachableNodes instances={data.instances} />

                    <div className="flex items-center gap-2">
                        <div className="inline-flex rounded-lg border border-glass-border overflow-hidden">
                            {(['shards', 'nodes'] as const).map(v => (
                                <button
                                    key={v}
                                    type="button"
                                    onClick={() => setParam('view', v === 'shards' ? null : v)}
                                    aria-pressed={view === v}
                                    className={cn(
                                        'h-7 px-2.5 text-[11px] font-semibold transition-colors',
                                        view === v
                                            ? 'bg-indigo-600 text-white'
                                            : 'text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                                    )}
                                >
                                    {v === 'shards' ? 'By shard' : 'All nodes'}
                                </button>
                            ))}
                        </div>
                        {data.summary.findings > 0 && (
                            <span className="text-[11px] text-amber-600 dark:text-amber-400">
                                {data.summary.findings} replication finding{data.summary.findings === 1 ? '' : 's'} below
                            </span>
                        )}
                    </div>

                    {data.instances.length === 0 ? (
                        <p className="py-6 text-[12px] text-ink-muted">
                            No graph store is configured yet. Add a provider under{' '}
                            <Link to="/ingestion?tab=providers" className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                                Ingestion → Providers
                            </Link>.
                        </p>
                    ) : (
                        data.instances.map(instance => (
                            <InstanceSection
                                key={instance.id}
                                instance={instance}
                                view={view}
                                reservePct={reservePct}
                                canAdjustLimits={isSystemAdmin}
                                focusedShard={focusedShard}
                            />
                        ))
                    )}
                </div>
            )}

            {isSystemAdmin && limitsFor && (
                <GraphStoreLimitsDialog open endpoint={limitsFor} onClose={closeLimits} />
            )}
        </PageContainer>
    )
}
