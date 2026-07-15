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
    },
  },
})

// Nullable return kept for callers that tolerate a not-yet-ready client.
export function getQueryClient(): QueryClient | null {
  return queryClient
}
