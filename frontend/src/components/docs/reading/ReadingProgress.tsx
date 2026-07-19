import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useScrollContainer } from './ScrollContainerContext'

/**
 * A thin accent bar that tracks how far through the article you've scrolled.
 * Keys off the page's `<main>` scroll container (provided via context) rather
 * than the window, and resets on route change.
 */
export function ReadingProgress() {
  const el = useScrollContainer()
  const location = useLocation()
  const [pct, setPct] = useState(0)

  useEffect(() => {
    if (!el) return
    const update = () => {
      const max = el.scrollHeight - el.clientHeight
      setPct(max > 0 ? Math.min(100, (el.scrollTop / max) * 100) : 0)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [el, location.pathname])

  return (
    <div className="relative h-0.5 shrink-0 bg-transparent" aria-hidden>
      <div
        className="h-full bg-gradient-to-r from-accent-lineage to-violet-500 transition-[width] duration-150 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
