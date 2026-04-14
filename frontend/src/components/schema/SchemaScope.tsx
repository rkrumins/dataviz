/**
 * <SchemaScope> — declarative scope boundary for graph-schema-dependent UI.
 *
 * Any feature that needs the ontology (entity types, edge types, root types,
 * etc.) must render inside a SchemaScope. The scope is expressed explicitly:
 *
 *     <SchemaScope workspaceId={ws} dataSourceId={ds}>
 *       <MyFeatureThatReadsSchema />
 *     </SchemaScope>
 *
 * Behavior:
 * - When the requested scope differs from the global active provider, creates
 *   a scoped RemoteGraphProvider (from the shared pool) and wraps children in
 *   a ProviderOverride. All downstream useGraphProvider() calls receive the
 *   correctly-scoped provider — no consumer changes needed.
 * - Fetches schema for the given scope via useGraphSchema()
 * - Renders a loading UI until the schema is ready
 * - Catches errors via ErrorBoundary so a failed fetch surfaces loudly
 * - Resets the error boundary when the scope changes
 *
 * This component is the ONLY place (outside ViewExecutionProvider for canvas
 * views) that decides "is schema ready yet" and "which provider should
 * children use". Child components can safely read from useSchemaStore() and
 * call useGraphProvider() — both are guaranteed correct for the given scope.
 */
import { ReactNode, useMemo, useState, useEffect, useRef } from 'react'
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useGraphSchema } from '@/hooks/useGraphSchema'
import {
  ProviderOverride,
  useGraphProviderContext,
  type GraphProviderContextValueExtended,
} from '@/providers/GraphProviderContext'
import { getOrCreateProvider, poolKey } from '@/providers/providerPool'

export interface SchemaScopeProps {
  workspaceId: string | null | undefined
  dataSourceId: string | null | undefined
  children: ReactNode
  /** Custom loading UI (defaults to a centered spinner). */
  fallback?: ReactNode
  /** Custom error UI (defaults to a generic failure card). */
  errorFallback?: (error: Error, reset: () => void) => ReactNode
  /** Hint shown in the default loading UI (e.g. "Loading ontology…"). */
  loadingLabel?: string
}

function DefaultLoadingUI({ label }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[200px] w-full items-center justify-center py-16">
      <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span>{label ?? 'Loading graph schema…'}</span>
      </div>
    </div>
  )
}

function DefaultErrorUI({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex h-full min-h-[200px] w-full items-center justify-center py-16">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
        <AlertCircle className="h-6 w-6 text-destructive" />
        <h3 className="text-sm font-semibold text-foreground">
          Unable to load graph schema
        </h3>
        <p className="text-xs text-muted-foreground">
          {error.message ||
            'The ontology for this workspace could not be resolved. ' +
              'This usually means the backend ontology service is unreachable or ' +
              'the workspace has no active ontology configured.'}
        </p>
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          <RefreshCw className="h-3 w-3" />
          Retry
        </button>
      </div>
    </div>
  )
}

/**
 * SchemaScopeBody — scope boundary + provider override.
 *
 * When the requested (workspaceId, dataSourceId) differs from the global
 * active provider, this creates a scoped RemoteGraphProvider from the shared
 * pool and wraps all children in a ProviderOverride. This ensures that
 * useGraphProvider() and useGraphProviderContext() calls within children
 * return the correctly-scoped provider — not the global active one.
 *
 * When the scope matches the global provider, children render directly
 * with no override overhead.
 */
function SchemaScopeBody({
  workspaceId,
  dataSourceId,
  children,
  fallback,
  loadingLabel,
}: Omit<SchemaScopeProps, 'errorFallback'>) {
  const globalCtx = useGraphProviderContext()

  // Determine if we need a scoped provider or can reuse the global one
  const scopeMatchesGlobal =
    workspaceId === globalCtx.workspaceId &&
    (dataSourceId === globalCtx.dataSourceId ||
      (!dataSourceId && !globalCtx.dataSourceId))

  // Get or create a scoped provider when scope differs from global
  const scopedProvider = useMemo(() => {
    if (scopeMatchesGlobal || !workspaceId) return null
    return getOrCreateProvider(workspaceId, dataSourceId ?? null)
  }, [scopeMatchesGlobal, workspaceId, dataSourceId])

  // Local provider version — increments when scope changes
  const [localVersion, setLocalVersion] = useState(1)
  const prevScopeRef = useRef(
    workspaceId ? poolKey(workspaceId, dataSourceId ?? null) : null,
  )
  useEffect(() => {
    const key = workspaceId ? poolKey(workspaceId, dataSourceId ?? null) : null
    if (key !== prevScopeRef.current) {
      prevScopeRef.current = key
      setLocalVersion(v => v + 1)
    }
  }, [workspaceId, dataSourceId])

  // Build the override context value for the scoped provider
  const overrideCtx = useMemo<GraphProviderContextValueExtended | null>(() => {
    if (!scopedProvider || !workspaceId) return null
    return {
      provider: scopedProvider,
      isLoading: false,
      error: null,
      scopeKind: 'ready',
      workspaceId,
      dataSourceId: dataSourceId ?? null,
      providerReady: true,
      providerVersion: localVersion,
      // No-ops: scoped contexts don't mutate workspace selection
      setWorkspaceId: () => {},
      setDataSourceId: () => {},
      connectionId: null,
      setConnectionId: () => {},
    }
  }, [scopedProvider, workspaceId, dataSourceId, localVersion])

  // SchemaScopeInner runs INSIDE the ProviderOverride so useGraphSchema's
  // call to useGraphProvider() returns the scoped provider
  const inner = (
    <SchemaScopeInner
      workspaceId={workspaceId}
      dataSourceId={dataSourceId}
      fallback={fallback}
      loadingLabel={loadingLabel}
    >
      {children}
    </SchemaScopeInner>
  )

  if (overrideCtx) {
    return <ProviderOverride value={overrideCtx}>{inner}</ProviderOverride>
  }
  return inner
}

/**
 * SchemaScopeInner — fetches schema and gates children on readiness.
 * Rendered inside the ProviderOverride (when cross-workspace) so that
 * useGraphSchema picks up the correctly-scoped provider.
 */
function SchemaScopeInner({
  workspaceId,
  dataSourceId,
  children,
  fallback,
  loadingLabel,
}: Omit<SchemaScopeProps, 'errorFallback'>) {
  const query = useGraphSchema({
    workspaceId: workspaceId ?? undefined,
    dataSourceId: dataSourceId ?? undefined,
  })

  // If the scope is incomplete (e.g. workspace not yet resolved), show the
  // loading UI rather than firing a useless query.
  if (!workspaceId || !dataSourceId) {
    return <>{fallback ?? <DefaultLoadingUI label={loadingLabel} />}</>
  }

  // Propagate errors up to the ErrorBoundary — no silent fallback.
  if (query.isError && query.error) {
    throw query.error instanceof Error
      ? query.error
      : new Error(String(query.error))
  }

  if (query.isLoading || !query.data) {
    return <>{fallback ?? <DefaultLoadingUI label={loadingLabel} />}</>
  }

  return <>{children}</>
}

export function SchemaScope({
  workspaceId,
  dataSourceId,
  children,
  fallback,
  errorFallback,
  loadingLabel,
}: SchemaScopeProps) {
  return (
    <ErrorBoundary
      // Reset the boundary when the scope changes so that e.g. switching
      // workspace after a failed fetch re-arms the fetch instead of leaving
      // the user stuck on the error card.
      resetKeys={[workspaceId, dataSourceId]}
      fallback={errorFallback ?? ((error, reset) => <DefaultErrorUI error={error} reset={reset} />)}
    >
      <SchemaScopeBody
        workspaceId={workspaceId}
        dataSourceId={dataSourceId}
        fallback={fallback}
        loadingLabel={loadingLabel}
      >
        {children}
      </SchemaScopeBody>
    </ErrorBoundary>
  )
}
