/**
 * drawerWidth — how wide the right-hand details rail is (DrawerFrame): the
 * reader's own width once they drag its edge, until then the panel's default.
 * A comparison (several entities, or several relationships) defaults wider:
 * its rows carry a value, a share and a count side by side.
 */

const DRAWER_WIDTH = 'clamp(420px, 32vw, 560px)'
const COMPARE_DRAWER_WIDTH = 'clamp(480px, 40vw, 720px)'
/** How narrow and how wide the reader may make the rail. */
export const DRAWER_MIN_WIDTH = 360
export const DRAWER_MAX_WIDTH = 960
/** The room the canvas keeps beside the rail, however wide it is dragged. */
export const CANVAS_MIN_WIDTH = 480

/** The rail's width as CSS: the reader's own, or the panel's default — wider for a comparison. */
export function drawerWidthCss(width: number | null, comparing = false): string {
  if (width !== null) return `${width}px`
  return comparing ? COMPARE_DRAWER_WIDTH : DRAWER_WIDTH
}

/** The default width in pixels, for the handle to measure a first drag from. */
export const defaultDrawerPx = (comparing = false): number => {
  if (typeof window === 'undefined') return 480
  const [min, share, max] = comparing ? [480, 0.4, 720] : [420, 0.32, 560]
  return Math.min(max, Math.max(min, Math.round(window.innerWidth * share)))
}
