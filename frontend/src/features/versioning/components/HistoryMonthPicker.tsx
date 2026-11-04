/**
 * HistoryMonthPicker — the graph as it was at the end of any month, or any day.
 *
 * Published's revisions a year at a time, each month shaded by how busy it was (one hue, more is
 * darker), with its count printed on it; a month opens to its days, shaded the same way. The end of a
 * month or a day is its last revision, which opens on the canvas, compares with now, or brings the
 * timeline to it. Counted in the reader's time zone (`/history/months`), one read for all of it.
 */
import { useMemo, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { CalendarDays, ChevronLeft, ChevronRight, Eye, GitCompareArrows, ListTree } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { Skeleton } from '@/components/ui/Skeleton'
import type { HistoryDay, HistoryMonth } from '@/services/versioningApiService'

/** One hue, more is darker: four steps of activity, and none. */
const HEAT = [
  'bg-black/[0.03] dark:bg-white/[0.04] text-ink-muted/60',
  'bg-indigo-500/[0.12] text-ink',
  'bg-indigo-500/[0.24] text-ink',
  'bg-indigo-500/[0.42] text-ink',
  'bg-indigo-600 text-white dark:bg-indigo-500',
]

function heat(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((4 * count) / max)))
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Where the picker points: the end of a month, or of one of its days. */
interface Target { label: string; seq: number; count: number; month: string }

export function HistoryMonthPicker({
  months, loading, headSeq, onOpen, onCompare, onJump, canOpen,
}: {
  /** Oldest first, as `/history/months` answers. */
  months: HistoryMonth[] | undefined
  loading: boolean
  /** Published's head: a target there is the graph as it is now. */
  headSeq: number | null
  onOpen: (seq: number) => void
  onCompare: (seq: number) => void
  /** Bring the timeline to a month (`YYYY-MM`). */
  onJump: (month: string) => void
  /** Opening on the canvas is offered (the revision viewer). */
  canOpen: boolean
}) {
  const [open, setOpen] = useState(false)
  const byMonth = useMemo(() => new Map((months ?? []).map((m) => [m.month, m])), [months])
  const years = useMemo(() => {
    const ys = new Set((months ?? []).map((m) => Number(m.month.slice(0, 4))))
    return [...ys].sort((a, b) => a - b)
  }, [months])
  const latestYear = years.at(-1) ?? new Date().getFullYear()
  const [year, setYear] = useState<number | null>(null)
  const shownYear = year ?? latestYear
  const [picked, setPicked] = useState<{ month: string; day?: string } | null>(null)

  const yearMonths = Array.from({ length: 12 }, (_, i) => byMonth.get(`${shownYear}-${pad(i + 1)}`) ?? null)
  const yearMax = Math.max(0, ...yearMonths.map((m) => m?.count ?? 0))
  const pickedMonth = picked ? byMonth.get(picked.month) ?? null : null

  const target: Target | null = useMemo(() => {
    if (!pickedMonth) return null
    const [y, m] = pickedMonth.month.split('-').map(Number)
    if (picked?.day) {
      const d = pickedMonth.days.find((x) => x.day === picked.day)
      if (d) {
        const label = new Date(y, m - 1, Number(d.day.slice(8, 10))).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
        return { label, seq: d.lastSeq, count: d.count, month: pickedMonth.month }
      }
    }
    const label = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    return { label, seq: pickedMonth.lastSeq, count: pickedMonth.count, month: pickedMonth.month }
  }, [pickedMonth, picked])
  const isNow = !!target && headSeq != null && target.seq >= headSeq

  const close = () => setOpen(false)

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <HoverTip className="inline-flex" label="Go to a month" detail="The graph as it was at the end of any month or day.">
        <Popover.Trigger asChild>
          <button
            aria-label="Go to a month"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-ink-muted border border-glass-border hover:text-ink hover:bg-canvas-overlay transition-colors data-[state=open]:bg-indigo-500/10 data-[state=open]:text-indigo-700 dark:data-[state=open]:text-indigo-300"
          >
            <CalendarDays className="w-3.5 h-3.5" /> Months
          </button>
        </Popover.Trigger>
      </HoverTip>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-[9999] w-[21rem] max-w-[94vw] p-3 bg-canvas border border-glass-border rounded-2xl shadow-xl animate-in fade-in zoom-in-95 duration-100"
        >
          <div className="flex items-center justify-between mb-2">
            <button
              aria-label="Previous year"
              disabled={!years.length || shownYear <= years[0]}
              onClick={() => { setYear(shownYear - 1); setPicked(null) }}
              className="p-1 rounded-lg text-ink-muted hover:bg-canvas-overlay disabled:opacity-30"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-sm font-semibold text-ink tabular-nums">{shownYear}</span>
            <button
              aria-label="Next year"
              disabled={!years.length || shownYear >= latestYear}
              onClick={() => { setYear(shownYear + 1); setPicked(null) }}
              className="p-1 rounded-lg text-ink-muted hover:bg-canvas-overlay disabled:opacity-30"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {loading ? (
            <div className="grid grid-cols-4 gap-1.5">
              {Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="h-11 rounded-lg" />)}
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-1.5" role="grid" aria-label={`Revisions in ${shownYear}`}>
              {yearMonths.map((m, i) => {
                const key = `${shownYear}-${pad(i + 1)}`
                const name = new Date(shownYear, i, 1).toLocaleDateString(undefined, { month: 'short' })
                const count = m?.count ?? 0
                const selected = picked?.month === key
                return (
                  <button
                    key={key}
                    role="gridcell"
                    aria-selected={selected}
                    aria-label={`${name} ${shownYear}: ${count} ${count === 1 ? 'revision' : 'revisions'}`}
                    disabled={count === 0}
                    onClick={() => setPicked({ month: key })}
                    className={cn(
                      'flex flex-col items-center justify-center h-11 rounded-lg text-[11px] transition-all outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70',
                      HEAT[heat(count, yearMax)],
                      count > 0 && 'hover:ring-2 hover:ring-indigo-500/40',
                      selected && 'ring-2 ring-indigo-500',
                      count === 0 && 'cursor-default',
                    )}
                  >
                    <span className="font-semibold">{name}</span>
                    <span className="text-[10px] opacity-80">{count > 0 ? count : '—'}</span>
                  </button>
                )
              })}
            </div>
          )}

          {pickedMonth && (
            <DayGrid
              month={pickedMonth}
              pickedDay={picked?.day ?? null}
              onPick={(day) => setPicked({ month: pickedMonth.month, day })}
            />
          )}

          <div className="mt-3 pt-3 border-t border-glass-border/70">
            {target ? (
              <>
                <p className="text-[12px] text-ink leading-snug">
                  As it was at the end of <span className="font-semibold">{target.label}</span>
                </p>
                <p className="text-[11px] text-ink-muted mb-2">
                  {isNow ? 'This is Published as it is now.' : `Revision #${target.seq} · ${target.count} ${target.count === 1 ? 'revision' : 'revisions'} that ${picked?.day ? 'day' : 'month'}`}
                </p>
                <div className={cn('grid gap-1.5', canOpen ? 'grid-cols-2' : 'grid-cols-1')}>
                  {canOpen && (
                    <button
                      disabled={isNow}
                      onClick={() => { onOpen(target.seq); close() }}
                      className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 disabled:opacity-40 disabled:cursor-default"
                    >
                      <Eye className="w-3.5 h-3.5" /> Open on canvas
                    </button>
                  )}
                  <button
                    disabled={isNow}
                    onClick={() => { onCompare(target.seq); close() }}
                    className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap text-indigo-700 dark:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 disabled:opacity-40 disabled:cursor-default"
                  >
                    <GitCompareArrows className="w-3.5 h-3.5" /> Compare with now
                  </button>
                </div>
                <button
                  onClick={() => { onJump(target.month); close() }}
                  className="mt-1 w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-canvas-overlay"
                >
                  <ListTree className="w-3.5 h-3.5" /> Show this month in the list
                </button>
              </>
            ) : (
              <p className="text-[11px] text-ink-muted">
                {months && months.length === 0 ? 'No revisions yet.' : 'Pick a month — darker ones saw more revisions.'}
              </p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** A month's days, Monday first, shaded by how busy each was. */
function DayGrid({ month, pickedDay, onPick }: {
  month: HistoryMonth
  pickedDay: string | null
  onPick: (day: string) => void
}) {
  const [y, m] = month.month.split('-').map(Number)
  const byDay = new Map<string, HistoryDay>(month.days.map((d) => [d.day, d]))
  const daysIn = new Date(y, m, 0).getDate()
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7
  const max = Math.max(0, ...month.days.map((d) => d.count))
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }))   // 1 Jan 2024 was a Monday
  return (
    <div className="mt-3">
      <div className="grid grid-cols-7 gap-1 mb-1">
        {weekdays.map((w, i) => (
          <span key={i} className="text-center text-[10px] font-semibold text-ink-muted/70">{w}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1" role="grid" aria-label="Revisions by day">
        {Array.from({ length: lead }, (_, i) => <span key={`lead${i}`} />)}
        {Array.from({ length: daysIn }, (_, i) => {
          const key = `${month.month}-${pad(i + 1)}`
          const d = byDay.get(key)
          const count = d?.count ?? 0
          return (
            <button
              key={key}
              role="gridcell"
              aria-selected={pickedDay === key}
              aria-label={`${i + 1}: ${count} ${count === 1 ? 'revision' : 'revisions'}`}
              disabled={count === 0}
              onClick={() => onPick(key)}
              className={cn(
                'h-7 rounded-md text-[11px] tabular-nums transition-all outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70',
                HEAT[heat(count, max)],
                count > 0 && 'hover:ring-2 hover:ring-indigo-500/40',
                pickedDay === key && 'ring-2 ring-indigo-500',
                count === 0 && 'cursor-default',
              )}
            >
              {i + 1}
            </button>
          )
        })}
      </div>
    </div>
  )
}
