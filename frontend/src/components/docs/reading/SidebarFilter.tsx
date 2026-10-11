import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { Search, X, Hash, HelpCircle, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatShortcut } from '@/lib/platform'
import { prefetchSearchIndex } from '@/components/docs/search/useDocsSearchIndex'
import { useReader } from './ReaderContext'
import type { FilterLink, SidebarFilter } from './useSidebarFilter'

/** The filter box and the Search everything button under it. */
export function SidebarFilterInput({ filter }: { filter: SidebarFilter }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const reader = useReader()
  const active = filter.links[filter.activeIndex]
  return (
    <>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          placeholder="Filter pages"
          aria-label="Filter the pages in this list"
          value={filter.query}
          onChange={(e) => filter.setQuery(e.target.value)}
          onKeyDown={filter.onKeyDown}
          onFocus={prefetchSearchIndex}
          role="combobox"
          aria-expanded={filter.filtering}
          aria-controls={filter.listId}
          aria-activedescendant={filter.filtering && active ? `${filter.listId}-${filter.activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          className="input pl-9 pr-8 h-9 text-sm"
        />
        {filter.query && (
          <button
            type="button"
            onClick={() => {
              filter.setQuery('')
              inputRef.current?.focus()
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-ink-muted hover:text-ink"
            aria-label="Clear the filter"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {reader && (
        <button
          type="button"
          onClick={() => reader.openSearch(filter.query)}
          onMouseEnter={prefetchSearchIndex}
          className="mt-2 w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs text-ink-muted hover:text-ink bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border hover:border-accent-lineage/30 transition-colors"
        >
          <span className="flex items-center gap-2">
            <Search className="w-3.5 h-3.5" /> Search everything
          </span>
          <kbd className="inline-flex [@media(hover:none)]:hidden items-center rounded border border-glass-border bg-canvas px-1.5 text-[10px]">
            {formatShortcut('mod+k')}
          </kbd>
        </button>
      )}
    </>
  )
}

/** The filtered list, in place of the table of contents. */
export function SidebarFilterResults({ filter }: { filter: SidebarFilter }) {
  const linkProps = (link: FilterLink) => {
    const i = filter.links.indexOf(link)
    return {
      id: `${filter.listId}-${i}`,
      role: 'option' as const,
      'aria-selected': i === filter.activeIndex,
      to: link.href,
      onMouseMove: () => {
        if (filter.activeIndex !== i) filter.setActiveIndex(i)
      },
      active: i === filter.activeIndex,
    }
  }

  return (
    <div className="space-y-0.5">
      <p className="px-3 pt-1 pb-2 text-[11px] text-ink-muted" aria-live="polite">
        {filter.groups.length === 0
          ? `No pages match “${filter.query.trim()}”`
          : `${filter.groups.length} page${filter.groups.length === 1 ? '' : 's'} match`}
      </p>
      <div id={filter.listId} role="listbox" aria-label="Matching pages" className="space-y-0.5">
        {filter.groups.map((g) => {
          const { active, ...pageProps } = linkProps(g.page)
          const Icon = g.page.kind === 'faq' ? HelpCircle : null
          return (
            <div key={g.page.key}>
              <Link
                {...pageProps}
                className={cn(
                  'flex items-start gap-2 px-3 py-2 rounded-xl text-left transition-colors',
                  active ? 'bg-accent-lineage/10 text-ink' : 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5',
                )}
              >
                {Icon && <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-muted" aria-hidden />}
                <span className="flex flex-col min-w-0">
                  <span className="text-sm font-semibold leading-tight line-clamp-2">{g.page.label}</span>
                  {g.page.detail && <span className="text-[10px] text-ink-muted truncate mt-0.5">{g.page.detail}</span>}
                </span>
              </Link>
              {g.sections.map((s) => {
                const { active: sectionActive, ...sectionProps } = linkProps(s)
                return (
                  <Link
                    key={s.key}
                    {...sectionProps}
                    className={cn(
                      'ml-4 flex items-center gap-1.5 pl-3 pr-2 py-1.5 border-l border-glass-border text-xs transition-colors',
                      sectionActive ? 'text-accent-lineage border-accent-lineage bg-accent-lineage/[0.06]' : 'text-ink-muted hover:text-ink',
                    )}
                  >
                    <Hash className="w-3 h-3 shrink-0 opacity-70" aria-hidden />
                    <span className="truncate">{s.label}</span>
                  </Link>
                )
              })}
            </div>
          )
        })}
      </div>
      <button
        type="button"
        onClick={filter.searchEverything}
        className="mt-3 w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl text-xs font-medium text-accent-lineage bg-accent-lineage/[0.06] hover:bg-accent-lineage/10 transition-colors"
      >
        <span className="truncate">Search everything for “{filter.query.trim()}”</span>
        <ArrowRight className="w-3.5 h-3.5 shrink-0" aria-hidden />
      </button>
      <p className="px-3 pt-2 text-[10px] text-ink-muted">
        <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> move · <kbd className="kbd">Enter</kbd> open ·{' '}
        <kbd className="kbd">Esc</kbd> clear
      </p>
    </div>
  )
}
