/**
 * The header search box's anchored popovers — the Look in and Match lists
 * and the active search's card — share one way of opening, placing and
 * closing, and this is it.
 *
 * The surface is portalled to the body and placed under its trigger: the
 * header creates a stacking context (it has a backdrop-filter), so a list
 * rendered inline would be layered under the canvas. No AnimatePresence at
 * the call site: the surface unmounts instantly on close so an interrupted
 * exit can never strand an invisible click-blocker over the toolbar.
 *
 * Focus moves into the surface on open — to the first match of the first of
 * `focusFirst` that matches anything, its first button by default — because
 * it is portalled to the end of `document.body` and a keyboard user would
 * otherwise reach it only by tabbing past the whole app. It goes back to the
 * trigger when the surface closes, so it is never simply dropped.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** What a click can move focus to on its own. */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'

const FIRST_BUTTON = ['button'] as const

export function useAnchoredPopover(
  focusFirst: readonly string[] = FIRST_BUTTON,
) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setAnchor({ top: rect.bottom + 6, left: rect.left })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  const close = useCallback(() => { setOpen(false) }, [])
  const toggle = useCallback(() => { setOpen((was) => !was) }, [])

  // Whether this popover currently owns the page's focus. It decides who
  // gets focus back when the popover closes, and it is the reason the two
  // effects below can be the only places that touch a ref.
  const holdsFocusRef = useRef(false)

  // Focus the first row once per opening. `anchor` is measured in a layout
  // effect, so the list is not yet in the DOM on the render that flips
  // `open`; the flag also keeps a later anchor update (resize, scroll)
  // from stealing focus back from wherever the user has since moved it.
  useEffect(() => {
    if (!open || holdsFocusRef.current) return
    const list = listRef.current
    let first: HTMLElement | null = null
    for (const selector of focusFirst) {
      first = list?.querySelector<HTMLElement>(selector) ?? null
      if (first) break
    }
    if (!first) return
    holdsFocusRef.current = true
    first.focus()
  }, [open, anchor, focusFirst])

  // Closing while still holding focus — Escape, a chosen row, a click on
  // inert chrome — would otherwise drop it on <body>, and the list is
  // portalled to the end of the document, so there is nothing sensible
  // after it to tab to. A click on another control cleared the flag
  // already: the user went there on purpose.
  useEffect(() => {
    if (open || !holdsFocusRef.current) return
    holdsFocusRef.current = false
    triggerRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (triggerRef.current?.contains(target)) return
      if (listRef.current?.contains(target)) return
      // Clicking a control means going there — taking focus back would
      // fight the user. Clicking inert chrome leaves focus nowhere, so
      // the trigger keeps its claim on it.
      if (target.closest?.(FOCUSABLE)) holdsFocusRef.current = false
      close()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  return { open, close, toggle, anchor, triggerRef, listRef }
}
