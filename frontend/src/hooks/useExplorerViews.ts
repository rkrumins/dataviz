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
 * - Every sort runs on the server (``view_repo._view_order_by``), across the
 *   whole result and with an id tiebreak, so appended pages never reshuffle.
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
import { invalidateOtherViewLists } from '@/features/view-filters/invalidate'

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
  // Ranked by opens in the last 30 days. The server reads them from the event
  // log by id and orders the catalogue by them — no cross-domain JOIN.
  | 'most-opened'
  | 'az'
  | 'za'
  // Column-sorts (list view header clicks)
  | 'modified-asc'
  | 'updated-asc'
  | 'likes-asc'
  | 'type-az'
  | 'type-za'
  | 'owner-az'
  | 'owner-za'

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
  /** The last page asked for failed; ``loadMore`` waits for ``retryLoadMore``. */
  loadMoreFailed: boolean
  retryLoadMore: () => void
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
    fetchNextPage, hasNextPage, isFetchingNextPage, isPlaceholderData, isFetchNextPageError,
  } = query

  // Flatten loaded pages in the server's order, deduped (rows can shift between pages).
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

  const views = flatViews
  const popularViews = data?.pages[0]?.popular ?? EMPTY_VIEWS
  const totalCount = data?.pages[0]?.total ?? 0

  // Infinite scroll. Safe to call on every sentinel intersection: no-ops while
  // a page is in flight or while previous-data is shown during a filter switch
  // (so we never fetch the wrong offset against the newly-keyed query).
  // A page that failed waits for the reader's Retry, rather than being asked for
  // again on every intersection, silently.
  const loadMore = useCallback(() => {
    if (isFetchingNextPage || isPlaceholderData || !hasNextPage || isFetchNextPageError) return
    fetchNextPage()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isPlaceholderData, isFetchNextPageError])
  const retryLoadMore = useCallback(() => { void fetchNextPage() }, [fetchNextPage])

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
    // Favorites (and any other list visited) refetches when next shown.
    onSettled: () => invalidateOtherViewLists(queryClient),
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
      // ``total`` is the whole list's count, carried on every page (the header
      // reads page one's), so it drops on every page whichever one held the view.
      const had = curr.pages.some(page => page.items.some(v => v.id === viewId))
      return {
        ...curr,
        pages: curr.pages.map(page => ({
          ...page,
          items: page.items.filter(v => v.id !== viewId),
          popular: page.popular?.filter(v => v.id !== viewId),
          total: had ? Math.max(0, page.total - 1) : page.total,
        })),
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
    loadMoreFailed: isFetchNextPageError,
    retryLoadMore,
  }
}
