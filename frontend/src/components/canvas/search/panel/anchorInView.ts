/**
 * anchorInView — whether an element can still be seen through every box
 * that scrolls or clips around it.
 *
 * The panel's menus are portaled and fixed to the screen, following the
 * control that opened them as the panel scrolls. Once that control has
 * scrolled out of sight, following it floated the menu over whatever was
 * there instead — the panel's header, the canvas — attached to nothing.
 * The menus close then.
 *
 * An element not laid out (jsdom, a first frame) counts as in view.
 */
export function anchorInView(anchor: Element): boolean {
    const r = anchor.getBoundingClientRect()
    if (!r.width && !r.height) return true
    for (let box = anchor.parentElement; box; box = box.parentElement) {
        const style = getComputedStyle(box)
        if (!/auto|scroll|hidden|clip/.test(style.overflowX + style.overflowY)) continue
        const b = box.getBoundingClientRect()
        if (!b.width && !b.height) continue
        if (r.bottom <= b.top || r.top >= b.bottom || r.right <= b.left || r.left >= b.right) return false
    }
    return true
}


/**
 * followAnchor — keeps an open menu on its anchor. `place` runs now, on
 * every scroll and resize, and on every frame: an anchor inside a popover
 * (a filter's editor, a sentence token's) moves when that popover is
 * placed, grows or follows a scroll, with no event of its own. Measured on
 * scroll alone, a menu stayed where the popover had been — once, in the
 * window's corner, before the popover was placed. `place` keeps its state
 * when nothing moved. Returns the cleanup.
 */
export function followAnchor(place: () => void): () => void {
    place()
    let frame = requestAnimationFrame(function tick() {
        place()
        frame = requestAnimationFrame(tick)
    })
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
        cancelAnimationFrame(frame)
        window.removeEventListener('resize', place)
        window.removeEventListener('scroll', place, true)
    }
}
