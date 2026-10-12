/**
 * Pieces the drawer's two lineage lists share — the flat list a canvas-only
 * lineage falls back to (LineageNeighbors) and the partner tree the walk
 * feeds (LineagePartnerTree).
 */
import { useEffect, useState } from 'react'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'

export type SortMode = 'default' | 'name-asc' | 'name-desc'

// ============================================
// Sort menu
// ============================================

export function SortMenu({
  value,
  onChange,
}: {
  value: SortMode
  onChange: (mode: SortMode) => void
}) {
  const [open, setOpen] = useState(false)
  // Close on outside click. Simpler than wiring a Radix Popover for the
  // three options this menu currently exposes.
  useEffect(() => {
    if (!open) return
    const onDocClick = () => setOpen(false)
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const labels: Record<SortMode, string> = {
    'default': 'Default',
    'name-asc': 'Name A → Z',
    'name-desc': 'Name Z → A',
  }
  const ariaLabel = `Sort: ${labels[value]}`

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        aria-label={ariaLabel}
        title={ariaLabel}
        className={cn(
          'inline-flex items-center gap-1 px-2 py-2 rounded-lg text-[11px] font-medium border transition-colors duration-150',
          value === 'default'
            ? 'text-ink-muted bg-white/[0.04] border-white/10 hover:text-ink hover:border-white/20'
            : 'text-accent-lineage bg-accent-lineage/10 border-accent-lineage/30',
        )}
      >
        <LucideIcons.ArrowUpDown className="w-3.5 h-3.5" />
        {value !== 'default' && (
          <span className="hidden sm:inline">{labels[value]}</span>
        )}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-20 min-w-[140px] rounded-lg border border-white/10 bg-canvas-elevated/98 backdrop-blur-2xl shadow-lg overflow-hidden"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(Object.keys(labels) as SortMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => {
                onChange(mode)
                setOpen(false)
              }}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left transition-colors duration-150',
                value === mode
                  ? 'bg-accent-lineage/15 text-accent-lineage'
                  : 'text-ink-muted hover:bg-white/[0.06] hover:text-ink',
              )}
            >
              {value === mode ? (
                <LucideIcons.Check className="w-3 h-3" />
              ) : (
                <span className="w-3" />
              )}
              {labels[mode]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  hint?: string
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-6 px-4 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-dashed border-white/[0.08]">
      <div className="w-9 h-9 rounded-full bg-white/[0.04] flex items-center justify-center mb-2">
        <Icon className="w-4 h-4 text-ink-muted/60" />
      </div>
      <p className="text-[11.5px] font-medium text-ink-muted">{title}</p>
      {hint && (
        <p className="text-[10.5px] text-ink-muted/70 mt-0.5">{hint}</p>
      )}
    </div>
  )
}
