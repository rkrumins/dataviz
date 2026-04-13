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
import { AnimatePresence, motion } from 'framer-motion'
import { useSearchParams } from 'react-router-dom'
import {
  Compass, Search, LayoutGrid, List, X, TrendingUp, Plus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth'
import { useExplorerViews, type SortOption, type ExplorerFilters } from '@/hooks/useExplorerViews'
import { useViewHealth } from '@/hooks/useViewHealth'
import { ExplorerViewCard } from '@/components/explorer/ExplorerViewCard'
import { ExplorerListRow } from '@/components/explorer/ExplorerListRow'
import { ExplorerListHeader } from '@/components/explorer/ExplorerListHeader'
import { ExplorerFilterBar } from '@/components/explorer/ExplorerFilterBar'
import { ExplorerStatsBar } from '@/components/explorer/ExplorerStatsBar'
import { DensityToggle } from '@/components/explorer/DensityToggle'
import { ExplorerSearchSuggestions } from '@/components/explorer/ExplorerSearchSuggestions'
import { KeyboardShortcutsDialog } from '@/components/explorer/KeyboardShortcutsDialog'
import { useViewFacets } from '@/hooks/useViewFacets'
import { useRecentSearches } from '@/hooks/useRecentSearches'
import { useTypewriter } from '@/hooks/useTypewriter'
import { usePreferencesStore } from '@/store/preferences'
import { ExplorerSortControl } from '@/components/explorer/ExplorerSortControl'
import { ExplorerHero } from '@/components/explorer/ExplorerHero'
import { ExplorerRecentStrip } from '@/components/explorer/ExplorerRecentStrip'
import { ExplorerEmptyState } from '@/components/explorer/ExplorerEmptyState'
import { ExplorerCardSkeleton, ExplorerListRowSkeleton } from '@/components/explorer/ExplorerCardSkeleton'
import { ExplorerPreviewDrawer } from '@/components/explorer/ExplorerPreviewDrawer'
import { ExplorerBulkActions } from '@/components/explorer/ExplorerBulkActions'
import { DeleteViewDialog } from '@/components/explorer/DeleteViewDialog'
import { BulkDeleteDialog } from '@/components/explorer/BulkDeleteDialog'
import { ShareViewDialog } from '@/components/views/ShareViewDialog'
import { updateViewVisibility, restoreView as restoreViewApi, type View } from '@/services/viewApiService'
import { useViewEditorModal } from '@/components/layout/AppLayout'
import { useWorkspacesStore } from '@/store/workspaces'
import { useToast } from '@/components/ui/toast'
import { AggregationProgressBanner } from '@/components/explorer/AggregationProgressBanner'

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
    viewTypes: params.getAll('type'),
    tags: params.getAll('tag'),
    creatorIds: params.getAll('creator'),
    sort: (params.get('sort') as SortOption) ?? 'newest',
    layout: (params.get('layout') as 'grid' | 'list') ?? 'grid',
    category: params.get('category'),
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ExplorerPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const parsed = parseSearchParams(searchParams)
  const currentUser = useAuthStore(s => s.user)
  const { openViewEditor } = useViewEditorModal()
  const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
  const { facets: explorerFacets, isLoading: facetsLoading } = useViewFacets()
  const density = usePreferencesStore(s => s.explorerDensity)

  // Tailwind gap class for the grid layout, driven by density preference.
  const gridGapClass =
    density === 'compact' ? 'gap-2.5'
    : density === 'spacious' ? 'gap-6'
    : 'gap-4'

  const [searchInput, setSearchInput] = useState(parsed.search)
  const searchRef = useRef<HTMLInputElement>(null)
  const [searchFocused, setSearchFocused] = useState(false)
  const { recents, record: recordRecent, remove: removeRecent, clear: clearRecents } = useRecentSearches()

  // Typewriter placeholder — cycles tips while the field is empty + not
  // focused so new users discover the search surface passively, with a
  // live "someone is typing" feel rather than a jarring snap-replace.
  // The hook pauses itself when ``enabled`` flips to false.
  const placeholderPhrases = useMemo(() => [
    'views by name, tag, or workspace…',
    'a workspace — "production", "analytics"…',
    'a tag — "finance", "pii", "kpi"…',
    'a creator name or email…',
    'views in a specific data source…',
  ], [])
  const typewriterText = useTypewriter({
    phrases: placeholderPhrases,
    enabled: !searchFocused && !searchInput,
  })

  const [previewView, setPreviewView] = useState<View | null>(null)
  const [shareView, setShareView] = useState<{ id: string; name: string; visibility: 'private' | 'workspace' | 'enterprise' } | null>(null)
  const [deleteView, setDeleteView] = useState<{ id: string; name: string; favouriteCount: number; permanent?: boolean } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulkDelete, setShowBulkDelete] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  
  // no-op callback for aggregation banner (informational only — no longer gates view creation)
  const onAggregationStatus = useCallback((_isReady: boolean) => {}, [])

  // ─── URL param setters ──────────────────────────────────────────────

  const setParam = useCallback((key: string, value: string | null) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (value === null || value === '') next.delete(key)
      else next.set(key, value)
      return next
    }, { replace: true })
  }, [setSearchParams])

  /**
   * Replace all values of a multi-value URL param (e.g. ``workspace``,
   * ``tag``, ``type``, ``creator``). Generic helper so every multi-select
   * dropdown in the filter bar uses the same plumbing instead of
   * re-inventing the delete+append dance.
   */
  const setMultiParam = useCallback((key: string, values: string[]) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete(key)
      values.forEach(v => next.append(key, v))
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setWorkspaceIds = useCallback((ids: string[]) => setMultiParam('workspace', ids), [setMultiParam])
  const setViewTypes = useCallback((types: string[]) => setMultiParam('type', types), [setMultiParam])
  const setTags = useCallback((tags: string[]) => setMultiParam('tag', tags), [setMultiParam])
  const setCreatorIds = useCallback((ids: string[]) => setMultiParam('creator', ids), [setMultiParam])

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

  // Record a search once it's been committed to the URL — only persist
  // real queries, not transient typing.
  useEffect(() => {
    if (parsed.search) recordRecent(parsed.search)
  }, [parsed.search, recordRecent])

  // ─── Data fetching ──────────────────────────────────────────────────

  const filters: ExplorerFilters = {
    search: searchInput,
    visibility: parsed.visibility,
    workspaceIds: parsed.workspaceIds,
    dataSourceId: parsed.dataSourceId,
    viewTypes: parsed.viewTypes,
    tags: parsed.tags,
    creatorIds: parsed.creatorIds,
    sort: parsed.sort,
    // Favourites is driven exclusively by the "Favorites" category pill;
    // the server-side resolver maps that category to ``favouritedOnly=true``.
    favouritedOnly: false,
    category: parsed.category,
    currentUserId: currentUser?.id ?? null,
    limit: PAGE_SIZE,
    offset: 0,
  }

  const {
    views,
    totalCount,
    popularViews,
    isLoading,
    toggleFavourite,
    removeView: removeViewFromList,
    refetch,
    loadMore,
    hasMore,
  } = useExplorerViews(filters)
  // Health map still drives the per-card health badge, but the
  // needs-attention filter itself runs server-side now, so the Explorer
  // no longer post-filters the loaded page.
  const healthMap = useViewHealth(views)

  const pinnedViews = useMemo(() => views.filter(v => v.isPinned), [views])

  const hasActiveFilters = !!(
    parsed.search || parsed.visibility || parsed.workspaceIds.length ||
    parsed.dataSourceId || parsed.viewTypes.length ||
    parsed.tags.length || parsed.creatorIds.length ||
    parsed.category
  )

  const layout = parsed.layout

  // ─── Keyboard navigation ────────────────────────────────────────────

  const [focusedIndex, setFocusedIndex] = useState(-1)
  const gridRef = useRef<HTMLDivElement>(null)

  // Reset focus when views change
  useEffect(() => { setFocusedIndex(-1) }, [views])

  // Scroll focused card into view
  useEffect(() => {
    if (focusedIndex < 0 || !gridRef.current) return
    const child = gridRef.current.children[focusedIndex] as HTMLElement | undefined
    child?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusedIndex])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      const inInput = ['INPUT', 'TEXTAREA'].includes(tag)

      // / → focus search
      if (e.key === '/' && !inInput) {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      // ? → show keyboard shortcuts cheat-sheet. ``?`` is a Shift+/ on
      // most layouts; use the resolved key rather than a shift+slash
      // combo so it works regardless of locale.
      if (e.key === '?' && !inInput) {
        e.preventDefault()
        setShortcutsOpen(true)
        return
      }
      // Escape → clear search / blur / deselect focus
      if (e.key === 'Escape') {
        if (document.activeElement === searchRef.current) {
          setSearchInput('')
          searchRef.current?.blur()
        } else {
          setFocusedIndex(-1)
        }
        return
      }

      // Arrow / Enter / f only when not in an input
      if (inInput || views.length === 0) return

      const cols = layout === 'list' ? 1
        : gridRef.current
          ? Math.round(gridRef.current.offsetWidth / (gridRef.current.firstElementChild as HTMLElement)?.offsetWidth || 1)
          : 4

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? cols : 1
        setFocusedIndex(prev => Math.min(prev + step, views.length - 1))
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowUp' ? cols : 1
        setFocusedIndex(prev => Math.max(prev - step, 0))
      } else if (e.key === 'Enter' && focusedIndex >= 0 && focusedIndex < views.length) {
        e.preventDefault()
        setPreviewView(views[focusedIndex])
      } else if (e.key === 'f' && focusedIndex >= 0 && focusedIndex < views.length) {
        e.preventDefault()
        toggleFavourite(views[focusedIndex].id)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [views, focusedIndex, layout, toggleFavourite])

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

  const { showToast } = useToast()

  const handleShare = useCallback((view: View) => {
    navigator.clipboard.writeText(`${window.location.origin}/views/${view.id}`)
      .then(() => showToast('success', `Link copied for "${view.name}"`))
      .catch(() => showToast('error', 'Failed to copy link'))
  }, [showToast])

  const handleShareDialog = useCallback((view: View) => {
    setShareView({ id: view.id, name: view.name, visibility: view.visibility })
  }, [])

  const handleDeleteRequest = useCallback((view: View) => {
    setDeleteView({ id: view.id, name: view.name, favouriteCount: view.favouriteCount })
  }, [])

  const handlePermanentDeleteRequest = useCallback((view: View) => {
    setDeleteView({ id: view.id, name: view.name, favouriteCount: view.favouriteCount, permanent: true })
  }, [])

  const handleDeleted = useCallback(() => {
    if (!deleteView) return
    const deletedName = deleteView.name
    const deletedId = deleteView.id
    // Close dialog
    setDeleteView(null)
    // Close preview drawer if it was showing this view
    setPreviewView(prev => prev?.id === deletedId ? null : prev)
    // Remove from list optimistically
    removeViewFromList(deletedId)
    // Deselect if it was selected
    setSelectedIds(prev => {
      if (!prev.has(deletedId)) return prev
      const next = new Set(prev)
      next.delete(deletedId)
      return next
    })
    // Toast
    showToast('success', `"${deletedName}" has been deleted`)
  }, [deleteView, removeViewFromList, showToast])

  const handleBulkDelete = useCallback(() => {
    if (selectedIds.size === 0) return
    setShowBulkDelete(true)
  }, [selectedIds])

  const handleBulkDeleted = useCallback(() => {
    const ids = Array.from(selectedIds)
    ids.forEach(id => removeViewFromList(id))
    setPreviewView(prev => prev && ids.includes(prev.id) ? null : prev)
    setSelectedIds(new Set())
    setShowBulkDelete(false)
    showToast('success', `Deleted ${ids.length} view${ids.length !== 1 ? 's' : ''}`)
  }, [selectedIds, removeViewFromList, showToast])

  const handleBulkVisibility = useCallback(async (visibility: 'private' | 'workspace' | 'enterprise') => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    const count = ids.length
    try {
      await Promise.all(ids.map(id => updateViewVisibility(id, visibility)))
      setSelectedIds(new Set())
      refetch()
      showToast('success', `Updated visibility to "${visibility}" for ${count} view${count !== 1 ? 's' : ''}`)
    } catch {
      showToast('error', 'Some views could not be updated')
    }
  }, [selectedIds, showToast, refetch])

  /**
   * Clicking a tag chip on a card toggles that tag in the tag filter —
   * a fast "show me more like this" interaction. If the tag is already
   * active it's removed; otherwise it's added to whatever set is in
   * the URL.
   */
  const handleTagClick = useCallback((tag: string) => {
    const current = parsed.tags
    const next = current.includes(tag)
      ? current.filter(t => t !== tag)
      : [...current, tag]
    setTags(next)
  }, [parsed.tags, setTags])

  const handleRestore = useCallback(async (view: View) => {
    try {
      await restoreViewApi(view.id)
      refetch()
      showToast('success', `"${view.name}" has been restored`)
    } catch {
      showToast('error', `Failed to restore "${view.name}"`)
    }
  }, [refetch, showToast])

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <div className="absolute inset-0 overflow-y-auto bg-canvas custom-scrollbar">
      <style>{STAGGER_STYLE}</style>
      <div className="px-6 md:px-10 lg:px-12 pb-28">

        {/* ── Header ──────────────────────────────────────────── */}
        <header className="pt-8 pb-6">
          {/* Title row */}
          <div className="flex items-center gap-3 mb-1">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent-lineage to-violet-600 flex items-center justify-center shadow-lg shadow-accent-lineage/20">
              <Compass className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1">
              <h1 className="text-xl font-bold text-ink leading-tight">Explorer</h1>
              <p className="text-[11px] text-ink-muted">Discover views across workspaces</p>
            </div>
            <button
              onClick={() => openViewEditor()}
              className={cn(
                'inline-flex items-center gap-2 rounded-xl px-4 py-2.5',
                'text-sm font-semibold',
                'bg-gradient-to-r from-accent-lineage to-violet-600 text-white shadow-lg shadow-accent-lineage/20 hover:shadow-xl hover:-translate-y-0.5',
                'transition-all duration-200',
              )}
              title="Create a new view"
            >
              <Plus className="w-4 h-4" />
              New View
            </button>
          </div>
        </header>

        {/* ── Stats summary bar ───────────────────────────────── */}
        <ExplorerStatsBar
          stats={explorerFacets.stats}
          isLoading={facetsLoading}
          onShowAll={() => setParam('category', null)}
          onShowRecent={() => setParam('category', 'recently-added')}
          onShowAttention={() => setParam('category', 'needs-attention')}
        />

        {/* ── Search bar ──────────────────────────────────────── */}
        <div className="mb-5 relative">
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
            {/* Input wrapper — lets the typewriter overlay sit atop the
                input without blocking pointer events. The real input is
                still the focus/typing surface; the overlay only paints
                the animated placeholder. */}
            <div className="flex-1 relative">
              <input
                ref={searchRef}
                type="text"
                /* Fallback for no-JS / reduced-motion: a static prompt. */
                placeholder={(!searchFocused && !searchInput) ? '' : 'Search views by name, tag, workspace...'}
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                className="w-full bg-transparent py-2.5 px-3 text-sm text-ink outline-none placeholder:text-ink-muted/50 font-medium"
              />
              {!searchFocused && !searchInput && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 px-3 py-2.5 flex items-center text-sm font-medium text-ink-muted/60 overflow-hidden whitespace-nowrap"
                >
                  <span>Search </span>
                  <span className="ml-1">{typewriterText}</span>
                  <span className="ml-[1px] inline-block w-[2px] h-[1em] translate-y-[1px] bg-ink-muted/50 animate-pulse" />
                </div>
              )}
            </div>
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

          {/* Search suggestions dropdown — recent + examples. Only
              visible while the input is focused and empty so it never
              competes with live results. */}
          {searchFocused && !searchInput && (
            <ExplorerSearchSuggestions
              recentSearches={recents}
              onPick={q => {
                setSearchInput(q)
                setSearchFocused(false)
                searchRef.current?.blur()
              }}
              onClearRecents={clearRecents}
              onRemoveRecent={removeRecent}
            />
          )}
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
              viewTypes={parsed.viewTypes}
              onViewTypesChange={setViewTypes}
              tags={parsed.tags}
              onTagsChange={setTags}
              creatorIds={parsed.creatorIds}
              onCreatorIdsChange={setCreatorIds}
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
            <DensityToggle />
          </div>
        </div>

        {/* ── Headline Banner for Aggregation ───────────────────── */}
        {activeWorkspaceId && parsed.dataSourceId && (
          <AggregationProgressBanner 
            workspaceId={activeWorkspaceId}
            dataSourceId={parsed.dataSourceId}
            onStatusChange={onAggregationStatus}
          />
        )}

        {/* ── Featured / Pinned ────────────────────────────────── */}
        {!hasActiveFilters && pinnedViews.length > 0 && (
          <ExplorerHero views={pinnedViews} onToggleFavourite={toggleFavourite} onPreview={setPreviewView} />
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
                <div key={v.id} className="flex-shrink-0 w-[300px]">
                  <ExplorerViewCard
                    view={v}
                    onToggleFavourite={() => toggleFavourite(v.id)}
                    onShare={() => handleShare(v)}
                    onPreview={() => setPreviewView(v)}
                    onEdit={() => openViewEditor(v.id)}
                    editDisabled={false}
                    onDelete={() => handleDeleteRequest(v)}
                    onRestore={() => handleRestore(v)}
                    onPermanentDelete={() => handlePermanentDeleteRequest(v)}
                    onTagClick={handleTagClick}
                    healthStatus={healthMap.get(v.id)?.status}
                    density={density}
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

          {/* Results slot with layout-swap crossfade. Each possible
              branch is wrapped in a motion.div with a distinct key so
              AnimatePresence sees the swap and animates between them. */}
          <AnimatePresence mode="wait" initial={false}>
          {isLoading ? (
            <motion.div
              key={`skeleton-${layout}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {layout === 'grid' ? (
                <div className={cn('grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 min-[1920px]:grid-cols-6', gridGapClass)}>
                  {Array.from({ length: 8 }).map((_, i) => <ExplorerCardSkeleton key={i} />)}
                </div>
              ) : (
                <div className="rounded-2xl border border-glass-border overflow-hidden bg-canvas-elevated">
                  {Array.from({ length: 8 }).map((_, i) => <ExplorerListRowSkeleton key={i} />)}
                </div>
              )}
            </motion.div>
          ) : views.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
            >
              <ExplorerEmptyState
                type={totalCount === 0 && !hasActiveFilters ? 'no-views' : 'no-results'}
                searchTerm={parsed.search}
                hasFilters={hasActiveFilters}
                activeCategory={parsed.category}
                onClearFilters={clearAllFilters}
                onCreateView={() => openViewEditor()}
              />
            </motion.div>
          ) : layout === 'grid' ? (
            <motion.div
              key="results-grid"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <div ref={gridRef} className={cn('grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 min-[1920px]:grid-cols-6', gridGapClass)}>
                {views.map((v, i) => (
                  <div
                    key={v.id}
                    className={cn('card-stagger', i === focusedIndex && 'ring-2 ring-accent-lineage/50 rounded-2xl')}
                    style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
                  >
                    <ExplorerViewCard
                      view={v}
                      onToggleFavourite={() => toggleFavourite(v.id)}
                      onShare={() => handleShare(v)}
                      onPreview={() => setPreviewView(v)}
                      onEdit={() => openViewEditor(v.id)}
                      editDisabled={false}
                      onDelete={() => handleDeleteRequest(v)}
                      onRestore={() => handleRestore(v)}
                      onPermanentDelete={() => handlePermanentDeleteRequest(v)}
                      onTagClick={handleTagClick}
                      healthStatus={healthMap.get(v.id)?.status}
                      isSelected={selectedIds.has(v.id)}
                      density={density}
                      onToggleSelect={() => setSelectedIds(prev => {
                        const next = new Set(prev)
                        if (next.has(v.id)) next.delete(v.id)
                        else next.add(v.id)
                        return next
                      })}
                    />
                  </div>
                ))}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="results-list"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
            <div className="rounded-2xl border border-glass-border overflow-hidden bg-canvas-elevated">
              <ExplorerListHeader
                sort={parsed.sort}
                onSortChange={v => setParam('sort', v)}
              />
              {views.map(v => (
                <ExplorerListRow
                  key={v.id}
                  view={v}
                  onToggleFavourite={() => toggleFavourite(v.id)}
                  onShare={() => handleShare(v)}
                  onPreview={() => setPreviewView(v)}
                  onEdit={() => openViewEditor(v.id)}
                  editDisabled={false}
                  onDelete={() => handleDeleteRequest(v)}
                  onRestore={() => handleRestore(v)}
                  onPermanentDelete={() => handlePermanentDeleteRequest(v)}
                  healthStatus={healthMap.get(v.id)?.status}
                  isSelected={selectedIds.has(v.id)}
                  density={density}
                  onToggleSelect={() => setSelectedIds(prev => {
                    const next = new Set(prev)
                    if (next.has(v.id)) next.delete(v.id)
                    else next.add(v.id)
                    return next
                  })}
                />
              ))}
            </div>
            </motion.div>
          )}
          </AnimatePresence>

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
        onEdit={previewView ? () => { setPreviewView(null); openViewEditor(previewView.id) } : undefined}
        editDisabled={false}
        onDelete={() => previewView && handleDeleteRequest(previewView)}
        healthStatus={previewView ? healthMap.get(previewView.id)?.status : undefined}
      />
      <ExplorerBulkActions
        selectedCount={selectedIds.size}
        onDelete={handleBulkDelete}
        onChangeVisibility={handleBulkVisibility}
        onClearSelection={() => setSelectedIds(new Set())}
      />
      {shareView && (
        <ShareViewDialog viewId={shareView.id} viewName={shareView.name} currentVisibility={shareView.visibility} isOpen={true} onClose={() => setShareView(null)} />
      )}
      {deleteView && (
        <DeleteViewDialog viewId={deleteView.id} viewName={deleteView.name} favouriteCount={deleteView.favouriteCount} isOpen={true} onClose={() => setDeleteView(null)} onDeleted={handleDeleted} permanent={deleteView.permanent} />
      )}
      <BulkDeleteDialog
        viewIds={Array.from(selectedIds)}
        isOpen={showBulkDelete}
        onClose={() => setShowBulkDelete(false)}
        onDeleted={handleBulkDeleted}
        permanent={parsed.category === 'deleted'}
      />
      <KeyboardShortcutsDialog
        isOpen={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

    </div>
  )
}
