import { useState, useEffect, useCallback } from 'react'
import { Outlet, Link } from 'react-router-dom'
import { BookOpen, ArrowLeft, Sun, Moon, Sparkles, Search } from 'lucide-react'
import { DocsSidebar } from '@/components/docs/DocsSidebar'
import { usePreferencesStore } from '@/store/preferences'
import { useAppliedTheme } from '@/hooks/useAppliedTheme'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { useBrand } from '@/store/branding'
import { ScrollContainerContext } from '@/components/docs/reading/ScrollContainerContext'
import { ReadingProgress } from '@/components/docs/reading/ReadingProgress'
import { DocsSearchModal } from '@/components/docs/search/DocsSearchModal'

export function DocsPage() {
  const { appName } = useBrand()
  useDocumentTitle('Docs')
  const setTheme = usePreferencesStore((s) => s.setTheme)
  const isDark = useAppliedTheme()
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)

  const toggleTheme = () => setTheme(isDark ? 'light' : 'dark')

  // ⌘K / Ctrl+K, or "/" (outside a field), opens full-text search.
  const onKey = useCallback((e: KeyboardEvent) => {
    const inField = /^(input|textarea|select)$/i.test((e.target as HTMLElement)?.tagName ?? '')
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !inField)) {
      e.preventDefault()
      setSearchOpen(true)
    }
  }, [])
  useEffect(() => {
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onKey])

  return (
    <ScrollContainerContext.Provider value={scrollEl}>
      <div className="absolute inset-0 flex flex-col bg-canvas">
        {/* Top bar */}
        <header className="shrink-0 h-14 flex items-center justify-between px-4 border-b border-glass-border glass-panel-subtle">
          <Link to="/docs" className="flex items-center gap-3 group">
            <BookOpen className="w-4 h-4 text-accent-lineage" />
            <span className="text-sm font-bold text-ink group-hover:text-accent-lineage transition-colors">
              {appName} Docs
            </span>
          </Link>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSearchOpen(true)}
              className="flex items-center gap-2 pl-2.5 pr-2 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border hover:border-accent-lineage/30 transition-colors"
              title="Search the docs"
            >
              <Search className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Search</span>
              <kbd className="hidden sm:inline-flex items-center rounded border border-glass-border bg-canvas px-1.5 text-[10px] text-ink-muted">⌘K</kbd>
            </button>
            <Link
              to="/guide"
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              title="Business user guide"
            >
              <Sparkles className="w-3.5 h-3.5" />
              User guide
            </Link>
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <Link
              to="/"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to app
            </Link>
          </div>
        </header>

        {/* Body: sidebar + content */}
        <div className="flex-1 flex overflow-hidden">
          <DocsSidebar onOpenSearch={() => setSearchOpen(true)} />
          <div className="flex-1 flex flex-col min-w-0">
            <ReadingProgress />
            <main ref={setScrollEl} className="flex-1 overflow-y-auto custom-scrollbar">
              <Outlet />
            </main>
          </div>
        </div>
      </div>

      <DocsSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </ScrollContainerContext.Provider>
  )
}
