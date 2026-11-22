/**
 * AllowedValuesEditor — the values a field may hold, as chips: type one and Enter (or a comma) adds
 * it, × takes it away, and candidates (what the data holds today) are added with a click. "Other
 * values too" makes them suggestions instead of the only values a publish accepts.
 */
import { useState, type KeyboardEvent } from 'react'
import { Plus, X as XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** The longest allowed value: the longest a property value is matched by. */
const VALUE_MAX = 256

export function AllowedValuesEditor({ values, allowOther, onChange, candidates = [], disabled, label = 'Allowed values' }: {
  values: readonly string[]
  allowOther: boolean
  onChange: (values: string[], allowOther: boolean) => void
  /** Values to offer with one click (not yet allowed). */
  candidates?: readonly string[]
  disabled?: boolean
  label?: string
}) {
  const [draft, setDraft] = useState('')
  const add = (raw: string) => {
    const next = [...values]
    for (const part of raw.split(',')) {
      const v = part.trim().slice(0, VALUE_MAX)
      if (v && !next.includes(v)) next.push(v)
    }
    if (next.length !== values.length) onChange(next, allowOther)
    setDraft('')
  }
  const remove = (v: string) => {
    const next = values.filter((x) => x !== v)
    onChange(next, next.length ? allowOther : false)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); e.stopPropagation(); add(draft) }
    else if (e.key === 'Backspace' && !draft && values.length) remove(values[values.length - 1]!)
  }
  const offered = candidates.filter((c) => !values.includes(c))
  return (
    <div className="space-y-1.5">
      <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-0.5 max-w-[12rem] pl-1.5 pr-0.5 py-px rounded-md text-[11px] font-medium bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-500/20">
            <span className="truncate">{v}</span>
            {!disabled && (
              <button type="button" onClick={() => remove(v)} aria-label={`Remove ${v}`}
                className="w-4 h-4 flex items-center justify-center rounded hover:bg-indigo-500/15">
                <XIcon className="w-2.5 h-2.5" />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => { if (draft.trim()) add(draft) }}
            aria-label={`Add to ${label.toLowerCase()}`}
            placeholder={values.length ? 'Add another…' : 'Type a value, Enter to add — none: any value'}
            className="flex-1 min-w-[8rem] px-1.5 py-0.5 rounded-md bg-transparent text-[11px] text-ink placeholder:text-ink-muted/60 border border-transparent hover:border-glass-border focus:border-indigo-500/30 focus:outline-none"
          />
        )}
      </div>
      {!disabled && offered.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-ink-muted">In the data:</span>
          {offered.map((c) => (
            <button key={c} type="button" onClick={() => add(c)} aria-label={`Allow ${c}`}
              className="inline-flex items-center gap-0.5 max-w-[10rem] px-1.5 py-px rounded-md text-[10.5px] text-ink-secondary border border-dashed border-glass-border hover:border-indigo-500/40 hover:text-ink">
              <Plus className="w-2.5 h-2.5 shrink-0" aria-hidden /><span className="truncate">{c}</span>
            </button>
          ))}
        </div>
      )}
      {values.length > 0 && (
        <label className={cn('flex items-center gap-1 select-none', disabled ? 'cursor-default' : 'cursor-pointer')}>
          <input type="checkbox" checked={allowOther} disabled={disabled}
            onChange={(e) => onChange([...values], e.target.checked)} className="w-3 h-3 rounded accent-indigo-500" />
          <span className="text-[10px] text-ink-muted font-medium">Other values too</span>
        </label>
      )}
      {values.length > 0 && (
        <p className="text-[10px] text-ink-muted/80">
          {allowOther ? 'These are suggestions: any other value is accepted too.'
            : 'Only these values can be published — editing warns of any other.'}
        </p>
      )}
    </div>
  )
}
