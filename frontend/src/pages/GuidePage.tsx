import { Outlet, Link } from 'react-router-dom'
import { Sparkles, ArrowLeft, Sun, Moon, BookOpen } from 'lucide-react'
import { GuideSidebar } from '@/components/guide/GuideSidebar'
import { usePreferencesStore } from '@/store/preferences'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { useBrand } from '@/store/branding'

export function GuidePage() {
  const { appName } = useBrand()
  useDocumentTitle('User Guide')
  const { setTheme } = usePreferencesStore()
  const isDark = document.documentElement.classList.contains('dark')

  const toggleTheme = () => setTheme(isDark ? 'light' : 'dark')

  return (
    <div className="absolute inset-0 flex flex-col bg-canvas">
      {/* Top bar */}
      <header className="shrink-0 h-12 flex items-center justify-between px-4 border-b border-glass-border bg-canvas-elevated">
        <Link to="/guide" className="flex items-center gap-2.5 group">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow shadow-indigo-500/20">
            <Sparkles className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-sm font-bold text-ink group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
            {appName} User Guide
          </span>
        </Link>
        <div className="flex items-center gap-1.5">
          <a
            href="/docs"
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            title="Engineer documentation"
          >
            <BookOpen className="w-3.5 h-3.5" />
            Engineer docs
          </a>
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
        <GuideSidebar />
        <main className="flex-1 overflow-y-auto custom-scrollbar">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
