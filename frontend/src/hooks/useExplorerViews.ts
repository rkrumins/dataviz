/**
 * useExplorerViews — Data fetching hook for the Explorer page.
 *
 * Strategic server-driven design:
 * - Every filter is a query param on ``GET /api/v1/views/`` — the backend
 *   is the single source of truth and returns a ``{ items, total, hasMore,
 *   nextOffset }`` envelope. No client-side residual filtering.
 * - ``total`` is the authoritative count shown in the UI; ``hasMore``
 *   drives the infinite-scroll sentinel.
 * - Backed by React Query's ``useInfiniteQuery``: each page is the
 *   server-advertised ``nextOffset``; ``loadMore()`` → ``fetchNextPage``.
 *   The full filter set is the query key, so a filter change is a new
 *   query (page 0) and ``placeholderData: keepPreviousData`` keeps the
 *   current list on screen while it loads — no skeleton flash — and
 *   returning to a recently-seen filter renders instantly from cache.
 * - Search is debounced 300ms before it enters the key (hits the wire).
 * - Sort is client-side over the assembled list; we keep the API in
 *   ``updated_at desc`` order so pagination stays deterministic.
 * - Favourite toggles are an optimistic ``useMutation`` (cache patch +
 *   rollback on error); local removals patch the cache directly.
 */
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import {
  useInfiniteQuery, useMutation, useQueryClient,
  keepPreviousData, type InfiniteData,
} from '@tanstack/react-query'
import {
  listViews, favouriteView, unfavouriteView,
  type View, type ViewListParams, type ViewListResponse,
} from '@/services/viewApiService'

/** Stable empty slice so ``popularViews`` keeps one reference across renders. */
const EMPTY_VIEWS: View[] = []

/** Stable JSON key for array deps — prevents infinite re-render loops from new array refs. */
function useStableKey(value: unknown): string {
  const key = JSON.stringify(value)
  const ref = useRef(key)
  if (ref.current !== key) ref.current = key
  return ref.current
}

// ─── Sort Options ───────────────────────────────────────────────────────────

/**
 * Sort options. The first six are the user-selectable global sorts
 * shown in the sort dropdown; the column-sorts below are applied when
 * the user clicks a header in the list view. Every option has a single
 * canonical string so the URL (``?sort=az``) stays stable and
 * human-readable.
 */
export type SortOption =
  // Freshest of data-publish or settings-edit — the default.
  | 'recently-modified'
  // Underlying DATA change time (publish / merge).
  | 'data-newest'
  | 'data-oldest'
  // View creation time.
  | 'newest'
  | 'oldest'
  // Settings-edit time.
  | 'updated'
  | 'popular'
  | 'az'
  | 'za'
  // Column-sorts (list view header clicks)
  | 'updated-asc'
  | 'likes-asc'
  | 'type-az'
  | 'type-za'
  | 'owner-az'
  | 'owner-za'

// The backend now orders these across the WHOLE result set (see
// view_repo._view_order_by), which is what makes sort correct with infinite
// scroll — re-sorting the appended pages here would be redundant and, for the
// data-* NULL handling, could even disagree with the server. So for these keys
// we trust the server order. Only the list-header column power-sorts (which the
// server doesn't handle) are still applied to the loaded page here.
const SERVER_SORTED = new Set<SortOption>([
  'recently-modified', 'data-newest', 'data-oldest',
  'newest', 'oldest', 'updated', 'updated-asc', 'popular', 'az', 'za',
])

function sortViews(views: View[], sort: SortOption): View[] {
  if (SERVER_SORTED.has(sort)) return views
  const sorted = [...views]
  const byStr = (a: string, b: string) => a.localeCompare(b)
  switch (sort) {
    case 'likes-asc':
      return sorted.sort((a, b) => a.favouriteCount - b.favouriteCount || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    case 'type-az':
      return sorted.sort((a, b) => byStr(a.viewType ?? '', b.viewType ?? '') || byStr(a.name, b.name))
    case 'type-za':
      return sorted.sort((a, b) => byStr(b.viewType ?? '', a.viewType ?? '') || byStr(a.name, b.name))
    case 'owner-az':
      return sorted.sort((a, b) => byStr(a.createdByName ?? a.createdBy ?? '', b.createdByName ?? b.createdBy ?? '') || byStr(a.name, b.name))
    case 'owner-za':
      return sorted.sort((a, b) => byStr(b.createdByName ?? b.createdBy ?? '', a.createdByName ?? a.createdBy ?? '') || byStr(a.name, b.name))
    default:
      return views
  }
}

// ─── Filter Params ──────────────────────────────────────────────────────────

export interface ExplorerFilters {
  search: string
  visibility: string | null         // 'enterprise' | 'workspace' | 'private' | null (all)
  workspaceIds: string[]            // Multi-select — sent as ``workspaceIds`` on API
  dataSourceId: string | null
  viewTypes: string[]               // Multi-select — sent as ``viewTypes`` on API
  tags: string[]                    // Multi-select — sent as ``tags`` on API (OR semantics)
  creatorIds: string[]              // Multi-select — sent as ``createdByIn`` on API
  sort: SortOption
  favouritedOnly: boolean
  /** 'my-views' | 'my-favourites' | 'recently-added' | 'shared-with-me' | 'needs-attention' | 'deleted' | null */
  category: string | null
  currentUserId: string | null      // For 'my-views' — sent as ``createdBy`` on API
  limit: number                     // Page size
  offset: number                    // Unused externally; hook manages offset internally
}

export interface UseExplorerViewsResult {
  views: View[]                     // Sorted + paginated display slice
  totalCount: number                // Authoritative server total across all pages
  popularViews: View[]
  isLoading: boolean                // Initial fetch
  isLoadingMore: boolean            // Subsequent page fetch
  error: string | null
  toggleFavourite: (viewId: string) => void
  removeView: (viewId: string) => void
  /** Apply a settled server change to one view in place. Cheaper and
   *  faster than a refetch, and without the window where the card still
   *  shows the old value. */
  patchView: (viewId: string, patch: Partial<View>) => void
  refetch: () => void
  loadMore: () => void
  hasMore: boolean
}

// ─── Category → server params resolver ─────────────────────────────────────

/**
 * Translate a user-selected category to the concrete API params the backend
 * understands. Centralising this here keeps the hook body simple and makes
 * the client/server contract explicit — no hidden client-side filtering.
 *
 * Exported so the stats bar and any future catalog-level consumers can
 * translate the same way without reimplementing the mapping.
 */
export function resolveCategoryParams(
  category: string | null,
  currentUserId: string | null,
): Partial<ViewListParams> {
  switch (category) {
    case 'my-views':
      // If we have no user id the Explorer page falls back to showing
      // nothing (not "all") so the filter label stays truthful.
      return currentUserId ? { createdBy: currentUserId } : { createdBy: '__no_user__' }
    case 'my-favourites':
      return { favouritedOnly: true }
    case 'recently-added': {
      // IMPORTANT: quantise the cutoff to a 5-minute bucket so the
      // string value is stable across re-renders. Without this, every
      // render produces a fresh ``Date.now()`` → fresh ISO string →
      // fresh React Query key → refetch → state update → re-render →
      // infinite fetch loop. The 5-minute window means the "last 7
      // days" cutoff can drift by at most 5 minutes, which is fine
      // for a human-facing "recent" filter.
      const QUANTUM_MS = 5 * 60 * 1000
      const now = Math.floor(Date.now() / QUANTUM_MS) * QUANTUM_MS
      const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000)
      return { createdAfter: sevenDaysAgo.toISOString() }
    }
    case 'shared-with-me':
      // Server-side truth: views reachable through an explicit grant
      // (direct or via group), excluding your own. The old visibilityIn
      // approximation showed every workspace/enterprise view instead.
      return { category: 'shared-with-me' }
    case 'needs-attention':
      return { attentionOnly: true }
    case 'deleted':
      return { deletedOnly: true }
    default:
      return {}
  }
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/** Map a transform over every View in the infinite-query cache (page items +
 *  the page-0 popular strip), preserving envelope shape. Backs the optimistic
 *  favourite patch. */
function mapViewInPages(
  data: InfiniteData<ViewListResponse>,
  fn: (v: View) => View,
): InfiniteData<ViewListResponse> {
  return {
    ...data,
    pages: data.pages.map(page => ({
      ...page,
      items: page.items.map(fn),
      popular: page.popular?.map(fn),
    })),
  }
}

export function useExplorerViews(filters: ExplorerFilters): UseExplorerViewsResult {
  const queryClient = useQueryClient()

  // Debounce search — only make API call after 300ms of no typing
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search)
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(filters.search)
    }, 300)
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current) }
  }, [filters.search])

  // Stabilise array deps so buildParams (and thus the query key) doesn't churn on identical values.
  const workspaceIdsKey = useStableKey(filters.workspaceIds)
  const viewTypesKey = useStableKey(filters.viewTypes)
  const tagsKey = useStableKey(filters.tags)
  const creatorIdsKey = useStableKey(filters.creatorIds)
  const stableVisibility = filters.visibility
  const stableDataSourceId = filters.dataSourceId
  const stableFavouritedOnly = filters.favouritedOnly
  const stableCategory = filters.category
  const stableCurrentUserId = filters.currentUserId
  const stableLimit = filters.limit
  const stableSort = filters.sort

  // Build the full set of API params for a given page offset. Category
  // params are merged last so they can override defaults (e.g. the
  // ``deleted`` category sets ``deletedOnly: true``).
  const buildParams = useCallback((pageOffset: number): ViewListParams => {
    const wsIds: string[] = JSON.parse(workspaceIdsKey)
    const vTypes: string[] = JSON.parse(viewTypesKey)
    const tagList: string[] = JSON.parse(tagsKey)
    const creators: string[] = JSON.parse(creatorIdsKey)
    const categoryParams = resolveCategoryParams(stableCategory, stableCurrentUserId)

    const params: ViewListParams = {
      search: debouncedSearch || undefined,
      visibility: stableVisibility || undefined,
      favouritedOnly: stableFavouritedOnly || undefined,
      dataSourceId: stableDataSourceId || undefined,
      workspaceIds: wsIds.length > 0 ? wsIds : undefined,
      viewTypes: vTypes.length > 0 ? vTypes : undefined,
      tags: tagList.length > 0 ? tagList : undefined,
      createdByIn: creators.length > 0 ? creators : undefined,
      sort: stableSort || undefined,
      limit: stableLimit,
      offset: pageOffset,
      ...categoryParams,
    }

    return params
  }, [
    debouncedSearch, stableVisibility, stableFavouritedOnly,
    stableDataSourceId, workspaceIdsKey, viewTypesKey, tagsKey,
    creatorIdsKey, stableSort, stableLimit, stableCategory, stableCurrentUserId,
  ])

  // The full filter set (minus offset — that's the page param) is the query
  // key, so any filter change is a distinct query: keepPreviousData shows the
  // current list until the new one lands, and revisiting a filter is a cache
  // hit. Memoised on buildParams so the key reference is stable within a filter
  // set and changes exactly when the filters do.
  const queryKey = useMemo(() => {
    const { offset: _offset, ...rest } = buildParams(0)
    return ['explorer-views', rest] as const
  }, [buildParams])

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => listViews(
      // ``?include=popular`` on page 0 folds the trending strip into the same
      // response, killing the second round-trip the page used to make.
      pageParam === 0
        ? { ...buildParams(0), include: ['popular'], popularLimit: 10 }
        : buildParams(pageParam),
      signal,
    ),
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextOffset != null ? lastPage.nextOffset : undefined,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })

  const {
    data, isPending, error, refetch: rqRefetch,
    fetchNextPage, hasNextPage, isFetchingNextPage, isPlaceholderData,
  } = query

  // Flatten loaded pages, deduped (rows can shift between pages). Sort is
  // applied client-side only for the list-header column power-sorts; the
  // server already orders the global sorts (see SERVER_SORTED).
  const flatViews = useMemo(() => {
    const seen = new Set<string>()
    const out: View[] = []
    for (const page of data?.pages ?? []) {
      for (const v of page.items) {
        if (!seen.has(v.id)) { seen.add(v.id); out.push(v) }
      }
    }
    return out
  }, [data])

  const views = useMemo(() => sortViews(flatViews, filters.sort), [flatViews, filters.sort])
  const popularViews = data?.pages[0]?.popular ?? EMPTY_VIEWS
  const totalCount = data?.pages[0]?.total ?? 0

  // Infinite scroll. Safe to call on every sentinel intersection: no-ops while
  // a page is in flight or while previous-data is shown during a filter switch
  // (so we never fetch the wrong offset against the newly-keyed query).
  const loadMore = useCallback(() => {
    if (isFetchingNextPage || isPlaceholderData || !hasNextPage) return
    fetchNextPage()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isPlaceholderData])

  // ─── Optimistic favourite toggle ────────────────────────────────────
  // ``wasFavourited`` is captured at click time (before onMutate flips the
  // cache) so the mutationFn calls the right endpoint.
  const favouriteMutation = useMutation({
    mutationFn: ({ viewId, wasFavourited }: { viewId: string; wasFavourited: boolean }) =>
      wasFavourited ? unfavouriteView(viewId) : favouriteView(viewId),
    onMutate: async ({ viewId, wasFavourited }) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<InfiniteData<ViewListResponse>>(queryKey)
      queryClient.setQueryData<InfiniteData<ViewListResponse>>(queryKey, (curr) =>
        curr
          ? mapViewInPages(curr, (v) => v.id === viewId
              ? { ...v, isFavourited: !wasFavourited, favouriteCount: v.favouriteCount + (wasFavourited ? -1 : 1) }
              : v)
          : curr,
      )
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous)
    },
  })

  const toggleFavourite = useCallback((viewId: string) => {
    const view = flatViews.find(v => v.id === viewId) ?? popularViews.find(v => v.id === viewId)
    if (!view) return
    favouriteMutation.mutate({ viewId, wasFavourited: view.isFavourited })
  }, [flatViews, popularViews, favouriteMutation])

  // Local optimistic removal — patch the cache (items + popular + total).
  const removeView = useCallback((viewId: string) => {
    queryClient.setQueryData<InfiniteData<ViewListResponse>>(queryKey, (curr) => {
      if (!curr) return curr
      return {
        ...curr,
        pages: curr.pages.map(page => {
          const had = page.items.some(v => v.id === viewId)
          return {
            ...page,
            items: page.items.filter(v => v.id !== viewId),
            popular: page.popular?.filter(v => v.id !== viewId),
            total: had ? Math.max(0, page.total - 1) : page.total,
          }
        }),
      }
    })
  }, [queryClient, queryKey])

  /**
   * Patch one view in place — the settled server value, applied locally.
   *
   * A plain ``refetch()`` is not enough for a single-field change: it
   * costs a round trip during which the card still shows the OLD value,
   * which reads as "nothing happened". Changing a view's visibility from
   * the card menu did exactly that, and the only way to see the new tier
   * was a full page reload.
   *
   * Patches the popular strip too — the same view can be on screen twice
   * (Trending and the grid), and updating only one is worse than
   * updating neither.
   */
  const patchView = useCallback((viewId: string, patch: Partial<View>) => {
    queryClient.setQueryData<InfiniteData<ViewListResponse>>(queryKey, (curr) =>
      curr
        ? mapViewInPages(curr, (v) => (v.id === viewId ? { ...v, ...patch } : v))
        : curr,
    )
  }, [queryClient, queryKey])

  const refetch = useCallback(() => { rqRefetch() }, [rqRefetch])

  return {
    views,
    totalCount,
    popularViews,
    isLoading: isPending,
    isLoadingMore: isFetchingNextPage,
    error: error ? (error instanceof Error ? error.message : 'Failed to load views') : null,
    toggleFavourite,
    removeView,
    patchView,
    refetch,
    loadMore,
    hasMore: hasNextPage,
  }
}
