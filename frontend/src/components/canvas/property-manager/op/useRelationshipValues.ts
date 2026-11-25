/**
 * useRelationshipValues — the values one property holds on the relationships a change reaches,
 * read on the draft by the server (`previewPropertyJobValues`): what a clean-up of relationships
 * previews, as a clean-up of entities previews the view's catalog — no catalog counts a
 * relationship's values. Its first 400 named relationships, or a Connections search's first page.
 *
 * Asked once the key has stood still for a moment (it is typed a letter at a time); while it is
 * asked again the values last read for it stay. A failed read says why, and `retry` asks again.
 * Nothing is asked without a target and a key.
 */
import { useEffect, useState } from 'react'
import { previewPropertyJobValues, type PropertyJobTarget, type PropertyJobValues } from '@/services/versioningApiService'
import type { SearchCatalogProperty } from '@/types/search'
import type { AllValues } from './useAllValues'

/** How long the key stands still before it is asked for. */
const DEBOUNCE_MS = 300

export interface RelationshipValues extends AllValues {
  /** The property as the relationships read hold it, as a catalog lists one; null when none of
   *  them holds it, or until they are read. */
  property: SearchCatalogProperty | null
  /** How many relationships were read. */
  read: number
  /** The change reaches more than were read. */
  truncated: boolean
}

export function useRelationshipValues(
  graph: { wsId: string; graphId: string; branchId: string }, target: PropertyJobTarget | null, key: string,
): RelationshipValues {
  const [attempt, setAttempt] = useState(0)
  const retry = () => setAttempt((n) => n + 1)
  // Which values: an answer for another key or target is never shown for this one.
  const of = target && key ? JSON.stringify([graph.wsId, graph.graphId, graph.branchId, target, key]) : ''
  const ask = of && `${of}\u0000${attempt}`
  const [asked, setAsked] = useState({ ask, of, graph, target, key })
  useEffect(() => {
    if (ask === asked.ask) return
    const timer = setTimeout(() => setAsked({ ask, of, graph, target, key }), DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ask` says what is asked
  }, [ask, asked.ask])
  const [held, setHeld] = useState<{ ask: string; of: string; data: PropertyJobValues | null; error: string | null }>(
    { ask: '', of: '', data: null, error: null })
  useEffect(() => {
    if (!asked.ask || !asked.target) return
    const controller = new AbortController()
    const { ask: answering, of: heldOf, graph: g } = asked
    previewPropertyJobValues(g.wsId, g.graphId, g.branchId, asked.key, asked.target, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setHeld({ ask: answering, of: heldOf, data, error: null }) })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setHeld({ ask: answering, of: heldOf, data: null, error: (e as Error).message || 'the server didn’t answer' })
      })
    return () => controller.abort()
  }, [asked])
  const data = held.of === of ? held.data : null
  return {
    property: data?.property ?? null, values: data ? data.property?.values ?? [] : null, read: data?.read ?? 0,
    truncated: !!data?.truncated, loading: !!of && held.ask !== ask, error: held.ask === ask ? held.error : null, retry,
  }
}
