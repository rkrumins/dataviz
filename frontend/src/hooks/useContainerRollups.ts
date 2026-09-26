/**
 * useContainerRollups — every roll-up of a selected collapsed container.
 *
 * The canvas asks for roll-ups among the rows it draws (the pair ledger in
 * useAggregatedLineage) and with the rows it holds past a page
 * (useHolderRollups). A closed container whose partners are none of those —
 * rows past another column's page that no holder cell names, rows inside a
 * closed row, rows outside the view — has lineage and no line, and selecting
 * it drew nothing. So the canvas asks, for a selected one, for ALL of its
 * roll-ups: out, the cells from it with no target named; in, the cells into
 * it with no source named. The projection places their far ends through
 * their chains, as it does a holder's cells (useEdgeProjection
 * `holderEdges`).
 *
 * Kept per container and direction while the container is drawn closed: one
 * opened, or gone, takes its cells. Another graph or level starts empty, at
 * once. An invalidation keeps them until a fresh answer replaces them, and
 * the next ask asks again. A leg that fails — an older server cannot answer
 * the in-direction — costs only that leg, and is asked again next time; a
 * cut-short answer is kept and asked again next time.
 */
import { useCallback, useRef, useState } from 'react'

import { useGraphProvider } from '@/providers/GraphProviderContext'
import type { AggregatedEdgeInfo, AggregatedEdgeRequest } from '@/providers/GraphDataProvider'

import { useAggregatedEdgesCacheVersion } from './useAggregatedLineage'

const CHUNK_SIZE = 500

const NONE: ReadonlyMap<string, AggregatedEdgeInfo> = new Map()

type Way = 'in' | 'out'

interface ContainerLedger {
  /** The graph and level the cells are of. */
  graph: string
  /** The cache version the answers were asked at. */
  version: number
  /** Per container and direction (`legKey`): its cells, and whose they are. */
  legs: Map<string, { urn: string; cells: AggregatedEdgeInfo[] }>
  /** Legs answered in full at `version`: not asked again. */
  answered: Set<string>
  /** Legs out now: not asked twice. */
  asking: Set<string>
}

const legKey = (way: Way, urn: string) => `${way}\n${urn}`

const emptyLedger = (graph: string, version: number): ContainerLedger =>
  ({ graph, version, legs: new Map(), answered: new Set(), asking: new Set() })

function chunked(urns: string[]): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < urns.length; i += CHUNK_SIZE) chunks.push(urns.slice(i, i + CHUNK_SIZE))
  return chunks
}

export function useContainerRollups(granularity: string | null): {
  containerEdges: ReadonlyMap<string, AggregatedEdgeInfo>
  /** Ask about `asks` (URNs, per direction), and drop the containers `kept`
   *  no longer holds: those no longer drawn closed. */
  fetchContainerRollups: (asks: { out: readonly string[]; in: readonly string[] }, kept: (urn: string) => boolean) => Promise<void>
} {
  const provider = useGraphProvider()
  const cacheVersion = useAggregatedEdgesCacheVersion(provider?.scopeKey)
  const graph = `${provider?.scopeKey ?? ''}:${granularity}`
  const [containerEdges, setContainerEdges] = useState<ReadonlyMap<string, AggregatedEdgeInfo>>(NONE)

  const ledgerRef = useRef<ContainerLedger>(emptyLedger('', 0))
  // The latest `kept`: an answer that lands after a container was opened
  // is not kept for it.
  const keptRef = useRef<(urn: string) => boolean>(() => true)

  const fetchContainerRollups = useCallback(async (
    asks: { out: readonly string[]; in: readonly string[] },
    kept: (urn: string) => boolean,
  ): Promise<void> => {
    keptRef.current = kept
    const publish = (ledger: ContainerLedger) => {
      const cells = new Map<string, AggregatedEdgeInfo>()
      ledger.legs.forEach(leg => leg.cells.forEach(c => cells.set(c.id, c)))
      setContainerEdges(cells.size > 0 ? cells : NONE)
    }

    let ledger = ledgerRef.current
    let changed = false
    if (ledger.graph !== graph) {
      changed = ledger.legs.size > 0
      ledger = ledgerRef.current = emptyLedger(graph, cacheVersion)
    } else if (ledger.version !== cacheVersion) {
      ledger.version = cacheVersion
      ledger.answered.clear()
    }
    for (const [key, leg] of ledger.legs) {
      if (kept(leg.urn)) continue
      ledger.legs.delete(key)
      ledger.answered.delete(key)
      changed = true
    }
    if (changed) publish(ledger)
    if (!provider) return

    const wanted = (way: Way) => asks[way].filter(urn => kept(urn)
      && !ledger.answered.has(legKey(way, urn)) && !ledger.asking.has(legKey(way, urn)))
    const legs = [
      ...chunked(wanted('out')).map(urns => ({ way: 'out' as const, urns })),
      ...chunked(wanted('in')).map(urns => ({ way: 'in' as const, urns })),
    ]
    if (legs.length === 0) return
    legs.forEach(({ way, urns }) => urns.forEach(urn => ledger.asking.add(legKey(way, urn))))
    const version = ledger.version
    const settled = await Promise.allSettled(legs.map(({ way, urns }) => {
      const request: AggregatedEdgeRequest = way === 'out'
        ? { sourceUrns: urns, granularity }
        : { sourceUrns: [], targetUrns: urns, granularity }
      return provider.getAggregatedEdges(request)
    }))
    legs.forEach(({ way, urns }) => urns.forEach(urn => ledger.asking.delete(legKey(way, urn))))
    // Another graph or level while this was out: not its answer.
    if (ledgerRef.current !== ledger) return

    settled.forEach((result, i) => {
      if (result.status === 'rejected') return
      const { way, urns } = legs[i]
      const answer = result.value
      for (const urn of urns) {
        if (!keptRef.current(urn)) continue
        const key = legKey(way, urn)
        ledger.legs.set(key, {
          urn,
          cells: answer.aggregatedEdges.filter(c => (way === 'out' ? c.sourceUrn : c.targetUrn) === urn),
        })
        if (!answer.truncated && ledger.version === version) ledger.answered.add(key)
      }
    })
    publish(ledger)
  }, [provider, graph, cacheVersion, granularity])

  return { containerEdges, fetchContainerRollups }
}
