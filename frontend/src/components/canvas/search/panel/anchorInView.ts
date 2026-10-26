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
