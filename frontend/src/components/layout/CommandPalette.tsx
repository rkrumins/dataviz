import { useEffect, useState, useCallback, useMemo } from 'react'
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
  ExternalLink,
} from 'lucide-react'
import { usePersonaStore } from '@/store/persona'
import { usePreferencesStore } from '@/store/preferences'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'
import { useRecentViews } from '@/hooks/useRecentViews'
import { DynamicIcon, layoutTypeIcon, wsGradient } from '@/lib/viewUtils'
import { timeAgo } from '@/lib/timeAgo'
import type { ViewConfiguration } from '@/types/schema'
import { cn } from '@/lib/utils'

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const EMPTY_VIEWS: ViewConfiguration[] = []

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [search, setSearch] = useState('')
  const navigate = useNavigate()
  const { toggleMode, mode } = usePersonaStore()
  const { setTheme, theme, toggleSidebar } = usePreferencesStore()

  // Schema views (all views across workspaces)
  const schemaViews = useSchemaStore((s) => s.schema?.views ?? EMPTY_VIEWS)
  // Workspaces
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const wsSetActive = useWorkspacesStore((s) => s.setActiveWorkspace)

  // Recent views
  const { recent } = useRecentViews()

  // Sort views: bookmarked first (isFavourited), then alphabetical
  const sortedViews = useMemo(() => {
    return [...schemaViews].sort((a, b) => {
      const aFav = a.isFavourited ? 0 : 1
      const bFav = b.isFavourited ? 0 : 1
      if (aFav !== bFav) return aFav - bFav
      return a.name.localeCompare(b.name)
    })
  }, [schemaViews])

  // Keyboard shortcut to open
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

  const handleSelect = useCallback((action: string) => {
    if (action.startsWith('navigate:')) {
      navigate(action.replace('navigate:', ''))
      onOpenChange(false)
      return
    }
    if (action.startsWith('go-to-view:')) {
      const parts = action.replace('go-to-view:', '').split('|')
      const viewId = parts[0]
      // Let useViewNavigation in ViewPage handle scope switching + view activation.
      // Doing it here causes a race condition with the provider rebuild pipeline.
      navigate(`/views/${viewId}`)
      onOpenChange(false)
      return
    }
    if (action.startsWith('switch-workspace:')) {
      const wsId = action.replace('switch-workspace:', '')
      wsSetActive(wsId)
      navigate(`/explorer?workspace=${encodeURIComponent(wsId)}`)
      onOpenChange(false)
      return
    }
    switch (action) {
      case 'toggle-persona':
        toggleMode()
        break
      case 'theme-light':
        setTheme('light')
        break
      case 'theme-dark':
        setTheme('dark')
        break
      case 'theme-system':
        setTheme('system')
        break
      case 'toggle-sidebar':
        toggleSidebar()
        break
    }
    onOpenChange(false)
  }, [toggleMode, setTheme, toggleSidebar, onOpenChange, navigate, wsSetActive])

  // Reset search when closing
  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  if (!open) return null

  const isZeroSearch = search.trim() === ''

  return (
    <div className="fixed inset-0 z-[100]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in"
        onClick={() => onOpenChange(false)}
      />

      {/* Command Dialog */}
      <div className="absolute inset-x-0 top-[20%] flex justify-center px-4">
        <Command
          className={cn(
            "w-full max-w-2xl rounded-2xl overflow-hidden",
            "glass-panel shadow-2xl",
            "animate-slide-up"
          )}
          loop
        >
          {/* Search Input */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-glass-border">
            <Search className="w-5 h-5 text-ink-muted" />
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder="Search commands, views, or workspaces..."
              className={cn(
                "flex-1 bg-transparent text-base",
                "placeholder:text-ink-muted",
                "focus:outline-none"
              )}
              autoFocus
            />
            <kbd className="kbd">ESC</kbd>
          </div>

          {/* Command List */}
          <Command.List className="max-h-[400px] overflow-y-auto custom-scrollbar p-2">
            <Command.Empty className="py-8 text-center text-ink-muted">
              No results found.
            </Command.Empty>

            {/* Recent Views — zero-search state only */}
            {isZeroSearch && recent.length > 0 && (
              <Command.Group heading="Recent">
                {recent.map((entry) => (
                  <Command.Item
                    key={`recent-${entry.viewId}`}
                    value={`recent ${entry.viewName} ${entry.workspaceName ?? ''}`}
                    onSelect={() => handleSelect(`go-to-view:${entry.viewId}|${entry.workspaceId ?? ''}|${entry.dataSourceId ?? ''}`)}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer",
                      "data-[selected=true]:bg-accent-lineage/10",
                      "transition-colors duration-100"
                    )}
                  >
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-black/5 dark:bg-white/5">
                      <History className="w-4 h-4 text-ink-secondary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-ink">{entry.viewName}</p>
                      <p className="text-xs text-ink-muted truncate">
                        {timeAgo(entry.visitedAt)}
                        {entry.workspaceName && ` · ${entry.workspaceName}`}
                      </p>
                    </div>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Switch Workspace */}
            {workspaces.length > 1 && (
              <Command.Group heading="Switch Workspace">
                {workspaces.map((ws, i) => {
                  const isActive = ws.id === activeWorkspaceId
                  const dsCount = ws.dataSources?.length ?? 0
                  return (
                    <Command.Item
                      key={`ws-${ws.id}`}
                      value={`workspace ${ws.name}`}
                      onSelect={() => handleSelect(`switch-workspace:${ws.id}`)}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer",
                        "data-[selected=true]:bg-accent-lineage/10",
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
                            <span className="ml-2 text-2xs text-accent-lineage font-normal">(active)</span>
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

            {/* Quick Actions */}
            <Command.Group heading="Quick Actions">
              <CommandItem
                icon={mode === 'business' ? Zap : Layers}
                label={`Switch to ${mode === 'business' ? 'Technical' : 'Business'} View`}
                description="Toggle persona mode"
                shortcut="⌘/"
                onSelect={() => handleSelect('toggle-persona')}
              />
            </Command.Group>

            {/* Navigation */}
            <Command.Group heading="Navigation">
              <CommandItem
                icon={LayoutDashboard}
                label="Go to Dashboard"
                description="Open the dashboard"
                onSelect={() => handleSelect('navigate:/dashboard')}
              />
              <CommandItem
                icon={Eye}
                label="Browse Views"
                description="Discover and explore all views"
                onSelect={() => handleSelect('navigate:/explorer')}
              />
            </Command.Group>

            {/* Go to View — all views, with workspace context */}
            {sortedViews.length > 0 && (
              <Command.Group heading="Go to View">
                {sortedViews.map((view) => {
                  const isCrossWorkspace = view.workspaceId !== activeWorkspaceId
                  const iconName = layoutTypeIcon(view.layout?.type ?? 'graph')
                  return (
                    <Command.Item
                      key={`view-${view.id}`}
                      value={`view ${view.name} ${view.workspaceName ?? ''} ${view.layout?.type ?? 'graph'}`}
                      onSelect={() => handleSelect(`go-to-view:${view.id}|${view.workspaceId ?? ''}|${view.dataSourceId ?? ''}`)}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer",
                        "data-[selected=true]:bg-accent-lineage/10",
                        "transition-colors duration-100"
                      )}
                    >
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-black/5 dark:bg-white/5">
                        <DynamicIcon name={iconName} className="w-4 h-4 text-ink-secondary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-ink flex items-center gap-2">
                          {view.name}
                          {isCrossWorkspace && (
                            <ExternalLink className="w-3 h-3 text-ink-muted shrink-0" />
                          )}
                        </p>
                        <p className="text-xs text-ink-muted truncate">
                          {view.layout?.type ?? 'graph'} view
                          {view.workspaceName && ` · ${view.workspaceName}`}
                        </p>
                      </div>
                    </Command.Item>
                  )
                })}
              </Command.Group>
            )}

            {/* Settings */}
            <Command.Group heading="Settings">
              <CommandItem
                icon={theme === 'dark' ? Moon : Sun}
                label="Toggle Theme"
                description={`Current: ${theme}`}
                onSelect={() => handleSelect(theme === 'dark' ? 'theme-light' : 'theme-dark')}
              />
              <CommandItem
                icon={Settings}
                label="Open Settings"
                description="Customize your experience"
                shortcut="⌘,"
                onSelect={() => handleSelect('open-settings')}
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
        "data-[selected=true]:bg-accent-lineage/10",
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
