/**
 * Freshness — the Ingestion → Freshness cockpit.
 *
 * A cross-workspace operator view of every data source's aggregation/cache
 * freshness, grouped by provider, with per-source refresh actions and a
 * guarded per-provider batch refresh (system:admin only).
 *
 * Reads never trigger a rebuild; the fleet endpoint does no provider work.
 * Copy is plain-language and white-label throughout.
 */
import { Fragment, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Filter, RefreshCw, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { usePermission } from '@/store/auth'
import { useToast } from '@/components/ui/toast'
import { ConfirmDialog } from '@/components/admin/job-history/ConfirmDialog'
import { providerService } from '@/services/providerService'
import { workspaceService } from '@/services/workspaceService'
import type { FreshnessRow as FreshnessRowData, RefreshScope } from '@/services/freshnessService'
import { FreshnessRow } from './FreshnessRow'
import { FreshnessDrawer } from './FreshnessDrawer'
import { ProviderRefreshDialog } from './ProviderRefreshDialog'
import { useFleetFreshness, useRefreshSource } from './useFreshness'

const SCOPE_LABEL: Record<RefreshScope, string> = {
    auto: 'Refresh',
    'read-caches': 'Refresh caches',
    rollups: 'Rebuild lineage',
    full: 'Full refresh',
}

/** A row wants attention when its lineage is stale, drifted, or its last
 *  aggregation failed. Mirrors the fleet's "needs attention" definition. */
function needsAttention(row: FreshnessRowData): boolean {
    return !!row.staleReason || row.drifted === true || row.aggregationStatus === 'failed'
}

export function Freshness() {
    useDocumentTitle('Freshness')
    const isSystemAdmin = usePermission('system:admin')
    const { showToast } = useToast()

    const [workspaceId, setWorkspaceId] = useState('')
    const [providerId, setProviderId] = useState('')
    const [attentionOnly, setAttentionOnly] = useState(false)

    const [drawerDsId, setDrawerDsId] = useState<string | null>(null)
    const [confirm, setConfirm] = useState<{ dsId: string; scope: RefreshScope } | null>(null)
    const [providerDialog, setProviderDialog] = useState<{ id: string; name: string } | null>(null)

    const fleet = useFleetFreshness({
        workspaceId: workspaceId || undefined,
        providerId: providerId || undefined,
    })
    const refreshSource = useRefreshSource()

    // Stable filter options + workspace-name resolution (independent of the
    // current filter, so the dropdowns don't collapse when one is applied).
    const workspacesQ = useQuery({
        queryKey: ['freshness', 'workspaces'],
        queryFn: () => workspaceService.list(),
        staleTime: 5 * 60_000,
    })
    const providersQ = useQuery({
        queryKey: ['freshness', 'providers'],
        queryFn: () => providerService.list(),
        staleTime: 5 * 60_000,
    })
    const workspaceName = useMemo(() => {
        const m = new Map<string, string>()
        for (const w of workspacesQ.data ?? []) m.set(w.id, w.name)
        return m
    }, [workspacesQ.data])

    const rows = fleet.data?.rows ?? []
    const visibleRows = attentionOnly ? rows.filter(needsAttention) : rows
    const attentionCount = rows.filter(needsAttention).length

    // Group by provider, preserving the server's per-source ordering.
    const groups = useMemo(() => {
        const byProvider = new Map<string, { name: string; rows: FreshnessRowData[] }>()
        for (const row of visibleRows) {
            const pid = row.providerId ?? '—'
            const g = byProvider.get(pid) ?? { name: row.providerName || 'Unknown provider', rows: [] }
            g.rows.push(row)
            byProvider.set(pid, g)
        }
        return [...byProvider.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))
    }, [visibleRows])

    const doRefresh = (dsId: string, scope: RefreshScope) => {
        const name = rows.find(r => r.dataSourceId === dsId)?.name || 'source'
        refreshSource.mutate({ dsId, scope }, {
            onSuccess: () => {
                const msg = scope === 'read-caches'
                    ? `Caches refreshed for ${name}.`
                    : scope === 'rollups'
                        ? `Lineage rebuild queued for ${name}.`
                        : `Full refresh started for ${name}.`
                showToast('success', msg)
            },
            onError: (e) => showToast('error', e.message || 'Refresh failed.'),
        })
    }

    // read-caches is non-destructive → run immediately; rebuilds confirm first.
    const onRefresh = (dsId: string, scope: RefreshScope) => {
        if (scope === 'read-caches') doRefresh(dsId, scope)
        else setConfirm({ dsId, scope })
    }

    const busyDsId = refreshSource.isPending ? refreshSource.variables?.dsId : undefined
    const truncated = (fleet.data?.total ?? 0) > rows.length

    return (
        <div className="space-y-4">
            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2">
                <Filter className="w-4 h-4 text-ink-muted" />
                <select
                    aria-label="Filter by workspace"
                    value={workspaceId}
                    onChange={(e) => setWorkspaceId(e.target.value)}
                    className="h-8 rounded-lg border border-glass-border bg-canvas px-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                >
                    <option value="">All workspaces</option>
                    {(workspacesQ.data ?? []).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
                <select
                    aria-label="Filter by provider"
                    value={providerId}
                    onChange={(e) => setProviderId(e.target.value)}
                    className="h-8 rounded-lg border border-glass-border bg-canvas px-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                >
                    <option value="">All providers</option>
                    {(providersQ.data ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button
                    onClick={() => setAttentionOnly(v => !v)}
                    className={cn(
                        'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-semibold transition-colors',
                        attentionOnly
                            ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                            : 'border-glass-border text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                    )}
                >
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Needs attention{attentionCount > 0 ? ` (${attentionCount})` : ''}
                </button>

                <div className="ml-auto flex items-center gap-2">
                    <span className="text-[11px] text-ink-muted">
                        {fleet.data?.total ?? 0} {(fleet.data?.total ?? 0) === 1 ? 'source' : 'sources'}
                    </span>
                    <button
                        onClick={() => fleet.refetch()}
                        disabled={fleet.isFetching}
                        aria-label="Reload freshness"
                        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-glass-border text-xs font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors disabled:opacity-50"
                    >
                        <RefreshCw className={cn('w-3.5 h-3.5', fleet.isFetching && 'animate-spin')} />
                        Reload
                    </button>
                </div>
            </div>

            {truncated && (
                <div className="rounded-xl border border-glass-border bg-glass-base/30 px-4 py-2 text-[11px] text-ink-muted">
                    Showing the {rows.length} most recently updated sources of {fleet.data?.total}. Use the filters to narrow the list.
                </div>
            )}

            {/* Table */}
            {fleet.isLoading ? (
                <div className="flex items-center gap-2 justify-center py-16 text-sm text-ink-muted">
                    <RefreshCw className="w-4 h-4 animate-spin" /> Loading freshness…
                </div>
            ) : fleet.isError ? (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
                    Could not load freshness. <button onClick={() => fleet.refetch()} className="underline">Retry</button>
                </div>
            ) : visibleRows.length === 0 ? (
                <div className="rounded-xl border border-glass-border bg-glass-base/20 px-4 py-12 text-center text-sm text-ink-muted">
                    {attentionOnly ? 'Nothing needs attention right now.' : 'No data sources match these filters.'}
                </div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-glass-border">
                    <table className="w-full min-w-[720px] text-left">
                        <thead>
                            <tr className="text-[10px] uppercase tracking-wide text-ink-muted">
                                <th className="px-3 py-2 font-semibold">Source</th>
                                <th className="px-3 py-2 font-semibold">Aggregation</th>
                                <th className="px-3 py-2 font-semibold">Cache</th>
                                <th className="px-3 py-2 font-semibold">Freshness</th>
                                <th className="px-3 py-2 font-semibold">Last activity</th>
                                <th className="px-3 py-2 font-semibold text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {groups.map(([pid, g]) => (
                                <Fragment key={pid}>
                                    <tr className="bg-black/[0.02] dark:bg-white/[0.02] border-t border-glass-border">
                                        <td colSpan={5} className="px-3 py-2">
                                            <span className="text-xs font-semibold text-ink-secondary">{g.name}</span>
                                            <span className="ml-2 text-[11px] text-ink-muted">
                                                {g.rows.length} {g.rows.length === 1 ? 'source' : 'sources'}
                                            </span>
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                            {isSystemAdmin && pid !== '—' && (
                                                <button
                                                    onClick={() => setProviderDialog({ id: pid, name: g.name })}
                                                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 transition-colors"
                                                >
                                                    <Zap className="w-3.5 h-3.5" /> Refresh provider…
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                    {g.rows.map(row => (
                                        <FreshnessRow
                                            key={row.dataSourceId}
                                            row={row}
                                            workspaceName={row.workspaceId ? workspaceName.get(row.workspaceId) : undefined}
                                            onOpenDrawer={setDrawerDsId}
                                            onRefresh={onRefresh}
                                            busy={busyDsId === row.dataSourceId}
                                        />
                                    ))}
                                </Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <FreshnessDrawer
                key={drawerDsId ?? 'closed'}
                dsId={drawerDsId}
                isOpen={drawerDsId != null}
                onClose={() => setDrawerDsId(null)}
                workspaceName={
                    drawerDsId
                        ? workspaceName.get(rows.find(r => r.dataSourceId === drawerDsId)?.workspaceId ?? '')
                        : undefined
                }
            />

            <ConfirmDialog
                open={confirm != null}
                title={confirm ? SCOPE_LABEL[confirm.scope] : ''}
                message={
                    confirm?.scope === 'full'
                        ? 'This refreshes caches and rebuilds aggregated lineage for this source. It can take a while.'
                        : 'This rebuilds aggregated lineage for this source. It can take a while.'
                }
                confirmLabel={confirm ? SCOPE_LABEL[confirm.scope] : ''}
                confirmColor="bg-indigo-600 hover:bg-indigo-700 shadow-md"
                confirmIcon={Zap}
                onConfirm={() => {
                    if (confirm) doRefresh(confirm.dsId, confirm.scope)
                    setConfirm(null)
                }}
                onCancel={() => setConfirm(null)}
            />

            <ProviderRefreshDialog
                key={providerDialog?.id ?? 'closed'}
                providerId={providerDialog?.id ?? null}
                providerName={providerDialog?.name ?? ''}
                isOpen={providerDialog != null}
                onClose={() => setProviderDialog(null)}
            />
        </div>
    )
}
