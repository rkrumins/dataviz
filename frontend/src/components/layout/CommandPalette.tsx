import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Command } from 'cmdk'
import {
  Search,
  Network,
  Layers,
  Bookmark,
  Settings,
  Moon,
  Sun,
  ArrowUpRight,
  ArrowDownLeft,
  GitBranch,
  Zap,
  Eye,
  LayoutDashboard
} from 'lucide-react'
import { usePersonaStore } from '@/store/persona'
import { usePreferencesStore } from '@/store/preferences'
import { useSchemaStore } from '@/store/schema'
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
  // IMPORTANT: never return a freshly allocated [] from a Zustand selector.
  // That changes identity on every render and can trigger infinite rerenders
  // through useSyncExternalStore.
  const schemaViews = useSchemaStore((s) => s.schema?.views ?? EMPTY_VIEWS)

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
      const viewId = action.replace('go-to-view:', '')
      navigate(`/views/${viewId}`)
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
  }, [toggleMode, setTheme, toggleSidebar, onOpenChange, navigate])

  if (!open) return null

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
              placeholder="Search commands, entities, or traces..."
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

            {/* Quick Actions */}
            <Command.Group heading="Quick Actions">
              <CommandItem
                icon={Network}
                label="New Trace"
                description="Start a new lineage trace from an entity"
                shortcut="⌘T"
                onSelect={() => handleSelect('new-trace')}
              />
              <CommandItem
                icon={mode === 'business' ? Zap : Layers}
                label={`Switch to ${mode === 'business' ? 'Technical' : 'Business'} View`}
                description="Toggle persona mode"
                shortcut="⌘/"
                onSelect={() => handleSelect('toggle-persona')}
              />
              <CommandItem
                icon={Bookmark}
                label="Save Current View"
                description="Bookmark this viewport and filters"
                shortcut="⌘S"
                onSelect={() => handleSelect('save-view')}
              />
            </Command.Group>

            {/* Trace Actions */}
            <Command.Group heading="Trace">
              <CommandItem
                icon={ArrowUpRight}
                label="Trace Upstream"
                description="Find data sources and origins"
                onSelect={() => handleSelect('trace-upstream')}
              />
              <CommandItem
                icon={ArrowDownLeft}
                label="Trace Downstream"
                description="Find data consumers and impacts"
                onSelect={() => handleSelect('trace-downstream')}
              />
              <CommandItem
                icon={GitBranch}
                label="Trace Both Directions"
                description="Full lineage exploration"
                onSelect={() => handleSelect('trace-both')}
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
                onSelect={() => handleSelect('navigate:/views')}
              />
            </Command.Group>

            {/* Go to View */}
            {schemaViews.length > 0 && (
              <Command.Group heading="Go to View">
                {schemaViews.slice(0, 10).map((view) => (
                  <CommandItem
                    key={view.id}
                    icon={Eye}
                    label={view.name}
                    description={view.description ?? `${view.layout?.type ?? 'graph'} view`}
                    onSelect={() => handleSelect(`go-to-view:${view.id}`)}
                  />
                ))}
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

