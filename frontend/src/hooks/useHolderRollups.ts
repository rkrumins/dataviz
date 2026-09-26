/**
 * useHolderRollups — roll-ups into the rows the view holds but has not
 * loaded.
 *
 * The canvas asks for the roll-ups among the rows it draws (the pair ledger
 * in useAggregatedLineage). A row whose partner is a row of an anchored
 * column past its loaded page, or a child of an open container not loaded
 * yet, was never asked about: no line, and a hollow port for a partner that
 * is in the view. So the canvas also asks about the HOLDERS (each anchor with
 * rows past its page, each open container with children not loaded) against
 * its rows, both ways. The projection keeps of each cell only what the
 * loaded rows under the holder do not carry (useEdgeProjection `holderEdges`).
 *
 * A request of its own: an anchor's cells reach down its whole column, and
 * one that fails, or comes back cut short, must not cost the rows their own
 * lines. Asked like the ledger: new rows against every holder, the rows
 * already asked against a new holder; whatever leaves takes its cells and
 * asks nothing. A failed round, or one a read gave up on part way, is asked
 * again on lookupRetryDelayMs, MAX_ATTEMPTS rounds in a row at most, then on
 * the next change. One cut at a cap (isCappedCut) — on a branch, where an
 * anchor's cells are derived by walking its whole column, that is the usual
 * answer — would be cut the same way again: it is final. It raises no
 * banner: what it could not learn stays as it was.
 *
 * Another graph or level starts empty, at once: its cells are no fact about
 * this one, and an answer that lands for a graph the canvas has left is
 * never shown. An invalidation asks everything again, and keeps showing the
 * cells it had until a whole answer replaces them, so a resync that fails
 * does not turn every row facing a holder hollow.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { lookupRetryDelayMs } from '@/config/polling'
import { mapWithConcurrency } from '@/lib/concurrency'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import type { AggregatedEdgeInfo, GraphDataProvider } from '@/providers/GraphDataProvider'

import { isCappedCut, useAggregatedEdgesCacheVersion } from './useAggregatedLineage'

const CHUNK_SIZE = 500
/** Asks in flight at once: the rows' own roll-ups come first. */
const CONCURRENCY = 2
/** Failed rounds in a row before it waits for the next change. */
const MAX_ATTEMPTS = 5

const NONE: ReadonlyMap<string, AggregatedEdgeInfo> = new Map()

interface HolderLedger {
  /** The graph and level the cells are of. */
  scope: string
  /** The cache version they were asked at. */
  version: number
  /** Rows whose cells with every holder in `holders` are known. */
  rows: Set<string>
  holders: Set<string>
  cells: Map<string, AggregatedEdgeInfo>
}

const emptyLedger = (scope: string, version: number, cells?: Map<string, AggregatedEdgeInfo>): HolderLedger =>
  ({ scope, version, rows: new Set(), holders: new Set(), cells: new Map(cells) })

function chunked(urns: string[]): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < urns.length; i += CHUNK_SIZE) chunks.push(urns.slice(i, i + CHUNK_SIZE))
  return chunks
}

export function useHolderRollups(granularity: string | null): {
  holderEdges: ReadonlyMap<string, AggregatedEdgeInfo>
  fetchHolders: (rows: string[], holders: string[]) => Promise<void>
} {
  const provider = useGraphProvider()
  const cacheVersion = useAggregatedEdgesCacheVersion(provider?.scopeKey)
  const scope = `${provider?.scopeKey ?? ''}:${granularity}`
  const [holderEdges, setHolderEdges] = useState<ReadonlyMap<string, AggregatedEdgeInfo>>(NONE)

  const ledgerRef = useRef<HolderLedger>(emptyLedger('', 0))
  const wantedRef = useRef<{ rows: string[]; holders: string[] }>({ rows: [], holders: [] })
  const askerRef = useRef<{ provider: GraphDataProvider; granularity: string | null; scope: string; version: number } | null>(null)
  // One round at a time; a change that arrives meanwhile runs it again.
  const runningRef = useRef(false)
  const againRef = useRef(false)
  const failuresRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(retryTimerRef.current), [])

  const sync = useCallback(async function run(): Promise<void> {
    if (runningRef.current) { againRef.current = true; return }
    const publish = (ledger: HolderLedger) => setHolderEdges(ledger.cells.size > 0 ? new Map(ledger.cells) : NONE)

    const round = async () => {
      const asker = askerRef.current
      if (!asker) return
      const prev = ledgerRef.current
      // Another graph or level: nothing it knew holds. An invalidation: all
      // of it is asked again, its cells shown until replaced.
      let changed = prev.scope !== asker.scope && prev.cells.size > 0
      if (prev.scope !== asker.scope || prev.version !== asker.version) {
        ledgerRef.current = emptyLedger(asker.scope, asker.version, prev.scope === asker.scope ? prev.cells : undefined)
      }
      const ledger = ledgerRef.current
      const { rows, holders } = wantedRef.current
      const rowSet = new Set(rows)
      const holderSet = new Set(holders)

      // What left takes its cells, and asks nothing.
      for (const r of ledger.rows) if (!rowSet.has(r)) ledger.rows.delete(r)
      for (const h of ledger.holders) if (!holderSet.has(h)) ledger.holders.delete(h)
      for (const [id, c] of ledger.cells) {
        const kept = (rowSet.has(c.sourceUrn) && holderSet.has(c.targetUrn))
          || (holderSet.has(c.sourceUrn) && rowSet.has(c.targetUrn))
        if (!kept) { ledger.cells.delete(id); changed = true }
      }
      if (changed) publish(ledger)

      // New rows against every holder; the rows already asked against the
      // new holders. With no holders at all, a row has nothing to ask.
      const newRows = rows.filter(r => !ledger.rows.has(r))
      const newHolders = holders.filter(h => !ledger.holders.has(h))
      if (holders.length === 0) newRows.forEach(r => ledger.rows.add(r))
      const asks: Array<{ rows: string[]; holders: string[]; forRows: boolean }> = []
      if (holders.length > 0) for (const chunk of chunked(newRows)) asks.push({ rows: chunk, holders, forRows: true })
      if (newHolders.length > 0) for (const chunk of chunked([...ledger.rows])) asks.push({ rows: chunk, holders: newHolders, forRows: false })
      if (asks.length === 0) {
        newHolders.forEach(h => ledger.holders.add(h))
        return
      }

      const legs = asks.flatMap((a, i) => [
        { i, sourceUrns: a.rows, targetUrns: a.holders },
        { i, sourceUrns: a.holders, targetUrns: a.rows },
      ])
      const settled = await mapWithConcurrency(legs, CONCURRENCY, leg =>
        asker.provider.getAggregatedEdges({ sourceUrns: leg.sourceUrns, targetUrns: leg.targetUrns, granularity: asker.granularity }))
      // A new graph, level or invalidation while this was out: dropped, and
      // the round that change asked for runs next.
      const latest = askerRef.current
      if (latest?.scope !== ledger.scope || latest.version !== ledger.version) return

      // What an answer says is kept, cut short or not; only a whole answer
      // (or one cut at a cap) to both legs makes its rows (or its new
      // holders) known, and is the whole truth about them: a cell an
      // invalidation carried over that it no longer names goes.
      const whole = asks.map(() => true)
      settled.forEach((s, n) => {
        if (s.status === 'rejected' || (s.value.truncated && !isCappedCut(s.value))) whole[legs[n].i] = false
      })
      asks.forEach((a, i) => {
        if (!whole[i]) return
        const R = new Set(a.rows)
        const H = new Set(a.holders)
        for (const [id, c] of ledger.cells) {
          if ((R.has(c.sourceUrn) && H.has(c.targetUrn)) || (H.has(c.sourceUrn) && R.has(c.targetUrn))) ledger.cells.delete(id)
        }
      })
      settled.forEach(s => {
        if (s.status === 'fulfilled') for (const c of s.value.aggregatedEdges) ledger.cells.set(c.id, c)
      })
      asks.forEach((a, i) => { if (a.forRows && whole[i]) a.rows.forEach(r => ledger.rows.add(r)) })
      if (asks.every((a, i) => a.forRows || whole[i])) newHolders.forEach(h => ledger.holders.add(h))
      publish(ledger)

      failuresRef.current = whole.every(Boolean) ? 0 : failuresRef.current + 1
      if (failuresRef.current > 0 && failuresRef.current < MAX_ATTEMPTS && retryTimerRef.current === undefined) {
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = undefined
          void run()
        }, lookupRetryDelayMs(failuresRef.current))
      }
    }

    runningRef.current = true
    try {
      do {
        againRef.current = false
        await round()
      } while (againRef.current)
    } finally {
      runningRef.current = false
    }
  }, [])

  const fetchHolders = useCallback((rows: string[], holders: string[]): Promise<void> => {
    if (!provider) return Promise.resolve()
    askerRef.current = { provider, granularity, scope, version: cacheVersion }
    wantedRef.current = { rows, holders }
    return sync()
  }, [provider, granularity, scope, cacheVersion, sync])

  return { holderEdges, fetchHolders }
}
