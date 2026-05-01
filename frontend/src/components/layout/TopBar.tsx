import { useState } from 'react'
import { Search, Settings, User, Moon, Sun, Monitor, LogOut, Pencil } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PersonaToggle } from '@/components/persona/PersonaToggle'
import { BookmarksPopover } from '@/components/layout/BookmarksPopover'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { AvatarPickerDialog, useAvatarContent } from '@/components/layout/AvatarPickerDialog'
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
  const navigate = useNavigate()
  const avatar = useAvatarContent()
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false)

  const initials = user
    ? `${(user.firstName?.[0] ?? '').toUpperCase()}${(user.lastName?.[0] ?? '').toUpperCase()}`
    : '?'

  /** Renders the user avatar — chosen illustration or initials fallback */
  const renderAvatar = (size: 'sm' | 'md') => {
    const dims = size === 'sm' ? 'w-8 h-8' : 'w-9 h-9'
    const iconDims = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'
    const textSize = size === 'sm' ? 'text-xs' : 'text-sm'

    if (avatar) {
      return (
        <div className={cn(dims, 'rounded-full flex items-center justify-center', avatar.bg)}>
          {avatar.content(cn(iconDims, 'text-ink'))}
        </div>
      )
    }
    if (user) {
      return (
        <div className={cn(dims, 'rounded-full flex items-center justify-center bg-accent-lineage/15')}>
          <span className={cn(textSize, 'font-semibold text-accent-lineage select-none leading-none')}>
            {initials}
          </span>
        </div>
      )
    }
    return (
      <div className={cn(dims, 'rounded-full flex items-center justify-center bg-accent-lineage/15')}>
        <User className={cn(iconDims, 'text-accent-lineage')} />
      </div>
    )
  }

  return (
    <>
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

        </div>

        {/* Center: Search Bar — visually paired with the Dashboard hero search */}
        <div className="flex-1 max-w-xl mx-8 relative group">
          {/* Soft gradient halo on hover, mirrors the Hero's focus glow at smaller scale */}
          <div className={cn(
            'absolute -inset-0.5 rounded-xl blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300',
            'bg-gradient-to-r from-accent-business/30 via-accent-explore/20 to-accent-lineage/30'
          )} />
          <button
            onClick={onOpenCommandPalette}
            className={cn(
              "relative w-full flex items-center gap-3 px-4 py-2 rounded-xl",
              "bg-canvas border border-glass-border",
              "text-ink-muted hover:border-accent-business/40 hover:bg-canvas-elevated",
              "transition-all duration-200"
            )}
          >
            <Search className="w-4 h-4 group-hover:text-accent-business transition-colors duration-200" />
            <span className="flex-1 text-left text-sm group-hover:text-ink-secondary transition-colors">
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

          <button
            className="btn btn-ghost p-2 rounded-lg"
            onClick={() => navigate('/admin')}
            title="Administration"
          >
            <Settings className="w-5 h-5 text-ink-secondary" />
          </button>

          {/* User Menu */}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                className={cn(
                  "rounded-full flex items-center justify-center",
                  "hover:ring-2 hover:ring-accent-lineage/30",
                  "transition-all outline-none focus:ring-2 focus:ring-accent-lineage/40"
                )}
                aria-label="User menu"
              >
                {renderAvatar('sm')}
              </button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="min-w-[240px] bg-canvas-elevated border border-glass-border rounded-xl shadow-xl p-2 z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
                sideOffset={8}
                align="end"
              >
                {/* Profile header */}
                <div className="flex items-center gap-3 px-3 py-2.5 border-b border-glass-border mb-1">
                  <div className="relative group">
                    {renderAvatar('md')}
                    <button
                      className={cn(
                        "absolute inset-0 rounded-full flex items-center justify-center",
                        "bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity",
                        "cursor-pointer"
                      )}
                      onClick={() => setAvatarPickerOpen(true)}
                      title="Change avatar"
                    >
                      <Pencil className="w-3.5 h-3.5 text-white" />
                    </button>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate">
                      {user?.displayName || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Unknown User'}
                    </p>
                    <p className="text-xs text-ink-muted truncate">
                      {user?.email}
                    </p>
                    <span className={cn(
                      "inline-block mt-0.5 px-1.5 py-px rounded text-[10px] font-medium capitalize",
                      user?.role === 'admin'
                        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                        : 'bg-accent-lineage/10 text-accent-lineage'
                    )}>
                      {user?.role || 'user'}
                    </span>
                  </div>
                </div>

                {/* Change Avatar action */}
                <DropdownMenu.Item
                  className="flex items-center gap-2 px-3 py-2 text-sm text-ink-secondary rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer outline-none focus:bg-accent-lineage/10 focus:text-accent-lineage transition-colors"
                  onSelect={() => setAvatarPickerOpen(true)}
                >
                  <Pencil className="w-4 h-4" />
                  <span>Change Avatar</span>
                </DropdownMenu.Item>

                <DropdownMenu.Separator className="h-px bg-glass-border my-1" />

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

      {/* Avatar picker dialog */}
      <AvatarPickerDialog
        isOpen={avatarPickerOpen}
        onClose={() => setAvatarPickerOpen(false)}
        initials={initials}
      />
    </>
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
