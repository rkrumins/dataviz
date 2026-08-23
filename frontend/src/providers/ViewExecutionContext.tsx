/**
 * ViewExecutionContext — Isolated execution environment for a single view.
 *
 * When a user opens a view, this context provides:
 *   1. A RemoteGraphProvider scoped to the view's workspace/datasource (from a pool)
 *   2. The resolved schema (entity types, edge types, etc.) for the view's data source
 *   3. A provider context override so all downstream hooks (useGraphProvider,
 *      useGraphHydration, etc.) use the scoped provider
 *
 * Views are self-contained data products. They carry their scope (workspaceId +
 * dataSourceId) and load their own data at runtime — without mutating the global
 * active workspace. The workspace selector in the sidebar remains purely
 * administrative (view creation, ontology editing, access control).
 *
 * Provider instances are pooled (max 8, LRU eviction) so switching between
 * views backed by the same data source reuses the provider and its response cache.
 * Schemas are cached by React Query per (wsId, dsId, providerVersion).
 */

import { createContext, useContext, useState, useEffect, useLayoutEffect, useRef, useMemo, type ReactNode } from 'react'
import type { ViewAccess } from '@/services/viewApiService'
import type { GraphSchema } from './GraphDataProvider'
import type { GraphProviderContextValueExtended } from './GraphProviderContext'
import { useGraphProviderContext, ProviderOverride } from './GraphProviderContext'
import { getOrCreateProvider, poolKey } from './providerPool'
import { useBranchStore, useEffectiveBranchId } from '@/store/branchStore'
import { useWorkspacesStore } from '@/store/workspaces'
import { useProviderStatus } from '@/store/providerStatus'
import { useGraphSchema } from '@/hooks/useGraphSchema'
import { useSchemaStore, convertBackendEntityType, convertBackendRelationshipType, deriveContainmentEdgeTypes, deriveLineageEdgeTypes } from '@/store/schema'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react'

// ─── Resolved View Schema ──────────────────────────────────────────────────

export interface ResolvedViewSchema {
  entityTypes: EntityTypeSchema[]
  relationshipTypes: RelationshipTypeSchema[]
  containmentEdgeTypes: string[]
  lineageEdgeTypes: string[]
  rootEntityTypes: string[]
  ontologyDigest?: string | null
}

// ─── Context Value ─────────────────────────────────────────────────────────

export interface ViewExecutionContextValue {
  /** Fully resolved schema for the view's data source */
  schema: ResolvedViewSchema
  /** The view's workspace ID */
  workspaceId: string
  /** The view's data source ID */
  dataSourceId: string | null
  /** The caller's capability envelope for the open view (null when the
   *  response hasn't landed or predates the envelope). */
  access: ViewAccess | null
  /** True when the data plane is read-only for this caller — the whole
   *  canvas tree hides edit/draft/versioning affordances off this flag. */
  readOnly: boolean
}

const ViewExecCtx = createContext<ViewExecutionContextValue | null>(null)

/** Read the current view execution context (null outside a ViewExecutionProvider). */
export function useViewExecutionContext(): ViewExecutionContextValue | null {
  return useContext(ViewExecCtx)
}

/**
 * Provide an explicit, static schema to the view-scoped hooks. Used by
 * previews (the type editor's live node preview renders a REAL GenericNode
 * against the unsaved form state) and by tests — never by real views, which
 * go through ViewExecutionProvider's fetch/gate flow.
 */
export function StaticViewSchemaProvider({ schema, children }: { schema: ResolvedViewSchema; children: ReactNode }) {
  const value = useMemo<ViewExecutionContextValue>(
    () => ({ schema, workspaceId: '__preview__', dataSourceId: null, access: null, readOnly: false }),
    [schema],
  )
  return <ViewExecCtx.Provider value={value}>{children}</ViewExecCtx.Provider>
}

// ─── Schema Resolution ─────────────────────────────────────────────────────

function resolveSchema(raw: GraphSchema): ResolvedViewSchema {
  const relationshipTypes = raw.relationshipTypes.map(convertBackendRelationshipType)
  // Fall back to the per-relationship isContainment flags when the top-level
  // array is empty/absent (e.g. the cached-ontology synthetic schema), so a
  // lossy payload can't silently disable parent-child nesting in the canvas.
  const explicitContainment = raw.containmentEdgeTypes ?? []
  const explicitLineage = raw.lineageEdgeTypes ?? []
  return {
    entityTypes: raw.entityTypes.map(convertBackendEntityType),
    relationshipTypes,
    containmentEdgeTypes: explicitContainment.length > 0
      ? explicitContainment
      : deriveContainmentEdgeTypes(relationshipTypes),
    lineageEdgeTypes: explicitLineage.length > 0
      ? explicitLineage
      : deriveLineageEdgeTypes(relationshipTypes),
    rootEntityTypes: raw.rootEntityTypes ?? [],
    ontologyDigest: raw.ontologyDigest ?? null,
  }
}

// ─── Component ─────────────────────────────────────────────────────────────

interface ViewExecutionProviderProps {
  workspaceId: string
  dataSourceId: string | null | undefined
  /** The active Context View's id (branch-per-view: scopes the draft lookup below to
   *  THIS view, so a different view on the same data source never reuses its branch).
   *  Also the capability context: it rides on every data request so the backend can
   *  authorize non-members through their read access to this view. */
  viewId?: string | null
  /** Provider behind the view's resolved source, from the API response —
   *  present even for non-members (the workspace store can't say). */
  providerId?: string | null
  /** The caller's capability envelope from GET /views/{id}. */
  access?: ViewAccess | null
  children: ReactNode
}

export function ViewExecutionProvider({
  workspaceId,
  dataSourceId: dataSourceIdProp,
  viewId,
  providerId: providerIdProp,
  access = null,
  children,
}: ViewExecutionProviderProps) {
  const globalCtx = useGraphProviderContext()

  // ── Resolve null dataSourceId to the workspace's primary data source ──
  // Many views don't have an explicit dataSourceId — they use the workspace's
  // primary data source. The old code resolved this via setActiveWorkspace()
  // which synchronously set activeDataSourceId. We replicate that resolution
  // reactively here: useWorkspacesStore subscription ensures we re-resolve
  // when workspaces finish loading (critical for page refresh, where the
  // workspace list loads asynchronously after mount).
  const workspaces = useWorkspacesStore(s => s.workspaces)
  const globalActiveDataSourceId = useWorkspacesStore(s => s.activeDataSourceId)

  const dataSourceId = useMemo(() => {
    // 1. If view has an explicit dataSourceId, use it
    if (dataSourceIdProp) return dataSourceIdProp
    // 2. If view's workspace matches the global active workspace, use its
    //    active data source (already resolved to primary by workspace store)
    if (workspaceId === globalCtx.workspaceId && globalActiveDataSourceId) {
      return globalActiveDataSourceId
    }
    // 3. Otherwise look up the workspace's primary data source from the
    //    workspace list (reactive — re-computes when workspaces load)
    const ws = workspaces.find(w => w.id === workspaceId)
    const primaryDs = ws?.dataSources?.find(ds => ds.isPrimary) ?? ws?.dataSources?.[0]
    return primaryDs?.id ?? null
  }, [dataSourceIdProp, workspaceId, globalCtx.workspaceId, globalActiveDataSourceId, workspaces])

  const providerId = useMemo(() => {
    // The API-resolved provider wins — it exists for non-members, where
    // the workspace-store lookup below comes back empty.
    if (providerIdProp) return providerIdProp
    const ws = workspaces.find((workspace) => workspace.id === workspaceId)
    const dataSource = ws?.dataSources?.find((candidate) => candidate.id === dataSourceId)
      ?? ws?.dataSources?.find((candidate) => candidate.isPrimary)
      ?? ws?.dataSources?.[0]
    return dataSource?.providerId ?? null
  }, [providerIdProp, workspaces, workspaceId, dataSourceId])
  const providerStatus = useProviderStatus(providerId)

  // ── Draft scoping: the active branch (if this scope owns one) routes every read
  // through ?branchId=. A draft is never the shared global (main) provider. Scoped by
  // viewId (branch-per-view) so a different view sharing this data source never reuses
  // this view's branch — without it, ViewPage doesn't remount on a view-only route
  // change, so a stale/other view's branchId could route this view's reads. ──
  const effectiveBranchId = useEffectiveBranchId(workspaceId, dataSourceId, viewId)
  const mainEpoch = useBranchStore((s) => s.mainEpoch)

  // ── Decide whether to reuse the global provider or create a scoped one ──
  // An open view ALWAYS gets a pooled scoped provider: its requests carry the
  // ?viewId= capability context, which the shared global provider doesn't.
  // Members pay one extra cheap getStats() probe; non-members need it.
  const scopeMatchesGlobal =
    !effectiveBranchId &&
    !viewId &&
    workspaceId === globalCtx.workspaceId &&
    (dataSourceId === globalCtx.dataSourceId || (!dataSourceId && !globalCtx.dataSourceId))

  const scopedProvider = useMemo(() => {
    if (scopeMatchesGlobal) return globalCtx.provider
    return getOrCreateProvider(workspaceId, dataSourceId, effectiveBranchId, viewId)
  }, [scopeMatchesGlobal, workspaceId, dataSourceId, effectiveBranchId, viewId, globalCtx.provider])

  // ── Provider version: global if matching, otherwise local counter ──
  const [localVersion, setLocalVersion] = useState(1)
  const prevScopeRef = useRef(poolKey(workspaceId, dataSourceId, effectiveBranchId, viewId))

  useEffect(() => {
    const key = poolKey(workspaceId, dataSourceId, effectiveBranchId, viewId)
    if (key !== prevScopeRef.current) {
      prevScopeRef.current = key
      setLocalVersion(v => v + 1)
    }
  }, [workspaceId, dataSourceId, effectiveBranchId, viewId])

  // mainEpoch bumps on publish/merge → folds into the version so schema + hydration
  // (keyed by providerVersion) refetch once main has moved.
  const providerVersion = (scopeMatchesGlobal ? globalCtx.providerVersion : localVersion) + mainEpoch

  // ── Background connectivity check for scoped providers ──
  const [providerReady, setProviderReady] = useState(scopeMatchesGlobal)
  const [providerError, setProviderError] = useState<Error | null>(null)

  useEffect(() => {
    if (scopeMatchesGlobal) {
      setProviderReady(globalCtx.providerReady)
      setProviderError(null)
      return
    }
    if (providerStatus?.status === 'unavailable') {
      setProviderReady(true)
      setProviderError(new Error(providerStatus.error ?? 'Provider unavailable'))
      return
    }
    let cancelled = false
    setProviderReady(false)
    setProviderError(null)
    scopedProvider.getStats()
      .then(() => { if (!cancelled) setProviderReady(true) })
      .catch((err) => {
        if (!cancelled) {
          setProviderReady(true) // Ready = check done (even if failed)
          setProviderError(err instanceof Error ? err : new Error('Provider connection failed'))
        }
      })
    return () => { cancelled = true }
  // Depends on the STATUS, not the object. `providerStatus` comes out of a polled
  // store that replaces its whole `statuses` map on each meaningful write, so any
  // provider in the fleet changing re-fired this effect for every open view —
  // setProviderReady(false) -> getStats() -> true, plus a live round-trip. The
  // store's own dedupe comment already names this as flickering the canvas.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedProvider, scopeMatchesGlobal, globalCtx.providerReady, providerStatus?.status])

  // ── Build the overridden provider context value ──
  const providerContextValue = useMemo<GraphProviderContextValueExtended>(() => ({
    provider: scopedProvider,
    isLoading: false,
    error: providerError,
    scopeKind: 'ready',
    workspaceId,
    dataSourceId,
    providerReady,
    providerVersion,
  }), [scopedProvider, providerError, workspaceId, dataSourceId, providerReady, providerVersion])

  // ── Fetch schema for the view's scope ──
  // useGraphSchema uses React Query with cache key [wsId, dsId, providerVersion].
  // Different scopes get separate cache entries — no cross-workspace contamination.
  // The hook fetches from the DB-cached schema endpoint first (zero provider dependency),
  // then optionally background-refreshes from the live provider.
  //
  // IMPORTANT: We call useGraphSchema INSIDE the ProviderOverride so the hook's
  // call to useGraphProvider() returns our scoped provider. This ensures the
  // background refresh hits the correct workspace's API endpoint.
  const readOnly = access?.dataAccess === 'readonly'

  return (
    <ProviderOverride value={providerContextValue}>
      <ViewSchemaGate workspaceId={workspaceId} dataSourceId={dataSourceId} viewId={viewId ?? undefined}>
        {(schema) => (
          <ViewExecValue
            schema={schema}
            workspaceId={workspaceId}
            dataSourceId={dataSourceId}
            access={access}
            readOnly={readOnly}
          >
            {children}
          </ViewExecValue>
        )}
      </ViewSchemaGate>
    </ProviderOverride>
  )
}

/**
 * The context value, memoized — a component rather than a `useMemo` in the body
 * above because `schema` only exists inside `ViewSchemaGate`'s render prop, which
 * re-runs on every render of either component.
 *
 * An inline `value={{ ... }}` here was the head of the flicker cascade. A Provider
 * value change re-renders EVERY `useContext` consumer unconditionally — memo
 * comparators downstream cannot stop it — so a fresh object each render meant:
 * new schema arrays -> new containment predicate identity -> `useContainmentHierarchy`
 * reads it as "ontology changed" and does a FULL rebuild -> new flat tree ->
 * `LineageFlowOverlay`'s observer effect (keyed on `nodes`) disconnects every
 * observer and clears `globalVisibleNodes`, leaving the edge layer blank for a
 * frame. That is the "edges blink" the overlay's own comment describes, and its
 * cost is O(nodes + edges) — which is why the flicker got worse the bigger the
 * graph. `StaticViewSchemaProvider` above already did this correctly.
 */
function ViewExecValue({
  schema,
  workspaceId,
  dataSourceId,
  access,
  readOnly,
  children,
}: ViewExecutionContextValue & { children: ReactNode }) {
  const value = useMemo<ViewExecutionContextValue>(
    () => ({ schema, workspaceId, dataSourceId, access, readOnly }),
    [schema, workspaceId, dataSourceId, access, readOnly],
  )
  return <ViewExecCtx.Provider value={value}>{children}</ViewExecCtx.Provider>
}

/**
 * The gate's last-good schema, per scope.
 *
 * A stable instance from `useState`'s lazy initializer rather than a `useRef`
 * read in the render body: this project's hooks lint (`react-hooks/refs`) forbids
 * that, and `FocusGraphView`'s `ConeStore`/`TrailStore` already establish this as
 * the way to hold mutable-across-renders state here.
 */
class LastGoodSchema {
  private entry: { scopeKey: string; schema: ResolvedViewSchema } | null = null

  remember(scopeKey: string, schema: ResolvedViewSchema): void {
    this.entry = { scopeKey, schema }
  }

  /** The remembered schema, but only if it belongs to this exact scope. */
  forScope(scopeKey: string): ResolvedViewSchema | null {
    return this.entry?.scopeKey === scopeKey ? this.entry.schema : null
  }
}

// ─── Schema Gate ───────────────────────────────────────────────────────────
// Fetches the schema and renders children only when it's ready.
// Renders loading/error UI when the schema is unavailable.

interface ViewSchemaGateProps {
  workspaceId: string
  dataSourceId: string | null
  /** Capability context — threads into the cached-schema/-ontology reads. */
  viewId?: string
  children: (schema: ResolvedViewSchema) => ReactNode
}

function ViewSchemaGate({ workspaceId, dataSourceId, viewId, children }: ViewSchemaGateProps) {
  const { isLoading, isError, error, data, refetch } = useGraphSchema({
    workspaceId,
    dataSourceId: dataSourceId ?? undefined,
    viewId,
  })

  // Sync schema to the global Zustand store so global consumers (sidebar,
  // dashboard, command palette) see the current view's entity types.
  const loadFromBackend = useSchemaStore(s => s.loadFromBackend)
  useEffect(() => {
    if (data && data.entityTypes && data.entityTypes.length > 0) {
      loadFromBackend(data, { workspaceId, dataSourceId })
    }
  }, [data, loadFromBackend, workspaceId, dataSourceId])

  // Resolve the raw GraphSchema into frontend types.
  //
  // This memo's cache hit is load-bearing, and it depends on `data` holding its
  // identity across a no-op refetch. Two things guarantee that, both verified:
  // React Query's structural sharing preserves the nested `schema` object when
  // the payload is deep-equal (so the 2s `computing` poll does not churn it, even
  // though `meta` changes), and `placeholderData` in `useGraphSchema` carries the
  // same object across a `providerVersion` re-key.
  //
  // If it ever DID miss, the cost is not a cheap re-render: `resolveSchema`
  // returns fresh entityTypes / containmentEdgeTypes / lineageEdgeTypes arrays ->
  // `useViewIsContainmentEdge` re-mints its predicate ->
  // `useContainmentHierarchy` reads that as "the ontology changed" and does a
  // FULL rebuild -> new flat tree -> `LineageFlowOverlay`'s observer effect
  // disconnects every observer, blanking the edge layer for a frame.
  const resolved = useMemo<ResolvedViewSchema | null>(() => {
    if (!data || !data.entityTypes || data.entityTypes.length === 0) return null
    return resolveSchema(data)
  }, [data])

  // Hold the last resolved schema FOR THIS SCOPE so a re-key never unmounts a
  // canvas that is already up.
  //
  // This gate renders `children` through a render prop, so returning the spinner
  // early does not overlay the canvas — it destroys it: the React Flow instance,
  // the open lens (its history is local state in ContextViewCanvas), the trace,
  // the camera. Rebuilding all of that is the hard flicker, and it costs more the
  // bigger the graph. With `placeholderData` on the query this is now belt and
  // braces, but it is the layer that holds even if a trigger slips through.
  //
  // Stamped with the scope key, so a genuine workspace switch still gates and can
  // never show the previous workspace's ontology.
  const scopeKey = `${workspaceId}/${dataSourceId ?? ''}/${viewId ?? ''}`
  const [lastGoodSchema] = useState(() => new LastGoodSchema())
  useLayoutEffect(() => {
    if (resolved) lastGoodSchema.remember(scopeKey, resolved)
  }, [lastGoodSchema, scopeKey, resolved])
  // An entry stamped with a DIFFERENT scope is never handed back, so there is
  // nothing to clear — it is replaced as soon as the new scope resolves.
  const lastGood = resolved ?? lastGoodSchema.forScope(scopeKey)

  if (isLoading || (!resolved && !isError)) {
    // Already showing this scope — keep the canvas mounted and let the refetch
    // land underneath it.
    if (lastGood) return <>{children(lastGood)}</>
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-canvas/60 backdrop-blur-sm z-10">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-accent-lineage" />
          <span className="text-sm text-ink-muted">Loading view schema...</span>
        </div>
      </div>
    )
  }

  if (isError || !resolved) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-canvas">
        <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
          <AlertCircle className="h-6 w-6 text-destructive" />
          <h3 className="text-sm font-semibold text-foreground">
            Unable to load view schema
          </h3>
          <p className="text-xs text-muted-foreground">
            {error instanceof Error
              ? error.message
              : 'The ontology for this data source could not be resolved. This usually means the data source has no active ontology configured.'}
          </p>
          <button
            type="button"
            onClick={() => refetch()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        </div>
      </div>
    )
  }

  return <>{children(resolved)}</>
}

export default ViewExecutionProvider
