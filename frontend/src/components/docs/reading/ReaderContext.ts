import { createContext, useContext } from 'react'
import type { ReaderArea } from './paths'

/**
 * What the reader frame offers the pages inside it: which reader this is,
 * and a way to open its search dialog — with text already typed, when a hub's
 * search box or the sidebar hands its query over.
 */
export interface ReaderContextValue {
  area: ReaderArea
  openSearch: (query?: string) => void
}

export const ReaderContext = createContext<ReaderContextValue | null>(null)

export function useReader(): ReaderContextValue | null {
  return useContext(ReaderContext)
}
