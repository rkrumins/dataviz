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
 * A container's roll-up cells count as lineage too (NodeDegree): its own
 * flows may be none while the rows inside it have plenty.
 */
import type { OffCanvasLineage } from '@/hooks/useEdgeProjection'
import type { NodeDegree } from '@/providers/GraphDataProvider'

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
   *  they keep the card from reading hollow. Lineage whose far end has no
   *  known place yet counts here too (unplacedLines). */
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
  /** `weight`: the lines one stands for (unloadedColumnLines); 1 if absent. */
  lines: Iterable<{ source: string; target: string; isBidirectional?: boolean; isDelegated?: boolean; weight?: number }>,
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
  for (const { source, target, isBidirectional, isDelegated, weight = 1 } of lines) {
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
    at(source)[sSide].out += weight
    at(target)[tSide].in += weight
    // A two-way bundle is drawn once, oriented by id rather than by flow, so
    // its other direction meets the very same sides.
    if (isBidirectional) {
      at(source)[sSide].in += weight
      at(target)[tSide].out += weight
    }
  }
  return ports
}

export function portView(
  side: PortSide,
  ports: NodePorts | undefined,
  total: NodeDegree | undefined,
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
  const hasIn = total.in > 0 || (total.rollupIn ?? 0) > 0
  const hasOut = total.out > 0 || (total.rollupOut ?? 0) > 0
  if (side === 'left' && hasIn && canvasIn === 0) return { kind: 'beyond', dir: 'in' }
  if (side === 'right' && hasOut && canvasOut === 0) return { kind: 'beyond', dir: 'out' }
  return null
}

const NO_TOTALS: ReadonlyMap<string, NodeDegree> = new Map()

/**
 * The totals each card's ports read (portView), from the server's.
 *
 * Roll-up cells speak for a CLOSED container only. Open, its rows carry
 * their own lines and ports, and the cells it holds to them — its own flows,
 * summarised against itself — would read as lineage leaving the view.
 *
 * A logical group is no entity, so the server has no total for it. Closed,
 * it stands for its members (and a nested group's): its total is theirs,
 * summed, once every one is counted, and unknown when one's count failed.
 * Open, its members speak for themselves.
 *
 * A hidden flow type never turns a port hollow. The totals count every
 * type, so when one the reader hid could explain the gap, no card says its
 * lineage only leaves the view; a failed count still says so.
 */
export function portTotals<N extends { id: string; isLogical?: boolean; children: readonly N[] }>(
  roots: Iterable<N>,
  totals: ReadonlyMap<string, NodeDegree>,
  failed: ReadonlySet<string>,
  isOpen: (id: string) => boolean,
  hiddenCouldExplain: boolean,
): { totals: ReadonlyMap<string, NodeDegree>; failed: ReadonlySet<string> } {
  const read = new Map<string, NodeDegree>()
  if (!hiddenCouldExplain) {
    totals.forEach((t, id) => {
      read.set(id, isOpen(id) && (t.rollupIn !== undefined || t.rollupOut !== undefined) ? { in: t.in, out: t.out } : t)
    })
  }
  const failedGroups: string[] = []
  const sum = (group: N): NodeDegree | 'unknown' | undefined => {
    const acc = { in: 0, out: 0, rollupIn: 0, rollupOut: 0 }
    let unknown = false
    let uncounted = false
    for (const member of group.children) {
      const t = member.isLogical ? sum(member) : failed.has(member.id) ? 'unknown' : totals.get(member.id)
      if (t === 'unknown') unknown = true
      else if (t === undefined) uncounted = true
      else {
        acc.in += t.in; acc.out += t.out
        acc.rollupIn += t.rollupIn ?? 0; acc.rollupOut += t.rollupOut ?? 0
      }
    }
    const answer = unknown ? 'unknown' : uncounted ? undefined : acc
    if (!isOpen(group.id)) {
      if (answer === 'unknown') failedGroups.push(group.id)
      else if (answer && !hiddenCouldExplain) read.set(group.id, answer)
    }
    return answer
  }
  for (const root of roots) if (root.isLogical) sum(root)
  return {
    totals: read.size > 0 ? read : NO_TOTALS,
    failed: failedGroups.length > 0 ? new Set([...failed, ...failedGroups]) : failed,
  }
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
 *
 * It weighs what it stands for, so the port's count and glow are the real
 * ones: one line per row it reaches — what selecting the card draws — and,
 * when it names no row (an anchor's rest, rows past the page with no URN
 * known), its flows, the only count there is.
 */
export function unloadedColumnLines(
  offCanvas: ReadonlyMap<string, OffCanvasLineage>,
): Array<{ source: string; target: string; weight: number }> {
  const lines: Array<{ source: string; target: string; weight: number }> = []
  offCanvas.forEach(({ columns }, row) => {
    columns.forEach((flows, layerId) => {
      if (flows.out > 0) lines.push({ source: row, target: COLUMN_END + layerId, weight: flows.outPartners.size || flows.out })
      if (flows.in > 0) lines.push({ source: COLUMN_END + layerId, target: row, weight: flows.inPartners.size || flows.in })
    })
  })
  return lines
}

/** A line's far end whose place is not known. */
const UNPLACED_END = 'unplaced:'

/**
 * Lineage whose far end has no known place: still being asked, or never
 * found (the projection's `unplaced`). Nothing says it leaves the view, so
 * the card must not read hollow on its account, and nothing says where it
 * goes, so it draws no port: like a delegated line, one per row and
 * direction.
 */
export function unplacedLines(
  offCanvas: ReadonlyMap<string, OffCanvasLineage>,
): Array<{ source: string; target: string; isDelegated: true }> {
  const lines: Array<{ source: string; target: string; isDelegated: true }> = []
  offCanvas.forEach(({ unplaced }, row) => {
    if (unplaced.out > 0) lines.push({ source: row, target: UNPLACED_END, isDelegated: true })
    if (unplaced.in > 0) lines.push({ source: UNPLACED_END, target: row, isDelegated: true })
  })
  return lines
}

/**
 * Rows whose lineage was read only in part: priming them came back at its
 * cap that way (the store's `lineagePartial`), so flows past it may reach
 * rows in the view. Like unplaced lineage, they keep that direction from
 * reading hollow and draw no port.
 */
export function partialLines(
  partial: { in: ReadonlySet<string>; out: ReadonlySet<string> },
): Array<{ source: string; target: string; isDelegated: true }> {
  const lines: Array<{ source: string; target: string; isDelegated: true }> = []
  partial.out.forEach(row => lines.push({ source: row, target: UNPLACED_END, isDelegated: true }))
  partial.in.forEach(row => lines.push({ source: UNPLACED_END, target: row, isDelegated: true }))
  return lines
}

/** Lines meeting one side — the port's size and glow scale with it. */
export function sideVolume(ports: NodePorts | undefined, side: PortSide): number {
  const s = ports?.[side]
  return s ? s.in + s.out : 0
}
