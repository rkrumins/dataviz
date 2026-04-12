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
 * This replaces the old implicit assumption that CanvasLayout had already
 * fetched the schema for the currently-active workspace — which broke every
 * non-canvas route (Dashboard, wizard, admin) and every cross-workspace view
 * edit.
 *
 * Behavior:
 * - Fetches schema for the given scope via useGraphSchema()
 * - Renders a loading UI until the schema is ready
 * - Catches errors via ErrorBoundary so a failed fetch surfaces loudly
 *   instead of silently serving stale/empty data
 * - Resets the error boundary when the scope changes, so switching workspace
 *   after an error re-arms the fetch
 *
 * This component should be the ONLY place that decides "is schema ready yet".
 * Child components can safely read from useSchemaStore() — the contract is
 * that if they render, the schema for the given scope has loaded.
 */
import { ReactNode } from 'react'
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useGraphSchema } from '@/hooks/useGraphSchema'

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
 * Inner body — rendered inside the ErrorBoundary so thrown errors from
 * useGraphSchema (via throwOnError-style assertions) become boundary catches.
 */
function SchemaScopeBody({
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
