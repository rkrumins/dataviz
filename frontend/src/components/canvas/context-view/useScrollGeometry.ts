/**
 * The canvas scroller's horizontal geometry, re-read whenever it can have
 * changed. Two surfaces need the same three numbers — the edge fades ("is
 * there more this way?") and the layer strip's position rail ("how much of
 * the run is on screen, and where?") — so they read one subscription
 * rather than each growing a scroll listener of its own.
 *
 * Read through `useSyncExternalStore`, the house pattern for re-rendering
 * on scroll: the numbers live in the DOM, never in state, so nothing is
 * ever set from an effect. The snapshot is a string because
 * `useSyncExternalStore` compares by identity and a fresh object every
 * call would loop forever.
 */
import { useCallback, useMemo, useSyncExternalStore, type RefObject } from 'react'

export interface ScrollGeometry {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}

const EMPTY = '0|0|0'

const encode = (el: HTMLElement | null) =>
  el ? `${Math.round(el.scrollLeft)}|${Math.round(el.scrollWidth)}|${Math.round(el.clientWidth)}` : EMPTY

export function useScrollGeometry(ref: RefObject<HTMLElement | null>): ScrollGeometry {
  const subscribe = useCallback((onChange: () => void) => {
    const el = ref.current
    if (!el) return () => {}
    el.addEventListener('scroll', onChange, { passive: true })
    // The container's own box changes on a window resize; the scrollable
    // WIDTH changes when a COLUMN's does — collapsed, expanded, dragged
    // wider — and no box pinned to the container reports that: the
    // scroller and the columns wrapper both stay 100% wide while the
    // columns overflow them. At scrollLeft 0 nothing needs clamping
    // either, so no scroll event fires. So watch the columns themselves.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onChange) : null
    ro?.observe(el)
    for (const child of Array.from(el.children)) ro?.observe(child)
    const columns = () => el.querySelectorAll<HTMLElement>('[data-layer-id]')
    const watchColumns = () => { for (const col of columns()) ro?.observe(col) }
    watchColumns()
    // Columns come and go — a layer added, a view switched — and this
    // subscription outlives them, so re-observe when the wrapper's
    // children change.
    const mo = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => { watchColumns(); onChange() })
      : null
    mo?.observe(columns()[0]?.parentElement ?? el, { childList: true })
    return () => {
      el.removeEventListener('scroll', onChange)
      ro?.disconnect()
      mo?.disconnect()
    }
  }, [ref])

  const snapshot = useSyncExternalStore(subscribe, () => encode(ref.current), () => EMPTY)

  return useMemo(() => {
    const [scrollLeft, scrollWidth, clientWidth] = snapshot.split('|').map(Number)
    return { scrollLeft, scrollWidth, clientWidth }
  }, [snapshot])
}
