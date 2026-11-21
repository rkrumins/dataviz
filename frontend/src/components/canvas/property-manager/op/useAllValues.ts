/**
 * useAllValues — every value the catalog keeps for one property (up to 1,000, with how many
 * entities hold each), not only the 20 it lists: what a merge of near-duplicates is chosen from,
 * and what a convert previews. Read from the catalog the server already holds for the view
 * (`valuesFor`), so once the Properties tab has read it the answer comes at once. Null where no
 * catalog can be read (not a remote graph) — the listed values stand in.
 */
import { useEffect, useState } from 'react'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { followCatalog } from '@/services/propertyCatalog'
import type { SearchCatalogValue } from '@/types/search'

export interface AllValues {
  values: SearchCatalogValue[] | null
  loading: boolean
  error: string | null
}

export function useAllValues(viewId: string, key: string, enabled = true): AllValues {
  const provider = useGraphProvider()
  const ask = enabled && !!key && provider instanceof RemoteGraphProvider ? `${viewId}\u0000${key}` : ''
  const [held, setHeld] = useState<{ ask: string; values: SearchCatalogValue[] | null; error: string | null }>({ ask: '', values: null, error: null })
  useEffect(() => {
    if (!ask || !(provider instanceof RemoteGraphProvider)) return
    const controller = new AbortController()
    followCatalog(provider, viewId, { signal: controller.signal, valuesFor: key })
      .then((answer) => {
        if (controller.signal.aborted) return
        const property = answer.properties.find((p) => p.key === key)
        setHeld({ ask, values: property?.values ?? [], error: null })
      })
      .catch((e: unknown) => { if (!controller.signal.aborted) setHeld({ ask, values: null, error: (e as Error).message }) })
    return () => controller.abort()
  }, [ask, provider, viewId, key])
  if (!ask) return { values: null, loading: false, error: null }
  return held.ask === ask ? { values: held.values, loading: false, error: held.error } : { values: null, loading: true, error: null }
}
