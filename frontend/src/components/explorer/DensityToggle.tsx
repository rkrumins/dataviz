/**
 * DensityToggle — switches the Explorer between Compact / Comfortable /
 * Spacious visual density. Persists via ``usePreferencesStore``.
 *
 * Renders as three icon buttons in a pill, matching the grid/list
 * toggle treatment next to it so the toolbar stays cohesive.
 */
import { Rows2, Rows3, Rows4 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePreferencesStore, type ExplorerDensity } from '@/store/preferences'

const OPTIONS: { key: ExplorerDensity; icon: typeof Rows3; label: string }[] = [
  { key: 'compact', icon: Rows4, label: 'Compact' },
  { key: 'comfortable', icon: Rows3, label: 'Comfortable' },
  { key: 'spacious', icon: Rows2, label: 'Spacious' },
]

export function DensityToggle() {
  const density = usePreferencesStore(s => s.explorerDensity)
  const setDensity = usePreferencesStore(s => s.setExplorerDensity)
  return (
    <div className="inline-flex items-center rounded-lg border border-glass-border p-0.5" role="group" aria-label="Row density">
      {OPTIONS.map(opt => {
        const Icon = opt.icon
        const active = density === opt.key
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => setDensity(opt.key)}
            className={cn(
              'p-1.5 rounded-md transition-colors duration-150',
              active
                ? 'bg-accent-lineage/12 text-accent-lineage'
                : 'text-ink-muted hover:text-ink',
            )}
            title={opt.label}
            aria-pressed={active}
            aria-label={opt.label}
          >
            <Icon className="w-3.5 h-3.5" />
          </button>
        )
      })}
    </div>
  )
}
