/**
 * The Review step's exact counts — how many entities the target holds, how many of them hold the
 * property, how many hold the new name — counted over the whole view (or data source) by the
 * server, a slice per request, each answer shown as it lands. A change of target or operation
 * cancels the count under way and starts again, after a pause for typing.
 */
import { useEffect, useState } from 'react'
import { useDraftDataKey } from '@/features/versioning/hooks/useDraftDataKey'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { countRules, type RuleCount } from '@/services/ruleCounts'
import type { Predicate } from '@/types/search'
import type { ScopeMode } from './opModel'

const DEBOUNCE_MS = 400

export interface ReviewCounts {
  counts: ReadonlyMap<string, RuleCount>
  /** Every count is exact. */
  complete: boolean
  /** How far the slowest count has got, 0–100. */
  percent: number
  error: string | null
  /** No count can be made here (not a remote graph). */
  unavailable: boolean
}

const EMPTY: ReviewCounts = { counts: new Map(), complete: false, percent: 0, error: null, unavailable: false }
const UNAVAILABLE: ReviewCounts = { ...EMPTY, unavailable: true }

export function useReviewCounts(
  viewId: string,
  items: ReadonlyArray<{ id: string; predicate: Predicate }> | null,
  scopeMode: ScopeMode,
): ReviewCounts {
  const provider = useGraphProvider()
  const remote = provider instanceof RemoteGraphProvider
  // Answers are kept with the request they answer: a newer request reads as counting afresh. The
  // draft is counted as it stands, so its moving on (a save, a running change's next window) is one.
  const draftKey = useDraftDataKey()
  const key = items && items.length > 0 ? JSON.stringify(items) + scopeMode + draftKey : ''
  const [state, setState] = useState<{ key: string; value: ReviewCounts }>({ key: '', value: EMPTY })
  useEffect(() => {
    if (!key || !items || !(provider instanceof RemoteGraphProvider)) return
    const controller = new AbortController()
    const read = (counts: ReadonlyMap<string, RuleCount>): ReviewCounts => {
      const all = items.map((i) => counts.get(i.id))
      const error = all.find((c) => c?.error)?.error ?? null
      return {
        counts,
        complete: all.every((c) => c?.complete),
        percent: Math.min(...all.map((c) => (c?.complete ? 100 : c?.percent ?? 0))),
        error,
        unavailable: false,
      }
    }
    const timer = setTimeout(() => {
      countRules(provider, viewId, items, {
        signal: controller.signal,
        scope: { viewId, scopeMode },
        purpose: 'search',
        onUpdate: (counts) => { if (!controller.signal.aborted) setState({ key, value: read(counts) }) },
      })
        .then((counts) => { if (!controller.signal.aborted) setState({ key, value: read(counts) }) })
        .catch(() => { /* the last update carries why it stopped */ })
    }, DEBOUNCE_MS)
    return () => { controller.abort(); clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, viewId, key])
  if (!key) return EMPTY
  if (!remote) return UNAVAILABLE
  return state.key === key ? state.value : EMPTY
}
