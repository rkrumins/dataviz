/**
 * DataLoadsPanel — what the open view has fetched this session, in the order
 * it happened.
 *
 * It is called Data loads, not Activity: the view has an Activity of its own —
 * its audit history, in the page header — and two things called the same word
 * in one screen is one thing too many. This is the fetching, not the editing.
 *
 * A notification lives 4.5 seconds and the app fires hundreds of them; a user
 * who looked away, or who was reading the canvas when three fired at once, has
 * no way back to what they said. This panel is that way back.
 *
 * It is docked directly ABOVE the Connections panel in the canvas's
 * bottom-right stack, and deliberately so: the log used to open from a chip in
 * the status cluster (z-30) that an expanded Connections body (z-40) grew up
 * over and covered — the chip could not be clicked at all. Flex siblings in a
 * bottom-anchored column cannot occlude each other, whichever one opens.
 *
 * The surface is ConnectionsPanel's, on purpose, so the two read as one dock:
 * an opaque elevated card (no backdrop blur — a blurred surface that animates
 * its height inside this band ghosts the Chromium "white strip"), a collapsed
 * header that is the panel's whole footprint, and an entrance-only animation
 * with no exit to strand a click-blocker.
 *
 * Order is NEWEST FIRST — the thing you just did is the thing you look for, and
 * scroller opens and the only card wearing a ring. Scope is the open view:
 * CanvasRouter clears the log whenever the active view or branch changes, and
 * nothing is persisted — a refresh starts clean.
 *
 * Each entry is a CARD, deliberately shaped like the NotificationCard it
 * records — the same 320px column, the same status colour, the same message
 * on one line — one size down. It used to be a flat 12px row in a 256px box
 * carrying TWO indicators: a timeline rail dot AND a status icon, saying the
 * same thing twice. With the cards in order and a time on every one, the rail
 * said nothing the sequence did not, so it is gone and the icon stayed.
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { motion } from 'framer-motion'
import { ChevronDown, ChevronUp, History, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/relativeTime'
import { iconColors, iconComponents, useNotificationStore, type NotificationHistoryEntry } from '@/components/ui/notifications'

/**
 * A coarse clock for the open panel. `relativeTime` is computed at render, so
 * without this a panel left open reads "just now" forever — on the one surface
 * whose job is answering "how long ago?". Ticking every 30s keeps the minute
 * boundary honest; nothing subscribes while the panel is closed.
 */
let clockTick = 0
const clockSubscribers = new Set<() => void>()
let clockTimer: ReturnType<typeof setInterval> | null = null

function subscribeClock(onChange: () => void): () => void {
  clockSubscribers.add(onChange)
  if (clockTimer === null) {
    clockTimer = setInterval(() => {
      clockTick += 1
      clockSubscribers.forEach(fn => fn())
    }, 30_000)
  }
  return () => {
    clockSubscribers.delete(onChange)
    if (clockSubscribers.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
}
const getClockTick = () => clockTick
const subscribeNothing = () => () => {}

interface DataLoadRow {
  entry: NotificationHistoryEntry
  count: number
  /** The run's LATEST occurrence — the row answers "when did this last happen?" */
  at: number
}

/**
 * Fold runs of the identical adjacent message into one row. The same message
 * fired five times is one thing that happened five times, not five things.
 * The input is newest-first, so a run's FIRST entry is its newest — which is
 * the time the row shows.
 */
function foldRuns(newestFirst: NotificationHistoryEntry[]): DataLoadRow[] {
  const rows: DataLoadRow[] = []
  for (const entry of newestFirst) {
    const last = rows[rows.length - 1]
    if (last && last.entry.message === entry.message && last.entry.type === entry.type) {
      last.count += 1
    } else {
      rows.push({ entry, count: 1, at: entry.createdAt })
    }
  }
  return rows
}

export function DataLoadsPanel({ className }: { className?: string }) {
  const history = useNotificationStore(s => s.history)
  const clearHistory = useNotificationStore(s => s.clearHistory)
  const [isExpanded, setIsExpanded] = useState(false)
  const bodyId = useId()

  // The store already keeps the log newest-first, and so does this panel: the
  // newest is what a reader came for, and having to scroll to reach it is the
  // one thing a log must never make you do. It also matches the live stack,
  // where the newest card sits on top.
  const rows = useMemo(() => foldRuns(history), [history])

  // Capped at ~7 rows (max-h-52): a load can raise dozens of messages, and a
  // log tall enough to span the canvas is a wall, not a surface. The rest is
  // one scroll away — and because the newest is first, an opened log already
  // shows it without scrolling anywhere.
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  // Times must keep counting while the panel is open, or the answer to "how
  // long ago?" freezes at whatever it was when the log was opened.
  useSyncExternalStore(isExpanded ? subscribeClock : subscribeNothing, getClockTick, getClockTick)

  // A message arriving while the log is open lands at the TOP. Follow it — but
  // only for a reader who was already there; never yank someone who has
  // scrolled down to read. A DOM write in an effect, not a state update.
  useEffect(() => {
    const el = scrollerRef.current
    if (el && el.scrollTop < 24) el.scrollTop = 0
  }, [rows])

  // Nothing to show — and the panel must not survive the emptying. The panel
  // unmounts but the component instance does not (the dock keeps it rendered
  // beside Connections), so an `isExpanded` left standing would spring the log
  // back open over the canvas the moment the next notification refills it. Reset
  // during render, not in an effect.
  if (history.length === 0) {
    if (isExpanded) setIsExpanded(false)
    return null
  }

  return (
    <div
      className={cn(
        'bg-canvas-elevated border border-glass-border shadow-lg rounded-xl overflow-hidden',
        className,
      )}
    >
      <button
        type="button"
        data-dock-header
        aria-expanded={isExpanded}
        aria-controls={bodyId}
        title="What this view has loaded"
        onClick={() => setIsExpanded(v => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
      >
        <span className="flex items-center gap-2 min-w-0">
          <History className="w-4 h-4 text-accent-lineage flex-shrink-0" />
          <span className="text-sm font-medium text-ink">Data loads</span>
          <span
            aria-label={`${history.length.toLocaleString()} ${history.length === 1 ? 'message' : 'messages'}`}
            className="text-2xs text-ink-muted px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5 tabular-nums whitespace-nowrap"
          >
            {history.length.toLocaleString()}
          </span>
        </span>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 text-ink-muted flex-shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-ink-muted flex-shrink-0" />
        )}
      </button>

      {isExpanded && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          transition={{ duration: 0.18 }}
          className="overflow-hidden"
        >
          <div id={bodyId} role="region" aria-label="Data loads" className="px-3 pb-3">
            <div ref={scrollerRef} className="max-h-52 overflow-y-auto custom-scrollbar">
              <ol role="list" className="flex flex-col gap-1.5">
                {rows.map(({ entry, count, at }, i) => {
                  const Icon = iconComponents[entry.type]
                  const isNewest = i === 0
                  return (
                    <li
                      key={entry.id}
                      className={cn(
                        'relative overflow-hidden rounded-lg border border-glass-border px-3 py-2.5',
                        'flex items-start gap-2.5 transition-colors',
                        // The newest card is the answer to "where did I get
                        // to" — a ring, readable without reading a time.
                        isNewest
                          ? 'bg-black/[0.05] dark:bg-white/[0.07] ring-1 ring-inset ring-glass-border'
                          : 'bg-black/[0.02] dark:bg-white/[0.03] hover:bg-black/[0.04] dark:hover:bg-white/[0.05]',
                      )}
                    >
                      {/* A notification wears its status as a bar along the
                          bottom; at this scale it is a 2px stripe down the
                          left. `bg-current` takes the colour from the same
                          `iconColors` the card uses. */}
                      <span
                        aria-hidden
                        data-accent
                        className={cn('absolute inset-y-0 left-0 w-0.5 bg-current', iconColors[entry.type])}
                      />
                      <Icon className={cn('w-4 h-4 mt-px flex-shrink-0', iconColors[entry.type])} />
                      <span className="flex-1 min-w-0 text-[13px] leading-snug text-ink break-words">
                        {entry.message}
                        {count > 1 && (
                          <span className="ml-1.5 inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold bg-black/5 dark:bg-white/10 text-ink-muted align-middle">
                            ×{count}
                          </span>
                        )}
                      </span>
                      <time
                        dateTime={new Date(at).toISOString()}
                        title={new Date(at).toLocaleTimeString()}
                        className="flex-shrink-0 mt-0.5 text-[11px] tabular-nums text-ink-muted whitespace-nowrap"
                      >
                        {relativeTime(at)}
                      </time>
                    </li>
                  )
                })}
              </ol>
            </div>

            <div className="mt-2 pt-2 border-t border-glass-border flex items-center justify-between gap-2">
              <span className="text-[10px] text-ink-muted">This view · this session</span>
              <button
                type="button"
                onClick={clearHistory}
                className="inline-flex items-center gap-1 text-2xs font-medium text-accent-lineage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 rounded"
              >
                <Trash2 className="w-3 h-3" />
                Clear
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  )
}

export default DataLoadsPanel
