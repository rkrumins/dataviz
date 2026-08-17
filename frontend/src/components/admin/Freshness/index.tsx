/**
 * Freshness — the Ingestion → Freshness triage cockpit.
 *
 * Overlay integrity briefs the schedule and live verdict; Start here guides
 * attention; the stat band doubles as the status filter; a sticky faceted bar
 * (status, provider, workspace, search) refines the fleet; the table groups by
 * provider and orders by severity.
 *
 * All facet state lives in the URL search params (shared with Ingestion's
 * ``?tab=``), so reload and back/forward restore the view. Provider/workspace
 * facets filter client-side over the fetched page (≤200 rows). Reads never
 * trigger a rebuild.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Zap } from 'lucide-react'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { usePermission, checkPermission, usePermissionClaims } from '@/store/auth'
import { useToast } from '@/components/ui/toast'
import { ConfirmDialog } from '@/components/admin/job-history/ConfirmDialog'
import { workspaceService } from '@/services/workspaceService'
import { aggregationService } from '@/services/aggregationService'
import type { FreshnessRow as FreshnessRowData, ProviderFreshnessSummary, RefreshScope } from '@/services/freshnessService'
import { FreshnessRow } from './FreshnessRow'
import { FreshnessDrawer } from './FreshnessDrawer'
import { ProviderRefreshDialog } from './ProviderRefreshDialog'
import { FleetRefreshDialog } from './FleetRefreshDialog'
import { FreshnessStatBand } from './FreshnessStatBand'
import { FreshnessFilterBar } from './FreshnessFilterBar'
import { FreshnessGroupHeader } from './FreshnessGroupHeader'
import { AutomationModal } from './AutomationModal'
import { OverlayIntegrity } from './OverlayIntegrity'
import { useFleetFreshness, useRefreshSource, FRESHNESS_KEYS } from './useFreshness'
import { useActiveJobs, ACTIVE_JOBS_KEY } from './useActiveJobs'
import {
    compareSeverity, freshnessState, isGroupAttention, matchesFacet, matchesFailureFacet,
    type FailureFacet, type StatusFacet,
} from './freshnessTriage'
import { asFailureCategory } from './failureGuidance'
import { parseDriftWindow } from './reconcileHealth'
import { StartHereStrip } from './StartHereStrip'
import { BulkRetryBar } from './BulkRetryBar'
import { SelectionCheckbox } from './SelectionCheckbox'

const SCOPE_LABEL: Record<RefreshScope, string> = {
    auto: 'Refresh',
    'read-caches': 'Refresh caches',
    clear: 'Clear cache',
    rollups: 'Rebuild lineage',
    full: 'Full refresh',
}

const COLS = 7

const STATUS_FACETS: readonly StatusFacet[] = ['ready', 'pending', 'needsAttention', 'notBuilt', 'cacheStamped', 'drifting', 'suspended']
const FAILURE_FACETS: readonly FailureFacet[] = [
    'out_of_memory', 'provider_unavailable', 'ontology', 'timeout', 'conflict', 'unknown',
]

function parseStatus(raw: string | null): StatusFacet {
    return (raw && (STATUS_FACETS as readonly string[]).includes(raw)) ? (raw as StatusFacet) : ''
}

function parseFailure(raw: string | null): FailureFacet {
    return (raw && (FAILURE_FACETS as readonly string[]).includes(raw)) ? (raw as FailureFacet) : ''
}

function parseList(raw: string | null): string[] {
    return (raw || '').split(',').filter(Boolean)
}

export function Freshness() {
    useDocumentTitle('Freshness')
    const isSystemAdmin = usePermission('system:admin')
    const { showToast } = useToast()

    const [searchParams, setSearchParams] = useSearchParams()

    // ── URL-synced facet state ────────────────────────────────────────
    const fprov = useMemo(() => parseList(searchParams.get('fprov')), [searchParams])
    const fws = useMemo(() => parseList(searchParams.get('fws')), [searchParams])
    const fstatus = parseStatus(searchParams.get('fstatus'))
    const ffail = parseFailure(searchParams.get('ffail'))
    const fwin = parseDriftWindow(searchParams.get('fwin'))
    const fq = searchParams.get('fq') ?? ''

    // Patch specific params, preserving everything else (notably ``tab``).
    // Discrete facet changes push a history entry; only debounced search
    // typing replaces (so keystrokes don't flood back/forward).
    const patchParams = useCallback((patch: Record<string, string | null>, replace = false) => {
        setSearchParams(prev => {
            const p = new URLSearchParams(prev)
            for (const [k, v] of Object.entries(patch)) {
                if (v == null || v === '') p.delete(k)
                else p.set(k, v)
            }
            return p
        }, { replace })
    }, [setSearchParams])

    // Search: immediate local box, debounced (~200ms) into the URL. A ref of
    // the last value we wrote lets external navigation (back/forward) adopt a
    // new ``fq`` without a facet toggle clobbering unsynced keystrokes.
    const [searchInput, setSearchInput] = useState(() => searchParams.get('fq') ?? '')
    const prevUrlQ = useRef(fq)
    useEffect(() => {
        const id = setTimeout(() => {
            if (searchInput !== (searchParams.get('fq') ?? '')) {
                patchParams({ fq: searchInput || null }, true)
            }
        }, 200)
        return () => clearTimeout(id)
    }, [searchInput, searchParams, patchParams])
    useEffect(() => {
        if (fq !== prevUrlQ.current) {
            prevUrlQ.current = fq
            setSearchInput(prev => (prev === fq ? prev : fq))
        }
    }, [fq])

    // The open drawer lives in the URL, not local state, so a link from
    // elsewhere in the app — a reconciliation job in Job History, a data
    // source profile — can land directly on one source's detail instead of
    // dropping the reader on an unfiltered fleet table to find it again.
    // Back/forward and a copied link both work as a result.
    const drawerDsId = searchParams.get('fds')
    const setDrawerDsId = useCallback(
        (id: string | null) => patchParams({ fds: id }),
        [patchParams],
    )
    // Stable for the same reason as closeAutomation below: it feeds the
    // drawer's focus effect.
    const closeDrawer = useCallback(() => setDrawerDsId(null), [setDrawerDsId])

    // The Automation modal opens from the URL for the same reason the drawer
    // does: "here is how the schedule is configured" is a link someone sends.
    const automationOpen = searchParams.get('automation') === 'open'
    const openAutomation = useCallback(() => patchParams({ automation: 'open' }), [patchParams])
    // Stable: it feeds the modal's focus effect, and a fresh identity on every
    // render of this page would pull focus back to the dialog mid-keystroke.
    const closeAutomation = useCallback(() => patchParams({ automation: null }), [patchParams])

    // ── Local (non-URL) UI state ──────────────────────────────────────
    const [confirm, setConfirm] = useState<{ dsId: string; scope: RefreshScope; firstBuild?: boolean } | null>(null)
    const [providerDialog, setProviderDialog] = useState<{ id: string; name: string } | null>(null)
    const [fleetDialogOpen, setFleetDialogOpen] = useState(false)
    const [expandOverride, setExpandOverride] = useState<Record<string, boolean>>({})
    const [expandedRow, setExpandedRow] = useState<string | null>(null)
    const [selectedIds, setSelectedIds] = useState<string[]>([])

    // ── Data ──────────────────────────────────────────────────────────
    // No server-side provider/workspace/stale filter: those are client facets
    // now, so one broad fetch feeds both the table and a fleet-wide summary.
    const fleet = useFleetFreshness()
    const activeJobs = useActiveJobs()
    const refreshSource = useRefreshSource()

    // The panel already disappears once its job leaves the feed (canExpand
    // goes false), but `expandedRow` itself would stay set — re-opening the
    // panel unasked the moment a later, unrelated job joins for that source.
    useEffect(() => {
        if (expandedRow && !activeJobs.byDataSource.has(expandedRow)) {
            setExpandedRow(null)
        }
    }, [expandedRow, activeJobs.byDataSource])

    const qc = useQueryClient()
    const onCancelJob = useCallback(async (dsId: string, jobId: string) => {
        try {
            await aggregationService.cancelJob(dsId, jobId)
            showToast('success', 'Rebuild cancelled.')
        } catch (e) {
            showToast('error', (e as Error).message || 'Could not cancel the rebuild.')
        }
        void qc.invalidateQueries({ queryKey: ACTIVE_JOBS_KEY })
        void qc.invalidateQueries({ queryKey: FRESHNESS_KEYS.fleetPrefix })
    }, [qc, showToast])

    const workspacesQ = useQuery({
        queryKey: ['freshness', 'workspaces'],
        queryFn: () => workspaceService.list(),
        staleTime: 5 * 60_000,
    })
    const workspaceName = useMemo(() => {
        const m = new Map<string, string>()
        for (const w of workspacesQ.data ?? []) m.set(w.id, w.name)
        return m
    }, [workspacesQ.data])

    const rows = useMemo(() => fleet.data?.rows ?? [], [fleet.data])
    const summary = fleet.data?.summary ?? null

    // Per-provider coverage summaries, keyed to match the group id (the
    // no-provider group is '—'). Null above the summary cap → the group
    // header degrades to a client count over its own rows.
    const providerSummaryById = useMemo(() => {
        const m = new Map<string, ProviderFreshnessSummary>()
        for (const ps of fleet.data?.providerSummaries ?? []) {
            m.set(ps.providerId ?? '—', ps)
        }
        return m
    }, [fleet.data])

    // ── Facet options + counts (from the fetched rows) ────────────────
    const providerOptions = useMemo(() => {
        const m = new Map<string, { name: string; count: number }>()
        for (const r of rows) {
            if (!r.providerId) continue
            const e = m.get(r.providerId) ?? { name: r.providerName || 'Unknown provider', count: 0 }
            e.count++
            m.set(r.providerId, e)
        }
        return [...m.entries()]
            .map(([id, e]) => ({ id, label: e.name, sublabel: `${e.count} ${e.count === 1 ? 'source' : 'sources'}` }))
            .sort((a, b) => a.label.localeCompare(b.label))
    }, [rows])

    const workspaceOptions = useMemo(() => {
        const m = new Map<string, number>()
        for (const r of rows) {
            if (r.workspaceId) m.set(r.workspaceId, (m.get(r.workspaceId) ?? 0) + 1)
        }
        return [...m.entries()]
            .map(([id, count]) => ({ id, label: workspaceName.get(id) || id, sublabel: `${count} ${count === 1 ? 'source' : 'sources'}` }))
            .sort((a, b) => a.label.localeCompare(b.label))
    }, [rows, workspaceName])

    // ── Filtering: provider/workspace scope → status facet + name search ─
    const scopeRows = useMemo(() => {
        const provSet = new Set(fprov)
        const wsSet = new Set(fws)
        return rows.filter(r =>
            (provSet.size === 0 || (r.providerId != null && provSet.has(r.providerId))) &&
            (wsSet.size === 0 || (r.workspaceId != null && wsSet.has(r.workspaceId))),
        )
    }, [rows, fprov, fws])

    const q = fq.trim().toLowerCase()
    const tableRows = useMemo(() => scopeRows.filter(r =>
        matchesFacet(r, fstatus) &&
        matchesFailureFacet(r, ffail) &&
        (q === '' ||
            (r.name || r.dataSourceId).toLowerCase().includes(q) ||
            (r.providerName ?? '').toLowerCase().includes(q)),
    ), [scopeRows, fstatus, ffail, q])

    // ── Grouping: attention groups first, severity-sorted within ──────
    const groups = useMemo(() => {
        const byProvider = new Map<string, { name: string; rows: FreshnessRowData[] }>()
        for (const row of tableRows) {
            const pid = row.providerId ?? '—'
            const g = byProvider.get(pid) ?? { name: row.providerName || 'Unknown provider', rows: [] }
            g.rows.push(row)
            byProvider.set(pid, g)
        }
        const arr = [...byProvider.entries()]
        for (const [, g] of arr) g.rows.sort(compareSeverity)
        arr.sort((a, b) => {
            const aa = a[1].rows.filter(isGroupAttention).length
            const bb = b[1].rows.filter(isGroupAttention).length
            if ((aa > 0) !== (bb > 0)) return aa > 0 ? -1 : 1
            if (aa !== bb) return bb - aa
            return a[1].name.localeCompare(b[1].name)
        })
        return arr
    }, [tableRows])

    // Healthy groups default collapsed; attention groups default expanded.
    // A manual toggle wins.
    const isExpanded = (pid: string, hasAttention: boolean) => expandOverride[pid] ?? hasAttention
    const toggleGroup = (pid: string, currentlyExpanded: boolean) =>
        setExpandOverride(prev => ({ ...prev, [pid]: !currentlyExpanded }))

    // ── Sticky offset: the header row pins just under the filter bar ──
    const stickyRef = useRef<HTMLDivElement>(null)
    const [headerTop, setHeaderTop] = useState(0)
    useLayoutEffect(() => {
        const el = stickyRef.current
        if (!el) return
        const measure = () => setHeaderTop(el.offsetHeight)
        measure()
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
    }, [fprov, fws, fstatus, ffail, fq])

    // ── Refresh actions ───────────────────────────────────────────────
    const doRefresh = (dsId: string, scope: RefreshScope, firstBuild?: boolean) => {
        const name = rows.find(r => r.dataSourceId === dsId)?.name || 'source'
        refreshSource.mutate({ dsId, scope }, {
            onSuccess: () => {
                const msg = scope === 'read-caches'
                    ? `Caches refreshed for ${name}.`
                    : scope === 'clear'
                        ? `Cache cleared for ${name}.`
                        : scope === 'rollups'
                            ? `Lineage ${firstBuild ? 'build' : 'rebuild'} queued for ${name}.`
                            : `Full refresh started for ${name}.`
                showToast('success', msg)
            },
            onError: (e) => showToast('error', e.message || 'Refresh failed.'),
        })
    }

    // read-caches and clear are non-destructive (no rebuild) → run immediately;
    // rebuilds confirm first.
    const onRefresh = (dsId: string, scope: RefreshScope, opts?: { firstBuild?: boolean }) => {
        if (scope === 'read-caches' || scope === 'clear') doRefresh(dsId, scope)
        else setConfirm({ dsId, scope, firstBuild: opts?.firstBuild })
    }

    const busyDsId = refreshSource.isPending ? refreshSource.variables?.dsId : undefined
    const truncated = (fleet.data?.total ?? 0) > rows.length
    const hasFilters = fprov.length > 0 || fws.length > 0 || fstatus !== '' || ffail !== '' || q !== ''
    const clearAll = () => patchParams({ fprov: null, fws: null, fstatus: null, ffail: null, fq: null })
    const buildMode = confirm?.firstBuild === true

    const toggleSelect = useCallback((id: string) => {
        setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
    }, [])

    const permissionClaims = usePermissionClaims()
    const selectableIds = useMemo(() => (
        tableRows
            .filter(r => freshnessState(r) !== 'recomputing')
            .filter(r => checkPermission(permissionClaims, 'workspace:datasource:manage', r.workspaceId))
            .map(r => r.dataSourceId)
    ), [tableRows, permissionClaims])

    const allSelectableSelected = selectableIds.length > 0
        && selectableIds.every(id => selectedIds.includes(id))
    const someSelectableSelected = selectableIds.some(id => selectedIds.includes(id))

    const toggleSelectAll = useCallback(() => {
        setSelectedIds(prev => {
            if (selectableIds.length === 0) return prev
            const allOn = selectableIds.every(id => prev.includes(id))
            if (allOn) return prev.filter(id => !selectableIds.includes(id))
            const merged = new Set(prev)
            for (const id of selectableIds) merged.add(id)
            return Array.from(merged)
        })
    }, [selectableIds])

    // Only visible selections count (facet change / refetch): derived, not
    // pruned in an effect, so a facet-hidden selection reappears when the
    // facet is cleared and the bulk bar still only ever acts on visible rows.
    const visibleSelectedIds = useMemo(() => {
        const visible = new Set(tableRows.map(r => r.dataSourceId))
        return selectedIds.filter(id => visible.has(id))
    }, [selectedIds, tableRows])

    return (
        <div className={`space-y-4${visibleSelectedIds.length > 0 ? ' pb-24' : ''}`}>
            <OverlayIntegrity
                summary={summary}
                activeFacet={fstatus}
                onFacet={(facet) => patchParams({ fstatus: facet || null })}
                onOpenAutomation={openAutomation}
                onReload={() => { void fleet.refetch() }}
                reloading={fleet.isFetching}
                onRefreshAll={isSystemAdmin ? () => setFleetDialogOpen(true) : undefined}
                onOpenSource={setDrawerDsId}
                window={fwin}
                onWindowChange={(w) => patchParams({ fwin: w === '24h' ? null : w })}
            />

            <StartHereStrip
                summary={summary}
                rows={scopeRows}
                status={fstatus}
                failureFacet={ffail}
                onStatus={(facet) => patchParams({ fstatus: facet || null })}
                onFailure={(facet) => patchParams({
                    ffail: facet || null,
                    // Cause filters imply looking at failures.
                    fstatus: facet ? 'needsAttention' : (fstatus || null),
                })}
                onClear={() => patchParams({ fstatus: null, ffail: null })}
            />

            {/* Stat band — scrolls away; the tiles are the status filter. */}
            <FreshnessStatBand
                summary={summary}
                activeFacet={fstatus}
                onToggle={(facet) => patchParams({ fstatus: facet || null })}
            />

            {/* Sticky faceted filter bar */}
            <div ref={stickyRef} className="sticky top-0 z-20 -mt-1 bg-canvas border-b border-glass-border py-2.5">
                <FreshnessFilterBar
                    providerOptions={providerOptions}
                    selectedProviders={fprov}
                    onProvidersChange={(ids) => patchParams({ fprov: ids.join(',') || null })}
                    workspaceOptions={workspaceOptions}
                    selectedWorkspaces={fws}
                    onWorkspacesChange={(ids) => patchParams({ fws: ids.join(',') || null })}
                    status={fstatus}
                    onStatusChange={(s) => patchParams({ fstatus: s || null, ffail: null })}
                    failureFacet={ffail}
                    onFailureChange={(f) => patchParams({ ffail: f || null })}
                    search={searchInput}
                    onSearchChange={setSearchInput}
                    onClearAll={clearAll}
                    summary={summary}
                />
            </div>

            {truncated && (
                <div className="rounded-xl border border-glass-border bg-glass-base/30 px-4 py-2 text-[11px] text-ink-muted">
                    Showing the {rows.length} most recently updated sources of {fleet.data?.total}.
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
            ) : tableRows.length === 0 ? (
                <div className="rounded-xl border border-glass-border bg-glass-base/20 px-4 py-12 text-center text-sm text-ink-muted">
                    {hasFilters ? (
                        <>
                            No sources match these filters.{' '}
                            <button onClick={clearAll} className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">Clear all</button>
                        </>
                    ) : 'No data sources found.'}
                </div>
            ) : (
                <div className="rounded-xl border border-glass-border">
                    <table className="w-full min-w-[720px] text-left">
                        <thead>
                            <tr className="text-[10px] uppercase tracking-wide text-ink-muted">
                                <th style={{ top: headerTop }} className="pl-3 pr-1 py-2 w-10 sticky z-10 bg-canvas">
                                    {selectableIds.length > 0 ? (
                                        <SelectionCheckbox
                                            selected={allSelectableSelected}
                                            indeterminate={someSelectableSelected && !allSelectableSelected}
                                            onToggle={toggleSelectAll}
                                            ariaLabel={allSelectableSelected
                                                ? 'Deselect all sources'
                                                : 'Select all sources'}
                                        />
                                    ) : (
                                        <span className="inline-block w-[18px]" aria-hidden />
                                    )}
                                </th>
                                {['Source', 'Aggregation', 'Cache', 'Freshness', 'Last activity'].map(h => (
                                    <th key={h} style={{ top: headerTop }} className="px-3 py-2 font-semibold sticky z-10 bg-canvas">{h}</th>
                                ))}
                                <th style={{ top: headerTop }} className="px-3 py-2 font-semibold sticky z-10 bg-canvas text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {groups.map(([pid, g]) => {
                                const hasAttention = g.rows.some(isGroupAttention)
                                const expanded = isExpanded(pid, hasAttention)
                                return (
                                    <Fragment key={pid}>
                                        <FreshnessGroupHeader
                                            providerId={pid}
                                            name={g.name}
                                            rows={g.rows}
                                            summary={providerSummaryById.get(pid) ?? null}
                                            expanded={expanded}
                                            onToggle={() => toggleGroup(pid, expanded)}
                                            isSystemAdmin={isSystemAdmin}
                                            onRefreshProvider={(id, name) => setProviderDialog({ id, name })}
                                            colSpan={COLS}
                                        />
                                        {expanded && g.rows.map(row => (
                                            <FreshnessRow
                                                key={row.dataSourceId}
                                                row={row}
                                                job={activeJobs.byDataSource.get(row.dataSourceId)}
                                                colSpan={COLS}
                                                workspaceName={row.workspaceId ? workspaceName.get(row.workspaceId) : undefined}
                                                onOpenDrawer={setDrawerDsId}
                                                onRefresh={onRefresh}
                                                busy={busyDsId === row.dataSourceId}
                                                expanded={expandedRow === row.dataSourceId}
                                                onToggleExpand={(dsId) => setExpandedRow(cur => (cur === dsId ? null : dsId))}
                                                onCancelJob={onCancelJob}
                                                peerRows={tableRows}
                                                onFilterFailure={(cat) => {
                                                    const facet = asFailureCategory(cat)
                                                    if (facet) patchParams({ ffail: facet, fstatus: 'needsAttention' })
                                                }}
                                                onFilterStatus={(facet) => patchParams({ fstatus: facet || null })}
                                                selectable
                                                selected={selectedIds.includes(row.dataSourceId)}
                                                onToggleSelect={toggleSelect}
                                            />
                                        ))}
                                    </Fragment>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            <BulkRetryBar
                selectedIds={visibleSelectedIds}
                rows={tableRows}
                onClear={() => setSelectedIds([])}
                onDone={() => {
                    void fleet.refetch()
                    void qc.invalidateQueries({ queryKey: ACTIVE_JOBS_KEY })
                }}
            />

            <FreshnessDrawer
                key={drawerDsId ?? 'closed'}
                dsId={drawerDsId}
                isOpen={drawerDsId != null}
                onClose={closeDrawer}
                workspaceName={
                    drawerDsId
                        ? workspaceName.get(rows.find(r => r.dataSourceId === drawerDsId)?.workspaceId ?? '')
                        : undefined
                }
            />

            <ConfirmDialog
                open={confirm != null}
                title={buildMode ? 'Build lineage' : (confirm ? SCOPE_LABEL[confirm.scope] : '')}
                message={
                    buildMode
                        ? 'Builds lineage rollups for this source for the first time. This may take a while on large sources.'
                        : confirm?.scope === 'full'
                            ? 'This refreshes caches and rebuilds aggregated lineage for this source. It can take a while.'
                            : 'This rebuilds aggregated lineage for this source. It can take a while.'
                }
                confirmLabel={buildMode ? 'Build lineage' : (confirm ? SCOPE_LABEL[confirm.scope] : '')}
                confirmColor="bg-indigo-600 hover:bg-indigo-700 shadow-md"
                confirmIcon={Zap}
                onConfirm={() => {
                    if (confirm) doRefresh(confirm.dsId, confirm.scope, confirm.firstBuild)
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

            <FleetRefreshDialog
                key={fleetDialogOpen ? 'open' : 'closed'}
                fleetTotal={summary?.total ?? null}
                isOpen={fleetDialogOpen}
                onClose={() => setFleetDialogOpen(false)}
            />

            <AutomationModal
                open={automationOpen}
                onClose={closeAutomation}
                isAdmin={isSystemAdmin}
                summary={summary}
            />
        </div>
    )
}
