/**
 * usePlacementAncestry — the part of an entity's path in the DATA that this canvas has not loaded.
 *
 * An entity placed in a view apart from its parent says where it really sits: its full path from
 * the top of the graph. The canvas knows the loaded part of that path from its containment map;
 * above the highest loaded ancestor it asks the server once per such ancestor (its ancestors, with
 * names — the plain containment read every reader serves, drafts included). Returns top-urn → the
 * ancestors ABOVE it, root first ([] = it is a root). A URN absent from the map is UNKNOWN (not
 * answered yet, or the reader could not answer) — the caller shows the path as partial.
 */
import { useEffect, useRef, useState } from 'react'

import { useGraphProvider } from '@/providers'
import type { AncestorRef } from '@/types/search'

const NONE: ReadonlyMap<string, readonly AncestorRef[]> = new Map()

export function usePlacementAncestry(tops: readonly string[]): ReadonlyMap<string, readonly AncestorRef[]> {
  const provider = useGraphProvider()
  const [known, setKnown] = useState<ReadonlyMap<string, readonly AncestorRef[]>>(NONE)
  const askedRef = useRef<Set<string>>(new Set())
  // Bumped per graph. An answer is dropped only when it belongs to ANOTHER graph — never because
  // the component re-rendered meanwhile: with the asked-set, a dropped answer is never re-asked.
  const generationRef = useRef(0)
  const key = [...tops].sort().join('|')

  // A different graph: every answer belongs to the old one.
  useEffect(() => {
    generationRef.current += 1
    askedRef.current = new Set()
    const raf = requestAnimationFrame(() => setKnown(NONE))
    return () => cancelAnimationFrame(raf)
  }, [provider])

  useEffect(() => {
    const wanted = tops.filter((u) => !askedRef.current.has(u) && !u.startsWith('logical:'))
    if (wanted.length === 0) return
    wanted.forEach((u) => askedRef.current.add(u))
    const generation = generationRef.current
    for (const top of wanted) {
      provider.getAncestors(top)                                   // parent first, root last
        .then((ancestors) => {
          if (generation !== generationRef.current) return
          const path = [...ancestors].reverse().map((n) => ({
            urn: n.urn, displayName: n.displayName, entityType: n.entityType,
          }) as AncestorRef)
          setKnown((prev) => new Map(prev).set(top, path))
        })
        .catch(() => { askedRef.current.delete(top) })              // unknown; ask again later
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, key])

  return known
}
