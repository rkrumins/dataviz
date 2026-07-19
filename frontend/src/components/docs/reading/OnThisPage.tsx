import { useEffect, useRef, useState } from 'react'
import { List } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Heading } from './headings'
import { useScrollContainer } from './ScrollContainerContext'

/**
 * The "On this page" rail with scroll-spy. Highlights the heading you're
 * currently reading as you scroll the page's `<main>` container, and scrolls
 * smoothly (not a hard jump) when a heading is clicked.
 */
export function OnThisPage({ headings }: { headings: Heading[] }) {
  const container = useScrollContainer()
  const [activeId, setActiveId] = useState<string | null>(null)
  const clickLockRef = useRef(false)

  useEffect(() => {
    if (!container || headings.length === 0) return
    const ids = headings.map((h) => h.id)

    const pickActive = () => {
      if (clickLockRef.current) return
      // The heading whose top is closest to (but not far below) the reading
      // line near the top of the viewport.
      const line = container.getBoundingClientRect().top + 96
      let current = ids[0]
      for (const id of ids) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= line) current = id
        else break
      }
      // If scrolled to the very bottom, activate the last heading.
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 4) {
        current = ids[ids.length - 1]
      }
      setActiveId(current)
    }

    pickActive()
    container.addEventListener('scroll', pickActive, { passive: true })
    return () => container.removeEventListener('scroll', pickActive)
  }, [container, headings])

  const onClick = (e: React.MouseEvent, id: string) => {
    e.preventDefault()
    const el = document.getElementById(id)
    if (!el) return
    setActiveId(id)
    // Briefly ignore scroll-spy so the smooth scroll lands on the clicked item.
    clickLockRef.current = true
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    window.history.replaceState(null, '', `#${id}`)
    window.setTimeout(() => (clickLockRef.current = false), 600)
  }

  return (
    <aside className="hidden lg:block">
      <div className="sticky top-6">
        <div className="flex items-center gap-2 mb-3 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
          <List className="w-3.5 h-3.5" />
          On this page
        </div>
        <nav className="border-l border-glass-border">
          {headings.map((h) => {
            const active = h.id === activeId
            return (
              <a
                key={h.id}
                href={`#${h.id}`}
                onClick={(e) => onClick(e, h.id)}
                className={cn(
                  '-ml-px block border-l py-1 text-xs transition-colors',
                  h.level === 3 ? 'pl-6' : 'pl-3',
                  active
                    ? 'border-accent-lineage text-ink font-medium'
                    : 'border-transparent text-ink-muted hover:border-accent-lineage/40 hover:text-ink',
                )}
              >
                {h.text}
              </a>
            )
          })}
        </nav>
      </div>
    </aside>
  )
}
