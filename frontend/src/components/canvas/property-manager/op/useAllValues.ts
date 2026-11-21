/**
 * useAllValues — every value the catalog keeps for one property (up to 1,000, with how many
 * entities hold each), not only the 20 it lists: what a merge of near-duplicates is chosen from,
 * and what a convert previews. Read from the catalog the server already holds for the view
 * (`valuesFor`), so once the Properties tab has read it the answer comes at once. Null where no
 * catalog can be read (not a remote graph) — the listed values stand in.
 *
 * Asked once the key has stood still for a moment (it is typed a letter at a time), and again as
 * the draft changes; while it is asked again the values it last read stay. A failed read says why,
 * and `retry` asks again.
 */
import { useEffect, useState } from 'react'
import { useDraftDataKey } from '@/features/versioning/hooks/useDraftDataKey'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { followCatalog } from '@/services/propertyCatalog'
import type { SearchCatalogValue } from '@/types/search'

/** How long the key stands still before it is asked for. */
const DEBOUNCE_MS = 300

export interface AllValues {
  values: SearchCatalogValue[] | null
  loading: boolean
  error: string | null
  /** Read them again. */
  retry: () => void
}

export function useAllValues(viewId: string, key: string, enabled = true): AllValues {
  const provider = useGraphProvider()
  const draftKey = useDraftDataKey()
  const [attempt, setAttempt] = useState(0)
  const retry = () => setAttempt((n) => n + 1)
  // Which property's values: an answer for another is never shown for this one.
  const of = enabled && !!key && provider instanceof RemoteGraphProvider ? `${viewId}\u0000${key}` : ''
  const ask = of && `${of}\u0000${draftKey}\u0000${attempt}`
  const [asked, setAsked] = useState({ ask, viewId, key })
  useEffect(() => {
    if (ask === asked.ask) return
    const timer = setTimeout(() => setAsked({ ask, viewId, key }), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [ask, asked.ask, viewId, key])
  const [held, setHeld] = useState<{ ask: string; of: string; values: SearchCatalogValue[] | null; error: string | null }>(
    { ask: '', of: '', values: null, error: null })
  useEffect(() => {
    if (!asked.ask || !(provider instanceof RemoteGraphProvider)) return
    const controller = new AbortController()
    const { ask: answering, viewId: view, key: property } = asked
    const heldOf = `${view}\u0000${property}`
    followCatalog(provider, view, { signal: controller.signal, valuesFor: property })
      .then((answer) => {
        if (controller.signal.aborted) return
        const found = answer.properties.find((p) => p.key === property)
        setHeld({ ask: answering, of: heldOf, values: found?.values ?? [], error: null })
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setHeld({ ask: answering, of: heldOf, values: null, error: (e as Error).message || 'the server didn’t answer' })
      })
    return () => controller.abort()
  }, [asked, provider])
  if (!of) return { values: null, loading: false, error: null, retry }
  if (held.ask === ask) return { values: held.values, loading: false, error: held.error, retry }
  // Asked again (the draft moved on, or a retry): the values last read for it stay meanwhile.
  return { values: held.of === of ? held.values : null, loading: true, error: null, retry }
}
