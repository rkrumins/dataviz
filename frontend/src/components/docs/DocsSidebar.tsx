import { useEffect, useRef } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { BookOpen, HelpCircle, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { docSections, docEntries, getEntriesForSection } from './docsConfig'
import { interpolateBrand } from '@/lib/brandText'
import { useBrand } from '@/store/branding'
import { useCollapsedSections } from './reading/useCollapsedSections'
import { SidebarFilterInput, SidebarFilterResults } from './reading/SidebarFilter'
import { useSidebarFilter } from './reading/useSidebarFilter'
import { ReadMark, SidebarPathCard } from './reading/ReadingPath'

export function DocsSidebar() {
  const brand = useBrand()
  const filter = useSidebarFilter('docs', docEntries)
  const { collapsed, toggle } = useCollapsedSections('docs-sidebar-collapsed')

  const sections = docSections.filter((s) => s.id !== 'faq')

  return (
    <aside className="w-72 max-w-full shrink-0 border-r border-glass-border bg-canvas-elevated flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <BookOpen className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-ink leading-tight">Documentation</h1>
            <p className="text-[11px] text-ink-muted">{brand.appName}</p>
          </div>
        </div>

        {/* Filter + full-text search */}
        <SidebarFilterInput filter={filter} />
      </div>

      {!filter.filtering && <SidebarPathCard area="docs" />}

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto custom-scrollbar px-3 pb-4 space-y-4" aria-label="Documentation pages">
        {filter.filtering && <SidebarFilterResults filter={filter} />}

        {!filter.filtering && sections.map((section) => {
          const entries = getEntriesForSection(section.id)
          if (entries.length === 0) return null
          const SectionIcon = section.icon
          const isCollapsed = collapsed.has(section.id)
          return (
            <div key={section.id} className="space-y-0.5">
              <button
                onClick={() => toggle(section.id)}
                className="sticky top-0 z-10 w-full flex items-center gap-2 px-2 py-1.5 bg-canvas-elevated group focus-visible:outline-none"
              >
                <SectionIcon className="w-3.5 h-3.5 text-ink-muted" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted flex-1 text-left">
                  {section.label}
                </span>
                <ChevronDown
                  className={cn(
                    'w-3.5 h-3.5 text-ink-muted transition-transform opacity-0 group-hover:opacity-100',
                    isCollapsed && 'opacity-100 -rotate-90',
                  )}
                />
              </button>
              {!isCollapsed &&
                entries.map((entry) => (
                  <SidebarLink key={entry.slug} slug={entry.slug} title={entry.title} description={entry.description} />
                ))}
            </div>
          )
        })}
      </nav>

      {/* FAQ pinned at bottom */}
      <div className="px-3 pb-4 border-t border-glass-border pt-3">
        <NavLink
          to="/docs/faq"
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200',
              isActive
                ? 'bg-gradient-to-r from-indigo-500/10 to-violet-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20'
                : 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink border border-transparent',
            )
          }
        >
          <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-black/5 dark:bg-white/5">
            <HelpCircle className="w-3.5 h-3.5" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold truncate leading-tight">FAQ</span>
            <span className="text-[10px] text-ink-muted truncate">Common questions</span>
          </div>
        </NavLink>
      </div>
    </aside>
  )
}

function SidebarLink({ slug, title, description }: { slug: string; title: string; description?: string }) {
  const brand = useBrand()
  const location = useLocation()
  const ref = useRef<HTMLAnchorElement>(null)
  const active = location.pathname === `/docs/${slug}`
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <NavLink
      ref={ref}
      to={`/docs/${slug}`}
      className={cn(
        'relative w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all duration-200',
        active
          ? 'bg-gradient-to-r from-indigo-500/10 to-violet-500/10 text-indigo-600 dark:text-indigo-400 shadow-sm border border-indigo-500/20 before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:h-5 before:w-0.5 before:rounded-full before:bg-accent-lineage'
          : 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink border border-transparent',
      )}
    >
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-semibold truncate leading-tight">{interpolateBrand(title, brand)}</span>
        {description && (
          <span className="text-[10px] text-ink-muted truncate mt-0.5">{interpolateBrand(description, brand)}</span>
        )}
      </div>
      <ReadMark area="docs" slug={slug} />
    </NavLink>
  )
}
