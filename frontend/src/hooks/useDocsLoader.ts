import { useState, useEffect } from 'react'
import type { DocEntry } from '@/components/docs/docsConfig'

// Module-level cache — docs loaded once per session
const cache = new Map<string, string>()

export function useDocsLoader(entry: DocEntry | undefined) {
  const [content, setContent] = useState<string | null>(
    entry ? cache.get(entry.slug) ?? null : null,
  )
  const [isLoading, setIsLoading] = useState(!content && !!entry)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!entry) {
      setContent(null)
      setIsLoading(false)
      setError('Document not found')
      return
    }

    const cached = cache.get(entry.slug)
    if (cached) {
      setContent(cached)
      setIsLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    entry
      .importFn()
      .then((mod) => {
        if (cancelled) return
        const text = mod.default
        cache.set(entry.slug, text)
        setContent(text)
        setIsLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message ?? 'Failed to load document')
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [entry])

  return { content, isLoading, error }
}
