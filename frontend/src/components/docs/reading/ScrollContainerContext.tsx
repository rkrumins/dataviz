import { createContext, useContext } from 'react'

/**
 * The docs and guide articles scroll inside their page's `<main>` element, not
 * the window. Reading aids that key off scroll position — the progress bar and
 * the "On this page" scroll-spy — need a handle on that element. The page
 * provides it here; consumers read it with `useScrollContainer()`.
 */
export const ScrollContainerContext = createContext<HTMLElement | null>(null)

export function useScrollContainer(): HTMLElement | null {
  return useContext(ScrollContainerContext)
}
