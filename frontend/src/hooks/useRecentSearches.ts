/**
 * useRecentSearches — small localStorage-backed MRU list of Explorer
 * searches. Powers the suggestions panel under the search input.
 *
 * Scope is intentionally per-browser rather than per-user/server-side:
 * recent-search memory is a navigation convenience, not account data.
 */
import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'nexus.explorer.recentSearches'
const MAX_ENTRIES = 5

function read(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((s): s is string => typeof s === 'string').slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
}

function write(values: string[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(values))
  } catch {
    // Ignore quota errors — the feature degrades silently.
  }
}

export function useRecentSearches() {
  const [recents, setRecents] = useState<string[]>(() => read())

  // Sync when the storage changes from another tab.
  useEffect(() => {
    function handler(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setRecents(read())
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  /** Record a query. Trimmed, deduped (case-insensitive), newest first. */
  const record = useCallback((query: string) => {
    const trimmed = query.trim()
    if (!trimmed) return
    setRecents(prev => {
      const filtered = prev.filter(q => q.toLowerCase() !== trimmed.toLowerCase())
      const next = [trimmed, ...filtered].slice(0, MAX_ENTRIES)
      write(next)
      return next
    })
  }, [])

  const remove = useCallback((query: string) => {
    setRecents(prev => {
      const next = prev.filter(q => q !== query)
      write(next)
      return next
    })
  }, [])

  const clear = useCallback(() => {
    write([])
    setRecents([])
  }, [])

  return { recents, record, remove, clear }
}
