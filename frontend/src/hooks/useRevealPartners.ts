/**
 * useRevealPartners — bring a card's partners that are IN the view but not
 * drawn onto the canvas, so the card's lines can reach them.
 *
 * The case it exists for: a row of an anchored column past its loaded page.
 * Its lineage is in the view (the card's port says so), but there is no row
 * to draw a line to until it is loaded.
 *
 * Along their paths only. The stub click this replaces ran the drawer's
 * reveal (useRevealNode) per partner, six at a time: per partner a
 * getAncestors, then one loadChildren per ancestor — which resumes the
 * level's pager at its NEXT page, and loads ancestors above the view's roots
 * that land nowhere. Hundreds of requests for one click, and "landed" was
 * judged by the store, so a partner loaded but drawn nowhere counted as
 * landed. Here, for any number of partners, at most three requests:
 *
 *   1. one /nodes/ancestor-chains for the partners whose chain the canvas
 *      does not already hold (useAncestorChains);
 *   2. one getNodes for every node the paths need, and
 *   3. one getEdgesBetween for their containment edges (primeRevealSpine).
 *
 * Each partner's chain is walked up to its STOP: the first ancestor drawn as
 * a row of its own, or a promoted anchor (drawn as its column, never opened).
 * The levels between the stop and the partner, and the stop itself when it
 * is a row, are opened in one update, each first marked as holding its first
 * page (it holds its spine child; its "N more" row fetches the rest), as the
 * search reveal does. No child page is loaded, and nothing on the way gets
 * its own lineage.
 *
 * Landing is judged by what is drawn (`isVisible`), after the canvas has had
 * time to paint it. A partner that landed then reads its own flows
 * (primeLineageFor), as a row from a page does: it arrived with only its line
 * to the card, and its other lines, to rows already drawn among them, would
 * never draw. Fired after the landing, so the outcome does not wait on it.
 */
import { useCallback, useLayoutEffect, useRef } from 'react'

import { useCanvasStore } from '@/store/canvas'
import { primeRevealSpine } from '@/lib/primeRevealSpine'
import { primeLineageFor } from '@/lib/primeLineageFor'
import { appearsWithin } from './useLocateManyOnCanvas'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

/** How many partners one reveal brings in at most: a page of a column. */
export const REVEAL_PARTNERS_CAP = 100

export interface UseRevealPartnersOptions {
  provider: GraphDataProvider
  /** Setter for the canvas's `expandedNodes` set. */
  setExpandedNodes: React.Dispatch<React.SetStateAction<Set<string>>>
  /** Tell the canvas a level's first page is accounted for (see useRevealSearchHit). */
  markFirstPageHandled: (nodeId: string) => void
  /** An end's containment chain, parent first, root last, when the canvas holds it. */
  chainOf: (urn: string) => readonly string[] | undefined
  /** Drawn as a row of its own: no closed row folds it away. */
  isVisible: (id: string) => boolean
  /** A promoted anchor: drawn as its column. */
  isAnchor: (urn: string) => boolean
  /** The view is open to its whole data source: a partner nothing on its
   *  path is drawn for is a row past its type column's page, brought in as
   *  itself for its column to place. */
  openScope?: boolean
  containmentEdgeTypes: readonly string[]
  lineageEdgeTypes: readonly string[]
  /** How long to wait for the partners to be drawn. */
  settleMs?: number
}

export interface RevealPartnersOutcome {
  landed: string[]
  missed: string[]
}

export interface RevealPartnersScope {
  /** Only the partners whose path stops at a promoted anchor: rows of an
   *  anchored column. The rest are left to the caller, at no cost. */
  anchoredOnly?: boolean
}

export function useRevealPartners(
  opts: UseRevealPartnersOptions,
): (partners: readonly string[], scope?: RevealPartnersScope) => Promise<RevealPartnersOutcome> {
  // Stable callback, latest options — in place before any effect can call it.
  const optsRef = useRef(opts)
  useLayoutEffect(() => { optsRef.current = opts })

  return useCallback(async (partners: readonly string[], scope?: RevealPartnersScope): Promise<RevealPartnersOutcome> => {
    const {
      provider, setExpandedNodes, markFirstPageHandled, chainOf, isVisible, isAnchor, openScope,
      containmentEdgeTypes, lineageEdgeTypes, settleMs = 1500,
    } = optsRef.current
    const outcome = (): RevealPartnersOutcome => ({
      landed: partners.filter(p => optsRef.current.isVisible(p)),
      missed: partners.filter(p => !optsRef.current.isVisible(p)),
    })

    const wanted = partners.filter(p => !isVisible(p))
    if (wanted.length === 0) return outcome()

    const chains = new Map<string, readonly string[]>()
    const unknown: string[] = []
    for (const p of wanted) {
      const chain = chainOf(p)
      if (chain) chains.set(p, chain)
      else unknown.push(p)
    }
    if (unknown.length > 0 && provider.getAncestorChains) {
      try {
        const answered = await provider.getAncestorChains(unknown)
        for (const p of unknown) if (answered[p]) chains.set(p, answered[p])
      } catch (e) {
        console.warn('[reveal] partner chains failed', e)
      }
    }

    // The paths: every node on them, the levels to open, and each
    // parent → child step (to tell which levels hold their spine child).
    const spine = new Set<string>()
    const levels = new Set<string>()
    const steps: Array<[string, string]> = []
    for (const [partner, chain] of chains) {
      const stop = chain.findIndex(a => isVisible(a) || isAnchor(a))
      if (stop === -1) {
        // Nothing on its path is in this view — unless the view holds all of it.
        if (openScope && !scope?.anchoredOnly) spine.add(partner)
        continue
      }
      if (scope?.anchoredOnly && !isAnchor(chain[stop])) continue
      const path = chain.slice(0, stop + 1).reverse()
      path.forEach((level, i) => {
        spine.add(level)
        if (i > 0 || !isAnchor(level)) levels.add(level)
        steps.push([level, path[i + 1] ?? partner])
      })
      spine.add(partner)
    }
    if (spine.size === 0) return outcome()

    await primeRevealSpine(provider, [...spine], containmentEdgeTypes)

    const held = new Set(useCanvasStore.getState().edges.map(e => `${e.source}>${e.target}`))
    for (const [level, child] of steps) {
      if (levels.has(level) && held.has(`${level}>${child}`)) markFirstPageHandled(level)
    }
    if (levels.size > 0) {
      setExpandedNodes(prev => {
        const opening = [...levels].filter(id => !prev.has(id))
        return opening.length === 0 ? prev : new Set([...prev, ...opening])
      })
    }

    await appearsWithin(() => wanted.every(p => optsRef.current.isVisible(p)), settleMs)

    const landed = wanted.filter(p => optsRef.current.isVisible(p))
    if (landed.length > 0) {
      const generation = useCanvasStore.getState().graphGeneration
      const primed = new Set(landed)
      void primeLineageFor(provider, landed, lineageEdgeTypes, containmentEdgeTypes)
        .then(({ edges, partial }) => {
          // Flows read for a graph since replaced do not belong in the new
          // one, nor on a partner removed while they were read.
          const store = useCanvasStore.getState()
          if (store.graphGeneration !== generation) return
          const kept = edges.filter(e =>
            [e.source, e.target].every(end => !primed.has(end) || store._nodeIndex.has(end)))
          if (kept.length > 0) store.addGraph([], kept)
          store.markLineagePartial(partial)
        })
        .catch(e => console.warn('[reveal] partner lineage priming failed', e))
    }
    return outcome()
  }, [])
}
