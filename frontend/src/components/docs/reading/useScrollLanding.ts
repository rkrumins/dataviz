import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { useScrollContainer } from './ScrollContainerContext'

/** Where each history entry was scrolled to, for the Back and Forward buttons. */
const positions = new Map<string, number>()

const LANDED_CLASS = 'reader-landed'

function scrollTo(container: HTMLElement, top: number): void {
  container.scrollTop = top
}

/**
 * Where a page opens: at the section its link names (`#anchor`), briefly
 * highlighted so the eye finds it; where the reader left it when they come
 * back with Back or Forward; otherwise at the top.
 *
 * The articles scroll inside the reader's `<main>`, not the window, so the
 * browser's own scroll handling never applies — without this, a new page
 * opened wherever the previous one had been scrolled to, and a link to a
 * section opened the top of its page. `ready` is false while the page's
 * content is still loading; landing waits for it. `content` is what the
 * page renders: going from one article to the next keeps the previous one
 * on screen until the new one has loaded, so landing runs again when it
 * changes.
 */
export function useScrollLanding(ready: boolean, content?: unknown): void {
  const container = useScrollContainer()
  const { key, hash } = useLocation()
  const navigationType = useNavigationType()
  const keyRef = useRef(key)

  // Scroll events after a navigation belong to the new entry.
  useLayoutEffect(() => {
    keyRef.current = key
  }, [key])

  useEffect(() => {
    if (!container) return
    const remember = () => positions.set(keyRef.current, container.scrollTop)
    container.addEventListener('scroll', remember, { passive: true })
    return () => container.removeEventListener('scroll', remember)
  }, [container])

  useLayoutEffect(() => {
    if (!ready || !container) return
    const saved = navigationType === 'POP' ? positions.get(key) : undefined
    if (saved !== undefined) {
      scrollTo(container, saved)
      return
    }
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null
    if (!target) {
      scrollTo(container, 0)
      return
    }
    target.scrollIntoView({ block: 'start' })
    target.classList.remove(LANDED_CLASS)
    void target.offsetWidth // restart the highlight if it is still running
    target.classList.add(LANDED_CLASS)
    const t = window.setTimeout(() => target.classList.remove(LANDED_CLASS), 2400)
    return () => window.clearTimeout(t)
  }, [ready, container, key, hash, navigationType, content])
}
