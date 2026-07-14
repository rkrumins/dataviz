/**
 * Pagination tunables for lazy-loaded graph browsing.
 */

/**
 * Children fetched per `loadChildren` page (see `hooks/useGraphHydration`).
 * Matches the backend's own default limit on `/nodes/{urn}/children-with-edges`.
 *
 * Lives here rather than next to the fetch so the "Load N more" row can name the
 * real page size without importing the hydration hook's whole module graph.
 *
 * This was 20, which meant a 600-child container needed 30 round-trips to drain
 * — and every page that landed re-armed the canvas's aggregated-edge fetch.
 */
export const CHILDREN_PAGE_SIZE = 100
