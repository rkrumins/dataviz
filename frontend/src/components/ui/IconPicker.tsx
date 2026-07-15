/**
 * IconPicker — searchable picker over the FULL Lucide catalog (~1,700 icons).
 *
 * The catalog is already in the bundle (several modules do
 * `import * as LucideIcons from 'lucide-react'`), so offering everything costs
 * nothing. Search matches on the camelCase-split words of the icon name.
 * A "suggested" row keeps the previously curated common icons one click away,
 * and recently used icons persist per user via the preferences store.
 */
import { useMemo, useRef, useState } from 'react'
import { icons } from 'lucide-react'
import { Search } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { usePreferencesStore } from '@/store/preferences'

const ALL_ICON_NAMES = Object.keys(icons)

/** "DatabaseZap" -> "database zap" for word-level matching. */
function words(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

const SEARCHABLE = ALL_ICON_NAMES.map(name => ({ name, words: words(name) }))

const GRID_COLS = 8

interface IconPickerProps {
  value: string
  onChange: (name: string) => void
  /** Curated names rendered as a "Suggested" row when not searching. */
  suggested?: string[]
  disabled?: boolean
}

export function IconPicker({ value, onChange, suggested = [], disabled }: IconPickerProps) {
  const [query, setQuery] = useState('')
  const recentIcons = usePreferencesStore(s => s.recentIcons)
  const addRecentIcon = usePreferencesStore(s => s.addRecentIcon)
  const scrollRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ALL_ICON_NAMES
    return SEARCHABLE.filter(e => e.words.includes(q) || e.name.toLowerCase().includes(q)).map(e => e.name)
  }, [query])

  const rows = useMemo(() => {
    const out: string[][] = []
    for (let i = 0; i < filtered.length; i += GRID_COLS) out.push(filtered.slice(i, i + GRID_COLS))
    return out
  }, [filtered])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    overscan: 6,
  })

  function pick(name: string) {
    if (disabled) return
    addRecentIcon(name)
    onChange(name)
  }

  const validRecent = recentIcons.filter(n => n in icons)
  const showCurated = !query.trim()

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/60" />
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          disabled={disabled}
          placeholder={`Search ${ALL_ICON_NAMES.length.toLocaleString()} icons...`}
          className="w-full pl-8 pr-3 py-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-xs text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/30 transition-colors"
        />
      </div>

      {showCurated && validRecent.length > 0 && (
        <IconRow label="Recent" names={validRecent} value={value} onPick={pick} />
      )}
      {showCurated && suggested.length > 0 && (
        <IconRow label="Suggested" names={suggested} value={value} onPick={pick} />
      )}

      <div>
        {showCurated && (
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">All icons</p>
        )}
        {filtered.length === 0 ? (
          <p className="text-xs text-ink-muted py-4 text-center">No icons match &ldquo;{query}&rdquo;</p>
        ) : (
          <div ref={scrollRef} className="h-48 overflow-y-auto rounded-lg border border-glass-border/60">
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map(vRow => (
                <div
                  key={vRow.key}
                  className="absolute left-0 w-full grid grid-cols-8 gap-1 px-1"
                  style={{ top: 0, transform: `translateY(${vRow.start}px)`, height: vRow.size }}
                >
                  {rows[vRow.index].map(name => (
                    <IconCell key={name} name={name} selected={value === name} onPick={pick} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function IconRow({ label, names, value, onPick }: {
  label: string
  names: string[]
  value: string
  onPick: (name: string) => void
}) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">{label}</p>
      <div className="flex flex-wrap gap-1">
        {names.map(name => (
          <IconCell key={name} name={name} selected={value === name} onPick={onPick} />
        ))}
      </div>
    </div>
  )
}

function IconCell({ name, selected, onPick }: { name: string; selected: boolean; onPick: (name: string) => void }) {
  const Icon = icons[name as keyof typeof icons]
  if (!Icon) return null
  return (
    <button
      type="button"
      onClick={() => onPick(name)}
      title={name}
      aria-label={name}
      aria-pressed={selected}
      className={cn(
        'w-9 h-9 rounded-lg flex items-center justify-center border transition-all',
        selected
          ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-500'
          : 'border-transparent hover:border-glass-border hover:bg-black/[0.03] dark:hover:bg-white/[0.04] text-ink-secondary',
      )}
    >
      <Icon className="w-4 h-4" />
    </button>
  )
}
