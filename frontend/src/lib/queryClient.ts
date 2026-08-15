import { QueryClient } from '@tanstack/react-query'

/**
 * The app-wide React Query client.
 *
 * This lives here rather than in ``main.tsx`` on purpose. Non-component modules
 * (permissionPoller, workspaceSwitchCleanup, fetchWithTimeout, ensureDraftOpen)
 * need the client to evict queries, and importing it from the entry module made
 * ``main.tsx`` an importer target — which put the entry inside an import cycle
 * and let Vite pick it as an HMR accept boundary. The browser then re-imported
 * ``/src/main.tsx`` on any edit to a module in the cycle and re-ran its body,
 * calling ``createRoot()`` a second time on ``#root`` (two live React trees,
 * duplicate pollers). Keep this module side-effect free, and never import
 * ``@/main`` from anywhere.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,   // 5 minutes default stale time
      retry: 1,
      refetchOnWindowFocus: false,
      // Both of these were previously unset, which meant React Query's
      // own defaults (true) applied — invisibly, because nothing here
      // said so.
      //
      // ``refetchOnMount`` stays true: it respects ``staleTime``, so the
      // real control over "does navigating refetch" is each query's
      // staleTime, not this flag. Stated explicitly so the next person
      // tuning a staleTime knows it is the lever.
      refetchOnMount: true,
      // ``refetchOnReconnect`` is false because recovery already has an
      // owner. ``useBackendRecovery`` (mounted in AppLayout) subscribes
      // to the health store and, on a real recovery transition, resets
      // the circuit breakers and reloads workspaces, views, graph schema
      // and insights — deliberately, by key. Leaving this true added an
      // uncoordinated blanket refetch of every stale active query on the
      // browser's ``online`` event, racing that handler and the health
      // banner's own ``online`` probe: three mechanisms firing on one
      // event. The health store is also the better signal — the backend
      // can be down while the network is up, and ``navigator.onLine``
      // cannot tell the difference.
      refetchOnReconnect: false,
    },
  },
})

// Nullable return kept for callers that tolerate a not-yet-ready client.
export function getQueryClient(): QueryClient | null {
  return queryClient
}
