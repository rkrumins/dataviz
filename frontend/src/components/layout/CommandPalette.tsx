import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Command } from 'cmdk'
import {
  Search,
  Layers,
  Settings,
  Moon,
  Sun,
  Zap,
  Eye,
  LayoutDashboard,
  History,
  Clock,
  Globe,
  Database,
  LayoutTemplate,
  BookOpen,
  Loader2,
} from 'lucide-react'
import { usePersonaStore } from '@/store/persona'
import { usePreferencesStore } from '@/store/preferences'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'
import { useRecentViews } from '@/hooks/useRecentViews'
import { useRecentSearches } from '@/hooks/useRecentSearches'
import { useGlobalSearch, CATEGORY_ORDER, type SearchHit, type SearchCategory } from '@/hooks/useGlobalSearch'
import { CATEGORY_COLORS } from '@/components/dashboard/dashboard-constants'
import { HighlightedText } from '@/components/ui/HighlightedText'
import { wsGradient } from '@/lib/viewUtils'
import { timeAgo } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const CATEGORY_ICONS: Record<SearchCategory, React.ComponentType<{ className?: string }>> = {
  Workspace: Globe,
  'Data Source': Database,
  View: Eye,
  Template: LayoutTemplate,
  'Semantic Layer': BookOpen,
}

const CATEGORY_HEADINGS: Record<SearchCategory, string> = {
  Workspace: 'Workspaces',
  'Data Source': 'Data Sources',
  View: 'Views',
  Template: 'Templates',
  'Semantic Layer': 'Semantic Layers',
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [search, setSearch] = useState('')
  const navigate = useNavigate()
  const { toggleMode, mode } = usePersonaStore()
  const { setTheme, theme, toggleSidebar } = usePreferencesStore()

  // Workspaces (for the zero-search "Switch Workspace" group)
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const wsSetActive = useWorkspacesStore((s) => s.setActiveWorkspace)
  const setActiveDataSource = useWorkspacesStore((s) => s.setActiveDataSource)
  const setActiveView = useSchemaStore((s) => s.setActiveView)

  // Recent views (zero-search state)
  const { recent } = useRecentViews()
  const { recents: recentSearches, record: recordRecentSearch, clear: clearRecentSearches } = useRecentSearches()

  // Unified ranked search across all top-level entities, including views
  // from the API — fixes the bug where the palette only saw views loaded
  // into `schemaStore.schema?.views` for the active scope.
  const searchResult = useGlobalSearch(search)
  const isZeroSearch = search.trim() === ''
  const hasEntityHits = !isZeroSearch && CATEGORY_ORDER.some(c => searchResult.byCategory[c].length > 0)

  // Keyboard shortcut to open / close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        onOpenChange(!open)
      }
      if (e.key === 'Escape' && open) {
        onOpenChange(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onOpenChange])

  const close = useCallback(() => {
    onOpenChange(false)
    setSearch('')
  }, [onOpenChange])

  const handleSelectHit = useCallback((hit: SearchHit) => {
    if (search.trim()) recordRecentSearch(search)
    switch (hit.category) {
      case 'Workspace':
        wsSetActive(hit.workspace.id)
        navigate(`/workspaces/${hit.workspace.id}`)
        break
      case 'Data Source':
        wsSetActive(hit.workspace.id)
        setActiveDataSource(hit.dataSource.id)
        navigate(`/workspaces/${hit.workspace.id}`)
        break
      case 'View':
        setActiveView(hit.view.id)
        navigate(`/views/${hit.view.id}`)
        break
      case 'Semantic Layer':
        navigate(`/schema/${hit.ontology.id}`)
        break
      case 'Template':
        // Templates have no dedicated detail route — land the user on the
        // dashboard where the templates section lives, then scroll into view.
        navigate('/dashboard')
        requestAnimationFrame(() => {
          document.getElementById('dashboard-templates')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
        break
    }
    close()
  }, [search, recordRecentSearch, navigate, wsSetActive, setActiveDataSource, setActiveView, close])

  const handleAction = useCallback((action: string) => {
    if (action.startsWith('navigate:')) {
      navigate(action.replace('navigate:', ''))
      close()
      return
    }
    if (action.startsWith('go-to-view:')) {
      const viewId = action.replace('go-to-view:', '').split('|')[0]
      navigate(`/views/${viewId}`)
      close()
      return
    }
    if (action.startsWith('switch-workspace:')) {
      const wsId = action.replace('switch-workspace:', '')
      wsSetActive(wsId)
      navigate(`/explorer?workspace=${encodeURIComponent(wsId)}`)
      close()
      return
    }
    switch (action) {
      case 'toggle-persona': toggleMode(); break
      case 'theme-light': setTheme('light'); break
      case 'theme-dark': setTheme('dark'); break
      case 'theme-system': setTheme('system'); break
      case 'toggle-sidebar': toggleSidebar(); break
    }
    close()
  }, [toggleMode, setTheme, toggleSidebar, navigate, wsSetActive, close])

  // Reset search when closing
  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 animate-fade-in"
        onClick={close}
      />

      {/* Command Dialog */}
      <div className="absolute inset-x-0 top-[15%] flex justify-center px-4">
        <div className="relative w-full max-w-2xl">
          {/* Soft gradient halo to echo the Hero search aesthetic */}
          <div className="absolute -inset-1 rounded-3xl blur-md bg-gradient-to-r from-accent-business/30 via-accent-explore/20 to-accent-lineage/30 opacity-80 pointer-events-none" />
          <Command
            className={cn(
              "relative w-full rounded-2xl overflow-hidden",
              "glass-panel shadow-2xl border border-accent-business/40",
              "animate-slide-up"
            )}
            loop
            shouldFilter={false}
          >
            {/* Search Input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-glass-border">
              <Search className="w-5 h-5 text-accent-business" />
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search workspaces, views, data sources, templates…"
                className={cn(
                  "flex-1 bg-transparent text-base",
                  "placeholder:text-ink-muted",
                  "focus:outline-none"
                )}
                autoFocus
              />
              {searchResult.isLoading && (
                <Loader2 className="w-4 h-4 text-ink-muted/60 animate-spin" />
              )}
              <kbd className="kbd">ESC</kbd>
            </div>

            {/* Command List */}
            <Command.List className="max-h-[460px] overflow-y-auto custom-scrollbar p-2">
              <Command.Empty className="py-8 text-center text-ink-muted text-sm">
                No results for "{search}".
              </Command.Empty>

              {/* Inline hint when query yields no entities but commands remain available */}
              {!isZeroSearch && !hasEntityHits && !searchResult.isLoading && (
                <div className="px-3 py-3 mb-1 text-xs text-ink-muted border border-glass-border rounded-lg bg-black/[0.02] dark:bg-white/[0.02]">
                  No matching workspaces, views, data sources, templates, or semantic layers. Try a different keyword, or use a command below.
                </div>
              )}

              {/* Entity hits — Views, Workspaces, Data Sources, Templates, Semantic Layers */}
              {hasEntityHits && CATEGORY_ORDER.map(category => {
                const hits = searchResult.byCategory[category]
                if (hits.length === 0) return null
                const total = searchResult.totalByCategory[category]
                const heading = total > hits.length
                  ? `${CATEGORY_HEADINGS[category]} (${total})`
                  : CATEGORY_HEADINGS[category]
                return (
                  <Command.Group key={category} heading={heading}>
                    {hits.map(hit => (
                      <EntityHitRow
                        key={hit.id}
                        hit={hit}
                        query={searchResult.query}
                        onSelect={() => handleSelectHit(hit)}
                      />
                    ))}
                  </Command.Group>
                )
              })}

              {/* Recent Searches — zero-search state only. Lets users re-run a prior query. */}
              {isZeroSearch && recentSearches.length > 0 && (
                <Command.Group
                  heading={
                    <span className="flex items-center justify-between w-full">
                      <span>Recent Searches</span>
                      <button
                        type="button"
                        onMouseDown={e => { e.preventDefault(); clearRecentSearches() }}
                        className="text-[10px] font-medium text-ink-muted hover:text-accent-business transition-colors"
                      >
                        Clear
                      </button>
                    </span>
                  }
                >
                  {recentSearches.map(q => (
                    <Command.Item
                      key={`recent-search-${q}`}
                      value={`search-history ${q}`}
                      onSelect={() => setSearch(q)}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer",
                        "data-[selected=true]:bg-accent-business/10",
                        "transition-colors duration-100"
                      )}
                    >
                      <div className="w-8 h-8 rounded-xl border border-glass-border bg-black/5 dark:bg-white/5 flex items-center justify-center">
                        <Clock className="w-4 h-4 text-ink-muted" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-ink truncate">{q}</p>
                      </div>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              {/* Recent Views — zero-search state only */}
              {isZeroSearch && recent.length > 0 && (
                <Command.Group heading="Recent Views">
                  {recent.map((entry) => (
                    <Command.Item
                      key={`recent-${entry.viewId}`}
                      value={`recent ${entry.viewName}`}
                      onSelect={() => handleAction(`go-to-view:${entry.viewId}`)}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer",
                        "data-[selected=true]:bg-accent-business/10",
                        "transition-colors duration-100"
                      )}
                    >
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-black/5 dark:bg-white/5">
                        <History className="w-4 h-4 text-ink-secondary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-ink truncate">{entry.viewName}</p>
                        <p className="text-xs text-ink-muted truncate">
                          {timeAgo(entry.visitedAt)}
                          {entry.workspaceName && ` · ${entry.workspaceName}`}
                        </p>
                      </div>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              {/* Switch Workspace — zero-search state only, when >1 workspace */}
              {isZeroSearch && workspaces.length > 1 && (
                <Command.Group heading="Switch Workspace">
                  {workspaces.map((ws, i) => {
                    const isActive = ws.id === activeWorkspaceId
                    const dsCount = ws.dataSources?.length ?? 0
                    return (
                      <Command.Item
                        key={`ws-${ws.id}`}
                        value={`workspace ${ws.name}`}
                        onSelect={() => handleAction(`switch-workspace:${ws.id}`)}
                        className={cn(
                          "flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer",
                          "data-[selected=true]:bg-accent-business/10",
                          "transition-colors duration-100"
                        )}
                      >
                        <div className={cn(
                          "w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white",
                          `bg-gradient-to-br ${wsGradient(i)}`
                        )}>
                          {ws.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-ink">
                            {ws.name}
                            {isActive && (
                              <span className="ml-2 text-2xs text-accent-business font-normal">(active)</span>
                            )}
                          </p>
                          <p className="text-xs text-ink-muted">
                            {dsCount} data source{dsCount !== 1 ? 's' : ''}
                          </p>
                        </div>
                      </Command.Item>
                    )
                  })}
                </Command.Group>
              )}

              {/* Quick Actions — always shown */}
              <Command.Group heading="Quick Actions">
                <CommandItem
                  icon={mode === 'business' ? Zap : Layers}
                  label={`Switch to ${mode === 'business' ? 'Technical' : 'Business'} View`}
                  description="Toggle persona mode"
                  shortcut="⌘/"
                  onSelect={() => handleAction('toggle-persona')}
                />
              </Command.Group>

              {/* Navigation — always shown */}
              <Command.Group heading="Navigation">
                <CommandItem
                  icon={LayoutDashboard}
                  label="Go to Dashboard"
                  description="Open the dashboard"
                  onSelect={() => handleAction('navigate:/dashboard')}
                />
                <CommandItem
                  icon={Eye}
                  label="Browse Views"
                  description="Discover and explore all views"
                  onSelect={() => handleAction('navigate:/explorer')}
                />
              </Command.Group>

              {/* Settings — always shown */}
              <Command.Group heading="Settings">
                <CommandItem
                  icon={theme === 'dark' ? Moon : Sun}
                  label="Toggle Theme"
                  description={`Current: ${theme}`}
                  onSelect={() => handleAction(theme === 'dark' ? 'theme-light' : 'theme-dark')}
                />
                <CommandItem
                  icon={Settings}
                  label="Open Settings"
                  description="Customize your experience"
                  shortcut="⌘,"
                  onSelect={() => handleAction('open-settings')}
                />
              </Command.Group>
            </Command.List>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-glass-border flex items-center justify-between text-2xs text-ink-muted">
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1">
                  <kbd className="kbd">↑↓</kbd> Navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="kbd">↵</kbd> Select
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="kbd">ESC</kbd> Close
                </span>
              </div>
              <span>Powered by NexusLineage</span>
            </div>
          </Command>
        </div>
      </div>
    </div>
  )
}

interface EntityHitRowProps {
  hit: SearchHit
  query: string
  onSelect: () => void
}

function EntityHitRow({ hit, query, onSelect }: EntityHitRowProps) {
  const Icon = CATEGORY_ICONS[hit.category]
  return (
    <Command.Item
      value={`${hit.category} ${hit.id} ${hit.name} ${hit.description ?? ''}`}
      onSelect={onSelect}
      className={cn(
        "flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer",
        "data-[selected=true]:bg-accent-business/10",
        "transition-colors duration-100 group/hit"
      )}
    >
      <div className={cn(
        'w-8 h-8 rounded-xl border flex items-center justify-center shrink-0',
        CATEGORY_COLORS[hit.category]
      )}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ink truncate">
          <HighlightedText text={hit.name} query={query} />
        </p>
        {hit.description && (
          <p className="text-xs text-ink-muted truncate">
            <HighlightedText text={hit.description} query={query} />
          </p>
        )}
      </div>
      <span className={cn(
        'text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border shrink-0',
        CATEGORY_COLORS[hit.category]
      )}>
        {hit.category}
      </span>
    </Command.Item>
  )
}

interface CommandItemProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  description?: string
  shortcut?: string
  onSelect: () => void
}

function CommandItem({ icon: Icon, label, description, shortcut, onSelect }: CommandItemProps) {
  return (
    <Command.Item
      onSelect={onSelect}
      className={cn(
        "flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer",
        "data-[selected=true]:bg-accent-business/10",
        "transition-colors duration-100"
      )}
    >
      <div className={cn(
        "w-8 h-8 rounded-lg flex items-center justify-center",
        "bg-black/5 dark:bg-white/5"
      )}>
        <Icon className="w-4 h-4 text-ink-secondary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        {description && (
          <p className="text-xs text-ink-muted truncate">{description}</p>
        )}
      </div>
      {shortcut && (
        <div className="flex items-center gap-1">
          {shortcut.split('').map((key, i) => (
            <kbd key={i} className="kbd">{key}</kbd>
          ))}
        </div>
      )}
    </Command.Item>
  )
}
