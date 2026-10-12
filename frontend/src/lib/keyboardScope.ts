/**
 * Keyboard scopes — a surface that owns the keys typed inside it (a drawer, a dialog).
 *
 * The canvas listens for its shortcuts on `document`, so a key pressed inside a drawer reached
 * it too: Backspace in the drawer deleted the node selected on the canvas, and T started a trace.
 * A surface marked with `data-keyboard-scope` keeps its keys; the canvas's shortcuts skip any
 * event that starts inside one.
 */
export const KEYBOARD_SCOPE_ATTR = 'data-keyboard-scope'

/** Spread onto a surface's root element to give it its own keys. */
export const keyboardScopeProps = (name: string) => ({ [KEYBOARD_SCOPE_ATTR]: name })

/** The event started inside a surface that owns its keys. */
export function isInKeyboardScope(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element
    && target.closest(`[${KEYBOARD_SCOPE_ATTR}]`) !== null
}
