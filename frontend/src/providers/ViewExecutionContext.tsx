/**
 * ViewExecutionContext — Isolated execution environment for a single view.
 *
 * When a user opens a view, this context provides:
 *   1. A RemoteGraphProvider scoped to the view's workspace/datasource (from a pool)
 *   2. The resolved schema (entity types, edge types, etc.) for the view's data source
 *   3. A provider context override so all downstream hooks (useGraphProvider,
 *      useGraphHydration, useLineageExploration, etc.) use the scoped provider
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
import { RemoteGraphProvider } from './RemoteGraphProvider'
import { useWorkspacesStore } from '@/store/workspaces'
import { useGraphSchema } from '@/hooks/useGraphSchema'
import { useSchemaStore, convertBackendEntityType, convertBackendRelationshipType } from '@/store/schema'
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

// ─── Provider Pool ─────────────────────────────────────────────────────────

interface PoolEntry {
  provider: RemoteGraphProvider
  lastUsed: number
}

const providerPool = new Map<string, PoolEntry>()
const POOL_MAX_SIZE = 8

function poolKey(wsId: string, dsId: string | null): string {
  return `${wsId}:${dsId ?? 'default'}`
}

function getOrCreateProvider(wsId: string, dsId: string | null): RemoteGraphProvider {
  const key = poolKey(wsId, dsId)
  const existing = providerPool.get(key)
  if (existing) {
    existing.lastUsed = Date.now()
    return existing.provider
  }
  // Evict LRU if pool is full
  if (providerPool.size >= POOL_MAX_SIZE) {
    let oldestKey: string | null = null
    let oldestTime = Infinity
    for (const [k, v] of providerPool) {
      if (v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed
        oldestKey = k
      }
    }
    if (oldestKey) providerPool.delete(oldestKey)
  }
  const provider = new RemoteGraphProvider({
    workspaceId: wsId,
    dataSourceId: dsId ?? undefined,
  })
  providerPool.set(key, { provider, lastUsed: Date.now() })
  return provider
}

// ─── Schema Resolution ─────────────────────────────────────────────────────

function resolveSchema(raw: GraphSchema): ResolvedViewSchema {
  return {
    entityTypes: raw.entityTypes.map(convertBackendEntityType),
    relationshipTypes: raw.relationshipTypes.map(convertBackendRelationshipType),
    containmentEdgeTypes: raw.containmentEdgeTypes ?? [],
    lineageEdgeTypes: raw.lineageEdgeTypes ?? [],
    rootEntityTypes: raw.rootEntityTypes ?? [],
    ontologyDigest: raw.ontologyDigest ?? null,
  }
}

// ─── Component ─────────────────────────────────────────────────────────────

interface ViewExecutionProviderProps {
  workspaceId: string
  dataSourceId: string | null | undefined
  children: ReactNode
}

export function ViewExecutionProvider({
  workspaceId,
  dataSourceId: dataSourceIdProp,
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

  // ── Decide whether to reuse the global provider or create a scoped one ──
  const scopeMatchesGlobal =
    workspaceId === globalCtx.workspaceId &&
    (dataSourceId === globalCtx.dataSourceId || (!dataSourceId && !globalCtx.dataSourceId))

  const scopedProvider = useMemo(() => {
    if (scopeMatchesGlobal) return globalCtx.provider
    return getOrCreateProvider(workspaceId, dataSourceId)
  }, [scopeMatchesGlobal, workspaceId, dataSourceId, globalCtx.provider])

  // ── Provider version: global if matching, otherwise local counter ──
  const [localVersion, setLocalVersion] = useState(1)
  const prevScopeRef = useRef(poolKey(workspaceId, dataSourceId))

  useEffect(() => {
    const key = poolKey(workspaceId, dataSourceId)
    if (key !== prevScopeRef.current) {
      prevScopeRef.current = key
      setLocalVersion(v => v + 1)
    }
  }, [workspaceId, dataSourceId])

  const providerVersion = scopeMatchesGlobal ? globalCtx.providerVersion : localVersion

  // ── Background connectivity check for scoped providers ──
  const [providerReady, setProviderReady] = useState(scopeMatchesGlobal)
  const [providerError, setProviderError] = useState<Error | null>(null)

  useEffect(() => {
    if (scopeMatchesGlobal) {
      setProviderReady(globalCtx.providerReady)
      setProviderError(null)
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
  }, [scopedProvider, scopeMatchesGlobal, globalCtx.providerReady])

  // ── Build the overridden provider context value ──
  const providerContextValue = useMemo<GraphProviderContextValueExtended>(() => ({
    provider: scopedProvider,
    isLoading: false,
    error: providerError,
    workspaceId,
    dataSourceId,
    providerReady,
    providerVersion,
    // No-ops in view scope — views don't change workspace
    setWorkspaceId: () => {},
    setDataSourceId: () => {},
    connectionId: null,
    setConnectionId: () => {},
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
