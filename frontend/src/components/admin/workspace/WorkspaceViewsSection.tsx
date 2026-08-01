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
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExplorerPreviewDrawer } from '@/components/explorer/ExplorerPreviewDrawer'
import {
    Eye, Search, Plus, Compass, LayoutGrid, List as ListIcon,
    Lock, Users, Globe, AlertTriangle, UserRound, Clock, X, History, ChevronDown,
    Check, Loader2,
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
import { useToast } from '@/components/ui/toast'
import { useAuthStore, usePermission } from '@/store/auth'
import { useBrand } from '@/store/branding'
import { timeAgo } from '@/lib/timeAgo'
import { ExplorerViewCard } from '@/components/explorer/ExplorerViewCard'
import { ExplorerListRow } from '@/components/explorer/ExplorerListRow'
import { ExplorerListHeader } from '@/components/explorer/ExplorerListHeader'
import { ExplorerSortControl } from '@/components/explorer/ExplorerSortControl'
import { ExplorerCardSkeleton } from '@/components/explorer/ExplorerCardSkeleton'
import { ExplorerBulkActions } from '@/components/explorer/ExplorerBulkActions'
import { DeleteViewDialog } from '@/components/explorer/DeleteViewDialog'
import { BulkDeleteDialog } from '@/components/explorer/BulkDeleteDialog'
import { ShareViewDialog } from '@/components/views/ShareViewDialog'

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
    const { showToast } = useToast()
    const { appName } = useBrand()
    const { resolve: resolveProvider } = useDataSourceProviderMap()
    const canAnswerPublishRequests = usePermission('workspace:view:publish', wsId)
    const canAdminWorkspace = usePermission('workspace:admin', wsId)

    // ─── Filters + layout ────────────────────────────────────────────
    const [search, setSearch] = useState('')
    const [dsFilter, setDsFilter] = useState<string>('all')
    const [visFilter, setVisFilter] = useState<Visibility | 'all'>('all')
    const [ownerFilter, setOwnerFilter] = useState<string>('all')
    const [attentionOnly, setAttentionOnly] = useState(false)
    const [sort, setSort] = useState<SortOption>('updated')
    const [layout, setLayout] = useState<'grid' | 'list'>('grid')
    const [showActivity, setShowActivity] = useState(false)

    const filters: ExplorerFilters = useMemo(() => ({
        search,
        visibility: visFilter === 'all' ? null : visFilter,
        workspaceIds: [wsId],
        dataSourceId: dsFilter === 'all' ? null : dsFilter,
        viewTypes: [],
        tags: [],
        creatorIds: ownerFilter === 'all' ? [] : [ownerFilter],
        sort,
        favouritedOnly: false,
        category: attentionOnly ? 'needs-attention' : null,
        currentUserId: currentUser?.id ?? null,
        limit: 60,
        offset: 0,
    }), [search, visFilter, wsId, dsFilter, ownerFilter, sort, attentionOnly, currentUser?.id])

    const {
        views, totalCount, isLoading,
        toggleFavourite, removeView, refetch, loadMore, hasMore,
    } = useExplorerViews(filters)
    const healthMap = useViewHealth(views)

    // Server-authoritative attention count for the whole workspace.
    const { stats } = useViewStats(useMemo(() => ({ workspaceIds: [wsId] }), [wsId]))

    // ─── Insight header (whole-workspace population) ─────────────────
    const insight = useMemo(() => {
        let mine = 0, priv = 0, wsVis = 0, ent = 0
        const owners = new Set<string>()
        let lastAt: string | null = null
        let lastBy: string | null = null
        for (const v of allViews) {
            if (currentUser?.id && v.createdBy === currentUser.id) mine++
            if (v.visibility === 'private') priv++
            else if (v.visibility === 'workspace') wsVis++
            else if (v.visibility === 'enterprise') ent++
            if (v.createdBy) owners.add(v.createdBy)
            const dataAt = v.dataUpdatedAt ?? null
            const freshest = dataAt && dataAt > v.updatedAt ? dataAt : v.updatedAt
            if (freshest && (!lastAt || freshest > lastAt)) {
                lastAt = freshest
                lastBy = (dataAt && dataAt > v.updatedAt ? v.dataUpdatedByName : v.updatedByName)
                    ?? v.createdByName ?? null
            }
        }
        return { total: allViews.length, mine, priv, wsVis, ent, owners: owners.size, lastAt, lastBy }
    }, [allViews, currentUser?.id])

    // Distinct owners for the owner filter (from the full population).
    const ownerOptions = useMemo(() => {
        const map = new Map<string, string>()
        for (const v of allViews) if (v.createdBy) map.set(v.createdBy, v.createdByName ?? v.createdBy)
        return [...map.entries()]
            .map(([id, name]) => ({ id, name }))
            .sort((a, b) => a.name.localeCompare(b.name))
    }, [allViews])

    // ─── Selection + management handlers ─────────────────────────────
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
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
        showToast('success', `"${name}" has been deleted`)
    }

    const handleRestore = async (view: View) => {
        try {
            await restoreViewApi(view.id)
            refetch()
            showToast('success', `"${view.name}" has been restored`)
        } catch {
            showToast('error', `Failed to restore "${view.name}"`)
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
            showToast('success', `Set ${ids.length} view${ids.length !== 1 ? 's' : ''} to "${visibility}"`)
        } catch {
            showToast('error', 'Some views could not be updated')
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
            onWorkspaceChanged?.()
            showToast('success', successMessage)
        } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'Could not answer the request')
        } finally {
            setBusyRequestId(null)
        }
    }

    const handleSetPublishPolicy = async (policy: WorkspacePublishPolicy) => {
        if (policy === (publishPolicy ?? 'request')) return
        setPolicySaving(true)
        try {
            await workspaceService.update(wsId, { publishPolicy: policy })
            onWorkspaceChanged?.()
            showToast('success', policy === 'open'
                ? 'Members can now publish views directly'
                : 'Members must request approval to publish')
        } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'Could not change the policy')
        } finally {
            setPolicySaving(false)
        }
    }

    const handleBulkDeleted = () => {
        const ids = Array.from(selectedIds)
        ids.forEach(id => removeView(id))
        setSelectedIds(new Set())
        setShowBulkDelete(false)
        showToast('success', `Deleted ${ids.length} view${ids.length !== 1 ? 's' : ''}`)
    }

    const hasActiveFilters = !!search || dsFilter !== 'all' || visFilter !== 'all' || ownerFilter !== 'all' || attentionOnly
    const clearFilters = () => {
        setSearch(''); setDsFilter('all'); setVisFilter('all'); setOwnerFilter('all'); setAttentionOnly(false)
    }

    // Shared per-view action props for card + row.
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
                        onClick={() => setVisFilter(v => v === 'private' ? 'all' : 'private')} />
                    <SegmentChip icon={Users} label="Workspace" count={insight.wsVis}
                        active={visFilter === 'workspace'} tone="emerald"
                        onClick={() => setVisFilter(v => v === 'workspace' ? 'all' : 'workspace')} />
                    <SegmentChip icon={Globe} label="Enterprise" count={insight.ent}
                        active={visFilter === 'enterprise'} tone="indigo"
                        onClick={() => setVisFilter(v => v === 'enterprise' ? 'all' : 'enterprise')} />
                    {stats.needsAttention > 0 && (
                        <SegmentChip icon={AlertTriangle} label="Need attention" count={stats.needsAttention}
                            active={attentionOnly} tone="amber"
                            onClick={() => setAttentionOnly(a => !a)} />
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
                                    aria-pressed={(publishPolicy ?? 'request') === opt.id}
                                    className={cn(
                                        'px-2.5 py-1 rounded-full border text-xs font-medium transition-colors disabled:opacity-50',
                                        (publishPolicy ?? 'request') === opt.id
                                            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
                                            : 'text-ink-muted border-glass-border hover:border-amber-500/30',
                                    )}
                                >
                                    {opt.label}
                                </button>
                            ))}
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
                        to={`/explorer?workspace=${wsId}`}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-glass-border text-ink-muted hover:text-ink hover:border-indigo-500/30 text-sm font-medium transition-colors"
                    >
                        <Compass className="w-4 h-4" /> Browse in Explorer
                    </Link>
                    <button
                        onClick={() => openViewEditor()}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors"
                    >
                        <Plus className="w-4 h-4" /> New view
                    </button>
                </div>
            </div>

            {/* ── Toolbar ────────────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-2 mb-5">
                <div className="relative flex-1 min-w-[200px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search views by name or description…"
                        className="w-full pl-9 pr-4 py-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    />
                </div>
                <select
                    value={dsFilter}
                    onChange={e => setDsFilter(e.target.value)}
                    className="px-3 py-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                >
                    <option value="all">All sources</option>
                    {dataSources.map(ds => (
                        <option key={ds.id} value={ds.id}>{ds.label || ds.catalogItemId}</option>
                    ))}
                </select>
                <select
                    value={ownerFilter}
                    onChange={e => setOwnerFilter(e.target.value)}
                    className="px-3 py-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 max-w-[180px]"
                >
                    <option value="all">All owners</option>
                    {currentUser?.id && <option value={currentUser.id}>You</option>}
                    {ownerOptions.filter(o => o.id !== currentUser?.id).map(o => (
                        <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                </select>
                <ExplorerSortControl sort={sort} onSortChange={setSort} />
                {hasActiveFilters && (
                    <button
                        onClick={clearFilters}
                        className="inline-flex items-center gap-1 px-2.5 py-2 rounded-xl text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                        <X className="w-3.5 h-3.5" /> Clear
                    </button>
                )}
                {/* Grid / list toggle */}
                <div className="inline-flex items-center rounded-xl border border-glass-border overflow-hidden ml-auto">
                    <button
                        onClick={() => setLayout('grid')}
                        title="Grid"
                        className={cn('p-2 transition-colors', layout === 'grid' ? 'bg-indigo-500/12 text-indigo-500' : 'text-ink-muted hover:text-ink')}
                    >
                        <LayoutGrid className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setLayout('list')}
                        title="List"
                        className={cn('p-2 transition-colors', layout === 'list' ? 'bg-indigo-500/12 text-indigo-500' : 'text-ink-muted hover:text-ink')}
                    >
                        <ListIcon className="w-4 h-4" />
                    </button>
                </div>
            </div>

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
                                <ExplorerViewCard key={v.id} view={v} {...actionProps(v)} />
                            ))}
                        </div>
                    ) : (
                        <div className="rounded-xl border border-glass-border overflow-hidden">
                            <ExplorerListHeader sort={sort} onSortChange={setSort} withCheckbox />
                            <div className="divide-y divide-glass-border/50">
                                {views.map(v => (
                                    <ExplorerListRow key={v.id} view={v} {...actionProps(v)} />
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
                    <p className="text-xs text-ink-muted mb-4 max-w-sm mx-auto">
                        {hasActiveFilters
                            ? 'Try a different search or filter.'
                            : 'Views are saved visual perspectives on this workspace’s graph data. Create one to get started.'}
                    </p>
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
                onClearSelection={() => setSelectedIds(new Set())}
            />

            {/* ── Detail drawer (view + edit details), reused from Explorer ── */}
            <ExplorerPreviewDrawer
                view={previewView}
                isOpen={!!previewView}
                onClose={() => setPreviewView(null)}
                onToggleFavourite={() => previewView && toggleFavourite(previewView.id)}
                onShare={() => previewView && setShareView({ id: previewView.id, name: previewView.name, visibility: previewView.visibility })}
                onEdit={previewView ? () => { const id = previewView.id; setPreviewView(null); openViewEditor(id) } : undefined}
                onDelete={previewView && canDeleteView(previewView)
                    ? () => setDeleteView({ id: previewView!.id, name: previewView!.name, favouriteCount: previewView!.favouriteCount })
                    : undefined}
                healthStatus={previewView ? healthMap.get(previewView.id)?.status : undefined}
                providerInfo={previewView ? resolveProvider(previewView.dataSourceId) : undefined}
                initialEditMode={previewEditMode}
                onSaved={() => refetch()}
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
