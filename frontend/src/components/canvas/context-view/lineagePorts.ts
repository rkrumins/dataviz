/**
 * What an entity card says about its lineage on each side — its PORTS.
 *
 * A port sits where the lines plug in. Lines join the sides of two cards that
 * face each other (lineRoute.ts), so a card's lines to a column on its right
 * meet its right edge and its lines to a column on its left meet its left
 * edge — whichever way the data flows. The port says which way: incoming
 * (upstream) and outgoing (downstream) carry the trace's own colours, and a
 * side carrying both shows both. A card with no lineage has no port, so
 * absence reads as absence.
 *
 * Ports used to be keyed to direction alone — left for incoming, right for
 * outgoing — while a right-to-left line leaves its card by the LEFT edge:
 * the Report cards on ABCDE had every line plugged into a bare left edge
 * and their only port on the right, and read as "lineage with no marker".
 *
 * The server's degree (`/nodes/degree`, the whole graph) says whether lineage
 * exists at all. Lineage with nothing on this canvas has no side to plug
 * into, so it takes the conventional one — incoming left, outgoing right —
 * as a HOLLOW port. An UNKNOWN total (not fetched yet, or its query failed)
 * is never read as zero, nor as some. Once counting has FAILED, and the card
 * has no line of its own to answer the question, the port says just that:
 * UNKNOWN, on both sides, in neither direction colour, until a retry counts
 * it. Not while the first count is still on its way — every card would flash.
 */
import type { OffCanvasLineage } from '@/hooks/useEdgeProjection'

export type PortSide = 'left' | 'right'

/** Lines on the canvas meeting one side of a card, by direction. */
export interface SideLines {
  in: number
  out: number
}

export interface NodePorts {
  left: SideLines
  right: SideLines
  /** Lines on the canvas that stand aside for their children's finer ones
   *  (delegated): not drawn, so no port — but the lineage IS in view, so
   *  they keep the card from reading hollow. */
  delegated: SideLines
}

export interface PortView {
  /** `here` — lines to entities on this canvas; `beyond` — lineage in the
   *  data, none of it to anything on this canvas; `unknown` — its lineage
   *  could not be counted. */
  kind: 'here' | 'beyond' | 'unknown'
  dir: 'in' | 'out' | 'both'
}

/**
 * Which side of each card its lines meet. `layerOf` places an entity's
 * column in the canvas's left-to-right order; two ends in one column meet on
 * the left, where the same-column lane runs. An end whose column is not known
 * takes the convention — out on the right, in on the left.
 */
export function buildNodePorts(
  lines: Iterable<{ source: string; target: string; isBidirectional?: boolean; isDelegated?: boolean }>,
  layerOf: (id: string) => number | undefined,
): Map<string, NodePorts> {
  const ports = new Map<string, NodePorts>()
  const at = (id: string): NodePorts => {
    let p = ports.get(id)
    if (!p) {
      p = { left: { in: 0, out: 0 }, right: { in: 0, out: 0 }, delegated: { in: 0, out: 0 } }
      ports.set(id, p)
    }
    return p
  }
  for (const { source, target, isBidirectional, isDelegated } of lines) {
    if (source === target) continue
    if (isDelegated) {
      at(source).delegated.out++
      at(target).delegated.in++
      if (isBidirectional) {
        at(source).delegated.in++
        at(target).delegated.out++
      }
      continue
    }
    const s = layerOf(source)
    const t = layerOf(target)
    const rightward = s === undefined || t === undefined ? true : t > s
    const sameColumn = s !== undefined && s === t
    const sSide = sameColumn || !rightward ? 'left' : 'right'
    const tSide = sameColumn || rightward ? 'left' : 'right'
    at(source)[sSide].out++
    at(target)[tSide].in++
    // A two-way bundle is drawn once, oriented by id rather than by flow, so
    // its other direction meets the very same sides.
    if (isBidirectional) {
      at(source)[sSide].in++
      at(target)[tSide].out++
    }
  }
  return ports
}

export function portView(
  side: PortSide,
  ports: NodePorts | undefined,
  total: { in: number; out: number } | undefined,
  /** Counting this card's total failed; it is being asked again. */
  unknown = false,
): PortView | null {
  const here = ports?.[side]
  if (here && here.in + here.out > 0) {
    return { kind: 'here', dir: here.in > 0 && here.out > 0 ? 'both' : here.in > 0 ? 'in' : 'out' }
  }
  if (!total) {
    const anyLine = sideVolume(ports, 'left') + sideVolume(ports, 'right')
      + (ports ? ports.delegated.in + ports.delegated.out : 0) > 0
    return unknown && !anyLine ? { kind: 'unknown', dir: 'both' } : null
  }
  // Lineage with nothing on this canvas — only when NONE of that direction
  // is here, on either side: some of it on the canvas already says it exists.
  const canvasIn = (ports?.left.in ?? 0) + (ports?.right.in ?? 0) + (ports?.delegated.in ?? 0)
  const canvasOut = (ports?.left.out ?? 0) + (ports?.right.out ?? 0) + (ports?.delegated.out ?? 0)
  if (side === 'left' && total.in > 0 && canvasIn === 0) return { kind: 'beyond', dir: 'in' }
  if (side === 'right' && total.out > 0 && canvasOut === 0) return { kind: 'beyond', dir: 'out' }
  return null
}

/** A line's far end that is an anchored column, not a row of it. */
const COLUMN_END = 'column:'

/** The layer id a `unloadedColumnLines` end stands for; undefined for a row. */
export function columnEndLayer(id: string): string | undefined {
  return id.startsWith(COLUMN_END) ? id.slice(COLUMN_END.length) : undefined
}

/**
 * Lineage into an anchored column that the canvas does not draw — rows past
 * its loaded page, or its anchor, drawn as the column itself (the
 * projection's `columns`). That lineage is IN the view, so the card's port is
 * solid, on the side facing that column: one line per row, column and
 * direction, whose far end is the column (`columnEndLayer`), never a row.
 */
export function unloadedColumnLines(
  offCanvas: ReadonlyMap<string, OffCanvasLineage>,
): Array<{ source: string; target: string }> {
  const lines: Array<{ source: string; target: string }> = []
  offCanvas.forEach(({ columns }, row) => {
    columns.forEach((flows, layerId) => {
      if (flows.out > 0) lines.push({ source: row, target: COLUMN_END + layerId })
      if (flows.in > 0) lines.push({ source: COLUMN_END + layerId, target: row })
    })
  })
  return lines
}

/** Lines meeting one side — the port's size and glow scale with it. */
export function sideVolume(ports: NodePorts | undefined, side: PortSide): number {
  const s = ports?.[side]
  return s ? s.in + s.out : 0
}
