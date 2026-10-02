/**
 * What hovering an entity lights up — decided where it is drawn.
 *
 * Hovering lights the entity, every line touching it or one of its loaded
 * descendants, and the entity at the far end of each of those lines; the
 * rest of the board dims. That rule is unchanged. What changed is where it
 * runs: it used to be React state on the canvas, so every change of the
 * hovered row re-rendered ContextViewCanvas, every column, every row and
 * every line — measured at 100–180 ms of main thread PER ROW the pointer
 * crossed (2026-09-21), which is what made the flows feel laggy and scrolling
 * with the pointer over a column stutter. The overlay now applies the result
 * straight to the DOM (LineageFlowOverlay's hover spotlight: marks on the lit
 * rows and lines), and a hover re-renders nothing but the hovered row.
 *
 * No lines, no spotlight: an entity with no lineage on the board dims nothing
 * (the canvas's own rule, `isHoverActive = edges.size > 0`).
 */
export interface SpotlightLine {
  id: string
  source: string
  target: string
}

export interface Spotlight {
  /** Entities to keep lit — the hovered one and every far end. */
  rows: Set<string>
  /** Lines touching the hovered entity or its descendants. */
  lines: Set<string>
}

export function hoverSpotlight(
  hovered: string,
  childMap: ReadonlyMap<string, readonly string[]>,
  lines: Iterable<SpotlightLine>,
): Spotlight | null {
  const focal = new Set([hovered])
  const stack = [hovered]
  while (stack.length > 0) {
    for (const child of childMap.get(stack.pop()!) ?? []) {
      if (!focal.has(child)) {
        focal.add(child)
        stack.push(child)
      }
    }
  }
  const rows = new Set([hovered])
  const lit = new Set<string>()
  for (const line of lines) {
    if (focal.has(line.source) || focal.has(line.target)) {
      lit.add(line.id)
      rows.add(line.source)
      rows.add(line.target)
    }
  }
  return lit.size > 0 ? { rows, lines: lit } : null
}

/**
 * How a line the projection set aside draws right now. An open container's
 * own line stands aside for its children's lines when they cover the same
 * pair (`isDelegated`: not drawn), or draws faint while those children are
 * only partly loaded (`isResidual`). Hovering either end brings it back in
 * full — decided here, at draw time, so the projection never re-runs for a
 * hover.
 */
export function delegatedLineState(
  line: { source: string; target: string; isDelegated?: boolean; isResidual?: boolean },
  hovered: string | null,
): 'hidden' | 'faint' | 'full' {
  if (hovered !== null && (line.source === hovered || line.target === hovered)) return 'full'
  if (line.isDelegated) return 'hidden'
  if (line.isResidual) return 'faint'
  return 'full'
}
