import { Search, Settings, User, Moon, Sun, Monitor } from 'lucide-react'
import { PersonaToggle } from '@/components/persona/PersonaToggle'
import { usePreferencesStore } from '@/store/preferences'
import { usePersonaStore } from '@/store/persona'
import { cn } from '@/lib/utils'

interface TopBarProps {
  onOpenCommandPalette: () => void
}

export function TopBar({ onOpenCommandPalette }: TopBarProps) {
  const { theme, setTheme } = usePreferencesStore()
  const persona = usePersonaStore((s) => s.mode)

  return (
    <header className="h-14 border-b border-glass-border bg-canvas-elevated flex items-center justify-between px-4 z-50">
      {/* Left: Logo & Branding */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
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
            Search entities, traces, or commands...
          </span>
          <div className="flex items-center gap-1">
            <kbd className="kbd">⌘</kbd>
            <kbd className="kbd">K</kbd>
          </div>
        </button>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        {/* Persona Toggle */}
        <PersonaToggle />

        {/* Divider */}
        <div className="w-px h-6 bg-glass-border mx-2" />

        {/* Theme Switcher */}
        <ThemeSwitcher theme={theme} onChange={setTheme} />

        {/* Settings */}
        <button className="btn btn-ghost p-2 rounded-lg">
          <Settings className="w-5 h-5 text-ink-secondary" />
        </button>

        {/* User Menu */}
        <button className={cn(
          "w-8 h-8 rounded-full bg-accent-lineage/20 flex items-center justify-center",
          "hover:bg-accent-lineage/30 transition-colors"
        )}>
          <User className="w-4 h-4 text-accent-lineage" />
        </button>
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

