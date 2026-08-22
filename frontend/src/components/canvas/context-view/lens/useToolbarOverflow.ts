/**
 * A toolbar that never overflows (2026-08-22).
 *
 * The Lens header carries six segmented groups — Next · Walk · Steps ·
 * Density · Wires · direction — plus help, share, a filter box and the
 * close button: ~1,700px of controls. Wrapping put the cluster on a
 * second row that still ran past the dialog's edge and was clipped
 * ("Filter connections…" cut in half); shrinking it made nothing
 * legible. The premium answer is the one every mature toolbar uses: ONE
 * row, and the groups the reader reaches for least collapse — in
 * priority order — into a **Display** menu the moment there is no room,
 * coming back the moment there is.
 *
 * `fitToolbar` is the pure decision; `useToolbarOverflow` measures the
 * row and its children and re-decides on every resize. Widths are read
 * from the DOM, never guessed; a group that is currently collapsed keeps
 * the width it had when it was last inline. An unmeasured row (jsdom, a
 * first frame before layout) keeps everything inline — the toolbar only
 * ever collapses on evidence.
 */
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** Room the Display button itself needs once anything has collapsed. */
export const DISPLAY_MENU_W = 112

/**
 * Which groups collapse, least important first, until what is left fits
 * in `free`. `order` is most-important-first. Returns the collapsed ids
 * in collapse order; an unknown width (`undefined`/0) counts as nothing,
 * and a `free` of 0 or less means "unmeasured — collapse nothing".
 */
export function fitToolbar(
  order: readonly string[],
  widthOf: (id: string) => number | undefined,
  free: number,
  gap: number,
): string[] {
  if (free <= 0) return []
  const w = (id: string) => widthOf(id) ?? 0
  let need = order.reduce((acc, id) => acc + w(id) + gap, 0)
  if (need <= free) return []
  const room = free - DISPLAY_MENU_W - gap
  const collapsed: string[] = []
  for (let i = order.length - 1; i >= 0; i--) {
    if (need <= room) break
    const id = order[i]
    need -= w(id) + gap
    collapsed.push(id)
  }
  return collapsed
}

export interface ToolbarOverflow {
  /** Groups currently folded into the Display menu, in collapse order. */
  collapsed: ReadonlySet<string>
  /** Ref callback for each group's root element — measures it. */
  registerGroup: (id: string) => (el: HTMLElement | null) => void
}

/**
 * @param rowRef   the toolbar row; every child that is NOT a registered
 *                 group (or the Display button) counts as fixed width.
 * @param order    group ids, most important first.
 * @param gap      the row's gap in px.
 */
export function useToolbarOverflow(
  rowRef: RefObject<HTMLElement | null>,
  order: readonly string[],
  gap = 8,
): ToolbarOverflow {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const widths = useRef(new Map<string, number>())
  const elements = useRef(new Map<string, HTMLElement>())

  const registerGroup = useCallback((id: string) => (el: HTMLElement | null) => {
    if (el) elements.current.set(id, el)
    else elements.current.delete(id)
  }, [])

  const measure = useCallback(() => {
    const row = rowRef.current
    if (!row) return
    const rowW = row.getBoundingClientRect().width
    if (rowW <= 0) return
    // Groups on screen refresh their width; collapsed ones keep the last.
    for (const [id, el] of elements.current) {
      const w = el.getBoundingClientRect().width
      if (w > 0) widths.current.set(id, w)
    }
    // Everything in the row that is not a group and not the menu is fixed.
    let fixed = 0
    let children = 0
    for (const child of Array.from(row.children) as HTMLElement[]) {
      if (child.dataset.toolbarGroup !== undefined || child.dataset.toolbarMenu !== undefined) continue
      if (child.classList.contains('absolute')) continue       // anchored to the dialog, not in the row's flow
      fixed += child.getBoundingClientRect().width
      children += 1
    }
    const free = rowW - fixed - children * gap
    const next = fitToolbar(order, id => widths.current.get(id), free, gap)
    setCollapsed(prev => {
      if (prev.size === next.length && next.every(id => prev.has(id))) return prev
      return new Set(next)
    })
  }, [rowRef, order, gap])

  useLayoutEffect(() => {
    measure()
    const row = rowRef.current
    if (!row || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(row)
    return () => ro.disconnect()
  }, [measure, rowRef])

  return { collapsed, registerGroup }
}
