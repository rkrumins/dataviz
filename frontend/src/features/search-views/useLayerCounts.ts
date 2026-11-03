/**
 * How many matches each layer of a would-be subset view holds, as the choices
 * change: each layer is the search and the layer's types, counted where the
 * subset would look (the view it is made from, or the whole data source).
 *
 * A preview, not a census: a few rounds of counting, then the counts so far
 * (floors). Each change waits a beat, and a newer question aborts the older one.
 */
import { useEffect, useState } from 'react'

import { useGraphProvider } from '@/providers'
import type { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { countRules, type RuleCount } from '@/services/ruleCounts'
import type { Predicate } from '@/types/search'

export interface LayerToCount {
  id: string
  predicate: Predicate
}

export type LayerCounts =
  | { status: 'idle' }
  | { status: 'counting'; counts: ReadonlyMap<string, RuleCount> }
  | { status: 'done'; counts: ReadonlyMap<string, RuleCount> }
  | { status: 'error'; message: string }

const DEBOUNCE_MS = 300
/** Rounds of counting a preview spends before it answers with floors. */
const ROUNDS = 3

export function useLayerCounts(viewId: string | null, layers: LayerToCount[], wholeDataSource: boolean): LayerCounts {
  const provider = useGraphProvider() as unknown as RemoteGraphProvider & { searchCounts?: unknown }
  const key = viewId && layers.length ? JSON.stringify({ viewId, layers, wholeDataSource }) : null
  const [state, setState] = useState<{ key: string | null; value: LayerCounts }>({ key: null, value: { status: 'idle' } })

  useEffect(() => {
    if (!key || !viewId || typeof provider.searchCounts !== 'function') return
    const { layers: rules } = JSON.parse(key) as { layers: LayerToCount[] }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      countRules(provider, viewId, rules, {
        signal: controller.signal,
        purpose: 'search',
        maxRequests: ROUNDS,
        scope: wholeDataSource ? { viewId, scopeMode: 'data_source' } : { viewId, scopeMode: 'view' },
        onUpdate: (counts) => {
          if (!controller.signal.aborted) setState({ key, value: { status: 'counting', counts } })
        },
      })
        .then((counts) => { if (!controller.signal.aborted) setState({ key, value: { status: 'done', counts } }) })
        .catch((err) => {
          if (!controller.signal.aborted) setState({ key, value: { status: 'error', message: (err as Error).message } })
        })
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [provider, key, viewId, wholeDataSource])

  if (!key) return { status: 'idle' }
  return state.key === key ? state.value : { status: 'counting', counts: new Map() }
}
