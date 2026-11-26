/**
 * A search over a list of entities to pick one from — a combobox over a listbox, the arrow keys and
 * Enter to choose, Esc to cancel, and at most {@link PICKER_ROWS} rows until the search narrows it.
 * The look every "pick an entity" surface shares: a new parent (MoveTargetPicker), the entity a
 * column is mapped to (MapColumnDialog).
 */
import { useId, useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import { Search, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

/** Rows a search shows at once; the rest wait for a narrower search. */
export const PICKER_ROWS = 50

export interface PickerOption {
  id: string
  label: string
  /** The small caps at the end of the row: its type, or what choosing it means ("No parent"). */
  badge?: string
  /** A quieter line under the label: where it is now. */
  detail?: string
  icon?: LucideIcon
  /** What a search matches besides the label (the badge, by default). */
  keywords?: string
  /** A rule under it, before the rest — a choice unlike the others. */
  separated?: boolean
}

export function EntitySearchPicker({
  options, onPick, onCancel, searchLabel, listLabel, placeholder, emptyText, autoFocus = false, inputRef,
}: {
  options: readonly PickerOption[]
  onPick: (id: string) => void
  /** Cancel, and Esc. */
  onCancel: () => void
  /** The search box's name. */
  searchLabel: string
  /** The list's name. */
  listLabel: string
  placeholder: string
  /** Said when there is nothing to pick at all (a search that matches nothing says so itself). */
  emptyText: string
  autoFocus?: boolean
  inputRef?: RefObject<HTMLInputElement | null>
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => [o.label, o.keywords ?? o.badge ?? ''].some((s) => s.toLowerCase().includes(q)))
  }, [options, query])
  const shown = matches.slice(0, PICKER_ROWS)

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); onPick(shown[active].id) }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
  }

  return (
    <div className="space-y-1.5">
      <div className="rounded-xl border border-glass-border overflow-hidden">
        <div className="flex items-center gap-2 px-3 border-b border-glass-border">
          <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-hidden />
          <input
            ref={inputRef}
            autoFocus={autoFocus}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
            aria-label={searchLabel}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="flex-1 min-w-0 py-2 bg-transparent outline-none text-sm text-ink placeholder:text-ink-muted"
          />
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
        <ul id={listId} role="listbox" aria-label={listLabel} className="max-h-56 overflow-y-auto custom-scrollbar py-1">
          {shown.map((o, i) => {
            const Icon = o.icon
            return (
              <li
                key={o.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); onPick(o.id) }}
                className={cn('flex items-center justify-between gap-3 px-3 py-1.5 cursor-pointer text-sm',
                  i === active ? 'bg-accent-lineage/10 text-ink' : 'text-ink',
                  o.separated && shown.length > 1 && 'border-b border-glass-border mb-1')}
              >
                <span className="flex items-center gap-2 min-w-0">
                  {Icon && <Icon className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-hidden />}
                  <span className="min-w-0">
                    <span data-option-label className="block truncate">{o.label}</span>
                    {o.detail && <span className="block truncate text-[11px] leading-snug text-ink-muted">{o.detail}</span>}
                  </span>
                </span>
                {o.badge && <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted shrink-0">{o.badge}</span>}
              </li>
            )
          })}
          {matches.length === 0 && (
            <li className="px-3 py-3 text-xs text-ink-muted italic">
              {options.length === 0 ? emptyText : 'Nothing matches that search.'}
            </li>
          )}
        </ul>
        {matches.length > shown.length && (
          <p className="px-3 py-1.5 border-t border-glass-border text-[11px] text-ink-muted">
            Showing {shown.length} of {matches.length.toLocaleString()} — type to narrow it down.
          </p>
        )}
      </div>
    </div>
  )
}
