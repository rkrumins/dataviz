/**
 * useRequireSchema
 *
 * Suspense-style assertion hook: read the loaded graph schema for a given
 * scope, or throw if it's not ready yet.
 *
 * Contract: this hook MUST be called from a component rendered inside a
 * <SchemaScope workspaceId dataSourceId> that declares the same scope.
 * SchemaScope owns the loading UI and the error boundary, so by the time
 * this hook returns a non-null value the schema is guaranteed to be loaded
 * for the declared scope.
 *
 * Returns the WorkspaceSchema from the Zustand store (kept in sync by
 * useGraphSchema), NOT the raw GraphSchema that came off the wire. The
 * store is the canonical in-memory shape every UI component reads from.
 */
import { useGraphSchema } from './useGraphSchema'
import { useSchemaStore } from '@/store/schema'
import type { WorkspaceSchema } from '@/types/schema'

export function useRequireSchema(
  workspaceId: string,
  dataSourceId: string,
): WorkspaceSchema {
  const query = useGraphSchema({ workspaceId, dataSourceId })

  // Errors propagate to the enclosing <SchemaScope>'s ErrorBoundary.
  if (query.isError && query.error) {
    throw query.error instanceof Error
      ? query.error
      : new Error(String(query.error))
  }

  // Read from the store rather than query.data so we get the canonical
  // WorkspaceSchema shape (post-normalization via loadFromBackend).
  const schema = useSchemaStore(s => s.schema)

  if (!schema || query.isLoading) {
    // SchemaScope should have rendered the loading UI before us — if we
    // hit this, the caller forgot to wrap their component in SchemaScope.
    throw new Error(
      'useRequireSchema: schema not loaded. ' +
        'Make sure this hook is called from a component rendered inside ' +
        '<SchemaScope workspaceId dataSourceId>.',
    )
  }

  return schema
}
