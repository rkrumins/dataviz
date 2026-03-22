import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { BookOpen, Search, HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { docSections, docEntries, getEntriesForSection } from './docsConfig'

export function DocsSidebar() {
  const [search, setSearch] = useState('')

  const filteredEntries = search
    ? docEntries.filter(
        (e) =>
          e.title.toLowerCase().includes(search.toLowerCase()) ||
          e.description?.toLowerCase().includes(search.toLowerCase()),
      )
    : null

  // When searching, show flat list; otherwise show sections
  const filteredSections = filteredEntries
    ? null
    : docSections.filter((s) => s.id !== 'faq')

  return (
    <aside className="w-72 shrink-0 border-r border-glass-border bg-canvas-elevated flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <BookOpen className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-ink leading-tight">Documentation</h1>
            <p className="text-[11px] text-ink-muted">Synodic Platform</p>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
          <input
            type="text"
            placeholder="Search docs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-9 h-9 text-sm"
          />
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto custom-scrollbar px-3 pb-4 space-y-4">
        {/* Search results */}
        {filteredEntries && (
          <div className="space-y-0.5">
            {filteredEntries.length === 0 && (
              <p className="px-3 py-4 text-xs text-ink-muted text-center">
                No documents match "{search}"
              </p>
            )}
            {filteredEntries.map((entry) => (
              <SidebarLink key={entry.slug} slug={entry.slug} title={entry.title} description={entry.description} />
            ))}
          </div>
        )}

        {/* Section groups */}
        {filteredSections?.map((section) => {
          const entries = getEntriesForSection(section.id)
          const SectionIcon = section.icon
          return (
            <div key={section.id} className="space-y-0.5">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <SectionIcon className="w-3.5 h-3.5 text-ink-muted" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
                  {section.label}
                </span>
              </div>
              {entries.map((entry) => (
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
  return (
    <NavLink
      to={`/docs/${slug}`}
      className={({ isActive }) =>
        cn(
          'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all duration-200',
          isActive
            ? 'bg-gradient-to-r from-indigo-500/10 to-violet-500/10 text-indigo-600 dark:text-indigo-400 shadow-sm border border-indigo-500/20'
            : 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink border border-transparent',
        )
      }
    >
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-semibold truncate leading-tight">{title}</span>
        {description && (
          <span className="text-[10px] text-ink-muted truncate mt-0.5">{description}</span>
        )}
      </div>
    </NavLink>
  )
}
