/**
 * Workspace-switch cleanup protocol.
 *
 * Every Zustand store that holds workspace-scoped state — schema, canvas,
 * reference model — must be purged when the active workspace changes, and
 * every React Query cache keyed on workspace/data-source must be evicted.
 * Otherwise the UI happily keeps showing workspace W1's data under W2's
 * labels (see BUG-4 in the refactor plan).
 *
 * Rather than have every store subscribe to the workspaces store and risk
 * subtle ordering bugs, we expose a single function that the workspaces
 * store calls explicitly inside `setActiveWorkspace` / `setActiveDataSource`
 * BEFORE it commits the new active ids. That ordering matters: dependent
 * stores must see "empty" when the next render re-runs their selectors,
 * otherwise a component rendering during the transition might read stale
 * data from a workspace that no longer matches its effective scope.
 *
 * The cleanup is idempotent and safe to call even when no workspace is
 * active — all operations no-op when their target is empty.
 */
import { getQueryClient } from '@/main'
import { useSchemaStore } from '@/store/schema'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useCanvasStore } from '@/store/canvas'

export function cleanupOnWorkspaceSwitch(): void {
  // --- 1. Evict React Query caches -----------------------------------------
  // Any query key that is workspace- or data-source-scoped must be removed
  // so the next render cold-fetches against the new scope. `exact: false`
  // matches every query whose key starts with the given prefix.
  const qc = getQueryClient()
  if (qc) {
    qc.removeQueries({ queryKey: ['graph'], exact: false })
    qc.removeQueries({ queryKey: ['graph-schema'], exact: false })
    qc.removeQueries({ queryKey: ['graph-nodes'], exact: false })
    qc.removeQueries({ queryKey: ['views'], exact: false })
    qc.removeQueries({ queryKey: ['view-metadata'], exact: false })
    qc.removeQueries({ queryKey: ['ontology'], exact: false })
  }

  // --- 2. Reset dependent Zustand stores -----------------------------------
  // Optional-chaining lets us call `reset()` / `clear()` methods that may
  // or may not exist on a given store without hard-coupling this module to
  // their exact APIs. Each store exposes the finest-grained reset it has;
  // if a store lacks a reset, we fall back to its cache-clear primitives.
  try {
    const schemaStore = useSchemaStore.getState() as { reset?: () => void }
    schemaStore.reset?.()
  } catch {
    /* no-op: store not yet mounted */
  }

  try {
    const refStore = useReferenceModelStore.getState() as {
      clear?: () => void
      clearAssignments?: () => void
      clearConflicts?: () => void
    }
    if (refStore.clear) {
      refStore.clear()
    } else {
      // Reference-model store doesn't expose a top-level reset — use the
      // finest-grained clears that exist to evict cross-workspace state.
      refStore.clearAssignments?.()
      refStore.clearConflicts?.()
    }
  } catch {
    /* no-op */
  }

  try {
    const canvasStore = useCanvasStore.getState() as {
      reset?: () => void
      clearCache?: () => void
      clearSelection?: () => void
    }
    if (canvasStore.reset) {
      canvasStore.reset()
    } else {
      canvasStore.clearCache?.()
      canvasStore.clearSelection?.()
    }
  } catch {
    /* no-op */
  }
}
