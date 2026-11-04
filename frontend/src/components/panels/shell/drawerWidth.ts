/**
 * drawerWidth — how wide the right-hand details rail is (DrawerFrame): the
 * reader's own width once they drag its edge, until then the panel's default.
 */

const DRAWER_WIDTH = 'clamp(420px, 32vw, 560px)'
/** How narrow and how wide the reader may make the rail. */
export const DRAWER_MIN_WIDTH = 360
export const DRAWER_MAX_WIDTH = 960
/** The room the canvas keeps beside the rail, however wide it is dragged. */
export const CANVAS_MIN_WIDTH = 480

/** The rail's width as CSS: the reader's own, or the panel's default. */
export function drawerWidthCss(width: number | null): string {
  return width === null ? DRAWER_WIDTH : `${width}px`
}

/** The default width in pixels, for the handle to measure a first drag from. */
export const defaultDrawerPx = (): number =>
  typeof window === 'undefined' ? 480 : Math.min(560, Math.max(420, Math.round(window.innerWidth * 0.32)))
