/**
 * Date — when a view was created, or when it last changed.
 *
 * One menu for both timestamps, with a switch at the top, rather than two menus
 * that look alike: the question is "when", and which clock to read is a detail of
 * it. "Updated" means the view's LAST CHANGE of any kind — its settings, its
 * layout or its data — because that is what "updated in the past week" means to a
 * person, and the sort menu already separates the kinds for anyone who needs to.
 *
 * Choices, quickest first:
 *  - presets (Today, Past 7 days, This month…), which close the menu;
 *  - "Past N days" for any other window;
 *  - a custom range on the same two-month calendar Analytics uses, so a range is
 *    picked as a shape on a grid rather than typed as two dates.
 *
 * Everything is kept as a rule (see dateFilter.ts), so a bookmarked "Past 7 days"
 * still means the past seven days when it's opened next month.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { CalendarRange, Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { keyboardScopeProps } from '@/lib/keyboardScope'
import { Segmented } from '@/components/ui/Segmented'
import { RangeCalendar } from '@/components/analytics/RangeCalendar'
import type { DateField } from '../model'
import {
  DATE_PRESETS, MAX_ROLLING_DAYS, describeRule, formatDay, rangeRule, ruleDays, spanLength,
} from '../dateFilter'

const FIELD_HINT: Record<DateField, string> = {
  created: 'When the view was made',
  updated: 'Its last change — settings, layout or data',
}

const FIELD_LABEL: Record<DateField, string> = { created: 'Created', updated: 'Updated' }

function patchOf(field: DateField, rule: string | null): { created?: string | null; updated?: string | null } {
  return field === 'created' ? { created: rule } : { updated: rule }
}

export function DateFilterMenu({
  created, updated, onChange, today, recentActive, presetCount, className,
}: {
  created: string | null
  updated: string | null
  onChange: (patch: { created?: string | null; updated?: string | null }) => void
  /** Local `YYYY-MM-DD`, from `useLocalDay`. */
  today: string
  /** The Recent pill is on — it already limits creation to the past 7 days. */
  recentActive?: boolean
  /** Views a preset would show for a field, when known. */
  presetCount?: (field: DateField, rule: string) => number | undefined
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [field, setField] = useState<DateField>('updated')
  const [custom, setCustom] = useState(false)
  const [calFrom, setCalFrom] = useState('')
  const [calTo, setCalTo] = useState('')
  const [nDays, setNDays] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const nId = useId()

  const rules: Record<DateField, string | null> = { created, updated }
  const current = rules[field]

  const openMenu = () => {
    // Open on the field that is set, so the menu shows what is filtering.
    const f: DateField = updated || !created ? 'updated' : 'created'
    setField(f)
    const span = rules[f] ? ruleDays(rules[f]!, today) : null
    const isRange = Boolean(rules[f] && /\d{4}-\d{2}-\d{2}/.test(rules[f]!))
    setCustom(isRange)
    setCalFrom(isRange ? (span?.from ?? '') : '')
    setCalTo(isRange ? (span?.to ?? '') : '')
    const rolling = rules[f] ? /^(\d+)d$/.exec(rules[f]!) : null
    setNDays(rolling ? rolling[1] : '')
    setOpen(true)
  }

  const close = (refocus = false) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }

  // A click outside closes the menu, the same as every other filter menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const apply = (rule: string | null, closeAfter = true) => {
    onChange(patchOf(field, rule))
    if (closeAfter) close(true)
  }

  // Switching the clock carries a lone rule across: "Past 7 days" stays the
  // question, asked of the other timestamp. With both set, it only changes which
  // one is being edited.
  const switchField = (next: DateField) => {
    if (next === field) return
    const other = rules[next]
    if (current && !other) onChange({ ...patchOf(field, null), ...patchOf(next, current) })
    setField(next)
  }

  const n = Number(nDays)
  const nValid = Number.isInteger(n) && n >= 1 && n <= MAX_ROLLING_DAYS
  const calComplete = Boolean(calFrom && calTo)

  const setCount = Number(Boolean(created)) + Number(Boolean(updated))
  const triggerLabel = setCount === 0
    ? 'Date'
    : setCount === 2
      ? 'Created & updated'
      : `${FIELD_LABEL[created ? 'created' : 'updated']} · ${describeRule((created ?? updated)!, today)}`

  return (
    <div
      ref={rootRef}
      className={cn('relative', className)}
      onKeyDown={e => {
        if (e.key === 'Escape' && open) { e.stopPropagation(); close(true) }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : openMenu())}
        className={cn(
          'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium whitespace-nowrap',
          'transition-colors duration-150',
          setCount > 0
            ? 'bg-teal-500/10 text-teal-700 dark:text-teal-300'
            : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
        )}
      >
        <CalendarRange className="h-3.5 w-3.5" />
        {triggerLabel}
        <ChevronDown className={cn('h-3 w-3 transition-transform duration-150', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          {...keyboardScopeProps('view-filters')}
          role="dialog"
          aria-label="Filter by date"
          className={cn(
            'absolute left-0 top-full z-50 mt-1.5 rounded-xl border border-glass-border bg-canvas shadow-xl',
            'max-w-[calc(100vw-2rem)] animate-in fade-in slide-in-from-top-1 duration-150',
            custom ? 'w-[20.5rem] sm:w-[34rem]' : 'w-[19rem]',
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] dark:border-white/[0.08] px-3 py-2.5">
            <Segmented
              label="Which date"
              value={field}
              onChange={switchField}
              options={[
                { value: 'created', label: 'Created' },
                { value: 'updated', label: 'Updated' },
              ]}
            />
            <span className="text-[10px] text-ink-muted text-right leading-tight">{FIELD_HINT[field]}</span>
          </div>

          {recentActive && field === 'created' && (
            <p className="mx-3 mt-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
              Recent already limits this list to views created in the past 7 days.
            </p>
          )}

          <div className="grid grid-cols-2 gap-0.5 p-1.5">
            {DATE_PRESETS.map(p => {
              const active = current === p.rule
              const count = presetCount?.(field, p.rule)
              return (
                <button
                  key={p.rule}
                  type="button"
                  aria-pressed={active}
                  onClick={() => apply(p.rule)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors duration-150',
                    'outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40',
                    active
                      ? 'bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300'
                      : 'text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                    count === 0 && !active && 'opacity-50',
                  )}
                >
                  <span className="flex-1 truncate">{p.label}</span>
                  {count !== undefined && (
                    <span className="tabular-nums text-[10px] font-semibold text-ink-muted">{count.toLocaleString()}</span>
                  )}
                  {active && <Check className="h-3 w-3 shrink-0" />}
                </button>
              )
            })}
          </div>

          <form
            className="flex items-center gap-2 border-t border-black/[0.06] dark:border-white/[0.08] px-3 py-2"
            onSubmit={e => { e.preventDefault(); if (nValid) apply(`${n}d`) }}
          >
            <label htmlFor={nId} className="text-xs text-ink-secondary">Past</label>
            <input
              id={nId}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_ROLLING_DAYS}
              value={nDays}
              onChange={e => setNDays(e.target.value)}
              placeholder="14"
              className="w-16 rounded-lg border border-glass-border bg-black/[0.03] dark:bg-white/[0.04] px-2 py-1 text-xs text-ink tabular-nums outline-none focus:ring-2 focus:ring-teal-500/40"
            />
            <span className="text-xs text-ink-secondary">days</span>
            <button
              type="submit"
              disabled={!nValid}
              className="ml-auto rounded-lg px-2.5 py-1 text-[11px] font-semibold text-teal-700 dark:text-teal-300 hover:bg-teal-500/10 disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              Apply
            </button>
          </form>

          <div className="border-t border-black/[0.06] dark:border-white/[0.08]">
            <button
              type="button"
              aria-expanded={custom}
              onClick={() => setCustom(c => !c)}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-ink-secondary hover:text-ink transition-colors"
            >
              <ChevronRight className={cn('h-3 w-3 transition-transform duration-150', custom && 'rotate-90')} />
              Custom range…
            </button>
            {custom && (
              <div className="px-3 pb-3">
                <RangeCalendar
                  from={calFrom}
                  to={calTo}
                  today={today}
                  maxSpanDays={MAX_ROLLING_DAYS}
                  onSelect={(f, t) => { setCalFrom(f); setCalTo(t) }}
                />
                <div className="mt-2 flex items-center gap-2">
                  <p className="flex-1 text-[11px] font-semibold text-ink" aria-live="polite">
                    {calComplete
                      ? `${formatDay(calFrom, today)} → ${formatDay(calTo, today)} · ${spanLength(calFrom, calTo)} day${spanLength(calFrom, calTo) === 1 ? '' : 's'}`
                      : calFrom ? `${formatDay(calFrom, today)} → pick the end date` : 'Pick a start date'}
                  </p>
                  <button
                    type="button"
                    disabled={!calComplete}
                    onClick={() => apply(rangeRule(calFrom, calTo))}
                    className="inline-flex items-center gap-1 rounded-lg bg-gradient-to-r from-teal-500 to-emerald-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm transition-opacity disabled:opacity-40"
                  >
                    <Check className="h-3 w-3" /> Apply range
                  </button>
                </div>
              </div>
            )}
          </div>

          {setCount > 0 && (
            <div className="flex items-center justify-between border-t border-black/[0.06] dark:border-white/[0.08] px-3 py-2">
              <button
                type="button"
                onClick={() => apply(null, setCount === 1)}
                disabled={!current}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink disabled:opacity-40 transition-colors"
              >
                <X className="h-3 w-3" /> Clear {FIELD_LABEL[field].toLowerCase()} date
              </button>
              {setCount === 2 && (
                <button
                  type="button"
                  onClick={() => { onChange({ created: null, updated: null }); close(true) }}
                  className="text-[11px] font-medium text-ink-muted hover:text-ink transition-colors"
                >
                  Clear both
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
