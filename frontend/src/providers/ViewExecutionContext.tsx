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

import { createContext, useContext, useState, useEffect, useRef, useMemo, type ReactNode } from 'react'
import type { GraphSchema } from './GraphDataProvider'
import type { GraphProviderContextValueExtended } from './GraphProviderContext'
import { useGraphProviderContext, ProviderOverride } from './GraphProviderContext'
import { getOrCreateProvider, poolKey } from './providerPool'
import { useBranchStore, useEffectiveBranchId } from '@/store/branchStore'
import { useWorkspacesStore } from '@/store/workspaces'
import { useProviderStatus } from '@/store/providerStatus'
import { useGraphSchema } from '@/hooks/useGraphSchema'
import { useSchemaStore, convertBackendEntityType, convertBackendRelationshipType, deriveContainmentEdgeTypes } from '@/store/schema'
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
    () => ({ schema, workspaceId: '__preview__', dataSourceId: null }),
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
  return {
    entityTypes: raw.entityTypes.map(convertBackendEntityType),
    relationshipTypes,
    containmentEdgeTypes: explicitContainment.length > 0
      ? explicitContainment
      : deriveContainmentEdgeTypes(relationshipTypes),
    lineageEdgeTypes: raw.lineageEdgeTypes ?? [],
    rootEntityTypes: raw.rootEntityTypes ?? [],
    ontologyDigest: raw.ontologyDigest ?? null,
  }
}

// ─── Component ─────────────────────────────────────────────────────────────

interface ViewExecutionProviderProps {
  workspaceId: string
  dataSourceId: string | null | undefined
  /** The active Context View's id (branch-per-view: scopes the draft lookup below to
   *  THIS view, so a different view on the same data source never reuses its branch). */
  viewId?: string | null
  children: ReactNode
}

export function ViewExecutionProvider({
  workspaceId,
  dataSourceId: dataSourceIdProp,
  viewId,
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
    const ws = workspaces.find((workspace) => workspace.id === workspaceId)
    const dataSource = ws?.dataSources?.find((candidate) => candidate.id === dataSourceId)
      ?? ws?.dataSources?.find((candidate) => candidate.isPrimary)
      ?? ws?.dataSources?.[0]
    return dataSource?.providerId ?? null
  }, [workspaces, workspaceId, dataSourceId])
  const providerStatus = useProviderStatus(providerId)

  // ── Draft scoping: the active branch (if this scope owns one) routes every read
  // through ?branchId=. A draft is never the shared global (main) provider. Scoped by
  // viewId (branch-per-view) so a different view sharing this data source never reuses
  // this view's branch — without it, ViewPage doesn't remount on a view-only route
  // change, so a stale/other view's branchId could route this view's reads. ──
  const effectiveBranchId = useEffectiveBranchId(workspaceId, dataSourceId, viewId)
  const mainEpoch = useBranchStore((s) => s.mainEpoch)

  // ── Decide whether to reuse the global provider or create a scoped one ──
  const scopeMatchesGlobal =
    !effectiveBranchId &&
    workspaceId === globalCtx.workspaceId &&
    (dataSourceId === globalCtx.dataSourceId || (!dataSourceId && !globalCtx.dataSourceId))

  const scopedProvider = useMemo(() => {
    if (scopeMatchesGlobal) return globalCtx.provider
    return getOrCreateProvider(workspaceId, dataSourceId, effectiveBranchId)
  }, [scopeMatchesGlobal, workspaceId, dataSourceId, effectiveBranchId, globalCtx.provider])

  // ── Provider version: global if matching, otherwise local counter ──
  const [localVersion, setLocalVersion] = useState(1)
  const prevScopeRef = useRef(poolKey(workspaceId, dataSourceId, effectiveBranchId))

  useEffect(() => {
    const key = poolKey(workspaceId, dataSourceId, effectiveBranchId)
    if (key !== prevScopeRef.current) {
      prevScopeRef.current = key
      setLocalVersion(v => v + 1)
    }
  }, [workspaceId, dataSourceId, effectiveBranchId])

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
  }, [scopedProvider, scopeMatchesGlobal, globalCtx.providerReady, providerStatus])

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
  return (
    <ProviderOverride value={providerContextValue}>
      <ViewSchemaGate workspaceId={workspaceId} dataSourceId={dataSourceId}>
        {(schema) => (
          <ViewExecCtx.Provider value={{ schema, workspaceId, dataSourceId }}>
            {children}
          </ViewExecCtx.Provider>
        )}
      </ViewSchemaGate>
    </ProviderOverride>
  )
}

// ─── Schema Gate ───────────────────────────────────────────────────────────
// Fetches the schema and renders children only when it's ready.
// Renders loading/error UI when the schema is unavailable.

interface ViewSchemaGateProps {
  workspaceId: string
  dataSourceId: string | null
  children: (schema: ResolvedViewSchema) => ReactNode
}

function ViewSchemaGate({ workspaceId, dataSourceId, children }: ViewSchemaGateProps) {
  const { isLoading, isError, error, data, refetch } = useGraphSchema({
    workspaceId,
    dataSourceId: dataSourceId ?? undefined,
  })

  // Sync schema to the global Zustand store so global consumers (sidebar,
  // dashboard, command palette) see the current view's entity types.
  const loadFromBackend = useSchemaStore(s => s.loadFromBackend)
  useEffect(() => {
    if (data && data.entityTypes && data.entityTypes.length > 0) {
      loadFromBackend(data, { workspaceId, dataSourceId })
    }
  }, [data, loadFromBackend, workspaceId, dataSourceId])

  // Resolve the raw GraphSchema into frontend types
  const resolved = useMemo<ResolvedViewSchema | null>(() => {
    if (!data || !data.entityTypes || data.entityTypes.length === 0) return null
    return resolveSchema(data)
  }, [data])

  if (isLoading || (!resolved && !isError)) {
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
