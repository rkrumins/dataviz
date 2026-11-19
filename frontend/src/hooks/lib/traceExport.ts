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
  /** Its direct container — null for an entity at the top of the graph. */
  parentUrn: string | null
  parentName: string | null
  parentType: string | null
  /** Every container it sits in, from the top of the graph down to its parent:
   *  by name, and the same chain by URN. */
  path: string[]
  pathUrns: string[]
  /** The seeds whose own walk reaches it (a combined trace only). */
  reachedFrom: string[]
}

export interface TraceExportInput {
  view: TraceView
  /** The walk itself: every node it shipped comes with its containment chain
   *  (`containmentEdges`), which is where a row's parent and path come from —
   *  the whole chain, not only the part this view draws. */
  model: Pick<LensWalkModel, 'nodes' | 'containmentEdges'>
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
  'urn', 'name', 'type', 'role', 'hops', 'hopsUp', 'hopsDown', 'layer',
  'parentUrn', 'parentName', 'parentType', 'path', 'pathUrns', 'reachedFrom',
] as const

/** Each node's containment chain from the top down to its parent, read once per
 *  node however many rows sit under it. A containment cycle (bad data) ends the
 *  chain where it would repeat. */
function chainsOf(model: TraceExportInput['model']) {
  const parentOf = new Map<string, string>()
  for (const e of model.containmentEdges) if (!parentOf.has(e.targetUrn)) parentOf.set(e.targetUrn, e.sourceUrn)
  const nodeOf = new Map(model.nodes.map(n => [n.urn, n]))
  const memo = new Map<string, string[]>()
  const chain = (urn: string): string[] => {
    const known = memo.get(urn)
    if (known) return known
    const up: string[] = []
    const seen = new Set([urn])
    for (let p = parentOf.get(urn); p && !seen.has(p); p = parentOf.get(p)) {
      const above = memo.get(p)
      if (above) { up.push(p, ...[...above].reverse()); break }
      seen.add(p)
      up.push(p)
    }
    const top = up.reverse()
    memo.set(urn, top)
    return top
  }
  const nameOf = (urn: string) => {
    const n = nodeOf.get(urn)
    return n?.displayName ?? (n?.data?.label as string | undefined) ?? urn
  }
  const typeOf = (urn: string) => {
    const n = nodeOf.get(urn)
    return n?.entityType ?? (n?.data?.type as string | undefined) ?? ''
  }
  return { chain, nameOf, typeOf }
}

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
  const { chain, nameOf, typeOf } = chainsOf(i.model)
  const rows: TraceExportRow[] = []
  for (const lane of i.view.lanes) {
    const layer = i.layerName(lane.layerId)
    const visit = (card: TraceCard) => {
      const role = roleOf(card, seeds, i.showUpstream, i.showDownstream)
      if (role) {
        const hopsUp = i.showUpstream ? card.hopUp : null
        const hopsDown = i.showDownstream ? card.hopDown : null
        const sides = [hopsUp, hopsDown].filter((h): h is number => h !== null)
        const pathUrns = chain(card.urn)
        const parentUrn = pathUrns.at(-1) ?? null
        rows.push({
          urn: card.urn,
          name: card.label,
          type: card.type,
          role,
          hops: sides.length > 0 ? Math.min(...sides) : null,
          hopsUp,
          hopsDown,
          layer,
          parentUrn,
          parentName: parentUrn ? nameOf(parentUrn) : null,
          parentType: parentUrn ? typeOf(parentUrn) : null,
          path: pathUrns.map(nameOf),
          pathUrns,
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

/** The file's lines: a header, then a row each. A path of names reads `A / B`;
 *  URN lists (the path's, the seeds') `a; b`, as a URN may hold a `/` — the cells
 *  `lib/csv` writes, formulas defused. */
export function traceCsvLines(rows: readonly TraceExportRow[]): string[] {
  const lines = [csvLine(TRACE_EXPORT_COLUMNS)]
  for (const r of rows) {
    lines.push(csvLine([
      r.urn, r.name, r.type, r.role, r.hops, r.hopsUp, r.hopsDown, r.layer,
      r.parentUrn, r.parentName, r.parentType, r.path.join(' / '), r.pathUrns, r.reachedFrom,
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

/** One end of a flow: the entity, the layer it is drawn in, and where it sits. */
interface FlowEnd {
  name: string
  type: string
  layer: string
  parentUrn: string | null
  parentName: string | null
  parentType: string | null
  path: string[]
  pathUrns: string[]
}

/** A flow of the file, with both its ends — what each is, the layer it is drawn in, its
 *  parent and every container down to it — so lineage can be read flow by flow: what feeds
 *  an entity are the flows whose `target` it is, what it feeds those whose `source` it is. */
export interface TraceFlowRow {
  source: string
  target: string
  type: string | null
  sourceName: string
  sourceType: string
  sourceLayer: string
  sourceParentUrn: string | null
  sourceParentName: string | null
  sourceParentType: string | null
  sourcePath: string[]
  sourcePathUrns: string[]
  targetName: string
  targetType: string
  targetLayer: string
  targetParentUrn: string | null
  targetParentName: string | null
  targetParentType: string | null
  targetPath: string[]
  targetPathUrns: string[]
}

export const TRACE_FLOW_COLUMNS = [
  'source', 'target', 'type',
  'sourceName', 'sourceType', 'sourceLayer', 'sourceParentUrn', 'sourceParentName', 'sourceParentType', 'sourcePath', 'sourcePathUrns',
  'targetName', 'targetType', 'targetLayer', 'targetParentUrn', 'targetParentName', 'targetParentType', 'targetPath', 'targetPathUrns',
] as const

/** Each flow with its two ends as the file's rows say them (`traceExportEdges` keeps only
 *  flows between rows, so both ends have one). */
export function traceFlowRows(rows: readonly TraceExportRow[], edges: readonly TraceExportEdge[]): TraceFlowRow[] {
  const byUrn = new Map(rows.map(r => [r.urn, r]))
  const end = (urn: string): FlowEnd => {
    const r = byUrn.get(urn)
    return {
      name: r?.name ?? urn, type: r?.type ?? '', layer: r?.layer ?? '',
      parentUrn: r?.parentUrn ?? null, parentName: r?.parentName ?? null, parentType: r?.parentType ?? null,
      path: r?.path ?? [], pathUrns: r?.pathUrns ?? [],
    }
  }
  return edges.map((e) => {
    const s = end(e.source)
    const t = end(e.target)
    return {
      source: e.source, target: e.target, type: e.type,
      sourceName: s.name, sourceType: s.type, sourceLayer: s.layer,
      sourceParentUrn: s.parentUrn, sourceParentName: s.parentName, sourceParentType: s.parentType,
      sourcePath: s.path, sourcePathUrns: s.pathUrns,
      targetName: t.name, targetType: t.type, targetLayer: t.layer,
      targetParentUrn: t.parentUrn, targetParentName: t.parentName, targetParentType: t.parentType,
      targetPath: t.path, targetPathUrns: t.pathUrns,
    }
  })
}

/** The flows file's lines: a header, then a flow each — paths and URN lists written as the
 *  rows' are (`A / B`, `a; b`). */
export function traceFlowCsvLines(flows: readonly TraceFlowRow[]): string[] {
  const lines = [csvLine(TRACE_FLOW_COLUMNS)]
  for (const f of flows) {
    lines.push(csvLine([
      f.source, f.target, f.type,
      f.sourceName, f.sourceType, f.sourceLayer, f.sourceParentUrn, f.sourceParentName, f.sourceParentType,
      f.sourcePath.join(' / '), f.sourcePathUrns,
      f.targetName, f.targetType, f.targetLayer, f.targetParentUrn, f.targetParentName, f.targetParentType,
      f.targetPath.join(' / '), f.targetPathUrns,
    ]))
  }
  return lines
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

/** The trace as the membership contract states it: these seeds with everything
 *  inside them, as the trace shows them, and this far each way. A side switched
 *  off is 0 hops; a depth at the walk's ceiling is the whole way. What a view made
 *  from the trace, and the complete server export, resolve — and what a script can
 *  post back. A view keeps each seed whole (`'all'`: one member, however much is
 *  inside it); a file asks for what is inside to be listed (`listInside`), two
 *  levels down, the most the server lists row by row. */
export function traceMembershipSpec(t: {
  urns: readonly string[]
  showUpstream: boolean
  showDownstream: boolean
  depthUp: number
  depthDown: number
  listInside?: boolean
}): MembershipSpec {
  const hops = (on: boolean, depth: number) => (!on ? 0 : depth >= UNLIMITED_DEPTH ? 'all' as const : depth)
  return specFor(
    { urns: [...new Set(t.urns)] },
    {
      children: t.listInside ? 2 : 'all',
      upstream: hops(t.showUpstream, t.depthUp),
      downstream: hops(t.showDownstream, t.depthDown),
    },
  )
}

/** The JSON file, as Blob parts: `{meta, spec, nodes:[…], edges:[…]}`, one
 *  row per part so no single string holds the whole trace. Each edge is a flow
 *  with both its ends (`traceFlowRows`). */
export function traceJsonParts(
  meta: TraceExportMeta,
  spec: MembershipSpec,
  rows: readonly TraceExportRow[],
  edges: readonly TraceExportEdge[],
): string[] {
  const parts = [`{"meta":${JSON.stringify(meta)},"spec":${JSON.stringify(spec)},"nodes":[`]
  rows.forEach((r, n) => parts.push(`${n === 0 ? '' : ','}${JSON.stringify(r)}`))
  parts.push('],"edges":[')
  traceFlowRows(rows, edges).forEach((f, n) => parts.push(`${n === 0 ? '' : ','}${JSON.stringify(f)}`))
  parts.push(']}')
  return parts
}

/** A file name a person can tell apart in their downloads folder; `-flows` for the flows
 *  that go with a CSV. */
export function traceExportFilename(label: string, ext: 'csv' | 'json', at = new Date(), part?: 'flows'): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'trace'
  return `trace-${slug}-${at.toISOString().slice(0, 10)}${part ? `-${part}` : ''}.${ext}`
}
