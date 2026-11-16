/**
 * Focus goes back to what opened a dialog or drawer when it closes.
 *
 * Radix does this only for its own `Dialog.Trigger`: on close it focuses the trigger, and with no
 * trigger (a dialog driven by `open`, which is how ours are used) focus falls to the page body, and
 * a keyboard user starts again from the top. So the element that had focus when the dialog opened
 * is remembered, and focused again on close.
 */
import { useRef } from 'react'

export function useReturnFocus(initialFocus?: { current: HTMLElement | null }) {
    const opener = useRef<HTMLElement | null>(null)
    return {
        onOpenAutoFocus: (e: Event) => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
            if (initialFocus) {
                e.preventDefault()
                initialFocus.current?.focus()
            }
        },
        onCloseAutoFocus: (e: Event) => {
            const el = opener.current
            opener.current = null
            if (el?.isConnected) {
                e.preventDefault()
                el.focus()
            }
        },
    }
}
