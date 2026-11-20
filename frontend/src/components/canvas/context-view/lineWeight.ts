/**
 * How wide a lineage line is drawn on the canvas (LineageFlowOverlay's `pushLine`): its base
 * width, for what it is (one line, a bundle, a roll-up), shaped by the state it is in and scaled
 * by the reader's Line weight (Display → Line weight).
 *
 * A trace draws its lines at the width they have everywhere else: it tells its own lines apart
 * by colour, opacity and glow, never by thickening them, so a busy trace stays readable.
 */
import type { LineWeight } from '@/store/preferences'

/** What Line weight does to every width. */
export const LINE_WEIGHT_SCALE: Record<LineWeight, number> = { thin: 0.6, regular: 1, thick: 1.6 }

/** The state a line is in: drawn as usual (in a trace too), picked out by a highlight, dimmed
 *  beside one, or faint while another line is pointed at. */
export type LineState = 'idle' | 'highlighted' | 'dimmed' | 'faint'

export function lineStrokeWidth(base: number, state: LineState, weight: LineWeight = 'regular'): number {
  const width = state === 'highlighted' ? base + 1
    : state === 'dimmed' ? Math.max(1, base - 1)
    : state === 'faint' ? Math.max(1, base * 0.7)
    : base * 0.75
  return width * (LINE_WEIGHT_SCALE[weight] ?? 1)
}
