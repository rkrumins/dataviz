import { useEffect, useRef } from 'react'
import { useScrollContainer } from './ScrollContainerContext'
import { useReadingStore } from './readingStore'
import type { ReaderArea } from './paths'

/** How long a page must be open before reaching its end counts as reading it. */
const MIN_READ_MS = 4000

/**
 * Remember the page as the last one opened, and mark it read once its end
 * has been on screen — after a few seconds, so paging through quickly
 * doesn't count.
 */
export function useReadTracking(area: ReaderArea, slug: string | undefined, ready: boolean) {
  const container = useScrollContainer()
  const visit = useReadingStore((s) => s.visit)
  const markRead = useReadingStore((s) => s.markRead)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (slug && ready) visit(area, slug)
  }, [area, slug, ready, visit])

  useEffect(() => {
    const end = endRef.current
    if (!slug || !ready || !end || typeof IntersectionObserver === 'undefined') return
    const opened = Date.now()
    let timer: number | undefined
    const observer = new IntersectionObserver(
      ([entry]) => {
        window.clearTimeout(timer)
        if (!entry?.isIntersecting) return
        timer = window.setTimeout(() => markRead(area, slug), Math.max(0, MIN_READ_MS - (Date.now() - opened)))
      },
      { root: container },
    )
    observer.observe(end)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [area, slug, ready, container, markRead])

  return endRef
}
