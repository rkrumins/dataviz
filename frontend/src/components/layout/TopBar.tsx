import { Search, Settings, User, Moon, Sun, Monitor, LogOut } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { PersonaToggle } from '@/components/persona/PersonaToggle'
import { WorkspaceBreadcrumb } from '@/components/layout/WorkspaceBreadcrumb'
import { BookmarksPopover } from '@/components/layout/BookmarksPopover'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { usePreferencesStore } from '@/store/preferences'
import { usePersonaStore } from '@/store/persona'
import { useAuthStore } from '@/store/auth'
import { useSchemaStore } from '@/store/schema'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { cn } from '@/lib/utils'

interface TopBarProps {
  onOpenCommandPalette: () => void
}

/** Dynamic search placeholder based on route context */
function useSearchPlaceholder(): string {
  const location = useLocation()
  const activeView = useSchemaStore((s) => s.getActiveView())

  if (location.pathname.startsWith('/views/') && activeView) {
    return `Search nodes in ${activeView.name}...`
  }
  if (location.pathname.startsWith('/explorer')) {
    return 'Filter views by name, tag, or workspace...'
  }
  return 'Search workspaces, views, or commands...'
}

export function TopBar({ onOpenCommandPalette }: TopBarProps) {
  const { theme, setTheme } = usePreferencesStore()
  const persona = usePersonaStore((s) => s.mode)
  const { user, logout } = useAuthStore()
  const searchPlaceholder = useSearchPlaceholder()

  return (
    <header className="h-14 border-b border-glass-border bg-canvas-elevated flex items-center justify-between px-4 z-50">
      {/* Left: Logo + Breadcrumb */}
      <div className="flex items-center gap-3 min-w-0">
        {/* Logo */}
        <div className="flex items-center gap-2 shrink-0">
          <div className={cn(
            "w-8 h-8 rounded-lg flex items-center justify-center",
            "bg-gradient-to-br from-accent-lineage to-accent-business"
          )}>
            <svg
              viewBox="0 0 24 24"
              className="w-5 h-5 text-white"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <div>
            <h1 className="font-display font-semibold text-lg leading-none">
              NexusLineage
            </h1>
            <p className="text-2xs text-ink-muted">
              {persona === 'business' ? 'Business View' : 'Technical View'}
            </p>
          </div>
        </div>

        {/* Breadcrumb separator */}
        <div className="w-px h-6 bg-glass-border shrink-0" />

        {/* Workspace Breadcrumb */}
        <WorkspaceBreadcrumb />
      </div>

      {/* Center: Search Bar */}
      <div className="flex-1 max-w-xl mx-8">
        <button
          onClick={onOpenCommandPalette}
          className={cn(
            "w-full flex items-center gap-3 px-4 py-2 rounded-lg",
            "bg-canvas border border-glass-border",
            "text-ink-muted hover:text-ink-secondary hover:border-ink-muted/30",
            "transition-all duration-150"
          )}
        >
          <Search className="w-4 h-4" />
          <span className="flex-1 text-left text-sm">
            {searchPlaceholder}
          </span>
          <div className="flex items-center gap-1">
            <kbd className="kbd">⌘</kbd>
            <kbd className="kbd">K</kbd>
          </div>
        </button>
      </div>

      {/* Right: Actions — 3 groups separated by dividers */}
      <div className="flex items-center gap-2">
        {/* Group 1: Mode */}
        <PersonaToggle />

        <div className="w-px h-6 bg-glass-border mx-1" />

        {/* Group 2: Content shortcuts */}
        <BookmarksPopover />
        <NotificationBell />

        <div className="w-px h-6 bg-glass-border mx-1" />

        {/* Group 3: System / Account */}
        <ThemeSwitcher theme={theme} onChange={setTheme} />

        <button className="btn btn-ghost p-2 rounded-lg">
          <Settings className="w-5 h-5 text-ink-secondary" />
        </button>

        {/* User Menu */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className={cn(
              "w-8 h-8 rounded-full bg-accent-lineage/20 flex items-center justify-center",
              "hover:bg-accent-lineage/30 transition-colors outline-none focus:ring-2 focus:ring-accent-lineage/40"
            )}>
              <User className="w-4 h-4 text-accent-lineage" />
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="min-w-[200px] bg-canvas-elevated border border-glass-border rounded-xl shadow-xl p-2 z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
              sideOffset={8}
              align="end"
            >
              <div className="px-3 py-2 border-b border-glass-border mb-1">
                <p className="text-xs font-semibold text-ink">
                  {user?.name || 'Admin User'}
                </p>
                <p className="text-[10px] text-ink-muted capitalize">
                  {user?.role || 'Administrator'}
                </p>
              </div>

              <DropdownMenu.Item
                className="flex items-center gap-2 px-3 py-2 text-sm text-ink-secondary rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer outline-none focus:bg-accent-lineage/10 focus:text-accent-lineage transition-colors"
                onSelect={logout}
              >
                <LogOut className="w-4 h-4" />
                <span>Sign Out</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  )
}

interface ThemeSwitcherProps {
  theme: 'light' | 'dark' | 'system'
  onChange: (theme: 'light' | 'dark' | 'system') => void
}

function ThemeSwitcher({ theme, onChange }: ThemeSwitcherProps) {
  const icons = {
    light: Sun,
    dark: Moon,
    system: Monitor,
  }
  const Icon = icons[theme]

  const cycleTheme = () => {
    const order: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system']
    const currentIndex = order.indexOf(theme)
    const nextIndex = (currentIndex + 1) % order.length
    onChange(order[nextIndex])
  }

  return (
    <button
      onClick={cycleTheme}
      className="btn btn-ghost p-2 rounded-lg group"
      title={`Theme: ${theme}`}
    >
      <Icon className="w-5 h-5 text-ink-secondary group-hover:text-ink transition-colors" />
    </button>
  )
}
