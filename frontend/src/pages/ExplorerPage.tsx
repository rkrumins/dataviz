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
import { useQueryClient } from '@tanstack/react-query'
import {
  Compass, Search, LayoutGrid, List, X, TrendingUp, Plus, FileUp, AlertTriangle, RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth'
import { useExplorerViews, type SortOption, type ExplorerFilters } from '@/hooks/useExplorerViews'
import { useViewStats } from '@/hooks/useViewStats'
import { useViewHealth } from '@/hooks/useViewHealth'
import { useViewUsage } from '@/hooks/useContentInsights'
import { useOpensOrdering } from '@/components/explorer/useOpensOrdering'
import { ExplorerViewCard } from '@/components/explorer/ExplorerViewCard'
import { ExplorerListRow } from '@/components/explorer/ExplorerListRow'
import { ExplorerListHeader } from '@/components/explorer/ExplorerListHeader'
import { ExplorerFilterBar } from '@/components/explorer/ExplorerFilterBar'
import { ExplorerStatsBar } from '@/components/explorer/ExplorerStatsBar'
import { DensityToggle } from '@/components/explorer/DensityToggle'
import { ExplorerSearchSuggestions } from '@/components/explorer/ExplorerSearchSuggestions'
import { KeyboardShortcutsDialog } from '@/components/explorer/KeyboardShortcutsDialog'
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
import { ExportViewDialog } from '@/features/view-transfer/ExportViewDialog'
import { useViewFileDrop } from '@/features/view-transfer/useViewFileDrop'
import { ViewFileDropOverlay } from '@/features/view-transfer/ViewFileDropOverlay'
import { DeleteViewDialog } from '@/components/explorer/DeleteViewDialog'
import { BulkDeleteDialog } from '@/components/explorer/BulkDeleteDialog'
import { ShareViewDialog } from '@/components/views/ShareViewDialog'
import { updateViewVisibility, restoreView as restoreViewApi, type View } from '@/services/viewApiService'
import { useViewEditorModal } from '@/components/layout/AppLayout'
import { useWorkspacesStore } from '@/store/workspaces'
import { useViewPortability } from '@/features/view-transfer/useViewPortability'
import { useDataSourceProviderMap } from '@/hooks/useDataSourceProviderMap'
import { useAppNotifications } from '@/components/ui/notifications'
import { useCopyViewLink } from '@/lib/viewShareLink'
import { AggregationProgressBanner } from '@/components/explorer/AggregationProgressBanner'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { PageContainer } from '@/components/layout/PageContainer'
import { TourLaunchButton } from '@/features/tour/TourLaunchButton'
import { isInKeyboardScope } from '@/lib/keyboardScope'
import { EMPTY_FILTERS, ME, isAnyFilterActive, type ViewFilterState } from '@/features/view-filters/model'
import { readFilterState, writeFilterState } from '@/features/view-filters/url'
import { resolveFilters, toQueryParams } from '@/features/view-filters/params'
import { useLocalDay } from '@/features/view-filters/useLocalDay'
import { ActivityTimeline } from '@/features/view-filters/components/ActivityTimeline'
import { SinceLastVisitBanner } from '@/features/view-filters/components/SinceLastVisitBanner'
import { visitMark as visitMarkOf } from '@/features/view-filters/visitMark'
import { VISIT_RULE } from '@/features/view-filters/dateFilter'
import { useVisitWindow, useVisitWindowsStore } from '@/store/visitWindows'
import { currentPersonOf, peopleFromFacets } from '@/features/view-filters/people'
import { activeDimensions } from '@/features/view-filters/dimensions'
import { useFilterLookups } from '@/features/view-filters/useFilterLookups'
import { useRelaxations } from '@/features/view-filters/useRelaxations'
import { invalidateViewAggregates } from '@/features/view-filters/invalidate'
import { useViewFacets } from '@/hooks/useViewFacets'

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 20

// ─── CSS stagger keyframes (injected once) ──────────────────────────────────

const STAGGER_STYLE = `
@keyframes card-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
.card-stagger { animation: card-in 0.3s ease-out both; }

/* Typewriter caret: hard on/off blink using steps(), so the cursor
   feels like a proper terminal cursor rather than a smeared fade. */
@keyframes typewriter-caret-blink {
  0%, 49.99% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
.typewriter-caret-blink {
  animation: typewriter-caret-blink 1.05s steps(1, end) infinite;
}

/* The loading line under the toolbar: a short glint crossing the full width. */
@keyframes explorer-progress {
  from { transform: translateX(-100%); }
  to { transform: translateX(300%); }
}
`

// ─── URL Param Helpers ──────────────────────────────────────────────────────

/** The list's own settings in the address. The filters are read by
 *  ``readFilterState`` (features/view-filters/url.ts), which the workspace tab's
 *  "Browse in Explorer" link and saved filters write in the same spelling. */
function parseSearchParams(params: URLSearchParams) {
  return {
    sort: (params.get('sort') as SortOption) ?? 'recently-modified',
    layout: (params.get('layout') as 'grid' | 'list') ?? 'grid',
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ExplorerPage() {
  useDocumentTitle('Explorer')
  const [searchParams, setSearchParams] = useSearchParams()
  const parsed = parseSearchParams(searchParams)
  // Re-read only when the address actually changes, so the object is stable
  // between renders and everything memoised on it stays memoised.
  const searchKey = searchParams.toString()
  const filterState = useMemo(() => readFilterState(new URLSearchParams(searchKey)), [searchKey])
  const currentUser = useAuthStore(s => s.user)
  const me = useMemo(() => currentPersonOf(currentUser), [currentUser])
  const today = useLocalDay()
  // "Since your last visit": this browser's window for this person here. It
  // stays put while the page is open, so the banner's counts stay the ones shown.
  const visitKey = currentUser?.id ? `${currentUser.id}:explorer` : null
  const visit = useVisitWindow(visitKey)
  const markVisitSeen = useVisitWindowsStore(s => s.markSeen)
  const { openViewEditor } = useViewEditorModal()
  // A view from another environment: the wizard's Import journey, from the button or a file
  // dropped anywhere on the page.
  const { canImport: importEnabled, canExport: exportEnabled } = useViewPortability()
  const openImport = useCallback(
    (file?: File) => openViewEditor(undefined, { journey: 'import', importFile: file }),
    [openViewEditor],
  )
  const { dragging: fileOverPage, dropProps } = useViewFileDrop(openImport, importEnabled)
  const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
  const density = usePreferencesStore(s => s.explorerDensity)
  const timelineCollapsed = usePreferencesStore(s => s.viewActivityCollapsed)
  const setTimelineCollapsed = usePreferencesStore(s => s.setViewActivityCollapsed)
  const timelineField = usePreferencesStore(s => s.viewActivityField)
  const setTimelineField = usePreferencesStore(s => s.setViewActivityField)

  // Filter-aware stats for the summary bar, through the SAME mapping the list
  // uses (``toQueryParams``) so the numbers describe the exact population on
  // screen. The committed (URL) search is used rather than the raw input so the
  // endpoint isn't hit on every keystroke.
  const visitFrom = visit?.from
  const visitTo = visit?.to
  const resolveCtx = useMemo(
    () => ({
      currentUserId: currentUser?.id ?? null,
      today,
      visit: visitFrom && visitTo ? { from: visitFrom, to: visitTo } : null,
    }),
    [currentUser?.id, today, visitFrom, visitTo],
  )
  const statsParams = useMemo(
    () => toQueryParams(resolveFilters(filterState, resolveCtx)),
    [filterState, resolveCtx],
  )
  const { stats: catalogStats, isFetching: statsFetching } = useViewStats(statsParams)

  // Tailwind gap class for the grid layout, driven by density preference.
  const gridGapClass =
    density === 'compact' ? 'gap-2.5'
    : density === 'spacious' ? 'gap-6'
    : 'gap-4'

  const [searchInput, setSearchInput] = useState(filterState.search)
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
  const typewriter = useTypewriter({
    phrases: placeholderPhrases,
    enabled: !searchFocused && !searchInput,
  })

  const [previewView, setPreviewView] = useState<View | null>(null)
  const [previewEditMode, setPreviewEditMode] = useState(false)
  const [shareView, setShareView] = useState<{ id: string; name: string; visibility: 'private' | 'workspace' | 'enterprise'; workspaceId?: string } | null>(null)

  // Card click → open the detail drawer to view; the pencil → open it in
  // details-edit mode. The full builder stays behind "Edit layout & scope".
  const openViewPreview = useCallback((v: View) => { setPreviewEditMode(false); setPreviewView(v) }, [])
  const openViewDetailsEdit = useCallback((v: View) => { setPreviewEditMode(true); setPreviewView(v) }, [])
  const [deleteView, setDeleteView] = useState<{ id: string; name: string; favouriteCount: number; permanent?: boolean } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [exportSelection, setExportSelection] = useState<Array<{ id: string; name: string }> | null>(null)
  const [showBulkDelete, setShowBulkDelete] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  
  // no-op callback for aggregation banner (informational only — no longer gates view creation)
  const onAggregationStatus = useCallback((_isReady: boolean) => {}, [])

  const { notify } = useAppNotifications()
  const queryClient = useQueryClient()

  // ─── URL param setters ──────────────────────────────────────────────

  const setParam = useCallback((key: string, value: string | null) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (value === null || value === '') next.delete(key)
      else next.set(key, value)
      return next
    }, { replace: true })
  }, [setSearchParams])

  /** Write a whole filter set to the address; sort, layout and anything else
   *  there are kept. */
  const setFilterState = useCallback((next: ViewFilterState) => {
    setSearchParams(prev => writeFilterState(prev, next), { replace: true })
  }, [setSearchParams])

  // "Show all views": every filter goes, the person's sort and layout stay —
  // with an Undo, because a carefully built filter set is one click from gone.
  const clearAllFilters = useCallback(() => {
    const previous = filterState
    setFilterState(EMPTY_FILTERS)
    setSearchInput('')
    if (isAnyFilterActive(previous)) {
      notify('info', 'Filters cleared', {
        label: 'Undo',
        onClick: () => { setFilterState(previous); setSearchInput(previous.search) },
      })
    }
  }, [filterState, setFilterState, notify])

  // A person clicked in a card's contributor trail joins the People filter —
  // as "You" when it is you, so the chip and a saved link read the same.
  const pickPerson = useCallback((userId: string) => {
    const id = userId === currentUser?.id ? ME : userId
    if (filterState.contributorIds.includes(id)) return
    setFilterState({ ...filterState, contributorIds: [...filterState.contributorIds, id] })
  }, [filterState, setFilterState, currentUser?.id])

  // Seen: the window closes, and a filter on it would now match nothing, so
  // it goes too.
  const markSeen = useCallback(() => {
    if (!visitKey) return
    markVisitSeen(visitKey)
    const dropVisit = (rule: string | null) => (rule === VISIT_RULE ? null : rule)
    if (filterState.created === VISIT_RULE || filterState.updated === VISIT_RULE) {
      setFilterState({ ...filterState, created: dropVisit(filterState.created), updated: dropVisit(filterState.updated) })
    }
  }, [visitKey, markVisitSeen, filterState, setFilterState])

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
    if (filterState.search) recordRecent(filterState.search)
  }, [filterState.search, recordRecent])

  // ─── Data fetching ──────────────────────────────────────────────────

  const filters: ExplorerFilters = {
    // The live input — the hook debounces it before it reaches the wire.
    ...resolveFilters({ ...filterState, search: searchInput }, resolveCtx),
    sort: parsed.sort,
    // Favourites is driven exclusively by the "Favorites" category pill;
    // the server-side resolver maps that category to ``favouritedOnly=true``.
    favouritedOnly: false,
    limit: PAGE_SIZE,
    offset: 0,
  }

  const {
    views: loadedViews,
    totalCount,
    popularViews,
    isLoading,
    error: listError,
    errorStatus: listErrorStatus,
    isFetching: listFetching,
    isPlaceholderData: showingPreviousList,
    toggleFavourite,
    removeView: removeViewFromList,
    patchView,
    refetch,
    loadMore,
    hasMore,
  } = useExplorerViews(filters)
  // Health map still drives the per-card health badge, but the
  // needs-attention filter itself runs server-side now, so the Explorer
  // no longer post-filters the loaded page.
  const healthMap = useViewHealth(loadedViews)


  // Usage for everything on screen, in ONE request. A card fetching its own
  // would be one request per tile — the exact shape the batched endpoint
  // exists to avoid — and the cache key is the sorted id list, so scrolling
  // in another page re-uses nothing it already has rather than refetching.
  const usageIds = useMemo(
    () => Array.from(new Set([...loadedViews, ...popularViews].map(v => v.id))),
    [loadedViews, popularViews],
  )
  const { data: usageMap } = useViewUsage(usageIds)
  // "Most opened" is finished here rather than on the server — see the hook.
  const views = useOpensOrdering(loadedViews, usageMap, filters.sort)
  // Resolves the provider (e.g. falkordb/neo4j) behind each view's data source
  // so cards can surface what the view is built from.
  const { resolve: resolveProvider } = useDataSourceProviderMap()

  const pinnedViews = useMemo(() => views.filter(v => v.isPinned), [views])

  const hasActiveFilters = isAnyFilterActive(filterState)

  // The way out of an empty list: one count per active filter, asked only
  // while the list is empty. The universe facets are the filter bar's own
  // (same cache entry), here for the people's names.
  const { facets: universeFacets } = useViewFacets()
  const people = useMemo(() => peopleFromFacets(universeFacets), [universeFacets])
  const lookups = useFilterLookups(people, today, currentUser?.id)
  const listEmpty = !isLoading && !listError && loadedViews.length === 0 && hasActiveFilters
  const relaxations = useRelaxations(filterState, resolveCtx, lookups, { enabled: listEmpty })

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
      // A filter menu owns the keys typed inside it — Escape there closes the
      // menu, it must not also clear the search behind it.
      if (isInKeyboardScope(e.target)) return
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

  const copyViewLink = useCopyViewLink()
  const handleShare = useCallback((view: View) => {
    void copyViewLink(view.id)
  }, [copyViewLink])

  const handleShareDialog = useCallback((view: View) => {
    setShareView({ id: view.id, name: view.name, visibility: view.visibility, workspaceId: view.workspaceId })
  }, [])

  /**
   * The card menu changed a view's tier. Patch it in place rather than
   * refetching: the menu has already confirmed with a notification naming the
   * new audience, and a round trip during which the card still shows the
   * OLD badge is exactly what made this feel like nothing happened.
   */
  const handleVisibilityChanged = useCallback(
    (viewId: string) => (visibility: 'private' | 'workspace' | 'enterprise') => {
      patchView(viewId, { visibility })
      invalidateViewAggregates(queryClient)
    },
    [patchView, queryClient],
  )

  // BE rule (views.py: can_delete_view): creator OR
  // workspace:view:delete on the view's workspace. Mirror that
  // here so the row/grid/preview Delete affordance disappears for
  // users who'd just get a 403 notification on click.
  const canDeleteView = useCallback((view: View): boolean => {
    if (currentUser?.id && view.createdBy === currentUser.id) return true
    return useAuthStore.getState().can('workspace:view:delete', view.workspaceId)
  }, [currentUser?.id])

  const handleDeleteRequest = useCallback((view: View) => {
    if (!canDeleteView(view)) return
    setDeleteView({ id: view.id, name: view.name, favouriteCount: view.favouriteCount })
  }, [canDeleteView])

  const handlePermanentDeleteRequest = useCallback((view: View) => {
    if (!canDeleteView(view)) return
    setDeleteView({ id: view.id, name: view.name, favouriteCount: view.favouriteCount, permanent: true })
  }, [canDeleteView])

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
    // Notification
    notify('success', `"${deletedName}" has been deleted`)
    invalidateViewAggregates(queryClient)
  }, [deleteView, removeViewFromList, notify, queryClient])

  const handleBulkDelete = useCallback(() => {
    if (selectedIds.size === 0) return
    setShowBulkDelete(true)
  }, [selectedIds])

  // Bulk delete is only offered when every selected view passes
  // canDeleteView — otherwise some rows would 403 and the operation
  // would partially succeed.
  const canBulkDelete = useMemo(() => {
    if (selectedIds.size === 0) return false
    for (const v of views) {
      if (!selectedIds.has(v.id)) continue
      if (!canDeleteView(v)) return false
    }
    return true
  }, [selectedIds, views, canDeleteView])

  const handleBulkDeleted = useCallback(() => {
    const ids = Array.from(selectedIds)
    ids.forEach(id => removeViewFromList(id))
    setPreviewView(prev => prev && ids.includes(prev.id) ? null : prev)
    setSelectedIds(new Set())
    setShowBulkDelete(false)
    notify('success', `Deleted ${ids.length} view${ids.length !== 1 ? 's' : ''}`)
    invalidateViewAggregates(queryClient)
  }, [selectedIds, removeViewFromList, notify, queryClient])

  const handleBulkVisibility = useCallback(async (visibility: 'private' | 'workspace' | 'enterprise') => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    // allSettled: one failed view (say, a publish-permission miss) must
    // not mask how many succeeded, nor swallow the reason.
    const results = await Promise.allSettled(ids.map(id => updateViewVisibility(id, visibility)))
    const failed = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    setSelectedIds(new Set())
    refetch()
    invalidateViewAggregates(queryClient)
    if (failed.length === 0) {
      notify('success', `Updated visibility to "${visibility}" for ${ids.length} view${ids.length !== 1 ? 's' : ''}`)
    } else {
      const reason = failed[0].reason
      const detail = reason instanceof Error ? reason.message : 'unknown error'
      // A bulk selection can span workspaces, so a partial failure is
      // normal and the REASON is the whole value of the message —
      // "3 failed" with no cause leaves someone re-clicking. The three
      // refusals a person can act on differently get named.
      const cause =
        detail.includes('enterpriseViewPolicy') || detail.includes('feature_disabled')
          ? 'your organisation does not allow publishing to everyone'
          : detail.includes('workspace:view:publish')
            ? 'publishing those needs approval — open each view to ask'
            : detail
      notify(
        'error',
        `Updated ${ids.length - failed.length} of ${ids.length} views — ${failed.length} failed: ${cause}`,
      )
    }
  }, [selectedIds, notify, refetch, queryClient])

  /**
   * Clicking a tag chip on a card toggles that tag in the tag filter —
   * a fast "show me more like this" interaction. If the tag is already
   * active it's removed; otherwise it's added to whatever set is in
   * the URL.
   */
  const handleTagClick = useCallback((tag: string) => {
    const current = filterState.tags
    const next = current.includes(tag)
      ? current.filter(t => t !== tag)
      : [...current, tag]
    setFilterState({ ...filterState, tags: next })
  }, [filterState, setFilterState])

  const handleRestore = useCallback(async (view: View) => {
    try {
      await restoreViewApi(view.id)
      refetch()
      invalidateViewAggregates(queryClient)
      notify('success', `"${view.name}" has been restored`)
    } catch {
      notify('error', `Failed to restore "${view.name}"`)
    }
  }, [refetch, notify, queryClient])

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <div className="absolute inset-0 overflow-y-auto bg-canvas custom-scrollbar" {...dropProps}>
      <style>{STAGGER_STYLE}</style>
      <ViewFileDropOverlay show={fileOverPage} />
      <PageContainer className="pb-28">

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
            <TourLaunchButton tourId="explore-lineage" />
            {importEnabled && (
              <button
                onClick={() => openImport()}
                className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold border border-glass-border text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                title="Import a view exported from another environment (or drop its file on this page)"
              >
                <FileUp className="w-4 h-4" />
                Import view
              </button>
            )}
            <button
              data-tour="explorer-new-view"
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
          stats={catalogStats}
          isLoading={statsFetching}
          onShowAll={() => setParam('category', null)}
          onShowRecent={() => setParam('category', 'recently-added')}
          onShowAttention={() => setParam('category', 'needs-attention')}
        />

        {/* ── Search bar ──────────────────────────────────────── */}
        <div data-tour="explorer-search" className="mb-5 relative">
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
                  {/* The animated text and the caret's blink are driven by the
                      hook writing DIRECTLY to these refs — it holds no React
                      state, so this ticking animation re-renders NOTHING. See
                      useTypewriter's performance contract: driving it through
                      state re-rendered this whole page (and every result card)
                      ~30x/sec forever, which in React 19 dev leaked millions of
                      PerformanceMeasure objects into an uncapped timeline. */}
                  <span ref={typewriter.textRef} className="ml-1" />
                  <span
                    ref={typewriter.caretRef}
                    className="ml-[2px] inline-block w-[2px] h-[1.1em] translate-y-[1px] bg-accent-lineage/70 rounded-[1px] typewriter-caret-blink"
                  />
                </div>
              )}
            </div>
            {searchInput && (
              <button
                onClick={() => setSearchInput('')}
                title="Clear search"
                aria-label="Clear search"
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

        {/* ── Unified toolbar: filters, with sort + layout ending the first row
            so the filter row beneath gets the full width ─────────── */}
        <div data-tour="explorer-filters" className="mb-6">
          <ExplorerFilterBar
            state={filterState}
            onChange={setFilterState}
            today={today}
            currentUser={me}
            ctx={resolveCtx}
            trailing={(
              <>
                <ExplorerSortControl
                  sort={parsed.sort}
                  onSortChange={v => setParam('sort', v)}
                />
                <div className="inline-flex items-center rounded-lg border border-glass-border p-0.5">
                  <button
                    onClick={() => setParam('layout', 'grid')}
                    title="Grid view"
                    aria-label="Grid view"
                    className={cn(
                      'p-1.5 rounded-md transition-colors duration-150',
                      layout === 'grid' ? 'bg-accent-lineage/10 text-accent-lineage' : 'text-ink-muted hover:text-ink'
                    )}
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setParam('layout', 'list')}
                    title="List view (sortable columns)"
                    aria-label="List view"
                    className={cn(
                      'p-1.5 rounded-md transition-colors duration-150',
                      layout === 'list' ? 'bg-accent-lineage/10 text-accent-lineage' : 'text-ink-muted hover:text-ink'
                    )}
                  >
                    <List className="w-3.5 h-3.5" />
                  </button>
                </div>
                <DensityToggle />
              </>
            )}
          />
        </div>

        {/* A thin line while a filter change loads. The previous results stay on
            screen (no skeleton flash), so without it nothing says they are
            about to change. */}
        <div className="relative -mt-4 mb-4 h-0.5 overflow-hidden rounded-full" aria-hidden>
          {listFetching && showingPreviousList && (
            <div className="absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-accent-lineage to-transparent animate-[explorer-progress_1.1s_ease-in-out_infinite]" />
          )}
        </div>

        {visit && filterState.category !== 'deleted' && (
          <SinceLastVisitBanner
            state={filterState}
            ctx={resolveCtx}
            window={visit}
            onApply={setFilterState}
            onMarkSeen={markSeen}
            className="mb-4"
          />
        )}

        {/* ── Headline Banner for Aggregation ───────────────────── */}
        {activeWorkspaceId && filterState.dataSourceId && (
          <AggregationProgressBanner 
            workspaceId={activeWorkspaceId}
            dataSourceId={filterState.dataSourceId}
            onStatusChange={onAggregationStatus}
          />
        )}

        {/* ── Featured / Pinned ────────────────────────────────── */}
        {!hasActiveFilters && pinnedViews.length > 0 && (
          <ExplorerHero views={pinnedViews} onToggleFavourite={toggleFavourite} onPreview={openViewPreview} />
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
                    onManageSharing={() => handleShareDialog(v)}
                    onVisibilityChange={handleVisibilityChanged(v.id)}
                    onPreview={() => openViewPreview(v)}
                    onEdit={() => openViewDetailsEdit(v)}
                    onEditLayout={() => openViewEditor(v.id)}
                    editDisabled={false}
                    onDelete={canDeleteView(v) ? () => handleDeleteRequest(v) : undefined}
                    onRestore={() => handleRestore(v)}
                    onPermanentDelete={() => handlePermanentDeleteRequest(v)}
                    onTagClick={handleTagClick}
                    healthStatus={healthMap.get(v.id)?.status}
                    usage={usageMap?.[v.id]}
                    density={density}
                    providerInfo={resolveProvider(v.dataSourceId)}
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Timeline: when things happened, and a quick way to pick dates.
            Not for the bin — a deleted view's dates are not what it is looked
            up by there. ───────────────────────────────────────── */}
        {filterState.category !== 'deleted' && (
          <ActivityTimeline
            field={timelineField}
            onFieldChange={setTimelineField}
            state={filterState}
            ctx={resolveCtx}
            onSelectRule={rule => setFilterState({ ...filterState, [timelineField]: rule })}
            collapsed={timelineCollapsed}
            onCollapsedChange={setTimelineCollapsed}
            visitFrom={visit?.from}
            className="mb-6"
          />
        )}

        {/* ── Results ──────────────────────────────────────────── */}
        <section data-tour="explorer-results">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
              <Compass className="w-3.5 h-3.5 text-indigo-500" />
            </div>
            <h2 className="text-sm font-bold text-ink">
              {hasActiveFilters ? `Results${filterState.search ? ` for "${filterState.search}"` : ''}` : 'All Views'}
            </h2>
            <span className="text-[11px] text-ink-muted tabular-nums" aria-live="polite" aria-atomic="true">
              <span className="sr-only">Showing </span>{totalCount}<span className="sr-only"> view{totalCount === 1 ? '' : 's'}</span>
            </span>
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
                <div className={cn('grid items-start grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 wide:grid-cols-5', gridGapClass)}>
                  {Array.from({ length: 8 }).map((_, i) => <ExplorerCardSkeleton key={i} />)}
                </div>
              ) : (
                <div className="rounded-2xl border border-glass-border overflow-hidden bg-canvas-elevated">
                  {Array.from({ length: 8 }).map((_, i) => <ExplorerListRowSkeleton key={i} />)}
                </div>
              )}
            </motion.div>
          ) : listError && (views.length === 0 || showingPreviousList) ? (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
            >
              <ListErrorState
                message={listError}
                // 503 + the Versioned/External filter: the server couldn't reach
                // the version store. Every other filter still works, so offer the
                // one change that gets a list back.
                sourceKindUnavailable={listErrorStatus === 503 && filterState.sourceKind !== null}
                onRemoveSourceKind={() => setFilterState({ ...filterState, sourceKind: null })}
                onRetry={() => refetch()}
              />
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
                searchTerm={filterState.search}
                hasFilters={hasActiveFilters}
                activeCategory={filterState.category}
                onClearFilters={clearAllFilters}
                onCreateView={() => openViewEditor()}
                relaxations={relaxations}
                onRelax={next => { setFilterState(next); setSearchInput(next.search) }}
                activeFilterCount={activeDimensions(filterState).length}
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
              <div ref={gridRef} className={cn('grid items-start grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 wide:grid-cols-5', gridGapClass)}>
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
                      onManageSharing={() => handleShareDialog(v)}
                      onVisibilityChange={handleVisibilityChanged(v.id)}
                      onPreview={() => openViewPreview(v)}
                      onEdit={() => openViewDetailsEdit(v)}
                      onEditLayout={() => openViewEditor(v.id)}
                      editDisabled={false}
                      onDelete={canDeleteView(v) ? () => handleDeleteRequest(v) : undefined}
                      onRestore={() => handleRestore(v)}
                      onPermanentDelete={() => handlePermanentDeleteRequest(v)}
                      onTagClick={handleTagClick}
                      healthStatus={healthMap.get(v.id)?.status}
                    usage={usageMap?.[v.id]}
                      isSelected={selectedIds.has(v.id)}
                      density={density}
                      providerInfo={resolveProvider(v.dataSourceId)}
                      onPickPerson={pickPerson}
                      visitMark={visitMarkOf(v, visit)}
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
                  onPreview={() => openViewPreview(v)}
                  onEdit={() => openViewDetailsEdit(v)}
                  onEditLayout={() => openViewEditor(v.id)}
                  editDisabled={false}
                  onDelete={canDeleteView(v) ? () => handleDeleteRequest(v) : undefined}
                  onRestore={() => handleRestore(v)}
                  onPermanentDelete={() => handlePermanentDeleteRequest(v)}
                  healthStatus={healthMap.get(v.id)?.status}
                    usage={usageMap?.[v.id]}
                  isSelected={selectedIds.has(v.id)}
                  density={density}
                  providerInfo={resolveProvider(v.dataSourceId)}
                  onPickPerson={pickPerson}
                  visitMark={visitMarkOf(v, visit)}
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
      </PageContainer>

      {/* Overlays */}
      <ExplorerPreviewDrawer
        view={previewView}
        isOpen={!!previewView}
        onClose={() => setPreviewView(null)}
        onShare={() => previewView && handleShareDialog(previewView)}
        onEdit={previewView ? () => { setPreviewView(null); openViewEditor(previewView.id) } : undefined}
        editDisabled={false}
        onDelete={previewView && canDeleteView(previewView)
          ? () => handleDeleteRequest(previewView)
          : undefined}
        healthStatus={previewView ? healthMap.get(previewView.id)?.status : undefined}
        initialEditMode={previewEditMode}
        onSaved={() => refetch()}
        onPickPerson={id => { setPreviewView(null); pickPerson(id) }}
      />
      <ExplorerBulkActions
        selectedCount={selectedIds.size}
        onDelete={canBulkDelete ? handleBulkDelete : undefined}
        onChangeVisibility={handleBulkVisibility}
        onExport={exportEnabled && filterState.category !== 'deleted'
          ? () => setExportSelection(Array.from(selectedIds, id => ({
              id, name: views.find(v => v.id === id)?.name ?? id,
            })))
          : undefined}
        onClearSelection={() => setSelectedIds(new Set())}
      />
      {exportSelection && (
        <ExportViewDialog views={exportSelection} onClose={() => setExportSelection(null)} />
      )}
      {shareView && (
        <ShareViewDialog
          viewId={shareView.id}
          viewName={shareView.name}
          currentVisibility={shareView.visibility}
          workspaceId={shareView.workspaceId}
          isOpen={true}
          onClose={() => setShareView(null)}
        />
      )}
      {deleteView && (
        <DeleteViewDialog viewId={deleteView.id} viewName={deleteView.name} favouriteCount={deleteView.favouriteCount} isOpen={true} onClose={() => setDeleteView(null)} onDeleted={handleDeleted} permanent={deleteView.permanent} />
      )}
      <BulkDeleteDialog
        viewIds={Array.from(selectedIds)}
        isOpen={showBulkDelete}
        onClose={() => setShowBulkDelete(false)}
        onDeleted={handleBulkDeleted}
        permanent={filterState.category === 'deleted'}
      />
      <KeyboardShortcutsDialog
        isOpen={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

    </div>
  )
}

// ─── List error ─────────────────────────────────────────────────────────────

/**
 * A failed load used to fall through to "No views match your search" — telling
 * someone their filters were wrong when the server was. Say what happened, and
 * when it is the Versioned/External filter that can't be answered, offer the one
 * change that gets the list back.
 */
function ListErrorState({ message, sourceKindUnavailable, onRemoveSourceKind, onRetry }: {
  message: string
  sourceKindUnavailable: boolean
  onRemoveSourceKind: () => void
  onRetry: () => void
}) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-2xl border border-amber-500/30 bg-amber-500/5 px-6 py-12 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10">
        <AlertTriangle className="h-5 w-5 text-amber-500" />
      </div>
      <h3 className="text-sm font-bold text-ink">
        {sourceKindUnavailable ? "Can't tell versioned from external right now" : "The views didn't load"}
      </h3>
      <p className="mt-1 max-w-md text-xs text-ink-muted">{message}</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {sourceKindUnavailable && (
          <button
            type="button"
            onClick={onRemoveSourceKind}
            className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-accent-lineage to-violet-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:shadow-md transition-shadow"
          >
            <X className="h-3.5 w-3.5" /> Remove the Versioned/External filter
          </button>
        )}
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-xl border border-glass-border px-4 py-2 text-xs font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Try again
        </button>
      </div>
    </div>
  )
}
