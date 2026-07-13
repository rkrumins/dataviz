import { Outlet, Link } from 'react-router-dom'
import { BookOpen, ArrowLeft, Sun, Moon, Sparkles } from 'lucide-react'
import { DocsSidebar } from '@/components/docs/DocsSidebar'
import { usePreferencesStore } from '@/store/preferences'
import { useAppliedTheme } from '@/hooks/useAppliedTheme'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { useBrand } from '@/store/branding'

export function DocsPage() {
  const { appName } = useBrand()
  useDocumentTitle('Docs')
  const setTheme = usePreferencesStore((s) => s.setTheme)
  const isDark = useAppliedTheme()

  const toggleTheme = () => setTheme(isDark ? 'light' : 'dark')

  return (
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
        <DocsSidebar />
        <main className="flex-1 overflow-y-auto custom-scrollbar">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
