/**
 * Search everything — the full-text search dialog of the Documentation and
 * the User Guide, opened from the top bar, the sidebar, a hub's search box,
 * ⌘K / Ctrl+K or "/".
 *
 * Results come from `useDocsSearchIndex` — every page, section and FAQ
 * answer of both readers — grouped by page, best page first, with the other
 * sections that matched underneath. Choosing a result opens the page at
 * that section. Tabs narrow the results to one reader; with nothing typed
 * the dialog offers recent searches and the journeys people take most.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, FileText, BookOpen, CornerDownLeft, HelpCircle, Hash, Clock, X, Loader2, ArrowRight,
  type LucideIcon,
} from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { useBrand } from '@/store/branding'
import { interpolateBrand } from '@/lib/brandText'
import { cn } from '@/lib/utils'
import { recordEvent } from '@/services/telemetryService'
import { docKeyJourneys } from '@/components/docs/docsConfig'
import { topJobs } from '@/components/guide/guideConfig'
import { useReadingStore } from '@/components/docs/reading/readingStore'
import {
  useDocsSearchIndex,
  type DocsSearchArea,
  type DocsSearchResult,
  type SnippetSegment,
} from './useDocsSearchIndex'

type Scope = 'all' | DocsSearchArea

interface DocsSearchModalProps {
  open: boolean
  onClose: () => void
  /** The reader it opens from: its pages rank first among near-equals. */
  area: DocsSearchArea
  /** Text to start with, e.g. what was typed into a hub's search box. */
  initialQuery?: string
}

/** One page's hits (or one FAQ answer), best first. */
interface Group {
  key: string
  area: DocsSearchArea
  hits: DocsSearchResult[]
}

/** A row the keyboard can land on. */
interface Option {
  key: string
  href: string
  label: string
}

const AREA_LABEL: Record<DocsSearchArea, string> = { docs: 'Documentation', guide: 'User Guide' }
const AREA_ICON: Record<DocsSearchArea, LucideIcon> = { docs: FileText, guide: BookOpen }
const SCOPES: { id: Scope; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'guide', label: 'User Guide' },
  { id: 'docs', label: 'Documentation' },
]
const MAX_GROUPS = 40
const NO_RESULTS = { results: [] as DocsSearchResult[], partial: false }

function groupResults(results: DocsSearchResult[]): Group[] {
  const groups: Group[] = []
  for (const hit of results) {
    const key = hit.kind === 'faq' ? `faq:${hit.href}` : `${hit.area}:${hit.slug}`
    const last = groups[groups.length - 1]
    if (last?.key === key) last.hits.push(hit)
    else groups.push({ key, area: hit.area, hits: [hit] })
  }
  return groups
}

export function DocsSearchModal({ open, onClose, area, initialQuery = '' }: DocsSearchModalProps) {
  const brand = useBrand()
  const navigate = useNavigate()
  const { ready, searchMeta } = useDocsSearchIndex(open)
  const recentSearches = useReadingStore((s) => s.recentSearches)
  const rememberSearch = useReadingStore((s) => s.rememberSearch)
  const forgetSearch = useReadingStore((s) => s.forgetSearch)

  // The reader remounts this for every opening, so it starts from what the
  // opener passed in.
  const [query, setQuery] = useState(initialQuery)
  const [scope, setScope] = useState<Scope>('all')
  const [selection, setSelection] = useState({ index: 0, for: '' })
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const returnFocusRef = useRef<HTMLElement | null>(null)

  // Focus moves into the dialog when it opens and back where it was when it
  // closes. A layout effect, so a keystroke typed into a hub's search box
  // lands in this input, not behind it.
  useLayoutEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement as HTMLElement | null
    const input = inputRef.current
    if (input) {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    }
    return () => {
      const back = returnFocusRef.current
      if (back && document.contains(back)) back.focus()
    }
  }, [open])

  // Escape closes the dialog wherever focus is.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const q = query.trim()
  const { results, partial } = useMemo(
    () => (ready && q ? searchMeta(q, { area, limit: 200, perPage: 3 }) : NO_RESULTS),
    [ready, q, area, searchMeta],
  )
  const allGroups = useMemo(() => groupResults(results), [results])
  const counts = useMemo(
    () => ({
      all: allGroups.length,
      guide: allGroups.filter((g) => g.area === 'guide').length,
      docs: allGroups.filter((g) => g.area === 'docs').length,
    }),
    [allGroups],
  )
  const groups = useMemo(
    () => (scope === 'all' ? allGroups : allGroups.filter((g) => g.area === scope)).slice(0, MAX_GROUPS),
    [allGroups, scope],
  )

  // With nothing typed: recent searches, then the journeys people take most.
  const journeys = useMemo(
    () =>
      area === 'guide'
        ? topJobs.map((j) => ({ title: j.title, outcome: j.outcome, href: `/guide/${j.slug}`, icon: j.icon }))
        : docKeyJourneys.map((j) => ({ title: j.title, outcome: j.outcome, href: `/docs/${j.slug}`, icon: j.icon })),
    [area],
  )

  const options = useMemo<Option[]>(() => {
    if (q) {
      return groups.flatMap((g) =>
        g.hits.map((hit, i) => ({ key: `${g.key}#${i}`, href: hit.href, label: hit.heading ?? hit.title })),
      )
    }
    return [
      ...recentSearches.map((r) => ({ key: `recent:${r}`, href: '', label: r })),
      ...journeys.map((j) => ({ key: `journey:${j.href}`, href: j.href, label: j.title })),
    ]
  }, [q, groups, recentSearches, journeys])

  // The highlighted row belongs to the results it was chosen from.
  const resultsKey = `${q}\u0000${scope}`
  const selected = Math.max(0, Math.min(selection.for === resultsKey ? selection.index : 0, options.length - 1))
  const setSelected = (index: number) => setSelection({ index, for: resultsKey })
  useEffect(() => {
    const key = options[selected]?.key
    if (key) rowRefs.current.get(key)?.scrollIntoView({ block: 'nearest' })
  }, [selected, options])

  // A settled query that finds nothing is a gap in the docs: record it once.
  const reportedMissRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open || !ready || !q || results.length > 0) return
    const t = window.setTimeout(() => {
      if (reportedMissRef.current !== q.toLowerCase()) {
        reportedMissRef.current = q.toLowerCase()
        recordEvent('docs.search_miss', { query: q, source: 'docs-modal' })
      }
    }, 1100)
    return () => window.clearTimeout(t)
  }, [open, ready, q, results.length])

  const choose = (option: Option) => {
    if (option.key.startsWith('recent:')) {
      setQuery(option.label)
      inputRef.current?.focus()
      return
    }
    if (q) rememberSearch(q)
    onClose()
    navigate(option.href)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled]), [href]') ?? [],
      ).filter((el) => el.offsetParent !== null || el === inputRef.current)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
      return
    }
    if (options.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((selected + 1) % options.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((selected - 1 + options.length) % options.length)
    } else if (e.key === 'Enter' && e.target === inputRef.current) {
      e.preventDefault()
      const option = options[selected]
      if (option) choose(option)
    }
  }

  const rowProps = (option: Option, index: number) => ({
    id: `docs-search-opt-${index}`,
    role: 'option' as const,
    'aria-selected': index === selected,
    ref: (el: HTMLElement | null) => {
      if (el) rowRefs.current.set(option.key, el)
      else rowRefs.current.delete(option.key)
    },
    onMouseMove: () => {
      if (selected !== index) setSelected(index)
    },
    onClick: () => choose(option),
  })

  let optionIndex = 0
  const nextIndex = () => optionIndex++

  return (
    <>
      <Backdrop open={open} onClick={onClose} zClassName="z-[100]" className="bg-black/50 backdrop-blur-[2px]" />
      {open && (
        <div className="fixed inset-0 z-[100] flex justify-center pointer-events-none sm:px-4 sm:pt-[10vh]">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Search the documentation and user guide"
            onKeyDown={onKeyDown}
            className={cn(
              'pointer-events-auto flex flex-col w-full h-full sm:h-auto sm:max-w-2xl sm:max-h-[min(680px,80vh)]',
              'glass-panel sm:rounded-2xl overflow-hidden shadow-2xl border-glass-border sm:border',
              'animate-slide-up',
            )}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 h-14 border-b border-glass-border shrink-0">
              <Search className="w-5 h-5 text-accent-lineage shrink-0" aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the guide and the docs…"
                aria-label="Search the documentation and user guide"
                role="combobox"
                aria-expanded={options.length > 0}
                aria-controls="docs-search-results"
                aria-activedescendant={options.length > 0 ? `docs-search-opt-${selected}` : undefined}
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="go"
                className="flex-1 min-w-0 bg-transparent text-base text-ink placeholder:text-ink-muted focus:outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('')
                    inputRef.current?.focus()
                  }}
                  className="p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10"
                  aria-label="Clear the search"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="sm:hidden text-sm font-medium text-accent-lineage px-1"
              >
                Cancel
              </button>
              <kbd className="kbd hidden sm:inline-flex">Esc</kbd>
            </div>

            {/* Scope tabs */}
            {q && ready && (
              <div className="flex items-center gap-1 px-3 pt-2 pb-1 shrink-0" role="tablist" aria-label="Where to search">
                {SCOPES.map((s) => {
                  const count = counts[s.id]
                  const active = scope === s.id
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        setScope(s.id)
                        inputRef.current?.focus()
                      }}
                      className={cn(
                        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                        active
                          ? 'bg-accent-lineage/[0.12] text-accent-lineage'
                          : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
                      )}
                    >
                      {s.label}
                      <span
                        className={cn(
                          'min-w-[1.25rem] px-1 rounded-full text-[10px] tabular-nums',
                          active ? 'bg-accent-lineage/15' : 'bg-black/5 dark:bg-white/10',
                        )}
                      >
                        {count}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Results */}
            <div
              id="docs-search-results"
              role="listbox"
              aria-label="Search results"
              className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 pb-2 pt-1 overscroll-contain"
            >
              {!q ? (
                <div className="py-1">
                  {recentSearches.length > 0 && (
                    <>
                      <GroupLabel>Recent searches</GroupLabel>
                      {recentSearches.map((r) => {
                        const option = { key: `recent:${r}`, href: '', label: r }
                        const index = nextIndex()
                        return (
                          <div
                            key={option.key}
                            {...rowProps(option, index)}
                            className={cn(rowClass(index === selected), 'items-center py-2')}
                          >
                            <Clock className="w-4 h-4 text-ink-muted shrink-0" aria-hidden />
                            <span className="flex-1 min-w-0 truncate text-sm text-ink">{r}</span>
                            <button
                              type="button"
                              tabIndex={-1}
                              onClick={(e) => {
                                e.stopPropagation()
                                forgetSearch(r)
                              }}
                              className="p-1 rounded text-ink-muted hover:text-ink"
                              aria-label={`Remove “${r}” from recent searches`}
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )
                      })}
                    </>
                  )}
                  <GroupLabel>{area === 'guide' ? 'Popular in the User Guide' : 'Popular in the Documentation'}</GroupLabel>
                  {journeys.map((j) => {
                    const option = { key: `journey:${j.href}`, href: j.href, label: j.title }
                    const index = nextIndex()
                    const Icon = j.icon
                    return (
                      <div key={option.key} {...rowProps(option, index)} className={rowClass(index === selected)}>
                        <RowIcon icon={Icon} selected={index === selected} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-ink truncate">{interpolateBrand(j.title, brand)}</p>
                          <p className="text-xs text-ink-muted truncate">{interpolateBrand(j.outcome, brand)}</p>
                        </div>
                        <ArrowRight className={cn('w-4 h-4 mt-2 shrink-0 text-ink-muted', index !== selected && 'opacity-0')} aria-hidden />
                      </div>
                    )
                  })}
                </div>
              ) : !ready ? (
                <Hint>
                  <Loader2 className="w-5 h-5 mx-auto mb-2 animate-spin text-accent-lineage" aria-hidden />
                  Getting search ready…
                </Hint>
              ) : groups.length === 0 ? (
                <Hint>
                  <p className="text-ink font-medium">No results for “{q}”{scope !== 'all' && ` in the ${AREA_LABEL[scope]}`}</p>
                  <p className="mt-1">Check the spelling, or try fewer or different words.</p>
                  {scope !== 'all' && counts.all > 0 ? (
                    <button type="button" onClick={() => setScope('all')} className="btn btn-secondary btn-sm mt-4 inline-flex">
                      Show {counts.all} result{counts.all === 1 ? '' : 's'} from everywhere
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        onClose()
                        navigate(area === 'guide' ? '/guide#popular-questions' : '/docs/faq')
                      }}
                      className="btn btn-secondary btn-sm mt-4 inline-flex"
                    >
                      <HelpCircle className="w-4 h-4" /> Browse the FAQ
                    </button>
                  )}
                </Hint>
              ) : (
                <>
                  {partial && (
                    <p className="px-3 pt-2 pb-1 text-xs text-ink-muted">
                      No page has every one of those words — these match some of them.
                    </p>
                  )}
                  {groups.map((group) => {
                    const [best, ...more] = group.hits
                    const bestOption = { key: `${group.key}#0`, href: best.href, label: best.heading ?? best.title }
                    const bestIndex = nextIndex()
                    const isFaq = best.kind === 'faq'
                    const Icon = isFaq ? HelpCircle : AREA_ICON[group.area]
                    return (
                      <div key={group.key} role="group" aria-label={isFaq ? best.heading : best.title} className="py-0.5">
                        <div {...rowProps(bestOption, bestIndex)} className={rowClass(bestIndex === selected)}>
                          <RowIcon icon={Icon} selected={bestIndex === selected} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2 min-w-0">
                              <p className="text-sm font-semibold text-ink truncate">
                                {isFaq ? best.heading : best.title}
                              </p>
                              <span className="ml-auto text-2xs text-ink-muted shrink-0 hidden sm:inline">
                                {AREA_LABEL[group.area]} · {best.sectionLabel}
                              </span>
                            </div>
                            {!isFaq && best.heading && (
                              <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-ink-secondary min-w-0">
                                <Hash className="w-3 h-3 shrink-0 text-ink-muted" aria-hidden />
                                <span className="truncate">{best.heading}</span>
                              </p>
                            )}
                            {best.snippet.length > 0 && (
                              <p className="mt-0.5 text-xs text-ink-muted line-clamp-2">
                                <Snippet segments={best.snippet} />
                              </p>
                            )}
                          </div>
                          <CornerDownLeft
                            className={cn('w-3.5 h-3.5 mt-1 shrink-0 text-ink-muted', bestIndex !== selected && 'opacity-0')}
                            aria-hidden
                          />
                        </div>
                        {more.map((hit, i) => {
                          const option = { key: `${group.key}#${i + 1}`, href: hit.href, label: hit.heading ?? hit.title }
                          const index = nextIndex()
                          return (
                            <div
                              key={option.key}
                              {...rowProps(option, index)}
                              className={cn(rowClass(index === selected), 'ml-11 py-1.5 pl-3 border-l border-glass-border rounded-l-none')}
                            >
                              <div className="flex-1 min-w-0">
                                <p className="flex items-center gap-1 text-xs font-medium text-ink-secondary min-w-0">
                                  <Hash className="w-3 h-3 shrink-0 text-ink-muted" aria-hidden />
                                  <span className="truncate">{hit.heading ?? 'Introduction'}</span>
                                </p>
                                {hit.snippet.length > 0 && (
                                  <p className="text-xs text-ink-muted truncate">
                                    <Snippet segments={hit.snippet} />
                                  </p>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="hidden sm:flex px-4 py-2 border-t border-glass-border items-center gap-4 text-2xs text-ink-muted shrink-0">
              <span className="flex items-center gap-1">
                <kbd className="kbd">↑</kbd>
                <kbd className="kbd">↓</kbd> to move
              </span>
              <span className="flex items-center gap-1">
                <kbd className="kbd">
                  <CornerDownLeft className="w-3 h-3" />
                </kbd>
                to open
              </span>
              <span className="flex items-center gap-1">
                <kbd className="kbd">Esc</kbd> to close
              </span>
              {q && ready && counts.all > 0 && (
                <span className="ml-auto tabular-nums">
                  {counts[scope]} page{counts[scope] === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function rowClass(selected: boolean): string {
  return cn(
    'flex items-start gap-3 px-3 py-2.5 rounded-lg cursor-pointer scroll-my-2 transition-colors duration-100',
    selected ? 'bg-accent-lineage/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
  )
}

function RowIcon({ icon: Icon, selected }: { icon: LucideIcon; selected: boolean }) {
  return (
    <div
      className={cn(
        'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors',
        selected ? 'bg-accent-lineage/15 text-accent-lineage' : 'bg-black/5 dark:bg-white/5 text-ink-secondary',
      )}
    >
      <Icon className="w-4 h-4" aria-hidden />
    </div>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div role="presentation" className="px-3 pt-3 pb-1 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
      {children}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div role="presentation" className="px-6 py-12 text-center text-sm text-ink-muted">
      {children}
    </div>
  )
}

function Snippet({ segments }: { segments: SnippetSegment[] }) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.hit ? (
          <mark key={i} className="bg-accent-lineage/15 text-accent-lineage font-semibold rounded px-0.5">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  )
}
