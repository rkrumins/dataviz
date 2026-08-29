/**
 * useRecentSearches — small localStorage-backed MRU list of Explorer
 * searches. Powers the suggestions panel under the search input.
 *
 * Scope is intentionally per-browser rather than per-user/server-side:
 * recent-search memory is a navigation convenience, not account data.
 */
import { useCallback, useEffect, useState } from 'react'

export const EXPLORER_RECENTS_KEY = 'nexus.explorer.recentSearches'
const MAX_ENTRIES = 5

function read(storageKey: string): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((s): s is string => typeof s === 'string').slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
}

function write(storageKey: string, values: string[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(values))
  } catch {
    // Ignore quota errors — the feature degrades silently.
  }
}

export function useRecentSearches(storageKey: string = EXPLORER_RECENTS_KEY) {
  const [recents, setRecents] = useState<string[]>(() => read(storageKey))

  // Sync when the storage changes from another tab.
  useEffect(() => {
    function handler(e: StorageEvent) {
      if (e.key === storageKey) setRecents(read(storageKey))
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [storageKey])

  /** Record a query. Trimmed, deduped (case-insensitive), newest first. */
  const record = useCallback((query: string) => {
    const trimmed = query.trim()
    if (!trimmed) return
    setRecents(prev => {
      const filtered = prev.filter(q => q.toLowerCase() !== trimmed.toLowerCase())
      const next = [trimmed, ...filtered].slice(0, MAX_ENTRIES)
      write(storageKey, next)
      return next
    })
  }, [storageKey])

  const remove = useCallback((query: string) => {
    setRecents(prev => {
      const next = prev.filter(q => q !== query)
      write(storageKey, next)
      return next
    })
  }, [storageKey])

  const clear = useCallback(() => {
    write(storageKey, [])
    setRecents([])
  }, [storageKey])

  return { recents, record, remove, clear }
}
