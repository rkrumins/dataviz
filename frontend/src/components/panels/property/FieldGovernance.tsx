/**
 * A governed field's value, helped along while it is edited (`lib/fieldRules`): its allowed values
 * picked with one click — the one held marked — and a warning, said where the value is, of what
 * publishing would refuse. Neither blocks the edit.
 */
import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { inputTypeOf, storedAllowed, valueText } from '@/lib/fieldRules'
import type { EntityFieldDefinition } from '@/types/schema'

/** Past this many allowed values the picker is a menu, not chips. */
const CHIPS_MAX = 12

type PickerField = Pick<EntityFieldDefinition, 'type' | 'allowedValues' | 'allowOther'>

const asList = (value: unknown): unknown[] =>
  Array.isArray(value) ? value
    : typeof value === 'string' && value.trim() ? value.split(',').map((s) => s.trim()).filter(Boolean) : []

export function AllowedValuePicker({ field, value, label, onPick, className }: {
  field: PickerField
  value: unknown
  /** The field's name, for what the picker is called. */
  label: string
  onPick: (next: unknown) => void
  className?: string
}) {
  const allowed = field.allowedValues ?? []
  if (allowed.length === 0) return null
  const tags = inputTypeOf(field.type) === 'tags'
  const held = new Set((tags ? asList(value) : [value]).map(valueText).filter((t): t is string => !!t))
  const what = field.allowOther ? 'Suggested values' : 'Allowed values'

  if (!tags && allowed.length > CHIPS_MAX) {
    const current = [...held][0]
    return (
      <select
        aria-label={`${what} of ${label}`}
        value={current && allowed.includes(current) ? current : ''}
        onChange={(e) => { if (e.target.value) onPick(storedAllowed(field, e.target.value)) }}
        className={cn('max-w-full rounded-md border border-glass-border bg-canvas-elevated px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-accent-lineage/30', className)}
      >
        <option value="" disabled>{field.allowOther ? 'Pick a suggested value…' : 'Pick one of the allowed values…'}</option>
        {allowed.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
    )
  }
  const pick = (a: string) => {
    if (!tags) { onPick(storedAllowed(field, a)); return }
    const list = asList(value)
    onPick(held.has(a) ? list.filter((x) => valueText(x) !== a) : [...list, a])
  }
  return (
    <div role="group" aria-label={`${what} of ${label}`} className={cn('flex flex-wrap items-center gap-1', className)}>
      {allowed.map((a) => {
        const on = held.has(a)
        return (
          <button
            key={a}
            type="button"
            aria-pressed={on}
            onClick={() => pick(a)}
            className={cn(
              'max-w-[12rem] truncate rounded-md border px-1.5 py-px text-[11px] font-medium transition-colors',
              on ? 'border-accent-lineage/50 bg-accent-lineage/15 text-accent-lineage'
                : 'border-glass-border text-ink-secondary hover:border-accent-lineage/40 hover:text-ink',
            )}
          >
            {a}
          </button>
        )
      })}
    </div>
  )
}

/** What publishing would refuse, said under the value — never a block. */
export function FieldNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="status" className={cn('flex items-start gap-1 text-2xs leading-snug text-amber-700 dark:text-amber-300', className)}>
      <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  )
}
