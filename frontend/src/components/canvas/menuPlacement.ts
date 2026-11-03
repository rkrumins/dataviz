/**
 * Where a right-click menu goes, so every item in it can be reached.
 */

/** Space kept between a menu and the edges of the window. */
const EDGE = 8

/**
 * Where a menu of `size` goes for a right-click at `at`: below and to the right of
 * the pointer, flipped above it or to its left where it would run off the window,
 * and never past the window's edges. A menu taller than the window sits at its top
 * and scrolls (`maxHeight`).
 */
export function placeMenu(
    at: { x: number; y: number },
    size: { width: number; height: number },
    view: { width: number; height: number },
): { left: number; top: number; maxHeight: number } {
    const maxHeight = Math.max(0, view.height - EDGE * 2)
    const height = Math.min(size.height, maxHeight)
    let left = at.x + size.width > view.width - EDGE ? at.x - size.width : at.x
    left = Math.max(EDGE, Math.min(left, view.width - EDGE - size.width))
    let top = at.y
    if (top + height > view.height - EDGE) {
        top = at.y - height >= EDGE ? at.y - height : view.height - EDGE - height
    }
    return { left, top: Math.max(EDGE, top), maxHeight }
}
