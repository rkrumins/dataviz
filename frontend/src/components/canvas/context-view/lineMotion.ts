/**
 * Which lineage lines move.
 *
 * A moving line carries a dashed chevron marching from source to target. That
 * says "the data goes this way" — worth saying on the lines a reader is looking
 * at, and noise on the thousand they are not. Every drawn line used to move all
 * the time: chevrons on every line of a sparse board, and a dash overlay on
 * every roll-up at ANY density. Measured on a 145-line board (2026-09-21), that
 * kept the GPU ~91% busy with nothing happening and changed 11.6% of the
 * canvas's pixels every frame — the flicker. Still lines cost nothing at rest.
 *
 *   focus — the lines the reader is on: the hovered line, the hovered or
 *           selected entity's lines, the trace focus's. The default.
 *   calm  — as focus, but a group of more lines than CALM_MOTION_AT (a trace's
 *           fan of sixty into one layer) is held still: sixty marching dashes
 *           through one corridor read as noise, not direction. A held line is
 *           drawn at the strength a moving one has, so the trace keeps its
 *           colour; only what the reader narrows to moves — the line under the
 *           pointer, or a hovered or selected entity with a handful of lines.
 *   all   — every line. The overlay applies it only while the board is sparse
 *           (its premium density tier) and falls back to `focus` above that.
 *   off   — nothing moves. Calm mode and the system's "reduce motion"
 *           setting resolve here, whatever was chosen.
 */
import type { LineageMotion } from '@/store/preferences'

export type LineMotion = LineageMotion

/** Most lines moving at once for a focus: a hub's fan can run to hundreds. */
export const MOTION_FOCUS_LIMIT = 120

/** The most lines a group may hold and still move, in the calm mode. */
export const CALM_MOTION_AT = 12

export interface MotionLine {
  id: string
  source: string
  target: string
  /** An end is the trace's focus. */
  isFocusIncident?: boolean
}

export interface MotionFocus {
  hoveredEdgeId: string | null
  hoveredNodeId: string | null
  /** The selected entity's lines, while a selection highlight is on. The rest
   *  of the board is dimmed then, so only these move — not the hovered row's. */
  highlighted: ReadonlySet<string> | null
}

export function pickMovingLines<T extends MotionLine>(
  lines: readonly T[],
  mode: LineMotion,
  focus: MotionFocus,
): T[] {
  return pickLineMotion(lines, mode, focus).moving
}

/** The lines that move, and — in the calm mode — those `focus` would have
 *  moved that are held still instead, to be drawn at a moving line's strength. */
export function pickLineMotion<T extends MotionLine>(
  lines: readonly T[],
  mode: LineMotion,
  focus: MotionFocus,
): { moving: T[]; held: T[] } {
  if (mode === 'off') return { moving: [], held: [] }
  if (mode === 'all') return { moving: [...lines], held: [] }
  const { hoveredEdgeId, hoveredNodeId, highlighted } = focus
  // The line under the pointer first, so a hub's cap never drops it.
  const hovered = hoveredEdgeId ? lines.find(l => l.id === hoveredEdgeId) : undefined
  // The groups a reader can be looking at: the selected or hovered entity's
  // lines, and the trace focus's.
  const lit: T[] = []
  let tracedSize = 0
  // The line under the pointer counts toward its group's size: pointing at one
  // line of a fan doesn't set the rest of the fan moving.
  for (const line of lines) {
    const onFocus = highlighted
      ? highlighted.has(line.id)
      : hoveredNodeId !== null && (line.source === hoveredNodeId || line.target === hoveredNodeId)
    if (onFocus) lit.push(line)
    if (line.isFocusIncident) tracedSize += 1
  }
  const moving: T[] = hovered ? [hovered] : []
  const held: T[] = []
  const calm = mode === 'calm'
  // In document order across the two groups, as `focus` always moved them.
  const litSet = new Set(lit)
  const litStill = calm && lit.length > CALM_MOTION_AT
  const tracedStill = calm && tracedSize > CALM_MOTION_AT
  for (const line of lines) {
    if (line === hovered) continue
    const inLit = litSet.has(line)
    if (!inLit && !line.isFocusIncident) continue
    if (inLit ? litStill : tracedStill) held.push(line)
    else if (moving.length < MOTION_FOCUS_LIMIT) moving.push(line)
  }
  return { moving, held }
}
