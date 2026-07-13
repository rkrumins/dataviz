import { useEffect, useRef } from 'react'

/**
 * Keyboard behaviour every dialog owes the user: Escape closes it, Tab stays inside it,
 * and focus goes back where it came from afterwards.
 *
 * These modals are hand-rolled rather than Radix `Dialog` — deliberately, because a Radix
 * MODAL dialog that unmounts while open leaves `body { pointer-events: none }` behind and
 * freezes the whole app (a bug this codebase has been bitten by three times). Hand-rolling
 * dodges that, but it also means none of the behaviour Radix gives you for free arrives on
 * its own. Without this hook a keyboard user cannot dismiss the dialog, and Tab walks off
 * into the page behind it — which for a dialog that is about to REWRITE A GRAPH is not a
 * cosmetic problem.
 *
 * Returns the ref to spread onto the dialog's own element.
 */
export function useModalA11y(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const restoreTo = document.activeElement as HTMLElement | null

    // Focus the panel itself, not its first control: a destructive dialog should not open
    // with "Restore" pre-armed under the Enter key.
    ref.current?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !ref.current) return
      const focusable = ref.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === ref.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      restoreTo?.focus?.()
    }
  }, [open, onClose])

  return ref
}
