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
import { httpStatusOf } from '@/services/graphRequestFailure'
import { toQueryParams, type ResolvedViewFilters } from '@/features/view-filters/params'

/** Stable empty slice so ``popularViews`` keeps one reference across renders. */
const EMPTY_VIEWS: View[] = []

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
  // Ranked by OPENS rather than favourites. Not server-sorted, and cannot be:
  // opens live in the event log and views in the catalogue, and this repo bans
  // cross-domain JOINs. Ordered on the client from the usage already fetched
  // for the cards, exactly as `likes-asc` / `type-az` / `owner-az` are.
  | 'most-opened'
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

/**
 * The resolved filter set (see ``resolveFilters`` in features/view-filters) plus
 * the list's own knobs. ``search`` is the LIVE input here — the hook debounces it.
 */
export interface ExplorerFilters extends ResolvedViewFilters {
  sort: SortOption
  favouritedOnly: boolean
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
  /** HTTP status of the failed request, when there was one (a 503 means the
   *  server couldn't tell versioned from external sources). */
  errorStatus: number | null
  /** A request for the current filters is in flight. */
  isFetching: boolean
  /** The list on screen belongs to the PREVIOUS filters while the new ones load. */
  isPlaceholderData: boolean
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

  // Every filter goes through the shared ``toQueryParams`` — the same mapping the
  // stats bar and the facet counts use — then is held as a JSON string, so the
  // query key changes exactly when the request would, not when a caller hands in a
  // new array with the same contents.
  const filterKey = JSON.stringify(toQueryParams({ ...filters, search: debouncedSearch }))
  const stableLimit = filters.limit
  const stableSort = filters.sort

  // Build the full set of API params for a given page offset.
  const buildParams = useCallback((pageOffset: number): ViewListParams => ({
    ...(JSON.parse(filterKey) as ViewListParams),
    sort: stableSort || undefined,
    limit: stableLimit,
    offset: pageOffset,
  }), [filterKey, stableSort, stableLimit])

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
    data, isPending, error, refetch: rqRefetch, isFetching,
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
    errorStatus: error ? httpStatusOf(error) : null,
    isFetching,
    isPlaceholderData,
    toggleFavourite,
    removeView,
    patchView,
    refetch,
    loadMore,
    hasMore: hasNextPage,
  }
}
