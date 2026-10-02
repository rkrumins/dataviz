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
 *   all   — every line. The overlay applies it only while the board is sparse
 *           (its premium density tier) and falls back to `focus` above that.
 *   off   — nothing moves. Calm mode and the system's "reduce motion"
 *           setting resolve here, whatever was chosen.
 */
import type { LineageMotion } from '@/store/preferences'

export type LineMotion = LineageMotion

/** Most lines moving at once for a focus: a hub's fan can run to hundreds. */
export const MOTION_FOCUS_LIMIT = 120

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
  if (mode === 'off') return []
  if (mode === 'all') return [...lines]
  const { hoveredEdgeId, hoveredNodeId, highlighted } = focus
  const moving: T[] = []
  // The line under the pointer first, so a hub's cap never drops it.
  const hovered = hoveredEdgeId ? lines.find(l => l.id === hoveredEdgeId) : undefined
  if (hovered) moving.push(hovered)
  for (const line of lines) {
    if (moving.length >= MOTION_FOCUS_LIMIT) break
    if (line === hovered) continue
    const onFocus = highlighted
      ? highlighted.has(line.id)
      : hoveredNodeId !== null && (line.source === hoveredNodeId || line.target === hoveredNodeId)
    if (onFocus || line.isFocusIncident) moving.push(line)
  }
  return moving
}
