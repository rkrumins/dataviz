/**
 * What the Lens builds its board from when the model holds rollup cells
 * (Part G, 2026-08-21): every raw hop, plus only the cells that still say
 * something once the inner-first accounting has run — each weighted by
 * what it says, so a coarse wire reads "≈W flows" and a partner card
 * "≈W on this lineage", and a container whose cells are fully stated by
 * the cells (or raw hops) inside it has no hop at all, which is what makes
 * it a host the picture passes through rather than a partner card.
 *
 * `vouchAll` — the walk is done: every raw-backed pair is vouched for and
 * its cell is dropped (raw evidence wins; a cell the raw pages never
 * confirmed keeps drawing, "≈", because the board cannot tell staleness
 * from a flow it is missing). While the walk runs, a raw-backed cell draws
 * its residual `W − R` so the coarse wire shrinks as the raw wires grow.
 *
 * The same rule the canvas applies, through the same functions — see
 * `traceWireLedger.ts`.
 */
import { accountRollups, buildLedger, modelParentOf, type RollupCell } from '@/hooks/lib/traceWireLedger'
import type { LensWalkModel } from './closure-adapter'
import type { LensEdgeLike } from './lens-subgraph'

export function accountedLineageEdges(
  model: LensWalkModel,
  opts: { vouchAll: boolean },
): ReadonlyArray<LensEdgeLike> {
  const rollups = model.lineageEdges.filter(e => e.kind === 'rollup')
  if (rollups.length === 0) return model.lineageEdges
  const raw = model.lineageEdges.filter(e => e.kind !== 'rollup')
  const parentOf = modelParentOf(model)
  const cells: RollupCell[] = rollups.map(e => ({ source: e.sourceUrn, target: e.targetUrn, weight: e.weight ?? 1 }))
  const ledger = buildLedger(model, opts.vouchAll ? undefined : new Set<string>(), raw)
  const byId = new Map(rollups.map(e => [`${e.sourceUrn}>${e.targetUrn}`, e]))
  const out: LensEdgeLike[] = [...raw]
  for (const [key, w] of accountRollups(cells, ledger, parentOf, { floor: false })) {
    const original = byId.get(key)
    out.push({
      ...(original ?? { id: `agg:${key}`, sourceUrn: w.source, targetUrn: w.target, edgeType: 'AGGREGATED' }),
      kind: 'rollup',
      weight: w.count,
    })
  }
  return out
}
