/**
 * traceExport — the trace on screen, as a file (2026-11-18).
 *
 * A trace of twenty tables is a finding people hand to a spreadsheet, a
 * ticket or a script, and the dock is where they are looking at it. This
 * turns WHAT THE DOCK SHOWS into rows: the same scope the board draws — the
 * sides being read, the hop limits, the seeds still in the trace — and
 * nothing the board does not (a chain this view cannot place is counted in
 * `outsideView`, never invented into a row). A card the reader has not opened
 * is still in the file: closed is a way of looking, not a scope.
 *
 * What the browser holds is what it can write. A walk parked at its memory
 * checkpoint holds part of the trace, and the file says so in `meta`; the
 * complete answer is the server's job ("Everything it reaches…").
 *
 * Pure: no React, no download. JSON is returned as Blob PARTS, never one
 * `JSON.stringify` of the whole trace — fifty thousand rows as a single
 * string is a long pause on the thread that draws the board.
 */
import type { LensWalkModel } from '@/components/canvas/context-view/lens/closure-adapter'
import { specFor } from '@/features/narrow/model'
import { csvLine } from '@/lib/csv'
import type { MembershipSpec } from '@/types/membership'
import type { TraceCard, TraceView } from './traceViewModel'

/** The dock's walk ceiling: a depth at or past it is "the whole way". */
const UNLIMITED_DEPTH = 25

export type TraceExportRole = 'seed' | 'inside-seed' | 'upstream' | 'downstream' | 'both'

export interface TraceExportRow {
  urn: string
  name: string
  type: string
  /** Why it is in the trace, as the reader is reading it: a side that is
   *  switched off is not a reason, so a `both` partner read upstream only is
   *  `upstream`. */
  role: TraceExportRole
  /** Lineage hops from the nearest seed, on the sides being read. */
  hops: number | null
  hopsUp: number | null
  hopsDown: number | null
  /** The layer it is drawn in, by name. */
  layer: string
  /** Its containers from the layer's top down, by name. */
  path: string[]
  /** The seeds whose own walk reaches it (a combined trace only). */
  reachedFrom: string[]
}

export interface TraceExportInput {
  view: TraceView
  /** Every seed still in the trace. */
  seeds: readonly string[]
  showUpstream: boolean
  showDownstream: boolean
  layerName: (layerId: string) => string
  /** Each seed's own walk, to say which seeds reach a row. Omitted (or one
   *  seed): `reachedFrom` is left empty — every row is the one seed's. */
  seedModels?: ReadonlyMap<string, Pick<LensWalkModel, 'nodes'>>
}

export const TRACE_EXPORT_COLUMNS = [
  'urn', 'name', 'type', 'role', 'hops', 'hopsUp', 'hopsDown', 'layer', 'path', 'reachedFrom',
] as const

function roleOf(card: TraceCard, seeds: ReadonlySet<string>, up: boolean, down: boolean): TraceExportRole | null {
  if (card.role === 'host') return null
  if (card.role === 'focus') return seeds.has(card.urn) ? 'seed' : 'inside-seed'
  const onUp = up && (card.role === 'up' || card.role === 'both')
  const onDown = down && (card.role === 'down' || card.role === 'both')
  return onUp && onDown ? 'both' : onUp ? 'upstream' : onDown ? 'downstream' : null
}

/** One row per entity the trace shows — every lane, every depth, whether or
 *  not its card is open. Hosts (the containers a row sits in) are its `path`,
 *  not rows of their own: they are not on the lineage. */
export function traceExportRows(i: TraceExportInput): TraceExportRow[] {
  const seeds = new Set(i.seeds)
  const reach = i.seedModels && i.seedModels.size > 1
    ? [...i.seedModels].map(([seed, m]) => [seed, new Set(m.nodes.map(n => n.urn))] as const)
    : null
  const rows: TraceExportRow[] = []
  for (const lane of i.view.lanes) {
    const layer = i.layerName(lane.layerId)
    const pathOf = (card: TraceCard): string[] => {
      const path: string[] = []
      const guard = new Set<string>()
      for (let id = card.parentId; id && !guard.has(id); id = lane.cards.get(id)?.parentId ?? null) {
        guard.add(id)
        path.push(lane.cards.get(id)?.label ?? id)
      }
      return path.reverse()
    }
    const visit = (card: TraceCard) => {
      const role = roleOf(card, seeds, i.showUpstream, i.showDownstream)
      if (role) {
        const hopsUp = i.showUpstream ? card.hopUp : null
        const hopsDown = i.showDownstream ? card.hopDown : null
        const sides = [hopsUp, hopsDown].filter((h): h is number => h !== null)
        rows.push({
          urn: card.urn,
          name: card.label,
          type: card.type,
          role,
          hops: sides.length > 0 ? Math.min(...sides) : null,
          hopsUp,
          hopsDown,
          layer,
          path: pathOf(card),
          reachedFrom: reach ? reach.filter(([, held]) => held.has(card.urn)).map(([seed]) => seed) : [],
        })
      }
      for (const kid of lane.childrenOf.get(card.id) ?? []) {
        const child = lane.cards.get(kid)
        if (child) visit(child)
      }
    }
    for (const root of lane.roots) visit(root)
  }
  return rows
}

/** How many rows `traceExportRows` would write — cheap enough to say on
 *  every render, before anyone asks for the file. */
export function countTraceRows(view: TraceView, seeds: readonly string[], showUpstream: boolean, showDownstream: boolean): number {
  const seedSet = new Set(seeds)
  let n = 0
  for (const lane of view.lanes) {
    for (const card of lane.cards.values()) if (roleOf(card, seedSet, showUpstream, showDownstream)) n += 1
  }
  return n
}

/** The file's lines: a header, then a row each. Paths read `A / B`, seed
 *  lists `a; b` — the cells `lib/csv` writes, formulas defused. */
export function traceCsvLines(rows: readonly TraceExportRow[]): string[] {
  const lines = [csvLine(TRACE_EXPORT_COLUMNS)]
  for (const r of rows) {
    lines.push(csvLine([
      r.urn, r.name, r.type, r.role, r.hops, r.hopsUp, r.hopsDown, r.layer, r.path.join(' / '), r.reachedFrom,
    ]))
  }
  return lines
}

export interface TraceExportEdge {
  source: string
  target: string
  type: string | null
}

/** The flows between rows of the file: raw lineage only (a rollup is a
 *  summary of these, not one of them), both ends exported. */
export function traceExportEdges(
  model: Pick<LensWalkModel, 'lineageEdges'>,
  rows: readonly TraceExportRow[],
): TraceExportEdge[] {
  const exported = new Set(rows.map(r => r.urn))
  const seen = new Set<string>()
  const edges: TraceExportEdge[] = []
  for (const e of model.lineageEdges) {
    if (e.kind === 'rollup' || !exported.has(e.sourceUrn) || !exported.has(e.targetUrn)) continue
    const key = `${e.sourceUrn}\n${e.targetUrn}\n${e.edgeType ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ source: e.sourceUrn, target: e.targetUrn, type: e.edgeType ?? null })
  }
  return edges
}

export interface TraceExportMeta {
  view: { id: string | null; name: string | null }
  dataSourceId: string | null
  generatedAt: string
  seeds: { urn: string; label: string }[]
  direction: 'up' | 'down' | 'both'
  depthUp: number
  depthDown: number
  /** Where the walk stood when the file was written: `checkpoint` holds part
   *  of the trace (the walk paused at its memory limit). */
  walkPhase: string | null
  truncated: boolean
  /** Chains the trace reached that this view cannot place, not in the file. */
  outsideView: number
}

/** The trace as the membership contract states it: these seeds, this far each
 *  way, nothing inside them. A side switched off is 0 hops; a depth at the
 *  walk's ceiling is the whole way. What a view made from the trace, and the
 *  complete server export, resolve — and what a script can post back. */
export function traceMembershipSpec(t: {
  urns: readonly string[]
  showUpstream: boolean
  showDownstream: boolean
  depthUp: number
  depthDown: number
}): MembershipSpec {
  const hops = (on: boolean, depth: number) => (!on ? 0 : depth >= UNLIMITED_DEPTH ? 'all' as const : depth)
  return specFor(
    { urns: [...new Set(t.urns)] },
    { upstream: hops(t.showUpstream, t.depthUp), downstream: hops(t.showDownstream, t.depthDown) },
  )
}

/** The JSON file, as Blob parts: `{meta, spec, nodes:[…], edges:[…]}`, one
 *  row per part so no single string holds the whole trace. */
export function traceJsonParts(
  meta: TraceExportMeta,
  spec: MembershipSpec,
  rows: readonly TraceExportRow[],
  edges: readonly TraceExportEdge[],
): string[] {
  const parts = [`{"meta":${JSON.stringify(meta)},"spec":${JSON.stringify(spec)},"nodes":[`]
  rows.forEach((r, n) => parts.push(`${n === 0 ? '' : ','}${JSON.stringify(r)}`))
  parts.push('],"edges":[')
  edges.forEach((e, n) => parts.push(`${n === 0 ? '' : ','}${JSON.stringify(e)}`))
  parts.push(']}')
  return parts
}

/** A file name a person can tell apart in their downloads folder. */
export function traceExportFilename(label: string, ext: 'csv' | 'json', at = new Date()): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'trace'
  return `trace-${slug}-${at.toISOString().slice(0, 10)}.${ext}`
}
