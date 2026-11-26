/**
 * Of some columns, the ones the reader cannot see right now: scrolled out of the canvas's view.
 * "In view" is the Layer Strip's rule — a meaningful share of the column on screen, 40% of its
 * width capped at 160px. Measured a frame after a scroll or a resize, and only while there is a
 * column to watch: no listener, and no measuring, for none.
 */
import { useEffect, useState, type RefObject } from 'react'

const NONE: ReadonlySet<string> = new Set()

export function useColumnsOutOfSight(scrollRef: RefObject<HTMLElement | null>, ids: readonly string[]): ReadonlySet<string> {
  const [out, setOut] = useState<ReadonlySet<string>>(NONE)
  const key = ids.join('\u0000')
  useEffect(() => {
    const el = scrollRef.current
    const watched = key ? key.split('\u0000') : []
    let raf: number | null = null
    const measure = () => {
      raf = null
      const next = new Set<string>()
      if (el) {
        const box = el.getBoundingClientRect()
        for (const id of watched) {
          const col = el.querySelector(`[data-layer-id="${CSS.escape(id)}"]`)
          if (!col) continue
          const r = col.getBoundingClientRect()
          const overlap = Math.min(r.right, box.right) - Math.max(r.left, box.left)
          if (overlap <= Math.min(r.width * 0.4, 160)) next.add(id)
        }
      }
      setOut((prev) => (prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next))
    }
    const schedule = () => { if (raf === null) raf = requestAnimationFrame(measure) }
    schedule()
    if (!el || watched.length === 0) return () => { if (raf !== null) cancelAnimationFrame(raf) }
    el.addEventListener('scroll', schedule, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', schedule)
      ro?.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [scrollRef, key])
  return out
}
