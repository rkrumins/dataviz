/**
 * A long list inside the drawer, virtualised against the drawer's own scrolling body — so a
 * selection holding hundreds of properties, or thousands of entities, paints only what is on
 * screen. Short lists are drawn whole: below `VIRTUAL_ABOVE` rows, a virtualiser costs more than
 * it saves and makes the list harder to read in a test.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useDrawerScrollElement } from '../../shell/drawerScroll'

export const VIRTUAL_ABOVE = 100

export function useDrawerList(count: number, estimate: number, getKey: (index: number) => string) {
  const scrollEl = useDrawerScrollElement()
  const listRef = useRef<HTMLDivElement>(null)
  const virtual = count > VIRTUAL_ABOVE && !!scrollEl
  // Where the list starts inside the scrolling body — re-read whenever what sits above it (or
  // the list itself) changes size. The observer reports once as it starts.
  const [margin, setMargin] = useState(0)
  useLayoutEffect(() => {
    const el = listRef.current
    if (!virtual || !el || !scrollEl) return
    const measure = () =>
      setMargin(Math.round(el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop))
    const observer = new ResizeObserver(measure)
    for (const child of Array.from(scrollEl.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [virtual, scrollEl])
  const virtualizer = useVirtualizer({
    count: virtual ? count : 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => estimate,
    scrollMargin: margin,
    overscan: 8,
    getItemKey: getKey,
  })
  return { listRef, virtual, virtualizer }
}
