/**
 * computeFitZoom — pure zoom computation for the Context View "Fit to
 * width" action.
 *
 * Intrinsic width is derived from STATE, not measured scrollWidth: at
 * zoom < 1 the columns wrapper pre-compensates its layout size with
 * `width: 100/zoom%` (see ContextViewCanvas), so scrollWidth tracks the
 * wrapper rather than the content and would lie.
 *
 * Width constants mirror the Tailwind literals in LayerColumn
 * (`min-w-[320px]` expanded / `min-w-[60px]` collapsed) and the columns
 * wrapper (`gap-12` = 48px). Tailwind's JIT can't consume JS constants,
 * so the classes stay literal — keep these in sync if the layout
 * changes.
 */
import { CANVAS_ZOOM_MIN } from '@/store/preferences'
import { EXTREMITY_EDGE_GUTTER_PX } from './LineageFlowOverlay'

export const EXPANDED_COLUMN_MIN_WIDTH_PX = 320
export const COLLAPSED_COLUMN_WIDTH_PX = 60
export const COLUMN_GAP_PX = 48

export function computeFitZoom(
  expandedColumns: number,
  collapsedColumns: number,
  viewportWidth: number,
): number {
  const columns = expandedColumns + collapsedColumns
  if (columns === 0 || viewportWidth <= 0) return 1
  const intrinsicWidth =
    expandedColumns * EXPANDED_COLUMN_MIN_WIDTH_PX +
    collapsedColumns * COLLAPSED_COLUMN_WIDTH_PX +
    Math.max(0, columns - 1) * COLUMN_GAP_PX +
    2 * EXTREMITY_EDGE_GUTTER_PX
  const fit = viewportWidth / intrinsicWidth
  // Never zoom IN to fit — 1 is the ceiling; the floor is the canvas min.
  return Math.min(1, Math.max(CANVAS_ZOOM_MIN, fit))
}
