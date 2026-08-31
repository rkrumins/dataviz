/**
 * GraphProvidersPanel — every registered graph data provider and its
 * reachability, whatever the type (FalkorDB, Neo4j, Spanner, DataHub…).
 * Fully data-driven from the snapshot's ``graphProviders`` list; status
 * comes from the shared provider resolver, so this reflects exactly what
 * the app experiences — no per-type checks here.
 */
import { Boxes } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GraphProvider } from '@/services/systemStatusService'
import { providerLabel } from '@/services/providerTypes'
import { STATUS_META } from './meta'

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
                    {providerLabel(p.type)}
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

export function GraphProvidersPanel({ providers }: { providers: GraphProvider[] | null }) {
    if (!providers || providers.length === 0) return null
    const down = providers.filter(p => p.status === 'down').length

    return (
        <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden">
            <div className="px-5 pt-4 pb-3 flex items-center gap-2">
                <Boxes className="w-4 h-4 text-indigo-500" />
                <div>
                    <h2 className="text-sm font-semibold text-ink">Graph data providers</h2>
                    <p className="text-[11px] text-ink-muted">Reachability of every registered graph backend, by type.</p>
                </div>
                <span className="ml-auto text-[11px] text-ink-muted">
                    {providers.length} provider{providers.length === 1 ? '' : 's'}{down > 0 ? ` · ${down} unreachable` : ''}
                </span>
            </div>
            <div className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {providers.map(p => <ProviderCard key={p.id} p={p} />)}
            </div>
        </div>
    )
}
