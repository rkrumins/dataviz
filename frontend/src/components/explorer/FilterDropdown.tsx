/**
 * FilterDropdown — reusable searchable multi-select dropdown for the
 * Explorer filter bar.
 *
 * Handles the boilerplate shared by Workspace / Tag / ViewType / Creator
 * filters: trigger button with accent tint, popover panel, search input,
 * scrollable option list, keyboard isolation (stopPropagation on input
 * keystrokes so the Explorer's global shortcut handler doesn't hijack
 * typing), and click-outside dismissal.
 *
 * Designed to be pure / controlled: parent owns the selected values and
 * the "open" state. This keeps the ExplorerFilterBar logic linear and
 * makes URL-param wiring straightforward.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

/** The colour family the trigger + active options use. */
export type FilterAccent =
  | 'indigo'
  | 'emerald'
  | 'violet'
  | 'amber'
  | 'sky'
  | 'rose'

const ACCENT_CLASSES: Record<FilterAccent, {
  triggerActive: string
  optionActive: string
  checkBox: string
}> = {
  indigo: {
    triggerActive: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
    optionActive: 'bg-indigo-500/8 text-indigo-600 dark:text-indigo-400',
    checkBox: 'bg-indigo-500 border-indigo-500',
  },
  emerald: {
    triggerActive: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    optionActive: 'bg-emerald-500/8 text-emerald-600 dark:text-emerald-400',
    checkBox: 'bg-emerald-500 border-emerald-500',
  },
  violet: {
    triggerActive: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
    optionActive: 'bg-violet-500/8 text-violet-600 dark:text-violet-400',
    checkBox: 'bg-violet-500 border-violet-500',
  },
  amber: {
    triggerActive: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    optionActive: 'bg-amber-500/8 text-amber-600 dark:text-amber-400',
    checkBox: 'bg-amber-500 border-amber-500',
  },
  sky: {
    triggerActive: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
    optionActive: 'bg-sky-500/8 text-sky-600 dark:text-sky-400',
    checkBox: 'bg-sky-500 border-sky-500',
  },
  rose: {
    triggerActive: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
    optionActive: 'bg-rose-500/8 text-rose-600 dark:text-rose-400',
    checkBox: 'bg-rose-500 border-rose-500',
  },
}

export interface FilterOption {
  id: string
  label: string
  /** Optional secondary line (e.g. user email, tag count). */
  sublabel?: string
  /** Per-option icon override. Falls back to the dropdown's trigger icon. */
  icon?: LucideIcon
  /** Per-option icon colour class (e.g. ``text-indigo-500``). */
  iconClassName?: string
}

export interface FilterDropdownProps {
  icon: LucideIcon
  label: string
  accent: FilterAccent
  options: FilterOption[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  /** Disable the search input — use for short finite lists. */
  disableSearch?: boolean
  searchPlaceholder?: string
  emptyMessage?: string
  /** Custom trigger label when something is selected. */
  activeLabelFormatter?: (selectedIds: string[], options: FilterOption[]) => string
}

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ref, onClose])
}

export function FilterDropdown({
  icon: Icon,
  label,
  accent,
  options,
  selectedIds,
  onChange,
  disableSearch,
  searchPlaceholder,
  emptyMessage = 'No options',
  activeLabelFormatter,
}: FilterDropdownProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const accentClasses = ACCENT_CLASSES[accent]

  const close = () => {
    setOpen(false)
    setSearch('')
  }

  useClickOutside(containerRef, close)

  // Auto-focus search input when the dropdown opens.
  useEffect(() => {
    if (open && !disableSearch) inputRef.current?.focus()
  }, [open, disableSearch])

  const filteredOptions = useMemo(() => {
    if (!search.trim()) return options
    const q = search.toLowerCase()
    return options.filter(o =>
      o.label.toLowerCase().includes(q) ||
      (o.sublabel?.toLowerCase().includes(q) ?? false)
    )
  }, [options, search])

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const selectedCount = selectedIds.length

  function toggle(id: string) {
    if (selectedSet.has(id)) {
      onChange(selectedIds.filter(x => x !== id))
    } else {
      onChange([...selectedIds, id])
    }
  }

  const triggerLabel = selectedCount > 0
    ? (activeLabelFormatter?.(selectedIds, options) ?? `${selectedCount} ${label.toLowerCase()}${selectedCount > 1 ? 's' : ''}`)
    : label

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(p => !p)}
        className={cn(
          'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium',
          'transition-colors duration-150',
          selectedCount > 0
            ? accentClasses.triggerActive
            : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        {triggerLabel}
        <ChevronDown className={cn('h-3 w-3 transition-transform duration-150', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-64 bg-canvas border border-glass-border rounded-xl shadow-xl overflow-hidden">
          {!disableSearch && (
            <div className="relative border-b border-glass-border/50 p-2">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-3 w-3 text-ink-muted/60 pointer-events-none" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={searchPlaceholder ?? `Search ${label.toLowerCase()}...`}
                className="w-full rounded-lg bg-black/[0.03] dark:bg-white/[0.04] pl-7 pr-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-muted/50 focus:bg-black/[0.05] dark:focus:bg-white/[0.06]"
                onKeyDown={e => e.stopPropagation()}
              />
            </div>
          )}
          <div className="max-h-60 overflow-y-auto p-1">
            {options.length === 0 && (
              <p className="px-3 py-2 text-xs text-ink-muted">{emptyMessage}</p>
            )}
            {options.length > 0 && filteredOptions.length === 0 && (
              <p className="px-3 py-2 text-xs text-ink-muted">No matches</p>
            )}
            {filteredOptions.map(opt => {
              const checked = selectedSet.has(opt.id)
              const OptIcon = opt.icon ?? null
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => toggle(opt.id)}
                  className={cn(
                    'w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs',
                    'transition-colors duration-150',
                    checked
                      ? accentClasses.optionActive
                      : 'text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                  )}
                >
                  <span className={cn(
                    'w-4 h-4 rounded border flex items-center justify-center shrink-0',
                    'transition-colors duration-150',
                    checked ? cn(accentClasses.checkBox, 'text-white') : 'border-glass-border',
                  )}>
                    {checked && <Check className="h-3 w-3" />}
                  </span>
                  {OptIcon && (
                    <OptIcon className={cn('h-3.5 w-3.5 shrink-0', opt.iconClassName)} />
                  )}
                  <span className="flex-1 min-w-0 text-left">
                    <span className="font-medium truncate block">{opt.label}</span>
                    {opt.sublabel && (
                      <span className="text-[10px] text-ink-muted/70 truncate block">
                        {opt.sublabel}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
