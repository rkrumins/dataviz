import { Outlet, Link } from 'react-router-dom'
import { BookOpen, ArrowLeft, Sun, Moon } from 'lucide-react'
import { DocsSidebar } from '@/components/docs/DocsSidebar'
import { usePreferencesStore } from '@/store/preferences'

export function DocsPage() {
  const { setTheme } = usePreferencesStore()
  const isDark = document.documentElement.classList.contains('dark')

  const toggleTheme = () => setTheme(isDark ? 'light' : 'dark')

  return (
    <div className="absolute inset-0 flex flex-col bg-canvas">
      {/* Top bar */}
      <header className="shrink-0 h-12 flex items-center justify-between px-4 border-b border-glass-border bg-canvas-elevated">
        <div className="flex items-center gap-3">
          <BookOpen className="w-4 h-4 text-accent-lineage" />
          <span className="text-sm font-bold text-ink">Synodic Docs</span>
        </div>
        <div className="flex items-center gap-2">
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
