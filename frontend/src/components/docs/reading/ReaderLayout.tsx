import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Outlet, Link, useLocation } from 'react-router-dom'
import { ArrowLeft, Sun, Moon, Search, Menu, X, type LucideIcon } from 'lucide-react'
import { usePreferencesStore } from '@/store/preferences'
import { useAppliedTheme } from '@/hooks/useAppliedTheme'
import { formatShortcut } from '@/lib/platform'
import { Backdrop } from '@/components/ui/Backdrop'
import { DocsSearchModal } from '@/components/docs/search/DocsSearchModal'
import { prefetchSearchIndex } from '@/components/docs/search/useDocsSearchIndex'
import { ScrollContainerContext } from './ScrollContainerContext'
import { ReaderContext } from './ReaderContext'
import { ReadingProgress } from './ReadingProgress'
import type { ReaderArea } from './paths'

interface ReaderLayoutProps {
  area: ReaderArea
  /** The reader's name in the top bar, e.g. "Acme Docs". */
  title: string
  logo: ReactNode
  /** The other reader, linked from the top bar. */
  crossLink: { to: string; label: string; title: string; icon: LucideIcon }
  sidebar: ReactNode
}

/**
 * The frame both readers share — the Documentation at /docs and the User
 * Guide at /guide: the top bar, the sidebar (a drawer on narrow screens),
 * the scrolling article area and the search dialog every part of the reader
 * can open.
 */
export function ReaderLayout({ area, title, logo, crossLink, sidebar }: ReaderLayoutProps) {
  const setTheme = usePreferencesStore((s) => s.setTheme)
  const isDark = useAppliedTheme()
  const location = useLocation()
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const [search, setSearch] = useState({ open: false, query: '', session: 0 })
  // The drawer is open only on the page it was opened on: going somewhere closes it.
  const [navOpenAt, setNavOpenAt] = useState<string | null>(null)
  const navOpen = navOpenAt === location.key
  const setNavOpen = (open: boolean) => setNavOpenAt(open ? location.key : null)

  const openSearch = useCallback((query = '') => {
    setSearch((s) => (s.open ? s : { open: true, query, session: s.session + 1 }))
  }, [])
  const closeSearch = useCallback(() => setSearch((s) => ({ ...s, open: false })), [])

  // ⌘K / Ctrl+K anywhere, or "/" outside a field, opens search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inField = !!target && (/^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable)
      const modK = e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
      const slash = e.key === '/' && !inField && !e.metaKey && !e.ctrlKey && !e.altKey
      if (modK || slash) {
        e.preventDefault()
        openSearch()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [openSearch])

  // Escape closes the drawer.
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpenAt(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navOpen])

  const reader = useMemo(() => ({ area, openSearch }), [area, openSearch])
  const shortcut = formatShortcut('mod+k')
  const CrossIcon = crossLink.icon

  return (
    <ReaderContext.Provider value={reader}>
      <ScrollContainerContext.Provider value={scrollEl}>
        <div className="absolute inset-0 flex flex-col bg-canvas">
          <button
            type="button"
            onClick={() => scrollEl?.focus()}
            className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[110] btn btn-primary"
          >
            Skip to content
          </button>

          {/* Top bar */}
          <header className="shrink-0 h-14 flex items-center justify-between gap-2 px-2 sm:px-4 border-b border-glass-border glass-panel-subtle">
            <div className="flex items-center gap-1 min-w-0">
              <button
                type="button"
                onClick={() => setNavOpen(true)}
                className="md:hidden p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
                aria-label="Open the table of contents"
                aria-expanded={navOpen}
              >
                <Menu className="w-5 h-5" />
              </button>
              <Link to={`/${area}`} className="flex items-center gap-2.5 group min-w-0 px-1">
                {logo}
                <span className="text-sm font-bold text-ink truncate group-hover:text-accent-lineage transition-colors">
                  {title}
                </span>
              </Link>
            </div>
            <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => openSearch()}
                onMouseEnter={prefetchSearchIndex}
                onFocus={prefetchSearchIndex}
                className="flex items-center gap-2 p-2 sm:pl-2.5 sm:pr-2 sm:py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink sm:bg-black/[0.03] sm:dark:bg-white/[0.04] sm:border border-glass-border hover:border-accent-lineage/30 transition-colors"
                aria-label="Search the guide and the docs"
                title={`Search the guide and the docs (${shortcut})`}
              >
                <Search className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                <span className="hidden sm:inline">Search</span>
                <kbd className="hidden sm:inline-flex items-center rounded border border-glass-border bg-canvas px-1.5 text-[10px] text-ink-muted">
                  {shortcut}
                </kbd>
              </button>
              <Link
                to={crossLink.to}
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                title={crossLink.title}
              >
                <CrossIcon className="w-3.5 h-3.5" />
                {crossLink.label}
              </Link>
              <button
                type="button"
                onClick={() => setTheme(isDark ? 'light' : 'dark')}
                className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
                title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
              <Link
                to="/"
                className="flex items-center gap-1.5 p-2 sm:px-3 sm:py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                aria-label="Back to the app"
              >
                <ArrowLeft className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                <span className="hidden sm:inline">Back to app</span>
              </Link>
            </div>
          </header>

          {/* Body: sidebar + content */}
          <div className="flex-1 flex overflow-hidden">
            <div className="hidden md:flex h-full">{sidebar}</div>
            <div className="flex-1 flex flex-col min-w-0">
              <ReadingProgress />
              <main
                ref={setScrollEl}
                id="reader-main"
                tabIndex={-1}
                className="flex-1 overflow-y-auto custom-scrollbar focus:outline-none"
              >
                <Outlet />
              </main>
            </div>
          </div>
        </div>

        {/* The table of contents as a drawer, below the md breakpoint */}
        <Backdrop open={navOpen} onClick={() => setNavOpen(false)} zClassName="z-[90] md:hidden" className="bg-black/40" />
        {navOpen && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Table of contents"
            className="md:hidden fixed inset-y-0 left-0 z-[95] flex max-w-[88vw] shadow-2xl animate-in slide-in-from-left duration-200"
          >
            {sidebar}
            <button
              type="button"
              onClick={() => setNavOpen(false)}
              className="absolute right-2 top-2 p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
              aria-label="Close the table of contents"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        )}

        <DocsSearchModal
          key={search.session}
          open={search.open}
          onClose={closeSearch}
          area={area}
          initialQuery={search.query}
        />
      </ScrollContainerContext.Provider>
    </ReaderContext.Provider>
  )
}
