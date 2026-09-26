/**
 * The keys a group of `role="radio"` buttons owes a keyboard user: the arrow keys move the choice
 * to the next or previous enabled option, wrapping round, and focus follows. Spread onto the
 * `role="radiogroup"` element; give the chosen option `tabIndex={0}` and the others `-1`, so Tab
 * enters the group at the choice and leaves it in one step.
 */
import type { KeyboardEvent } from 'react'

export function onRadioGroupKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown'
  if (!forward && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)')]
  if (radios.length < 2) return
  e.preventDefault()
  const at = radios.indexOf(document.activeElement as HTMLElement)
  const next = radios[(Math.max(at, 0) + (forward ? 1 : radios.length - 1)) % radios.length]
  next.focus()
  next.click()
}
