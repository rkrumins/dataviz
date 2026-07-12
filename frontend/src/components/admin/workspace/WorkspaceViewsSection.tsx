/**
 * WorkspaceViewsSection — the workspace-detail "Views" tab (?tab=views).
 *
 * The in-workspace home for managing a workspace's views. It reuses the
 * Explorer building blocks — the same ``ExplorerViewCard``, share/delete
 * dialogs, favourite/restore handlers and provider resolver — scoped to
 * this one workspace, so management here is identical in look and behaviour
 * to the global Explorer without duplicating any of it. Heavier, cross-
 * workspace browsing still lives in Explorer, one click away via "Browse in
 * Explorer".
 *
 * Data + mutations come from ``useExplorerViews`` (scoped to this workspace),
 * which owns the fetch, favourite toggle, optimistic removal, pagination and
 * search debounce — the same hook the Explorer page uses.
 */
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Eye, Search, Plus, Compass } from 'lucide-react'
import type { DataSourceResponse } from '@/services/workspaceService'
import { restoreView as restoreViewApi, type View } from '@/services/viewApiService'
import { useExplorerViews, type ExplorerFilters, type SortOption } from '@/hooks/useExplorerViews'
import { useViewHealth } from '@/hooks/useViewHealth'
import { useDataSourceProviderMap } from '@/hooks/useDataSourceProviderMap'
import { useViewEditorModal } from '@/components/layout/AppLayout'
import { useToast } from '@/components/ui/toast'
import { useAuthStore } from '@/store/auth'
import { ExplorerViewCard } from '@/components/explorer/ExplorerViewCard'
import { ExplorerSortControl } from '@/components/explorer/ExplorerSortControl'
import { ExplorerCardSkeleton } from '@/components/explorer/ExplorerCardSkeleton'
import { DeleteViewDialog } from '@/components/explorer/DeleteViewDialog'
import { ShareViewDialog } from '@/components/views/ShareViewDialog'

interface WorkspaceViewsSectionProps {
    wsId: string
    dataSources: DataSourceResponse[]
}

export default function WorkspaceViewsSection({ wsId, dataSources }: WorkspaceViewsSectionProps) {
    const navigate = useNavigate()
    const currentUser = useAuthStore(s => s.user)
    const { openViewEditor } = useViewEditorModal()
    const { showToast } = useToast()
    const { resolve: resolveProvider } = useDataSourceProviderMap()

    const [dsFilter, setDsFilter] = useState<string>('all')
    const [search, setSearch] = useState('')
    const [sort, setSort] = useState<SortOption>('updated')

    // Scoped to this workspace. useExplorerViews debounces the search field
    // internally, so a raw value is fine here.
    const filters: ExplorerFilters = useMemo(() => ({
        search,
        visibility: null,
        workspaceIds: [wsId],
        dataSourceId: dsFilter === 'all' ? null : dsFilter,
        viewTypes: [],
        tags: [],
        creatorIds: [],
        sort,
        favouritedOnly: false,
        category: null,
        currentUserId: currentUser?.id ?? null,
        limit: 60,
        offset: 0,
    }), [search, wsId, dsFilter, sort, currentUser?.id])

    const {
        views, totalCount, isLoading,
        toggleFavourite, removeView, refetch, loadMore, hasMore,
    } = useExplorerViews(filters)
    const healthMap = useViewHealth(views)

    // ─── Management dialogs + handlers (mirror ExplorerPage) ──────────
    const [shareView, setShareView] = useState<{ id: string; name: string; visibility: string } | null>(null)
    const [deleteView, setDeleteView] = useState<{ id: string; name: string; favouriteCount: number } | null>(null)

    // BE rule (views.py can_delete_view): creator OR workspace:view:delete on
    // the view's workspace. Mirror it so the Delete affordance hides for users
    // who would just get a 403.
    const canDeleteView = (view: View): boolean => {
        if (currentUser?.id && view.createdBy === currentUser.id) return true
        return useAuthStore.getState().can('workspace:view:delete', view.workspaceId)
    }

    const handleDeleted = () => {
        if (!deleteView) return
        const { id, name } = deleteView
        setDeleteView(null)
        removeView(id)
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

    const hasActiveFilters = !!search || dsFilter !== 'all'

    return (
        <section>
            {/* ── Header ─────────────────────────────────────────── */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
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
            <div className="flex flex-wrap items-center gap-3 mb-5">
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
                <ExplorerSortControl sort={sort} onSortChange={setSort} />
            </div>

            {/* ── Grid ───────────────────────────────────────────── */}
            {isLoading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {Array.from({ length: 6 }).map((_, i) => <ExplorerCardSkeleton key={i} />)}
                </div>
            ) : views.length > 0 ? (
                <>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {views.map(v => (
                            <ExplorerViewCard
                                key={v.id}
                                view={v}
                                onToggleFavourite={() => toggleFavourite(v.id)}
                                onShare={() => setShareView({ id: v.id, name: v.name, visibility: v.visibility })}
                                onPreview={() => navigate(`/views/${v.id}`)}
                                onEdit={() => openViewEditor(v.id)}
                                onDelete={canDeleteView(v)
                                    ? () => setDeleteView({ id: v.id, name: v.name, favouriteCount: v.favouriteCount })
                                    : undefined}
                                onRestore={() => handleRestore(v)}
                                healthStatus={healthMap.get(v.id)?.status}
                                providerInfo={resolveProvider(v.dataSourceId)}
                            />
                        ))}
                    </div>
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
                            ? 'Try a different search or data-source filter.'
                            : 'Views are saved visual perspectives on this workspace’s graph data. Create one to get started.'}
                    </p>
                    {!hasActiveFilters && (
                        <button
                            onClick={() => openViewEditor()}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors"
                        >
                            <Plus className="w-4 h-4" /> New view
                        </button>
                    )}
                </div>
            )}

            {/* ── Dialogs (reused from Explorer) ─────────────────── */}
            {shareView && (
                <ShareViewDialog
                    viewId={shareView.id}
                    viewName={shareView.name}
                    currentVisibility={shareView.visibility as 'private' | 'workspace' | 'enterprise'}
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
        </section>
    )
}
