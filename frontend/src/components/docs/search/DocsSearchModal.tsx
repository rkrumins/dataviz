/**
 * DocsSearchModal — a docs-scoped ⌘K-style full-text search palette for the
 * in-app Documentation + User Guide. Separate from the global CommandPalette
 * (which searches app entities); this one searches the Markdown content.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, FileText, BookOpen, CornerDownLeft } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { useBrand } from '@/store/branding'
import { interpolateBrand } from '@/lib/brandText'
import { cn } from '@/lib/utils'
import { recordEvent } from '@/services/telemetryService'
import {
  useDocsSearchIndex,
  type DocsSearchResult,
  type SnippetSegment,
} from './useDocsSearchIndex'

interface DocsSearchModalProps {
  open: boolean
  onClose: () => void
}

const AREA_LABEL: Record<DocsSearchResult['area'], string> = {
  docs: 'Documentation',
  guide: 'User Guide',
}

const AREA_ICON = {
  docs: FileText,
  guide: BookOpen,
} as const

export function DocsSearchModal({ open, onClose }: DocsSearchModalProps) {
  const brand = useBrand()
  const navigate = useNavigate()
  const { ready, search } = useDocsSearchIndex()

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef<(HTMLLIElement | null)[]>([])

  // Ranked results, grouped for display but kept as one flat list (docs
  // first, then guide) so keyboard navigation maps 1:1 to what's on screen.
  const results = useMemo<DocsSearchResult[]>(() => {
    if (!ready || !query.trim()) return []
    const ranked = search(query)
    const docs = ranked.filter((r) => r.area === 'docs')
    const guide = ranked.filter((r) => r.area === 'guide')
    return [...docs, ...guide]
  }, [ready, query, search])

  const groups = useMemo(() => {
    const docs = results.filter((r) => r.area === 'docs')
    const guide = results.filter((r) => r.area === 'guide')
    return [
      { area: 'docs' as const, items: docs },
      { area: 'guide' as const, items: guide },
    ].filter((g) => g.items.length > 0)
  }, [results])

  // Reset selection whenever the result set changes.
  useEffect(() => {
    setSelected(0)
  }, [results])

  // Autofocus the input each time the modal opens.
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  // Record a "content gap" when a settled query finds nothing — debounced so we
  // capture the query the user actually meant, not every keystroke, and only
  // once per distinct miss.
  const reportedMissRef = useRef<string | null>(null)
  useEffect(() => {
    const q = query.trim()
    if (!ready || !q || results.length > 0) return
    const t = window.setTimeout(() => {
      if (reportedMissRef.current !== q.toLowerCase()) {
        reportedMissRef.current = q.toLowerCase()
        recordEvent('docs.search_miss', { query: q, source: 'docs-modal' })
      }
    }, 1100)
    return () => window.clearTimeout(t)
  }, [ready, query, results.length])

  // Reset the query when the modal closes.
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  // Keep the selected row visible.
  useEffect(() => {
    rowRefs.current[selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const go = (result: DocsSearchResult) => {
    navigate(`/${result.area}/${result.slug}`)
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => (i + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => (i - 1 + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = results[selected]
      if (hit) go(hit)
    }
  }

  if (!open) return null

  const hasQuery = query.trim().length > 0

  return (
    <>
      <Backdrop open onClick={onClose} zClassName="z-[100]" className="bg-black/50" />
      <div className="fixed inset-0 z-[100] pointer-events-none">
        <div className="absolute inset-x-0 top-[12%] flex justify-center px-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search documentation and user guide"
            className={cn(
              'relative w-full max-w-2xl pointer-events-auto',
              'glass-panel rounded-2xl overflow-hidden shadow-2xl',
              'border border-accent-lineage/40 animate-slide-up',
            )}
            onKeyDown={handleKeyDown}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-glass-border">
              <Search className="w-5 h-5 text-accent-lineage shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the docs & user guide…"
                aria-label="Search query"
                aria-controls="docs-search-results"
                aria-activedescendant={
                  results.length > 0 ? `docs-search-opt-${selected}` : undefined
                }
                className="flex-1 bg-transparent text-base text-ink placeholder:text-ink-muted focus:outline-none"
              />
              <kbd className="kbd">ESC</kbd>
            </div>

            {/* Results */}
            <ul
              id="docs-search-results"
              role="listbox"
              aria-label="Search results"
              className="max-h-[460px] overflow-y-auto custom-scrollbar p-2"
            >
              {!hasQuery ? (
                <EmptyHint>Type to search the docs &amp; user guide…</EmptyHint>
              ) : !ready ? (
                <EmptyHint>Building search index…</EmptyHint>
              ) : results.length === 0 ? (
                <EmptyHint>
                  No results for &ldquo;<span className="text-ink">{query}</span>&rdquo;.
                </EmptyHint>
              ) : (
                groups.map((group) => {
                  const AreaIcon = AREA_ICON[group.area]
                  return (
                    <li key={group.area} role="presentation">
                      <div className="px-2 pt-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                        {AREA_LABEL[group.area]}
                      </div>
                      <ul role="presentation">
                        {group.items.map((result) => {
                          const idx = results.indexOf(result)
                          const isSelected = idx === selected
                          return (
                            <li
                              key={`${result.area}-${result.slug}`}
                              id={`docs-search-opt-${idx}`}
                              ref={(el) => {
                                rowRefs.current[idx] = el
                              }}
                              role="option"
                              aria-selected={isSelected}
                              onMouseEnter={() => setSelected(idx)}
                              onClick={() => go(result)}
                              className={cn(
                                'flex items-start gap-3 px-3 py-2.5 rounded-lg cursor-pointer scroll-mt-2',
                                'transition-colors duration-100',
                                isSelected && 'bg-accent-lineage/10',
                              )}
                            >
                              <div
                                className={cn(
                                  'mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                                  isSelected
                                    ? 'bg-accent-lineage/15 text-accent-lineage'
                                    : 'bg-black/5 dark:bg-white/5 text-ink-secondary',
                                )}
                              >
                                <AreaIcon className="w-4 h-4" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="text-sm font-medium text-ink truncate">
                                    {interpolateBrand(result.title, brand)}
                                  </p>
                                  <span className="text-2xs text-ink-muted shrink-0">
                                    {result.sectionLabel}
                                  </span>
                                </div>
                                <p className="mt-0.5 text-xs text-ink-secondary line-clamp-2">
                                  <Snippet segments={result.snippet} brand={brand} />
                                </p>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    </li>
                  )
                })
              )}
            </ul>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-glass-border flex items-center gap-4 text-2xs text-ink-muted">
              <span className="flex items-center gap-1">
                <kbd className="kbd">↑↓</kbd> Navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="kbd">
                  <CornerDownLeft className="w-3 h-3" />
                </kbd>
                Open
              </span>
              <span className="flex items-center gap-1">
                <kbd className="kbd">esc</kbd> Close
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <li role="presentation" className="py-10 text-center text-sm text-ink-muted">
      {children}
    </li>
  )
}

function Snippet({
  segments,
  brand,
}: {
  segments: SnippetSegment[]
  brand: ReturnType<typeof useBrand>
}) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.hit ? (
          <mark
            key={i}
            className="bg-accent-lineage/15 text-accent-lineage font-semibold rounded px-0.5"
          >
            {interpolateBrand(seg.text, brand)}
          </mark>
        ) : (
          <span key={i}>{interpolateBrand(seg.text, brand)}</span>
        ),
      )}
    </>
  )
}
