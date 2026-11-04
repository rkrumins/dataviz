/**
 * The kinds of entity a would-be subset view holds, most common first — for "A
 * layer per type found". One by-type breakdown of what the view will find (its
 * search, and what it keeps with the matches), where it will look. Asked only
 * while that layout is chosen, a beat after the last change; a newer question
 * aborts the older one.
 *
 * The breakdown runs over the search's capped candidates, so on a very large
 * result it is a sample: plenty to rank the twelve most common kinds, and the
 * rarer ones land in "Other matches" anyway.
 */
import { useEffect, useState } from 'react'

import { useGraphProvider } from '@/providers'
import type { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { Predicate, SearchQuery } from '@/types/search'

export type TypeBreakdown =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; types: Array<{ type: string; count: number }> }
  | { status: 'error' }

const DEBOUNCE_MS = 300
/** More kinds than a subset lays out, so the most common are among them. */
const MAX_TYPES = 50

export function useTypeBreakdown(viewId: string | null, predicate: Predicate | null, wholeDataSource: boolean): TypeBreakdown {
  const provider = useGraphProvider() as unknown as Partial<Pick<RemoteGraphProvider, 'searchAdvanced'>>
  const key = viewId && predicate ? JSON.stringify({ viewId, predicate, wholeDataSource }) : null
  const [state, setState] = useState<{ key: string | null; value: TypeBreakdown }>({ key: null, value: { status: 'idle' } })

  useEffect(() => {
    if (!key || typeof provider.searchAdvanced !== 'function') return
    const ask = JSON.parse(key) as { viewId: string; predicate: Predicate; wholeDataSource: boolean }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const query = {
        // A bare leaf is wrapped, as every other search the canvas sends is.
        predicate: ask.predicate.kind === 'group' ? ask.predicate : { kind: 'group', op: 'and', children: [ask.predicate] },
        scope: { viewId: ask.viewId, scopeMode: ask.wholeDataSource ? 'data_source' : 'view' },
        options: { results: 'aggregates', pageSize: 1, aggregations: [{ by: 'entityType', maxBuckets: MAX_TYPES }] },
      } as unknown as SearchQuery
      provider.searchAdvanced!(query, { signal: controller.signal })
        .then((page) => {
          if (controller.signal.aborted) return
          const types = (page.aggregates?.[0] ?? [])
            .map((b) => ({ type: String(b.ancestorEntityType || b.ancestorDisplayName || ''), count: b.matchCount ?? 0 }))
            .filter((t) => t.type && t.count > 0)
          setState({ key, value: { status: 'done', types } })
        })
        .catch(() => {
          if (!controller.signal.aborted) setState({ key, value: { status: 'error' } })
        })
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [provider, key])

  if (!key) return { status: 'idle' }
  return state.key === key ? state.value : { status: 'loading' }
}
