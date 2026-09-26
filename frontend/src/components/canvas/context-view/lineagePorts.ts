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
 * Lineage with no line on this canvas has no side to plug into, so it takes
 * the conventional one — incoming left, outgoing right — SOLID: the card has
 * lineage that way, and selecting it draws the lines. Anything that says so
 * will do: the server's degree (`/nodes/degree`, the whole graph), a
 * container's roll-up cells (NodeDegree: its own flows may be none while the
 * rows inside it have plenty), a far end whose place is still being asked,
 * a read that came back at its cap. None of them can say where the partners
 * are — a row past a page, a row inside the card, a member of the same
 * group — so none of them makes a port HOLLOW. Only the canvas placing that
 * direction's flows outside the view does (`outside`), and then only while
 * nothing of that direction is in it, and only when those flows are all it
 * counted that way: a flow the canvas never read (pruned with a collapse, a
 * group member not read, roll-up cells not asked for) may be in the view.
 * Holding roll-up cells is not such a flow. A closed container with no flow
 * of its own that way is held (NodePorts) until its own roll-ups are read
 * whole, so it is hollow only once every cell they name is placed outside.
 *
 * An UNKNOWN total (not fetched yet, or its query failed) is never read as
 * zero, nor as some. Once counting has FAILED, and nothing else says the
 * card has lineage, the port says just that: UNKNOWN, on both sides, in
 * neither direction colour, until a retry counts it. Not while the first
 * count is still on its way — every card would flash. A total whose roll-up
 * check failed is counted only in part: its flows say what they say, and
 * with none, whether it holds roll-up cells is still unknown.
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
   *  they keep the card from reading hollow. */
  delegated: SideLines
  /** Lineage with no line of its own yet: its far end has no known place
   *  (unplacedLines), or its read came back at its cap, or a closed
   *  container's roll-ups were not read in full (partialLines). The card
   *  has lineage that way, and none of it is known to leave the view. */
  held: SideLines
}

export interface PortView {
  /** `here` — lines to entities on this canvas; `lineage` — lineage no line
   *  shows yet (solid, on the conventional side); `beyond` — lineage the
   *  canvas placed outside this view, none of that direction in it;
   *  `unknown` — its lineage could not be counted. */
  kind: 'here' | 'lineage' | 'beyond' | 'unknown'
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
  lines: Iterable<{ source: string; target: string; isBidirectional?: boolean; isDelegated?: boolean; isHeld?: boolean; weight?: number }>,
  layerOf: (id: string) => number | undefined,
): Map<string, NodePorts> {
  const ports = new Map<string, NodePorts>()
  const at = (id: string): NodePorts => {
    let p = ports.get(id)
    if (!p) {
      p = { left: { in: 0, out: 0 }, right: { in: 0, out: 0 }, delegated: { in: 0, out: 0 }, held: { in: 0, out: 0 } }
      ports.set(id, p)
    }
    return p
  }
  for (const { source, target, isBidirectional, isDelegated, isHeld, weight = 1 } of lines) {
    if (source === target) continue
    if (isHeld) {
      at(source).held.out++
      at(target).held.in++
      continue
    }
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
  /** Flows the canvas placed OUTSIDE this view (the projection's
   *  offCanvasByNode): the only thing that makes a port hollow. */
  outside?: { in: number; out: number },
): PortView | null {
  const here = ports?.[side]
  if (here && here.in + here.out > 0) {
    return { kind: 'here', dir: here.in > 0 && here.out > 0 ? 'both' : here.in > 0 ? 'in' : 'out' }
  }
  // Each direction speaks on its conventional side — incoming left,
  // outgoing right — and only while none of it is drawn, on either side:
  // some of it on the canvas already says it exists.
  const dir = side === 'left' ? 'in' : 'out'
  const drawn = (ports?.left[dir] ?? 0) + (ports?.right[dir] ?? 0)
  const held = ports?.held[dir] ?? 0
  const placedOutside = outside?.[dir] ?? 0
  // Its own flows that way. Holding roll-up cells says it has lineage, and
  // is no flow more to place: a cube server flags every entity with a flow.
  const counted = total?.[dir] ?? 0
  const rolledUp = (dir === 'in' ? total?.rollupIn : total?.rollupOut) ?? 0
  if (drawn === 0) {
    if (placedOutside > 0 && placedOutside >= counted && held + (ports?.delegated[dir] ?? 0) === 0) return { kind: 'beyond', dir }
    // A line standing aside for its children's is theirs to show.
    if (placedOutside + held + counted + rolledUp > 0) return { kind: 'lineage', dir }
  }
  if (!unknown) return null
  // Its count failed: unknown, unless anything else says it has lineage.
  const anything = sideVolume(ports, 'left') + sideVolume(ports, 'right')
    + (ports ? ports.delegated.in + ports.delegated.out + ports.held.in + ports.held.out : 0)
    + (outside ? outside.in + outside.out : 0)
    + (total ? total.in + total.out + (total.rollupIn ?? 0) + (total.rollupOut ?? 0) : 0) > 0
  return anything ? null : { kind: 'unknown', dir: 'both' }
}

const NO_TOTALS: ReadonlyMap<string, NodeDegree> = new Map()

/**
 * The totals each card's ports read (portView), from the server's.
 *
 * Roll-up cells speak for a CLOSED container only. Open, its rows carry
 * their own lines and ports, and the cells it holds to them — its own flows,
 * summarised against itself — would give it lineage of its own it has not.
 *
 * A logical group is no entity, so the server has no total for it. Closed,
 * it stands for its members (and a nested group's): its total is theirs,
 * summed. A member's lineage is the group's at once — flows counted by a
 * member whose roll-up check failed too, and the flags it had before that
 * check; with none found, it waits for every member, and is unknown when
 * one's count failed. Open, its members speak for themselves.
 *
 * An open container reads its own flows alone, so a total with its flows
 * counted is its whole answer, whatever its roll-up check did.
 */
export function portTotals<N extends { id: string; isLogical?: boolean; children: readonly N[] }>(
  roots: Iterable<N>,
  totals: ReadonlyMap<string, NodeDegree>,
  failed: ReadonlySet<string>,
  isOpen: (id: string) => boolean,
): { totals: ReadonlyMap<string, NodeDegree>; failed: ReadonlySet<string> } {
  const read = new Map<string, NodeDegree>()
  // Open and counted: not unknown, whatever its roll-up check did.
  const counted = new Set<string>()
  totals.forEach((t, id) => {
    if (!isOpen(id)) { read.set(id, t); return }
    read.set(id, t.rollupIn !== undefined || t.rollupOut !== undefined ? { in: t.in, out: t.out } : t)
    if (failed.has(id)) counted.add(id)
  })
  const failedGroups: string[] = []
  const sum = (group: N): NodeDegree | 'unknown' | undefined => {
    const acc = { in: 0, out: 0, rollupIn: 0, rollupOut: 0 }
    let unknown = false
    let uncounted = false
    for (const member of group.children) {
      const own = totals.get(member.id)
      const t = member.isLogical ? sum(member)
        : failed.has(member.id) && !(own && own.in + own.out + (own.rollupIn ?? 0) + (own.rollupOut ?? 0) > 0) ? 'unknown' : own
      if (t === 'unknown') unknown = true
      else if (t === undefined) uncounted = true
      else {
        acc.in += t.in; acc.out += t.out
        acc.rollupIn += t.rollupIn ?? 0; acc.rollupOut += t.rollupOut ?? 0
      }
    }
    const found = acc.in + acc.out + acc.rollupIn + acc.rollupOut > 0
    const answer = found ? acc : unknown ? 'unknown' : uncounted ? undefined : acc
    if (!isOpen(group.id)) {
      if (answer === 'unknown') failedGroups.push(group.id)
      else if (answer) read.set(group.id, answer)
    }
    return answer
  }
  for (const root of roots) if (root.isLogical) sum(root)
  return {
    totals: read.size > 0 ? read : NO_TOTALS,
    failed: failedGroups.length > 0 || counted.size > 0
      ? new Set([...failed, ...failedGroups].filter(id => !counted.has(id))) : failed,
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
 * ones: one line per row it names — what selecting the card draws — or the
 * flows it names no row for (an anchor's rest, the only count there is),
 * whichever is more. One row beside a forty-flow rest is not one line.
 */
export function unloadedColumnLines(
  offCanvas: ReadonlyMap<string, OffCanvasLineage>,
): Array<{ source: string; target: string; weight: number }> {
  const lines: Array<{ source: string; target: string; weight: number }> = []
  offCanvas.forEach(({ columns }, row) => {
    columns.forEach((flows, layerId) => {
      if (flows.out > 0) lines.push({ source: row, target: COLUMN_END + layerId, weight: Math.max(flows.outPartners.size, flows.unnamed.out) })
      if (flows.in > 0) lines.push({ source: COLUMN_END + layerId, target: row, weight: Math.max(flows.inPartners.size, flows.unnamed.in) })
    })
  })
  return lines
}

/** A line's far end whose place is not known. */
const UNPLACED_END = 'unplaced:'

/**
 * Lineage whose far end has no known place: still being asked, or never
 * found (the projection's `unplaced`). The card has lineage that way, and
 * nothing says it leaves the view or where it goes: a held line (NodePorts),
 * one per row and direction — solid on the conventional side, never hollow.
 */
export function unplacedLines(
  offCanvas: ReadonlyMap<string, OffCanvasLineage>,
): Array<{ source: string; target: string; isHeld: true }> {
  const lines: Array<{ source: string; target: string; isHeld: true }> = []
  offCanvas.forEach(({ unplaced }, row) => {
    if (unplaced.out > 0) lines.push({ source: row, target: UNPLACED_END, isHeld: true })
    if (unplaced.in > 0) lines.push({ source: UNPLACED_END, target: row, isHeld: true })
  })
  return lines
}

/**
 * Rows whose lineage was read only in part: priming them came back at its
 * cap that way (the store's `lineagePartial`), so flows past it may reach
 * rows in the view. Like unplaced lineage, a held line.
 */
export function partialLines(
  partial: { in: ReadonlySet<string>; out: ReadonlySet<string> },
): Array<{ source: string; target: string; isHeld: true }> {
  const lines: Array<{ source: string; target: string; isHeld: true }> = []
  partial.out.forEach(row => lines.push({ source: row, target: UNPLACED_END, isHeld: true }))
  partial.in.forEach(row => lines.push({ source: UNPLACED_END, target: row, isHeld: true }))
  return lines
}

/** Lines meeting one side — the port's size and glow scale with it. */
export function sideVolume(ports: NodePorts | undefined, side: PortSide): number {
  const s = ports?.[side]
  return s ? s.in + s.out : 0
}
