import { useEffect, useRef } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { Sparkles, Home, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  guideSections,
  guideEntries,
  getEntriesForSection,
  getPersona,
} from './guideConfig'
import { interpolateBrand } from '@/lib/brandText'
import { useBrand } from '@/store/branding'
import { useCollapsedSections } from '@/components/docs/reading/useCollapsedSections'
import { SidebarFilterInput, SidebarFilterResults } from '@/components/docs/reading/SidebarFilter'
import { useSidebarFilter } from '@/components/docs/reading/useSidebarFilter'
import { ReadMark, SidebarPathCard } from '@/components/docs/reading/ReadingPath'

export function GuideSidebar() {
  const brand = useBrand()
  const filter = useSidebarFilter('guide', guideEntries)
  const { collapsed, toggle } = useCollapsedSections('guide-sidebar-collapsed')

  return (
    <aside className="w-72 max-w-full shrink-0 border-r border-glass-border bg-canvas-elevated flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <NavLink to="/guide" className="flex items-center gap-3 mb-4 group">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-ink leading-tight group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
              User Guide
            </h1>
            <p className="text-[11px] text-ink-muted">{brand.appName}</p>
          </div>
        </NavLink>

        {/* Filter + full-text search */}
        <SidebarFilterInput filter={filter} />
      </div>

      {!filter.filtering && <SidebarPathCard area="guide" />}

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto custom-scrollbar px-3 pb-4 space-y-5" aria-label="User Guide pages">
        {filter.filtering && <SidebarFilterResults filter={filter} />}

        {!filter.filtering &&
          guideSections.map((section) => {
            const entries = getEntriesForSection(section.id)
            if (entries.length === 0) return null
            const SectionIcon = section.icon
            const persona = getPersona(section.persona)
            const isCollapsed = collapsed.has(section.id)
            return (
              <div key={section.id} className="space-y-0.5">
                <button
                  onClick={() => toggle(section.id)}
                  className="sticky top-0 z-10 w-full flex items-center gap-2 px-2 py-1.5 bg-canvas-elevated group focus-visible:outline-none"
                >
                  <SectionIcon className={cn('w-3.5 h-3.5', persona ? persona.accent.text : 'text-ink-muted')} />
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

      {/* Hub link pinned at bottom */}
      <div className="px-3 pb-4 border-t border-glass-border pt-3">
        <NavLink
          to="/guide"
          end
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
            <Home className="w-3.5 h-3.5" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold truncate leading-tight">Guide Home</span>
            <span className="text-[10px] text-ink-muted truncate">Overview & key journeys</span>
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
  const active = location.pathname === `/guide/${slug}`
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <NavLink
      ref={ref}
      to={`/guide/${slug}`}
      className={cn(
        'relative w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all duration-200',
        active
          ? 'bg-gradient-to-r from-indigo-500/10 to-violet-500/10 text-indigo-600 dark:text-indigo-400 shadow-sm border border-indigo-500/20 before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:h-5 before:w-0.5 before:rounded-full before:bg-indigo-500'
          : 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink border border-transparent',
      )}
    >
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-semibold truncate leading-tight">{interpolateBrand(title, brand)}</span>
        {description && (
          <span className="text-[10px] text-ink-muted truncate mt-0.5">{interpolateBrand(description, brand)}</span>
        )}
      </div>
      <ReadMark area="guide" slug={slug} />
    </NavLink>
  )
}
