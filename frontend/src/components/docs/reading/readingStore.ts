/**
 * What this reader has read, kept in their browser: the pages they finished,
 * the page they were last on, the path they are following in each area and
 * their recent searches. It drives "Step 2 of 6", the sidebar's checkmarks
 * and the hubs' "Continue where you left off". Nothing here leaves the
 * browser, and losing it costs nothing but those conveniences.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { readKey, type ReaderArea } from './paths'

const RECENT_SEARCHES = 5

interface ReadingState {
  /** Pages read to the end, keyed `area:slug`, with when. */
  read: Record<string, number>
  /** The page last opened in each area. */
  last: Partial<Record<ReaderArea, { slug: string; at: number }>>
  /** The path being followed in each area — a persona id. */
  activePath: Partial<Record<ReaderArea, string>>
  /** Searches that took the reader somewhere, newest first. */
  recentSearches: string[]
  visit: (area: ReaderArea, slug: string) => void
  markRead: (area: ReaderArea, slug: string) => void
  followPath: (area: ReaderArea, id: string) => void
  leavePath: (area: ReaderArea) => void
  /** Forget which of `slugs` were read — "start the path again". */
  forget: (area: ReaderArea, slugs: string[]) => void
  rememberSearch: (query: string) => void
  forgetSearch: (query: string) => void
}

export const useReadingStore = create<ReadingState>()(
  persist(
    (set) => ({
      read: {},
      last: {},
      activePath: {},
      recentSearches: [],
      visit: (area, slug) => set((s) => ({ last: { ...s.last, [area]: { slug, at: Date.now() } } })),
      markRead: (area, slug) =>
        set((s) => (s.read[readKey(area, slug)] ? s : { read: { ...s.read, [readKey(area, slug)]: Date.now() } })),
      followPath: (area, id) => set((s) => ({ activePath: { ...s.activePath, [area]: id } })),
      leavePath: (area) =>
        set((s) => {
          const activePath = { ...s.activePath }
          delete activePath[area]
          return { activePath }
        }),
      forget: (area, slugs) =>
        set((s) => {
          const read = { ...s.read }
          for (const slug of slugs) delete read[readKey(area, slug)]
          return { read }
        }),
      rememberSearch: (query) =>
        set((s) => {
          const q = query.trim()
          if (!q) return s
          const rest = s.recentSearches.filter((r) => r.toLowerCase() !== q.toLowerCase())
          return { recentSearches: [q, ...rest].slice(0, RECENT_SEARCHES) }
        }),
      forgetSearch: (query) => set((s) => ({ recentSearches: s.recentSearches.filter((r) => r !== query) })),
    }),
    {
      name: 'nexus-docs-reading',
      version: 1,
      partialize: ({ read, last, activePath, recentSearches }) => ({ read, last, activePath, recentSearches }),
    },
  ),
)

