/**
 * useBlankSchemaHydration — temporarily hydrate the global schema store from a
 * blank model's derived schema for the lifetime of the wizard's blank Phase B.
 *
 * The blank path has no data source, so there is no <SchemaScope> to fetch a
 * schema from the graph endpoint. The wizard steps read the schema store
 * directly, so we set it here from the chosen ontology and restore the previous
 * scope/schema on unmount (cancel, back-to-scope, or after the model is created
 * and the wizard navigates away).
 *
 * Returns `true` once the store carries the blank schema, so the caller can gate
 * the wizard body until the steps will read the right schema.
 */
import { useEffect, useState } from 'react'
import { useSchemaStore } from '@/store/schema'
import type { WorkspaceSchema } from '@/types/schema'

export function useBlankSchemaHydration(
  schema: WorkspaceSchema | null,
  wsId: string | null,
): boolean {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!schema) {
      setReady(false)
      return
    }
    const store = useSchemaStore.getState()
    const prev = {
      schema: store.schema,
      activeViewId: store.activeViewId,
      activeScopeKey: store.activeScopeKey,
      lastLoadedScopeKey: store.lastLoadedScopeKey,
    }
    const blankScopeKey = wsId ? `${wsId}/__blank__` : '__blank__'
    useSchemaStore.setState({
      schema,
      activeViewId: null,
      activeScopeKey: blankScopeKey,
      lastLoadedScopeKey: blankScopeKey,
    })
    setReady(true)
    return () => {
      useSchemaStore.setState(prev)
      setReady(false)
    }
  }, [schema, wsId])

  return ready
}
