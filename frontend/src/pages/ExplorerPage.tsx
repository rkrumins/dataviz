/**
 * Explorer page: /explorer
 *
 * Performance-optimized shopfront for views:
 * - No transition-all (specific properties only)
 * - No backdrop-blur on persistent elements
 * - CSS stagger via animation-delay (no framer-motion per card)
 * - Minimal motion: page-level fade-in only, no per-section orchestration
 * - Unified filter toolbar (no duplicate rows)
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Compass, Search, LayoutGrid, List, X, TrendingUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useExplorerViews, type SortOption, type ExplorerFilters } from '@/hooks/useExplorerViews'
import { useViewHealth } from '@/hooks/useViewHealth'
import { ExplorerViewCard } from '@/components/explorer/ExplorerViewCard'
import { ExplorerListRow } from '@/components/explorer/ExplorerListRow'
import { ExplorerFilterBar } from '@/components/explorer/ExplorerFilterBar'
import { ExplorerSortControl } from '@/components/explorer/ExplorerSortControl'
import { ExplorerHero } from '@/components/explorer/ExplorerHero'
import { ExplorerRecentStrip } from '@/components/explorer/ExplorerRecentStrip'
import { ExplorerEmptyState } from '@/components/explorer/ExplorerEmptyState'
import { ExplorerCardSkeleton, ExplorerListRowSkeleton } from '@/components/explorer/ExplorerCardSkeleton'
import { ExplorerPreviewDrawer } from '@/components/explorer/ExplorerPreviewDrawer'
import { ExplorerBulkActions } from '@/components/explorer/ExplorerBulkActions'
import { DeleteViewDialog } from '@/components/explorer/DeleteViewDialog'
import { ShareViewDialog } from '@/components/views/ShareViewDialog'
import type { View } from '@/services/viewApiService'

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 20

// ─── CSS stagger keyframes (injected once) ──────────────────────────────────

const STAGGER_STYLE = `
@keyframes card-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
.card-stagger { animation: card-in 0.3s ease-out both; }
`

// ─── URL Param Helpers ──────────────────────────────────────────────────────

function parseSearchParams(params: URLSearchParams) {
  return {
    search: params.get('q') ?? '',
    visibility: params.get('visibility'),
    workspaceIds: params.getAll('workspace'),
    dataSourceId: params.get('dataSource'),
    sort: (params.get('sort') as SortOption) ?? 'newest',
    layout: (params.get('layout') as 'grid' | 'list') ?? 'grid',
    favouritedOnly: params.get('favourites') === 'true',
    category: params.get('category'),
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ExplorerPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const parsed = parseSearchParams(searchParams)

  const [searchInput, setSearchInput] = useState(parsed.search)
  const searchRef = useRef<HTMLInputElement>(null)
  const [searchFocused, setSearchFocused] = useState(false)

  const [previewView, setPreviewView] = useState<View | null>(null)
  const [shareView, setShareView] = useState<{ id: string; name: string; visibility: 'private' | 'workspace' | 'enterprise' } | null>(null)
  const [deleteView, setDeleteView] = useState<{ id: string; name: string; favouriteCount: number } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // ─── URL param setters ──────────────────────────────────────────────

  const setParam = useCallback((key: string, value: string | null) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (value === null || value === '') next.delete(key)
      else next.set(key, value)
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setWorkspaceIds = useCallback((ids: string[]) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('workspace')
      ids.forEach(id => next.append('workspace', id))
      return next
    }, { replace: true })
  }, [setSearchParams])

  const clearAllFilters = useCallback(() => {
    setSearchParams({}, { replace: true })
    setSearchInput('')
  }, [setSearchParams])

  // Debounced URL sync
  const searchSyncTimer = useRef<ReturnType<typeof setTimeout>>(null)
  useEffect(() => {
    if (searchSyncTimer.current) clearTimeout(searchSyncTimer.current)
    searchSyncTimer.current = setTimeout(() => {
      const currentQ = searchParams.get('q') ?? ''
      if (searchInput !== currentQ) setParam('q', searchInput || null)
    }, 350)
    return () => { if (searchSyncTimer.current) clearTimeout(searchSyncTimer.current) }
  }, [searchInput]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Data fetching ──────────────────────────────────────────────────

  const filters: ExplorerFilters = {
    search: searchInput,
    visibility: parsed.visibility,
    workspaceIds: parsed.workspaceIds,
    dataSourceId: parsed.dataSourceId,
    sort: parsed.sort,
    favouritedOnly: parsed.favouritedOnly || parsed.category === 'favourites',
    category: parsed.category,
    limit: PAGE_SIZE,
    offset: 0,
  }

  const { views, totalCount, popularViews, isLoading, toggleFavourite, loadMore, hasMore } = useExplorerViews(filters)
  const healthMap = useViewHealth(views)
  const pinnedViews = useMemo(() => views.filter(v => v.isPinned), [views])

  const hasActiveFilters = !!(
    parsed.search || parsed.visibility || parsed.workspaceIds.length ||
    parsed.dataSourceId || parsed.favouritedOnly || parsed.category
  )

  // ─── Keyboard shortcuts ─────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        setSearchInput('')
        searchRef.current?.blur()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // ─── Infinite scroll ────────────────────────────────────────────────

  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!hasMore || isLoading) return
    const observer = new IntersectionObserver(
      entries => { if (entries[0]?.isIntersecting) loadMore() },
      { rootMargin: '200px' }
    )
    if (sentinelRef.current) observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [hasMore, isLoading, loadMore])

  // ─── Handlers ───────────────────────────────────────────────────────

  const handleShare = useCallback((view: View) => {
    navigator.clipboard.writeText(`${window.location.origin}/views/${view.id}`)
  }, [])

  const handleShareDialog = useCallback((view: View) => {
    setShareView({ id: view.id, name: view.name, visibility: view.visibility })
  }, [])

  const handleDeleteRequest = useCallback((view: View) => {
    setDeleteView({ id: view.id, name: view.name, favouriteCount: view.favouriteCount })
  }, [])

  // ─── Render ─────────────────────────────────────────────────────────

  const layout = parsed.layout

  return (
    <div className="absolute inset-0 overflow-y-auto bg-canvas custom-scrollbar">
      <style>{STAGGER_STYLE}</style>
      <div className="max-w-[1440px] mx-auto px-4 md:px-8 pb-28">

        {/* ── Header ──────────────────────────────────────────── */}
        <header className="pt-8 pb-6">
          {/* Title row */}
          <div className="flex items-center gap-3 mb-1">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent-lineage to-violet-600 flex items-center justify-center shadow-lg shadow-accent-lineage/20">
              <Compass className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-ink leading-tight">Explorer</h1>
              <p className="text-[11px] text-ink-muted">Discover views across workspaces</p>
            </div>
          </div>
        </header>

        {/* ── Search bar ──────────────────────────────────────── */}
        <div className="mb-5">
          <div className={cn(
            'relative flex items-center rounded-xl border bg-canvas-elevated overflow-hidden',
            'transition-[border-color,box-shadow] duration-200',
            searchFocused
              ? 'border-accent-lineage/50 shadow-[0_0_0_3px_rgba(var(--accent-lineage-rgb,99,102,241),0.08)]'
              : 'border-glass-border',
          )}>
            <Search className={cn(
              'w-4.5 h-4.5 ml-4 shrink-0 transition-colors duration-150',
              searchFocused ? 'text-accent-lineage' : 'text-ink-muted'
            )} />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search views by name, tag, workspace..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              className="flex-1 bg-transparent py-2.5 px-3 text-sm text-ink outline-none placeholder:text-ink-muted/50 font-medium"
            />
            {searchInput && (
              <button
                onClick={() => setSearchInput('')}
                className="mr-1.5 p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors duration-150"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            <kbd className="hidden sm:block mr-3 rounded border border-glass-border bg-black/[0.03] dark:bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
              /
            </kbd>
          </div>
        </div>

        {/* ── Unified toolbar: filters + sort + layout ─────────── */}
        <div className="flex items-start gap-3 mb-6">
          <div className="flex-1 min-w-0">
            <ExplorerFilterBar
              visibility={parsed.visibility}
              onVisibilityChange={v => setParam('visibility', v)}
              workspaceIds={parsed.workspaceIds}
              onWorkspaceIdsChange={setWorkspaceIds}
              dataSourceId={parsed.dataSourceId}
              onDataSourceIdChange={v => setParam('dataSource', v)}
              favouritedOnly={parsed.favouritedOnly}
              onFavouritedOnlyChange={v => setParam('favourites', v ? 'true' : null)}
              category={parsed.category}
              onCategoryChange={v => setParam('category', v)}
            />
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <ExplorerSortControl
              sort={parsed.sort}
              onSortChange={v => setParam('sort', v)}
            />
            <div className="inline-flex items-center rounded-lg border border-glass-border p-0.5">
              <button
                onClick={() => setParam('layout', 'grid')}
                className={cn(
                  'p-1.5 rounded-md transition-colors duration-150',
                  layout === 'grid' ? 'bg-accent-lineage/12 text-accent-lineage' : 'text-ink-muted hover:text-ink'
                )}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setParam('layout', 'list')}
                className={cn(
                  'p-1.5 rounded-md transition-colors duration-150',
                  layout === 'list' ? 'bg-accent-lineage/12 text-accent-lineage' : 'text-ink-muted hover:text-ink'
                )}
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* ── Featured / Pinned ────────────────────────────────── */}
        {!hasActiveFilters && pinnedViews.length > 0 && (
          <ExplorerHero views={pinnedViews} onToggleFavourite={toggleFavourite} />
        )}

        {/* ── Recently Viewed ──────────────────────────────────── */}
        {!hasActiveFilters && <ExplorerRecentStrip />}

        {/* ── Trending ─────────────────────────────────────────── */}
        {!hasActiveFilters && popularViews.length > 0 && (
          <section className="mb-8">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                <TrendingUp className="w-3.5 h-3.5 text-amber-500" />
              </div>
              <h2 className="text-sm font-bold text-ink">Trending</h2>
              <span className="text-[11px] text-ink-muted">Most favourited</span>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-none [&::-webkit-scrollbar]:hidden">
              {popularViews.slice(0, 6).map(v => (
                <div key={v.id} className="flex-shrink-0 w-[280px]">
                  <ExplorerViewCard
                    view={v}
                    onToggleFavourite={() => toggleFavourite(v.id)}
                    onShare={() => handleShare(v)}
                    onPreview={() => setPreviewView(v)}
                    onDelete={() => handleDeleteRequest(v)}
                    healthStatus={healthMap.get(v.id)?.status}
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Results ──────────────────────────────────────────── */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
              <Compass className="w-3.5 h-3.5 text-indigo-500" />
            </div>
            <h2 className="text-sm font-bold text-ink">
              {hasActiveFilters ? `Results${parsed.search ? ` for "${parsed.search}"` : ''}` : 'All Views'}
            </h2>
            <span className="text-[11px] text-ink-muted">{totalCount}</span>
          </div>

          {isLoading ? (
            layout === 'grid' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {Array.from({ length: 8 }).map((_, i) => <ExplorerCardSkeleton key={i} />)}
              </div>
            ) : (
              <div className="rounded-2xl border border-glass-border overflow-hidden bg-canvas-elevated">
                {Array.from({ length: 8 }).map((_, i) => <ExplorerListRowSkeleton key={i} />)}
              </div>
            )
          ) : views.length === 0 ? (
            <ExplorerEmptyState
              type={totalCount === 0 && !hasActiveFilters ? 'no-views' : 'no-results'}
              searchTerm={parsed.search}
              hasFilters={hasActiveFilters}
              onClearFilters={clearAllFilters}
            />
          ) : layout === 'grid' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {views.map((v, i) => (
                <div
                  key={v.id}
                  className="card-stagger"
                  style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
                >
                  <ExplorerViewCard
                    view={v}
                    onToggleFavourite={() => toggleFavourite(v.id)}
                    onShare={() => handleShare(v)}
                    onPreview={() => setPreviewView(v)}
                    onDelete={() => handleDeleteRequest(v)}
                    healthStatus={healthMap.get(v.id)?.status}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-glass-border overflow-hidden bg-canvas-elevated">
              <div className="grid grid-cols-[1fr_140px_100px_36px_120px_60px_80px_72px] gap-3 px-4 py-2.5 border-b border-glass-border/50 text-[10px] uppercase tracking-wider text-ink-muted font-bold">
                <span>Name</span><span>Workspace</span><span>Type</span><span>Vis</span><span>Owner</span><span>Likes</span><span>Updated</span><span></span>
              </div>
              {views.map(v => (
                <ExplorerListRow
                  key={v.id}
                  view={v}
                  onToggleFavourite={() => toggleFavourite(v.id)}
                  onShare={() => handleShare(v)}
                  onPreview={() => setPreviewView(v)}
                  onDelete={() => handleDeleteRequest(v)}
                  healthStatus={healthMap.get(v.id)?.status}
                />
              ))}
            </div>
          )}

          {hasMore && <div ref={sentinelRef} className="h-4" />}
        </section>
      </div>

      {/* Overlays */}
      <ExplorerPreviewDrawer
        view={previewView}
        isOpen={!!previewView}
        onClose={() => setPreviewView(null)}
        onToggleFavourite={() => previewView && toggleFavourite(previewView.id)}
        onShare={() => previewView && handleShareDialog(previewView)}
      />
      <ExplorerBulkActions
        selectedCount={selectedIds.size}
        onDelete={() => {}}
        onChangeVisibility={() => {}}
        onClearSelection={() => setSelectedIds(new Set())}
      />
      {shareView && (
        <ShareViewDialog viewId={shareView.id} viewName={shareView.name} currentVisibility={shareView.visibility} isOpen={true} onClose={() => setShareView(null)} />
      )}
      {deleteView && (
        <DeleteViewDialog viewId={deleteView.id} viewName={deleteView.name} favouriteCount={deleteView.favouriteCount} isOpen={true} onClose={() => setDeleteView(null)} onDeleted={() => setDeleteView(null)} />
      )}
    </div>
  )
}
