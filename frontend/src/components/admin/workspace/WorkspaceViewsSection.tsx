/**
 * WorkspaceViewsSection — the workspace-detail "Views" tab (?tab=views).
 *
 * A workspace-owner governance surface: full insight into every view the
 * workspace owns — who created it, who last changed it (settings vs data)
 * and when, its visibility and health — plus the controls to act (filter,
 * change visibility, delete) in bulk or per-view.
 *
 * It reuses the Explorer building blocks scoped to this one workspace so the
 * look and behaviour match the global Explorer with zero duplication:
 *   - data + mutations: ``useExplorerViews`` (favourite, optimistic remove,
 *     pagination, search debounce), scoped via ``workspaceIds: [wsId]``;
 *   - presentation: ``ExplorerViewCard`` (grid) / ``ExplorerListRow`` +
 *     ``ExplorerListHeader`` (audit table), ``ExplorerBulkActions``;
 *   - dialogs: ``ShareViewDialog`` / ``DeleteViewDialog`` / ``BulkDeleteDialog``.
 *
 * The insight header is computed from ``allViews`` (the full, unfiltered
 * workspace population the parent already loads) so the totals describe the
 * whole workspace regardless of the active filter; the body reflects the
 * filter. Attention count is server-authoritative via ``useViewStats``.
 *
 * NOTE: there is no per-view change *timeline* API yet — we surface the last
 * change of each kind (created / settings-edited / data-published, each with
 * who + when). A full activity log per view is a backend follow-up.
 */
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExplorerPreviewDrawer } from '@/components/explorer/ExplorerPreviewDrawer'
import {
    Eye, Plus, Compass, LayoutGrid, List as ListIcon,
    Lock, Users, Globe, AlertTriangle, UserRound, Clock, X, History, ChevronDown,
    Check, Loader2, FileUp, Database,
} from 'lucide-react'
import { WorkspaceActivityFeed } from '@/components/views/WorkspaceActivityFeed'
import { cn } from '@/lib/utils'
import {
    workspaceService,
    type DataSourceResponse,
    type WorkspacePublishPolicy,
} from '@/services/workspaceService'
import {
    updateViewVisibility, restoreView as restoreViewApi,
    approveViewPublication, denyViewPublication, type View,
} from '@/services/viewApiService'
import { useExplorerViews, type ExplorerFilters, type SortOption } from '@/hooks/useExplorerViews'
import { useViewStats } from '@/hooks/useViewStats'
import { useViewHealth } from '@/hooks/useViewHealth'
import { useDataSourceProviderMap } from '@/hooks/useDataSourceProviderMap'
import { useViewEditorModal } from '@/components/layout/AppLayout'
import { useAppNotifications } from '@/components/ui/notifications'
import { useAuthStore, usePermission } from '@/store/auth'
import { useBrand } from '@/store/branding'
import { useVisitWindow, useVisitWindowsStore } from '@/store/visitWindows'
import { timeAgo } from '@/lib/timeAgo'
import { ExplorerViewCard } from '@/components/explorer/ExplorerViewCard'
import { ExplorerListRow } from '@/components/explorer/ExplorerListRow'
import { ExplorerListHeader } from '@/components/explorer/ExplorerListHeader'
import { ExplorerSortControl } from '@/components/explorer/ExplorerSortControl'
import { useViewUsage } from '@/hooks/useContentInsights'
import { useOpensOrdering } from '@/components/explorer/useOpensOrdering'
import { ExplorerCardSkeleton } from '@/components/explorer/ExplorerCardSkeleton'
import { ExplorerBulkActions } from '@/components/explorer/ExplorerBulkActions'
import { ExportViewDialog } from '@/features/view-transfer/ExportViewDialog'
import { useViewPortability } from '@/features/view-transfer/useViewPortability'
import { DeleteViewDialog } from '@/components/explorer/DeleteViewDialog'
import { BulkDeleteDialog } from '@/components/explorer/BulkDeleteDialog'
import { ShareViewDialog } from '@/components/views/ShareViewDialog'
import { useQueryClient } from '@tanstack/react-query'
import { FilterDropdown } from '@/components/explorer/FilterDropdown'
import { EMPTY_FILTERS, ME, isAnyFilterActive, type ViewFilterState } from '@/features/view-filters/model'
import { resolveFilters } from '@/features/view-filters/params'
import { writeFilterState } from '@/features/view-filters/url'
import { filterChips } from '@/features/view-filters/dimensions'
import { useLiveFacets } from '@/features/view-filters/useLiveFacets'
import { useRelaxations } from '@/features/view-filters/useRelaxations'
import { invalidateViewAggregates } from '@/features/view-filters/invalidate'
import { withCounts } from '@/features/view-filters/facetOptions'
import { SOURCE_KIND_META } from '@/features/view-filters/sourceKindMeta'
import { RelaxationList } from '@/features/view-filters/components/RelaxationList'
import { useLocalDay } from '@/features/view-filters/useLocalDay'
import { useFilterLookups } from '@/features/view-filters/useFilterLookups'
import { SourceKindToggle } from '@/features/view-filters/components/SourceKindToggle'
import { DateFilterMenu } from '@/features/view-filters/components/DateFilterMenu'
import { ExplorerSearchBox } from '@/components/explorer/ExplorerSearchBox'
import { searchTextOf } from '@/features/view-filters/tokens'
import { SinceLastVisitBanner } from '@/features/view-filters/components/SinceLastVisitBanner'
import { visitMark as visitMarkOf } from '@/features/view-filters/visitMark'
import { VISIT_RULE } from '@/features/view-filters/dateFilter'
import { PeopleFilterMenu } from '@/features/view-filters/components/PeopleFilterMenu'
import { currentPersonOf } from '@/features/view-filters/people'
import { ActiveFilterChips } from '@/features/view-filters/components/ActiveFilterChips'

type Visibility = 'private' | 'workspace' | 'enterprise'

/**
 * Where a view stands today, said from the APPROVER's seat. Not
 * `visibilityDescription` — that one speaks to the owner ("Only you…"),
 * which is the wrong voice for someone reviewing another person's view.
 */
const CURRENT_REACH: Record<string, string> = {
    private: 'currently visible only to its owner and workspace admins',
    workspace: 'currently visible to this workspace',
    enterprise: 'currently visible to everyone signed in',
}

interface WorkspaceViewsSectionProps {
    wsId: string
    dataSources: DataSourceResponse[]
    /** The full, unfiltered workspace view population — drives the insight
     *  header totals so they describe the whole workspace, not the filter. */
    allViews: View[]
    /** Who may publish here. Absent on servers that predate the setting. */
    publishPolicy?: WorkspacePublishPolicy
    /** Re-pull the workspace (and `allViews`) after answering a request or
     *  changing the policy — both change data this component only reads. */
    onWorkspaceChanged?: () => void
}

export default function WorkspaceViewsSection({
    wsId, dataSources, allViews, publishPolicy, onWorkspaceChanged,
}: WorkspaceViewsSectionProps) {
    const currentUser = useAuthStore(s => s.user)
    const { openViewEditor } = useViewEditorModal()
    const { notify } = useAppNotifications()
    const { appName } = useBrand()
    const { resolve: resolveProvider } = useDataSourceProviderMap()
    const canAnswerPublishRequests = usePermission('workspace:view:publish', wsId)
    const canAdminWorkspace = usePermission('workspace:admin', wsId)

    // ─── Filters + layout ────────────────────────────────────────────
    // The same filter value and controls as the Explorer, held here in state
    // (this tab has never kept its filters in the address) and always scoped to
    // this workspace. Visibility and "Need attention" are driven by the insight
    // chips below; the rest by the toolbar.
    const [fstate, setFstate] = useState<ViewFilterState>(EMPTY_FILTERS)
    const patchFilters = (patch: Partial<ViewFilterState>) => setFstate(prev => ({ ...prev, ...patch }))
    // The box can hold a token being typed (`by:al`); the filter searches only
    // its words. A reset from elsewhere (Clear all, a suggestion) wins.
    const [searchBox, setSearchBox] = useState('')
    const searchBoxText = searchTextOf(searchBox) === fstate.search ? searchBox : fstate.search
    const searchRef = useRef<HTMLInputElement>(null)
    const visFilter = fstate.visibility
    const attentionOnly = fstate.category === 'needs-attention'
    const [sort, setSort] = useState<SortOption>('updated')
    const [layout, setLayout] = useState<'grid' | 'list'>('grid')
    const [showActivity, setShowActivity] = useState(false)
    const today = useLocalDay()
    const me = useMemo(() => currentPersonOf(currentUser), [currentUser])

    // "Since your last visit" to this workspace's views, per browser.
    const visitKey = currentUser?.id ? `${currentUser.id}:ws:${wsId}` : null
    const visit = useVisitWindow(visitKey)
    const markVisitSeen = useVisitWindowsStore(s => s.markSeen)
    const visitFrom = visit?.from
    const visitTo = visit?.to
    const resolveCtx = useMemo(
        () => ({
            currentUserId: currentUser?.id ?? null,
            today,
            scopeWorkspaceId: wsId,
            visit: visitFrom && visitTo ? { from: visitFrom, to: visitTo } : null,
        }),
        [currentUser?.id, today, wsId, visitFrom, visitTo],
    )
    const filters: ExplorerFilters = useMemo(() => ({
        ...resolveFilters(fstate, resolveCtx),
        sort,
        favouritedOnly: false,
        limit: 60,
        offset: 0,
    }), [fstate, resolveCtx, sort])

    // People, sources and counts for this workspace — from the server, so they
    // aren't limited to the first page of views the parent loaded, and with
    // each option's count following the other filters.
    const { universe, people, counts, sourceKinds, pending: countsPending } = useLiveFacets(fstate, resolveCtx)
    const lookups = useFilterLookups(people, today, currentUser?.id)
    const chips = useMemo(
        () => filterChips(fstate, lookups, ['workspace', 'category', 'search']),
        [fstate, lookups],
    )
    const sourceOptions = useMemo(() => {
        const kinds = new Map((universe.dataSources ?? []).map(d => [d.id, d.kind]))
        return withCounts(dataSources, ds => ds.id, counts.dataSources)
            .map(({ option: ds, count }) => {
                const kind = kinds.get(ds.id)
                const meta = kind ? SOURCE_KIND_META[kind] : null
                return {
                    id: ds.id, label: ds.label || ds.catalogItemId || ds.id, count,
                    icon: meta?.icon ?? Database, iconClassName: meta?.glyph ?? 'text-emerald-500',
                }
            })
    }, [dataSources, universe.dataSources, counts.dataSources])

    const {
        views: loadedViews, totalCount, isLoading, error: listError,
        toggleFavourite, removeView, refetch, loadMore, hasMore,
    } = useExplorerViews(filters)
    const queryClient = useQueryClient()
    const healthMap = useViewHealth(loadedViews)

    // Same batched call as the Explorer, and the same reason: a card fetching
    // its own usage would be one request per tile.
    const usageIds = useMemo(() => loadedViews.map(v => v.id), [loadedViews])
    const { data: usageMap } = useViewUsage(usageIds)
    // "Most opened" is finished on the client — opens live in the event log
    // and views in the catalogue, and this repo bans cross-domain JOINs.
    const views = useOpensOrdering(loadedViews, usageMap, sort)

    // Server-authoritative attention count for the whole workspace.
    const { stats } = useViewStats(useMemo(() => ({ workspaceIds: [wsId] }), [wsId]))

    // ─── Insight header (whole-workspace population) ─────────────────
    // The counts come from the server, over the whole workspace: `allViews` is
    // only the first page the parent loads, so counting it understated every
    // number in a large workspace. The last activity still reads it — the
    // newest changes are on that first page.
    const insight = useMemo(() => {
        const visibilityCount = (v: string) => universe.visibilities?.find(x => x.value === v)?.count
        // The unfiltered people, not the toolbar's: their numbers follow the filters.
        const everyone = universe.contributors
        const owners = everyone
            ? everyone.filter(p => p.createdCount > 0).length
            : new Set(allViews.map(v => v.createdBy).filter(Boolean)).size
        let lastAt: string | null = null
        let lastBy: string | null = null
        for (const v of allViews) {
            const dataAt = v.dataUpdatedAt ?? null
            const freshest = dataAt && dataAt > v.updatedAt ? dataAt : v.updatedAt
            if (freshest && (!lastAt || freshest > lastAt)) {
                lastAt = freshest
                lastBy = (dataAt && dataAt > v.updatedAt ? v.dataUpdatedByName : v.updatedByName)
                    ?? v.createdByName ?? null
            }
        }
        return {
            total: stats.total || allViews.length,
            mine: everyone
                ? (everyone.find(p => p.userId === currentUser?.id)?.createdCount ?? 0)
                : allViews.filter(v => currentUser?.id && v.createdBy === currentUser.id).length,
            priv: visibilityCount('private') ?? allViews.filter(v => v.visibility === 'private').length,
            wsVis: visibilityCount('workspace') ?? allViews.filter(v => v.visibility === 'workspace').length,
            ent: visibilityCount('enterprise') ?? allViews.filter(v => v.visibility === 'enterprise').length,
            owners,
            lastAt,
            lastBy,
        }
    }, [allViews, currentUser?.id, universe.visibilities, universe.contributors, stats.total])

    // ─── Selection + management handlers ─────────────────────────────
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [exportSelection, setExportSelection] = useState<Array<{ id: string; name: string }> | null>(null)
    const { canExport: exportEnabled, canImport: importEnabled } = useViewPortability()
    const [shareView, setShareView] = useState<{ id: string; name: string; visibility: string } | null>(null)
    const [deleteView, setDeleteView] = useState<{ id: string; name: string; favouriteCount: number } | null>(null)
    const [showBulkDelete, setShowBulkDelete] = useState(false)
    const [previewView, setPreviewView] = useState<View | null>(null)
    const [previewEditMode, setPreviewEditMode] = useState(false)

    // BE rule (views.py can_delete_view): creator OR workspace:view:delete on
    // the view's workspace. Mirror it so Delete hides for users who'd 403.
    const canDeleteView = (view: View): boolean => {
        if (currentUser?.id && view.createdBy === currentUser.id) return true
        return useAuthStore.getState().can('workspace:view:delete', view.workspaceId)
    }

    const toggleSelect = (id: string) => setSelectedIds(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id); else next.add(id)
        return next
    })

    const handleDeleted = () => {
        if (!deleteView) return
        const { id, name } = deleteView
        setDeleteView(null)
        removeView(id)
        setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n })
        notify('success', `"${name}" has been deleted`)
        invalidateViewAggregates(queryClient)
    }

    const handleRestore = async (view: View) => {
        try {
            await restoreViewApi(view.id)
            refetch()
            invalidateViewAggregates(queryClient)
            notify('success', `"${view.name}" has been restored`)
        } catch {
            notify('error', `Failed to restore "${view.name}"`)
        }
    }

    // Bulk delete is only offered when every selected view passes canDeleteView.
    const canBulkDelete = useMemo(() => {
        if (selectedIds.size === 0) return false
        for (const v of views) {
            if (selectedIds.has(v.id) && !canDeleteView(v)) return false
        }
        return true
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedIds, views, currentUser?.id])

    const handleBulkVisibility = async (visibility: Visibility) => {
        const ids = Array.from(selectedIds)
        if (ids.length === 0) return
        try {
            await Promise.all(ids.map(id => updateViewVisibility(id, visibility)))
            setSelectedIds(new Set())
            refetch()
            invalidateViewAggregates(queryClient)
            notify('success', `Set ${ids.length} view${ids.length !== 1 ? 's' : ''} to "${visibility}"`)
        } catch {
            notify('error', 'Some views could not be updated')
        }
    }

    // ─── Publication requests ────────────────────────────────────────
    // `allViews` is the parent's snapshot, so an answered row is dropped
    // locally rather than waiting for the reload to come back.
    const [answeredIds, setAnsweredIds] = useState<Set<string>>(new Set())
    const [busyRequestId, setBusyRequestId] = useState<string | null>(null)
    const [denyingId, setDenyingId] = useState<string | null>(null)
    const [denyReason, setDenyReason] = useState('')
    // Approve is a one-way door onto every signed-in account, so it goes
    // through a confirm step that states the consequence. Decline already
    // had one (its reason box) — this makes the pair symmetric.
    const [confirmingId, setConfirmingId] = useState<string | null>(null)
    const [policySaving, setPolicySaving] = useState(false)
    const [restrictingDsId, setRestrictingDsId] = useState<string | null>(null)

    const pendingRequests = useMemo(
        () => allViews.filter(v => v.publishRequest && !answeredIds.has(v.id)),
        [allViews, answeredIds],
    )

    const answerRequest = async (
        view: View,
        answer: () => Promise<unknown>,
        successMessage: string,
    ) => {
        setBusyRequestId(view.id)
        try {
            await answer()
            setAnsweredIds(prev => new Set(prev).add(view.id))
            setDenyingId(null)
            setDenyReason('')
            setConfirmingId(null)
            refetch()
            invalidateViewAggregates(queryClient)
            onWorkspaceChanged?.()
            notify('success', successMessage)
        } catch (err) {
            notify('error', err instanceof Error ? err.message : 'Could not answer the request')
        } finally {
            setBusyRequestId(null)
        }
    }

    const handleSetPublishPolicy = async (policy: WorkspacePublishPolicy) => {
        if (policy === (publishPolicy ?? 'open')) return
        setPolicySaving(true)
        try {
            await workspaceService.update(wsId, { publishPolicy: policy })
            onWorkspaceChanged?.()
            notify('success', policy === 'open'
                ? 'Members can now publish views directly'
                : 'Members must request approval to publish')
        } catch (err) {
            notify('error', err instanceof Error ? err.message : 'Could not change the policy')
        } finally {
            setPolicySaving(false)
        }
    }

    const handleSetRestricted = async (dsId: string, isRestricted: boolean) => {
        setRestrictingDsId(dsId)
        try {
            await workspaceService.updateDataSource(wsId, dsId, { isRestricted })
            onWorkspaceChanged?.()
            notify('success', isRestricted
                ? 'Views over this source now need a publisher\u2019s approval'
                : 'Members can publish views over this source directly')
        } catch (err) {
            notify('error', err instanceof Error ? err.message : 'Could not change the source')
        } finally {
            setRestrictingDsId(null)
        }
    }

    const handleBulkDeleted = () => {
        const ids = Array.from(selectedIds)
        ids.forEach(id => removeView(id))
        setSelectedIds(new Set())
        setShowBulkDelete(false)
        invalidateViewAggregates(queryClient)
        notify('success', `Deleted ${ids.length} view${ids.length !== 1 ? 's' : ''}`)
    }

    const hasActiveFilters = isAnyFilterActive(fstate, { workspace: true })
    const clearFilters = () => setFstate(EMPTY_FILTERS)
    const relaxations = useRelaxations(fstate, resolveCtx, lookups, {
        enabled: !isLoading && !listError && loadedViews.length === 0 && hasActiveFilters,
        hide: ['workspace'],
    })

    // Shared per-view action props for card + row.
    // A person in a contributor trail joins the People filter ("You" for you).
    const pickPerson = (userId: string) => {
        const id = userId === currentUser?.id ? ME : userId
        setFstate(prev => (prev.contributorIds.includes(id) ? prev : { ...prev, contributorIds: [...prev.contributorIds, id] }))
    }
    // Seen: the window closes, and a filter on it would now match nothing.
    const markSeen = () => {
        if (!visitKey) return
        markVisitSeen(visitKey)
        const drop = (rule: string | null) => (rule === VISIT_RULE ? null : rule)
        setFstate(prev => ({ ...prev, created: drop(prev.created), updated: drop(prev.updated) }))
    }

    const actionProps = (v: View) => ({
        onToggleFavourite: () => toggleFavourite(v.id),
        onShare: () => setShareView({ id: v.id, name: v.name, visibility: v.visibility }),
        // Click a card/row → open the detail drawer to view; the pencil → open
        // it in details-edit mode. Same surface as Explorer.
        onPreview: () => { setPreviewEditMode(false); setPreviewView(v) },
        onEdit: () => { setPreviewEditMode(true); setPreviewView(v) },
        onEditLayout: () => openViewEditor(v.id),
        onDelete: canDeleteView(v)
            ? () => setDeleteView({ id: v.id, name: v.name, favouriteCount: v.favouriteCount })
            : undefined,
        onRestore: () => handleRestore(v),
        healthStatus: healthMap.get(v.id)?.status,
        providerInfo: resolveProvider(v.dataSourceId),
        isSelected: selectedIds.has(v.id),
        onToggleSelect: () => toggleSelect(v.id),
        // Every view here is in this workspace — the workspace pill would be
        // identical on every card/row, so drop it and give the scope column
        // room for the data source + provider.
        hideWorkspaceInScope: true,
        onPickPerson: pickPerson,
        visitMark: visitMarkOf(v, visit),
    })

    return (
        <section>
            {/* ── Insight header: "State of your views" ──────────── */}
            <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-4 mb-4">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 mb-3">
                    <span className="text-sm font-bold text-ink">{insight.total} view{insight.total !== 1 ? 's' : ''}</span>
                    {insight.mine > 0 && (
                        <span className="text-xs text-ink-muted">· you own {insight.mine}</span>
                    )}
                    <span className="text-xs text-ink-muted inline-flex items-center gap-1">
                        · <UserRound className="w-3 h-3" /> {insight.owners} owner{insight.owners !== 1 ? 's' : ''}
                    </span>
                    {insight.lastAt && (
                        <span className="text-xs text-ink-muted inline-flex items-center gap-1 ml-auto" title={new Date(insight.lastAt).toLocaleString()}>
                            <Clock className="w-3 h-3" /> last activity {timeAgo(insight.lastAt)}{insight.lastBy ? ` by ${insight.lastBy}` : ''}
                        </span>
                    )}
                </div>
                {/* Segment chips — click to filter */}
                <div className="flex flex-wrap items-center gap-2">
                    <SegmentChip icon={Lock} label="Private" count={insight.priv}
                        active={visFilter === 'private'} tone="slate"
                        onClick={() => patchFilters({ visibility: visFilter === 'private' ? null : 'private' })} />
                    <SegmentChip icon={Users} label="Workspace" count={insight.wsVis}
                        active={visFilter === 'workspace'} tone="emerald"
                        onClick={() => patchFilters({ visibility: visFilter === 'workspace' ? null : 'workspace' })} />
                    <SegmentChip icon={Globe} label="Enterprise" count={insight.ent}
                        active={visFilter === 'enterprise'} tone="indigo"
                        onClick={() => patchFilters({ visibility: visFilter === 'enterprise' ? null : 'enterprise' })} />
                    {stats.needsAttention > 0 && (
                        <SegmentChip icon={AlertTriangle} label="Need attention" count={stats.needsAttention}
                            active={attentionOnly} tone="amber"
                            onClick={() => patchFilters({ category: attentionOnly ? null : 'needs-attention' })} />
                    )}
                </div>
            </div>

            {/* ── Publishing: the request queue + who may publish ── */}
            {(canAnswerPublishRequests || canAdminWorkspace) && (
                <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-4 mb-4">
                    <div className="flex flex-wrap items-center gap-2 mb-3">
                        <Globe className="w-4 h-4 text-amber-500" />
                        <span className="text-sm font-bold text-ink">Publication requests</span>
                        {pendingRequests.length > 0 && (
                            <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                                {pendingRequests.length}
                            </span>
                        )}
                    </div>

                    {canAnswerPublishRequests && (
                        pendingRequests.length === 0 ? (
                            <p className="text-xs text-ink-muted">
                                Nothing waiting. Members who can't publish ask from a view's Share dialog, and the request lands here.
                            </p>
                        ) : (
                            <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 divide-y divide-amber-500/15">
                                {pendingRequests.map(v => {
                                    const req = v.publishRequest!
                                    const isBusy = busyRequestId === v.id
                                    // The whole decision in one sentence. Named data
                                    // source when we have one — list payloads carry it,
                                    // but a view with no source assigned does not.
                                    const consequence = v.dataSourceName
                                        ? `Publishing makes this view, and read-only access to ${v.dataSourceName}, visible to everyone signed in to ${appName}.`
                                        : `Publishing makes this view visible to everyone signed in to ${appName}.`
                                    return (
                                        <div key={v.id} className="px-3 py-2.5">
                                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                <span className="text-sm font-semibold text-ink truncate">{v.name}</span>
                                                <span className="text-[11px] text-ink-muted">
                                                    · asked by {req.requestedByName ?? 'a workspace member'} {timeAgo(req.requestedAt)}
                                                </span>
                                            </div>
                                            {/* What they'd be handing over, and from where. */}
                                            <p className="text-[11px] text-ink-muted mt-0.5">
                                                {v.dataSourceName ? `${v.dataSourceName} · ` : ''}
                                                {CURRENT_REACH[v.visibility] ?? ''}
                                            </p>
                                            {req.note && (
                                                <p className="text-[11px] text-ink-secondary italic mt-1 pl-2 border-l-2 border-amber-500/30">
                                                    {req.note}
                                                </p>
                                            )}
                                            {denyingId === v.id ? (
                                                <div className="flex flex-wrap items-center gap-2 mt-2">
                                                    <input
                                                        type="text"
                                                        value={denyReason}
                                                        onChange={e => setDenyReason(e.target.value)}
                                                        placeholder="Why not? (optional — the asker sees this)"
                                                        className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                                    />
                                                    <button
                                                        onClick={() => void answerRequest(v, () => denyViewPublication(v.id, denyReason), `Declined publishing "${v.name}"`)}
                                                        disabled={isBusy}
                                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50"
                                                    >
                                                        {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                                                        Confirm decline
                                                    </button>
                                                    <button
                                                        onClick={() => { setDenyingId(null); setDenyReason('') }}
                                                        disabled={isBusy}
                                                        className="px-3 py-1.5 rounded-lg text-xs font-semibold text-ink-muted hover:text-ink transition-colors disabled:opacity-50"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            ) : confirmingId === v.id ? (
                                                <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
                                                    <p className="text-[11px] text-ink leading-relaxed">
                                                        {consequence}
                                                    </p>
                                                    <div className="flex flex-wrap items-center gap-2 mt-2">
                                                        <button
                                                            onClick={() => void answerRequest(v, () => approveViewPublication(v.id), `"${v.name}" is now visible to everyone`)}
                                                            disabled={isBusy}
                                                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 text-white hover:brightness-110 transition-all disabled:opacity-50"
                                                        >
                                                            {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                                                            Publish to everyone
                                                        </button>
                                                        <button
                                                            onClick={() => setConfirmingId(null)}
                                                            disabled={isBusy}
                                                            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-ink-muted hover:text-ink transition-colors disabled:opacity-50"
                                                        >
                                                            Cancel
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-2 mt-2">
                                                    <button
                                                        onClick={() => setConfirmingId(v.id)}
                                                        disabled={isBusy}
                                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 text-white hover:brightness-110 transition-all disabled:opacity-50"
                                                    >
                                                        <Check className="w-3.5 h-3.5" />
                                                        Approve
                                                    </button>
                                                    <button
                                                        onClick={() => { setDenyingId(v.id); setDenyReason('') }}
                                                        disabled={isBusy}
                                                        className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-glass-border text-ink-muted hover:text-ink transition-colors disabled:opacity-50"
                                                    >
                                                        Decline
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        )
                    )}

                    {canAdminWorkspace && (
                        <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-glass-border">
                            <span className="text-xs text-ink-muted">Publishing to everyone:</span>
                            {([
                                { id: 'request' as const, label: 'Members must request approval' },
                                { id: 'open' as const, label: 'Members can publish directly' },
                            ]).map(opt => (
                                <button
                                    key={opt.id}
                                    onClick={() => void handleSetPublishPolicy(opt.id)}
                                    disabled={policySaving}
                                    aria-pressed={(publishPolicy ?? 'open') === opt.id}
                                    className={cn(
                                        'px-2.5 py-1 rounded-full border text-xs font-medium transition-colors disabled:opacity-50',
                                        (publishPolicy ?? 'open') === opt.id
                                            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
                                            : 'text-ink-muted border-glass-border hover:border-amber-500/30',
                                    )}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Restriction belongs to the SOURCE, not the workspace:
                        publishing a view exposes read-only access to the whole
                        source behind it. Marking the sensitive one keeps the
                        rest of the workspace open, instead of dragging every
                        view back to admin-only because one source is touchy. */}
                    {canAdminWorkspace && dataSources.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-glass-border">
                            <p className="text-xs text-ink-muted mb-2">
                                Sources that always need a publisher&rsquo;s approval:
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                                {dataSources.map(ds => {
                                    const restricted = !!ds.isRestricted
                                    return (
                                        <button
                                            key={ds.id}
                                            onClick={() => void handleSetRestricted(ds.id, !restricted)}
                                            disabled={restrictingDsId === ds.id}
                                            aria-pressed={restricted}
                                            title={restricted
                                                ? 'Restricted — publishing a view over this source needs the publish permission'
                                                : 'Open — members can publish views over this source'}
                                            className={cn(
                                                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-colors disabled:opacity-50',
                                                restricted
                                                    ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30'
                                                    : 'text-ink-muted border-glass-border hover:border-rose-500/30',
                                            )}
                                        >
                                            {restricted ? <Lock className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
                                            {ds.label || ds.id}
                                        </button>
                                    )
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Recent activity (collapsible) ──────────────────── */}
            <div className="rounded-2xl border border-glass-border bg-canvas-elevated mb-4 overflow-hidden">
                <button
                    onClick={() => setShowActivity(v => !v)}
                    className="w-full flex items-center gap-2 px-4 py-3 text-sm font-semibold text-ink hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
                >
                    <History className="w-4 h-4 text-indigo-500" />
                    Recent activity
                    <ChevronDown className={cn('w-4 h-4 text-ink-muted ml-auto transition-transform', showActivity && 'rotate-180')} />
                </button>
                {showActivity && (
                    <div className="px-4 pb-3 border-t border-glass-border/50 pt-2">
                        <WorkspaceActivityFeed workspaceId={wsId} />
                    </div>
                )}
            </div>

            {/* ── Header actions ─────────────────────────────────── */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2">
                    <h3 className="text-lg font-bold text-ink">Views</h3>
                    <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-indigo-500/10 text-indigo-500">
                        {totalCount}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <Link
                        // Carries this tab's filters across, in the Explorer's own
                        // spelling, so the wider list starts where this one is.
                        to={`/explorer?${writeFilterState(new URLSearchParams(), { ...fstate, workspaceIds: [wsId] })}`}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-glass-border text-ink-muted hover:text-ink hover:border-indigo-500/30 text-sm font-medium transition-colors"
                    >
                        <Compass className="w-4 h-4" /> Browse in Explorer
                    </Link>
                    {importEnabled && (
                        <button
                            onClick={() => openViewEditor(undefined, { journey: 'import' })}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-glass-border text-ink-muted hover:text-ink hover:border-indigo-500/30 text-sm font-medium transition-colors"
                            title="Import a view exported from another environment"
                        >
                            <FileUp className="w-4 h-4" /> Import view
                        </button>
                    )}
                    <button
                        onClick={() => openViewEditor()}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors"
                    >
                        <Plus className="w-4 h-4" /> New view
                    </button>
                </div>
            </div>

            {/* ── Toolbar ────────────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
                <ExplorerSearchBox
                    className="flex-1 min-w-[200px]"
                    value={searchBoxText}
                    onChange={text => { setSearchBox(text); patchFilters({ search: searchTextOf(text) }) }}
                    inputRef={searchRef}
                    state={fstate}
                    onApplyFilters={setFstate}
                    ctx={resolveCtx}
                    currentUser={me}
                    onRemoveLastFilter={() => {
                        const last = chips[chips.length - 1]
                        if (!last) return
                        const previous = fstate
                        setFstate(last.without(fstate))
                        notify('info', `Removed ${last.prefix}: ${last.value}`, {
                            label: 'Undo',
                            onClick: () => setFstate(previous),
                        })
                    }}
                    fixedWorkspace
                />
                <SourceKindToggle
                    value={fstate.sourceKind}
                    onChange={v => patchFilters({ sourceKind: v })}
                    counts={sourceKinds}
                />
                <DateFilterMenu
                    created={fstate.created}
                    updated={fstate.updated}
                    onChange={patch => patchFilters(patch)}
                    today={today}
                    counting={{ state: fstate, ctx: resolveCtx }}
                />
                <PeopleFilterMenu
                    ids={fstate.contributorIds}
                    role={fstate.contributorRole}
                    people={people}
                    currentUser={me}
                    onChange={({ ids, role }) => patchFilters({ contributorIds: ids, contributorRole: role })}
                />
                <FilterDropdown
                    icon={Database}
                    label="Source"
                    accent="emerald"
                    selectionMode="single"
                    disableSearch={dataSources.length < 8}
                    options={sourceOptions}
                    countsPending={countsPending}
                    selectedIds={fstate.dataSourceId ? [fstate.dataSourceId] : []}
                    onChange={ids => patchFilters({ dataSourceId: ids[0] ?? null })}
                    activeLabelFormatter={(ids, opts) => opts.find(o => o.id === ids[0])?.label ?? 'Source'}
                    emptyMessage="No data sources"
                />
                <ExplorerSortControl sort={sort} onSortChange={setSort} />
                {/* Grid / list toggle */}
                <div className="inline-flex items-center rounded-xl border border-glass-border overflow-hidden ml-auto">
                    <button
                        onClick={() => setLayout('grid')}
                        title="Grid"
                        className={cn('p-2 transition-colors', layout === 'grid' ? 'bg-indigo-500/10 text-indigo-500' : 'text-ink-muted hover:text-ink')}
                    >
                        <LayoutGrid className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setLayout('list')}
                        title="List"
                        className={cn('p-2 transition-colors', layout === 'list' ? 'bg-indigo-500/10 text-indigo-500' : 'text-ink-muted hover:text-ink')}
                    >
                        <ListIcon className="w-4 h-4" />
                    </button>
                </div>
            </div>
            <ActiveFilterChips
                className="mb-4"
                chips={chips}
                currentUserId={currentUser?.id}
                onRemove={chip => setFstate(prev => chip.without(prev))}
                // In this tab "Clear all" resets everything — search and the
                // insight chips included — back to the whole workspace.
                onClearAll={clearFilters}
            />
            {!chips.length && <div className="mb-2" />}
            {visit && (
                <SinceLastVisitBanner
                    state={fstate}
                    ctx={resolveCtx}
                    window={visit}
                    onApply={setFstate}
                    onMarkSeen={markSeen}
                    className="mb-4"
                />
            )}

            {/* ── Body ───────────────────────────────────────────── */}
            {isLoading ? (
                layout === 'grid' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {Array.from({ length: 6 }).map((_, i) => <ExplorerCardSkeleton key={i} />)}
                    </div>
                ) : (
                    <div className="py-16 flex justify-center text-ink-muted">
                        <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                )
            ) : views.length > 0 ? (
                <>
                    {layout === 'grid' ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                            {views.map(v => (
                                <ExplorerViewCard key={v.id} view={v} usage={usageMap?.[v.id]} {...actionProps(v)} />
                            ))}
                        </div>
                    ) : (
                        <div className="rounded-xl border border-glass-border overflow-hidden">
                            <ExplorerListHeader sort={sort} onSortChange={setSort} withCheckbox />
                            <div className="divide-y divide-glass-border/50">
                                {views.map(v => (
                                    <ExplorerListRow key={v.id} view={v} usage={usageMap?.[v.id]} {...actionProps(v)} />
                                ))}
                            </div>
                        </div>
                    )}
                    {hasMore && (
                        <div className="flex justify-center mt-6">
                            <button
                                onClick={() => loadMore()}
                                className="px-4 py-2 rounded-xl border border-glass-border text-sm font-medium text-ink-muted hover:text-ink hover:border-indigo-500/30 transition-colors"
                            >
                                Load more
                            </button>
                        </div>
                    )}
                </>
            ) : (
                <div className="py-16 text-center border-2 border-dashed border-glass-border rounded-2xl">
                    <Eye className="w-10 h-10 mx-auto text-ink-muted mb-3 opacity-30" />
                    <h4 className="text-sm font-bold text-ink mb-1">
                        {hasActiveFilters ? 'No matching views' : 'No views yet'}
                    </h4>
                    {hasActiveFilters && relaxations.length > 0 ? (
                        <RelaxationList
                            relaxations={relaxations}
                            onRelax={setFstate}
                            className="mx-auto mb-4 max-w-md px-4"
                        />
                    ) : (
                        <p className="text-xs text-ink-muted mb-4 max-w-sm mx-auto">
                            {hasActiveFilters
                                ? 'Try a different search or filter.'
                                : 'Views are saved visual perspectives on this workspace’s graph data. Create one to get started.'}
                        </p>
                    )}
                    {hasActiveFilters ? (
                        <button
                            onClick={clearFilters}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-glass-border text-ink-muted hover:text-ink text-sm font-medium transition-colors"
                        >
                            <X className="w-4 h-4" /> Clear filters
                        </button>
                    ) : (
                        <button
                            onClick={() => openViewEditor()}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors"
                        >
                            <Plus className="w-4 h-4" /> New view
                        </button>
                    )}
                </div>
            )}

            {/* ── Bulk actions bar ───────────────────────────────── */}
            <ExplorerBulkActions
                selectedCount={selectedIds.size}
                onDelete={canBulkDelete ? () => setShowBulkDelete(true) : undefined}
                onChangeVisibility={handleBulkVisibility}
                onExport={exportEnabled
                    ? () => setExportSelection(Array.from(selectedIds, id => ({
                        id, name: views.find(v => v.id === id)?.name ?? id,
                    })))
                    : undefined}
                onClearSelection={() => setSelectedIds(new Set())}
            />
            {exportSelection && (
                <ExportViewDialog views={exportSelection} onClose={() => setExportSelection(null)} />
            )}

            {/* ── Detail drawer (view + edit details), reused from Explorer ── */}
            <ExplorerPreviewDrawer
                view={previewView}
                isOpen={!!previewView}
                onClose={() => setPreviewView(null)}
                onShare={() => previewView && setShareView({ id: previewView.id, name: previewView.name, visibility: previewView.visibility })}
                onEdit={previewView ? () => { const id = previewView.id; setPreviewView(null); openViewEditor(id) } : undefined}
                onDelete={previewView && canDeleteView(previewView)
                    ? () => setDeleteView({ id: previewView!.id, name: previewView!.name, favouriteCount: previewView!.favouriteCount })
                    : undefined}
                healthStatus={previewView ? healthMap.get(previewView.id)?.status : undefined}
                initialEditMode={previewEditMode}
                // The save refreshed the lists; the drawer holds its own copy of the view.
                onSaved={updated => setPreviewView(prev => prev && {
                    ...prev, name: updated.name, description: updated.description, tags: updated.tags, visibility: updated.visibility,
                })}
                onPickPerson={id => { setPreviewView(null); pickPerson(id) }}
            />

            {/* ── Dialogs (reused from Explorer) ─────────────────── */}
            {shareView && (
                <ShareViewDialog
                    viewId={shareView.id}
                    viewName={shareView.name}
                    currentVisibility={shareView.visibility as Visibility}
                    isOpen={true}
                    onClose={() => setShareView(null)}
                />
            )}
            {deleteView && (
                <DeleteViewDialog
                    viewId={deleteView.id}
                    viewName={deleteView.name}
                    favouriteCount={deleteView.favouriteCount}
                    isOpen={true}
                    onClose={() => setDeleteView(null)}
                    onDeleted={handleDeleted}
                />
            )}
            {showBulkDelete && (
                <BulkDeleteDialog
                    viewIds={Array.from(selectedIds)}
                    isOpen={true}
                    onClose={() => setShowBulkDelete(false)}
                    onDeleted={handleBulkDeleted}
                />
            )}
        </section>
    )
}

// ─── Segment chip: a clickable visibility/attention filter pill ──────
const CHIP_TONES: Record<string, { active: string; idle: string }> = {
    slate: { active: 'bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30', idle: 'text-ink-muted border-glass-border hover:border-slate-500/30' },
    emerald: { active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30', idle: 'text-ink-muted border-glass-border hover:border-emerald-500/30' },
    indigo: { active: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30', idle: 'text-ink-muted border-glass-border hover:border-indigo-500/30' },
    amber: { active: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30', idle: 'text-amber-600 dark:text-amber-400 border-amber-500/20 hover:border-amber-500/40' },
}

function SegmentChip({ icon: Icon, label, count, active, tone, onClick }: {
    icon: React.ElementType
    label: string
    count: number
    active: boolean
    tone: keyof typeof CHIP_TONES
    onClick: () => void
}) {
    const t = CHIP_TONES[tone]
    return (
        <button
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-colors',
                active ? t.active : t.idle,
            )}
        >
            <Icon className="w-3.5 h-3.5" />
            {label}
            <span className={cn('font-bold', active ? '' : 'text-ink')}>{count}</span>
        </button>
    )
}
