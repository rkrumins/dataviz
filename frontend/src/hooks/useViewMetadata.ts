/**
 * React Query hooks for fetching a View by id.
 *
 * Why two hooks on one underlying query:
 * The ViewWizard has a chicken-egg problem — to find the view's full config
 * we need the schema scope, and to fetch the correct schema we need to know
 * which (workspace, dataSource) the view was created against. We resolve
 * this in two phases:
 *   - Phase 1: `useViewMetadata(viewId)` returns JUST the scope fields the
 *     scope resolver needs — without touching the schema store. It gates
 *     the mount of <SchemaScope>, which may cold-fetch for a workspace
 *     other than the currently-active one (cross-workspace edit).
 *   - Phase 2: `useViewFull(viewId)` returns the raw View for the wizard
 *     body to hydrate form state. It is only called inside <SchemaScope>
 *     where `useSchemaStore` is guaranteed populated.
 *
 * Both hooks share the React Query cache key ['view', viewId] so the
 * underlying GET /views/{id} fires exactly once per view open.
 *
 * Does NOT read from or write to useSchemaStore. Errors surface normally
 * through React Query; callers render their own loading/error UI.
 */
import { useQuery } from '@tanstack/react-query'
import { getView, type View, type ViewAccess } from '@/services/viewApiService'

export const VIEW_QUERY_KEY = ['view'] as const

export interface ViewMetadata {
  id: string
  name: string
  workspaceId: string
  /** Nullable because legacy views may not have a data source assigned. */
  dataSourceId: string | null
  /** Top-level projection of `config.layoutType`. May be undefined for
   *  views created before this field was added to the response model. */
  layoutType: string | null
  updatedAt: string
  /** Ontology digest captured when the view was last saved. Null for views
   *  that predate drift tracking — drift checks no-op in that case. */
  ontologyDigest: string | null
}

function projectMetadata(view: View): ViewMetadata {
  return {
    id: view.id,
    name: view.name,
    workspaceId: view.workspaceId,
    dataSourceId: view.dataSourceId ?? null,
    layoutType: view.layoutType ?? null,
    updatedAt: view.updatedAt,
    ontologyDigest: view.ontologyDigest ?? null,
  }
}

const VIEW_QUERY_OPTIONS = {
  // Views' scope metadata rarely changes — the only mutation that bumps
  // it is an explicit save. A 1-minute stale window is safe.
  staleTime: 60 * 1000,
  gcTime: 5 * 60 * 1000,
  // Failure is loud: the wizard's scope resolver renders an error state
  // and the user can retry from there.
  retry: false as const,
  refetchOnWindowFocus: false,
}

/**
 * Fetches the minimal metadata needed by ViewWizardScopeResolver. Shares
 * the ['view', viewId] cache entry with useViewFull so there is exactly
 * one HTTP call per view open even when both hooks are active.
 */
export function useViewMetadata(viewId: string | null | undefined) {
  return useQuery({
    queryKey: [...VIEW_QUERY_KEY, viewId],
    queryFn: async () => {
      if (!viewId) throw new Error('useViewMetadata called without a viewId')
      return await getView(viewId)
    },
    enabled: Boolean(viewId),
    select: projectMetadata,
    ...VIEW_QUERY_OPTIONS,
  })
}

/**
 * Fetches the raw View by id. Called by ViewWizardBody to hydrate the
 * wizard's form state — only invoked once the wizard's <SchemaScope>
 * has confirmed the ontology is loaded for the view's scope.
 *
 * `branchId` — when the wizard is opened on a draft, pass its branch id so the
 * hydrated layout/entityScope is the BRANCH-EFFECTIVE one (base ⊕ overlay). The
 * wizard's submit re-writes layout to that same overlay, so reading base here
 * would let a metadata-only edit overwrite the draft's canvas layout with base.
 * Without a branch (Published / create) the key stays ['view', viewId] so it
 * still shares useViewMetadata's cache entry — exactly one GET per view open.
 */
export function useViewFull(viewId: string | null | undefined, branchId?: string | null) {
  return useQuery<View>({
    queryKey: branchId ? [...VIEW_QUERY_KEY, viewId, branchId] : [...VIEW_QUERY_KEY, viewId],
    queryFn: async () => {
      if (!viewId) throw new Error('useViewFull called without a viewId')
      return await getView(viewId, branchId ?? undefined)
    },
    enabled: Boolean(viewId),
    ...VIEW_QUERY_OPTIONS,
  })
}

/**
 * The caller's capability envelope for a view — shares the
 * ['view', viewId] cache entry with useViewMetadata/useViewFull, so it
 * costs zero extra HTTP wherever the view is already being fetched.
 * `access` is null while loading, on error, or against a backend that
 * predates the envelope; combine with `deriveViewCapabilities` from
 * `@/lib/viewAccess` for gating with a legacy fallback.
 */
export function useViewAccess(viewId: string | null | undefined) {
  const query = useQuery({
    queryKey: [...VIEW_QUERY_KEY, viewId],
    queryFn: async () => {
      if (!viewId) throw new Error('useViewAccess called without a viewId')
      return await getView(viewId, undefined, { silent403: true })
    },
    enabled: Boolean(viewId),
    ...VIEW_QUERY_OPTIONS,
  })
  const access: ViewAccess | null = query.data?.access ?? null
  return { access, view: query.data, isLoading: query.isLoading, error: query.error }
}
