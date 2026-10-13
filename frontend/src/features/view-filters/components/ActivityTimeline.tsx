/**
 * Timeline — how many views were created (or updated) on each of the last 90 days,
 * as a slim bar strip you can drag across to filter by date. ("Timeline", not
 * "Activity": the workspace tab already has a Recent activity feed of events.)
 *
 * It answers the question the Date menu can only guess at: WHEN did things happen?
 * A spike says "something was published on Tuesday"; a gap says "nothing changed
 * for a month". And it is the quickest way to pick a period — drag across the
 * bars, or click one day — which writes the same date rule the menu would, so the
 * list, the chips and the menu all agree.
 *
 * Built to the repo's chart rules (components/analytics/charts/chartTheme.ts): one
 * series, so no legend — the title names it; thin bars from one baseline with a
 * 2px gap; recessive month ticks; a value-first tooltip on the hovered bar; while
 * the next filters load, the previous picture stays, dimmed, instead of a skeleton.
 * The keyboard reaches everything the pointer can: arrows move a day cursor that is
 * read out, Shift extends a range, Enter applies it, Escape lets go.
 */
import { useId, useMemo, useRef, useState } from 'react'
import { Activity, ChevronDown, RotateCcw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { keyboardScopeProps } from '@/lib/keyboardScope'
import { Segmented } from '@/components/ui/Segmented'
import { MARK, useChartTheme, useChartWidth } from '@/components/analytics/charts/chartTheme'
import { describeRule, localDay, localMidnight, rangeRule, ruleDays } from '../dateFilter'
import { ACTIVITY_DAYS, useDayActivity } from '../hooks'
import type { DateField, ViewFilterState } from '../model'
import type { ResolveContext } from '../params'

const CHART_H = 56
/** A month label needs this much room before the axis's end, where "Today"
 *  sits: its own width and Today's, with a gap between. */
const TICK_CLEARANCE = 60
const AXIS_H = 16

const VERB: Record<DateField, string> = { created: 'created', updated: 'updated' }

function dayLabel(day: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return localMidnight(day).toLocaleDateString(undefined, opts)
}

/** A bar rounded at its data end and square at the baseline. */
function barPath(x: number, base: number, w: number, h: number): string {
  const r = Math.min(MARK.barRadius, w / 2, h)
  const top = base - h
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`
}

export function ActivityTimeline({
  field, onFieldChange, state, ctx, onSelectRule,
  collapsed, onCollapsedChange, visitFrom, className,
}: {
  field: DateField
  onFieldChange: (field: DateField) => void
  /** All the filters. The strip counts with every one but this field's own rule,
   *  which it draws as the selection instead. */
  state: ViewFilterState
  ctx: ResolveContext
  onSelectRule: (rule: string | null) => void
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  /** Start of "since your last visit", marked on the strip when known. */
  visitFrom?: string | null
  className?: string
}) {
  const theme = useChartTheme()
  const [chartRef, width] = useChartWidth()
  const liveId = useId()
  const color = field === 'updated' ? theme.series[0] : theme.series[2]
  const today = ctx.today
  const rule = state[field]

  const { days, counts, histogram } = useDayActivity(state, ctx, field, !collapsed)
  const values = useMemo(() => days.map(d => counts.get(d) ?? 0), [days, counts])
  const total = values.reduce((a, b) => a + b, 0)
  const max = Math.max(1, ...values)

  // The selection the current rule paints; a drag or keyboard range overrides it.
  const span = rule ? ruleDays(rule, today) : null
  const [drag, setDrag] = useState<{ anchor: number; current: number } | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const [keyAnchor, setKeyAnchor] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const dragging = useRef(false)

  const live = drag
    ? { lo: Math.min(drag.anchor, drag.current), hi: Math.max(drag.anchor, drag.current) }
    : keyAnchor !== null && cursor !== null
      ? { lo: Math.min(keyAnchor, cursor), hi: Math.max(keyAnchor, cursor) }
      : null
  const inSelection = (i: number): boolean => {
    if (live) return i >= live.lo && i <= live.hi
    if (!span) return true
    const d = days[i]
    return (!span.from || d >= span.from) && (!span.to || d <= span.to)
  }
  const hasSelection = Boolean(live || span)
  const selectedTotal = values.reduce((sum, v, i) => (inSelection(i) ? sum + v : sum), 0)

  const slot = width / days.length
  const barW = Math.max(1, Math.min(MARK.maxBarWidth, slot - MARK.surfaceGap))
  const xOf = (i: number) => i * slot + (slot - barW) / 2
  const indexAt = (clientX: number) => {
    const rect = chartRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.max(0, Math.min(days.length - 1, Math.floor(((clientX - rect.left) / rect.width) * days.length)))
  }

  const commit = (lo: number, hi: number) => {
    onSelectRule(rangeRule(days[lo], days[hi]))
    setKeyAnchor(null)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = cursor ?? days.length - 1
    const move = (to: number) => {
      e.preventDefault()
      const next = Math.max(0, Math.min(days.length - 1, to))
      if (e.shiftKey && keyAnchor === null) setKeyAnchor(at)
      if (!e.shiftKey) setKeyAnchor(null)
      setCursor(next)
    }
    if (e.key === 'ArrowLeft') move(at - 1)
    else if (e.key === 'ArrowRight') move(at + 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(days.length - 1)
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (keyAnchor !== null) commit(Math.min(keyAnchor, at), Math.max(keyAnchor, at))
      else commit(at, at)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (keyAnchor !== null) setKeyAnchor(null)
      else if (rule) onSelectRule(null)
    }
  }

  const readout = cursor !== null
    ? `${dayLabel(days[cursor])}: ${values[cursor]} view${values[cursor] === 1 ? '' : 's'} ${VERB[field]}`
      + (live ? `. Range ${dayLabel(days[live.lo], { day: 'numeric', month: 'short' })} to ${dayLabel(days[live.hi], { day: 'numeric', month: 'short' })}, press Enter to apply.` : '')
    : ''

  const visitIndex = visitFrom ? days.indexOf(localDay(new Date(visitFrom))) : -1
  const tip = hover ?? (cursor !== null ? cursor : null)
  const loading = histogram.isPending && !histogram.data
  const refetching = histogram.isFetching && histogram.isPlaceholderData

  return (
    <section
      {...keyboardScopeProps('activity-timeline')}
      aria-label="Timeline"
      className={cn('rounded-2xl border border-glass-border bg-canvas-elevated px-4 py-3', className)}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-lg border border-indigo-500/20 bg-indigo-500/10">
            <Activity className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
          </div>
          <h2 className="text-sm font-bold text-ink">Timeline</h2>
        </div>
        {!collapsed && (
          <Segmented
            label="Which date the strip counts"
            value={field}
            onChange={onFieldChange}
            options={[
              { value: 'created', label: 'Created' },
              { value: 'updated', label: 'Updated' },
            ]}
          />
        )}
        {!collapsed && (
          <p className="min-w-0 basis-full text-[11px] text-ink-muted sm:basis-auto sm:flex-1 sm:truncate" aria-live="polite">
            {loading ? 'Counting…'
              : histogram.isError ? null
                : hasSelection && rule && !live
                  ? <><span className="font-semibold tabular-nums text-ink">{selectedTotal.toLocaleString()}</span> {VERB[field]} · {describeRule(rule, today)}</>
                  : <><span className="font-semibold tabular-nums text-ink">{total.toLocaleString()}</span> view{total === 1 ? '' : 's'} {VERB[field]} in the past {ACTIVITY_DAYS} days</>}
          </p>
        )}
        {!collapsed && rule && (
          <button
            type="button"
            onClick={() => onSelectRule(null)}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
          >
            <X className="h-3 w-3" /> Clear dates
          </button>
        )}
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => onCollapsedChange(!collapsed)}
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors',
          )}
        >
          {collapsed ? 'Show timeline' : 'Hide'}
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-150', !collapsed && 'rotate-180')} />
        </button>
      </div>

      {!collapsed && (
        <div className="mt-2">
          {histogram.isError ? (
            <div className="flex h-[72px] items-center justify-center gap-2 text-[11px] text-ink-muted">
              Couldn&rsquo;t load the activity.
              <button
                type="button"
                onClick={() => void histogram.refetch()}
                className="inline-flex items-center gap-1 font-semibold text-ink-secondary hover:text-ink"
              >
                <RotateCcw className="h-3 w-3" /> Try again
              </button>
            </div>
          ) : (
            <div
              ref={chartRef}
              role="group"
              tabIndex={0}
              aria-roledescription="activity chart"
              aria-label={`Views ${VERB[field]} each day over the past ${ACTIVITY_DAYS} days. Arrow keys move between days, Shift extends a range, Enter filters to it.`}
              aria-describedby={liveId}
              onKeyDown={onKeyDown}
              onFocus={() => { if (cursor === null) setCursor(days.length - 1) }}
              onBlur={() => { setCursor(null); setKeyAnchor(null) }}
              onPointerDown={e => {
                if (e.button !== 0) return
                dragging.current = true
                const i = indexAt(e.clientX)
                setDrag({ anchor: i, current: i })
                e.currentTarget.setPointerCapture?.(e.pointerId)
              }}
              onPointerMove={e => {
                const i = indexAt(e.clientX)
                setHover(i)
                if (dragging.current) setDrag(d => (d ? { ...d, current: i } : d))
              }}
              onPointerUp={() => {
                if (!dragging.current || !drag) return
                dragging.current = false
                commit(Math.min(drag.anchor, drag.current), Math.max(drag.anchor, drag.current))
                setDrag(null)
              }}
              onPointerCancel={() => { dragging.current = false; setDrag(null) }}
              onPointerLeave={() => setHover(null)}
              onDoubleClick={() => onSelectRule(null)}
              className={cn(
                'relative cursor-crosshair select-none touch-none rounded-lg outline-none',
                'focus-visible:ring-2 focus-visible:ring-indigo-500/40',
                refetching && 'opacity-60 transition-opacity',
              )}
            >
              <svg width={width} height={CHART_H + AXIS_H} className="block overflow-visible" aria-hidden>
                {/* The selected stretch, behind the bars. */}
                {hasSelection && (() => {
                  const sel = values.map((_, i) => inSelection(i))
                  const lo = sel.indexOf(true)
                  const hi = sel.lastIndexOf(true)
                  if (lo < 0 || (lo === 0 && hi === days.length - 1 && !live && !span?.from)) return null
                  return (
                    <rect
                      x={lo * slot} y={0} width={(hi - lo + 1) * slot} height={CHART_H}
                      rx={6} fill={color} opacity={0.08}
                    />
                  )
                })()}
                <line x1={0} x2={width} y1={CHART_H + 0.5} y2={CHART_H + 0.5} stroke={theme.grid} />
                {values.map((v, i) => {
                  if (loading) {
                    const h = 6 + ((i * 37) % 23)
                    return <path key={days[i]} d={barPath(xOf(i), CHART_H, barW, h)} fill={theme.muted} opacity={0.5} />
                  }
                  if (v === 0) return null
                  const h = Math.max(2, (v / max) * (CHART_H - 4))
                  return (
                    <path
                      key={days[i]}
                      d={barPath(xOf(i), CHART_H, barW, h)}
                      fill={color}
                      opacity={hasSelection && !inSelection(i) ? MARK.ghostOpacity : (tip === i ? 0.85 : 1)}
                      className="transition-opacity duration-150"
                    />
                  )
                })}
                {/* "You were here" — the start of since-your-last-visit. */}
                {visitIndex >= 0 && (
                  <g>
                    <line
                      x1={visitIndex * slot} x2={visitIndex * slot} y1={0} y2={CHART_H}
                      stroke={theme.muted} strokeDasharray="0" strokeWidth={1}
                    />
                    <circle cx={visitIndex * slot} cy={2} r={2.5} fill={theme.muted} />
                  </g>
                )}
                {/* The day cursor, for keyboard readers. */}
                {cursor !== null && (
                  <rect
                    x={cursor * slot} y={0} width={slot} height={CHART_H}
                    fill="none" stroke={color} strokeWidth={1} rx={3}
                  />
                )}
                {/* A month that starts in the last few days would sit on
                    "Today"; the later label wins. */}
                {days.map((d, i) => (d.endsWith('-01') || i === 0) && i * slot < width - TICK_CLEARANCE && (
                  <text
                    key={`tick-${d}`} x={i * slot + 1} y={CHART_H + 12}
                    className="fill-current text-ink-muted" fontSize={10}
                  >
                    {dayLabel(d, { month: 'short' })}
                  </text>
                ))}
                <text x={width} y={CHART_H + 12} textAnchor="end" className="fill-current text-ink-muted" fontSize={10}>
                  Today
                </text>
              </svg>

              {!loading && total === 0 && (
                <p className="pointer-events-none absolute inset-x-0 top-4 text-center text-[11px] text-ink-muted">
                  No views {VERB[field]} in the past {ACTIVITY_DAYS} days{rule ? ' with these filters' : ''}.
                </p>
              )}

              {/* Value first, then what and when — the reader has the series and
                  wants the number. */}
              {tip !== null && !loading && (
                <div
                  className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-black/[0.08] dark:border-white/[0.1] bg-canvas-elevated px-2.5 py-1.5 text-center shadow-lg"
                  style={{ left: Math.min(Math.max(tip * slot + slot / 2, 60), width - 60), top: -4 }}
                >
                  <div className="text-xs font-bold tabular-nums text-ink">
                    {values[tip].toLocaleString()} view{values[tip] === 1 ? '' : 's'}
                  </div>
                  <div className="whitespace-nowrap text-[10px] text-ink-muted">
                    {VERB[field]} · {dayLabel(days[tip])}
                  </div>
                </div>
              )}
            </div>
          )}
          <p id={liveId} className="sr-only" aria-live="polite">{readout}</p>
        </div>
      )}
    </section>
  )
}
