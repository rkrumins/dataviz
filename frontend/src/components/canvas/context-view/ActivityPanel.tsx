/**
 * ActivityPanel — the notifications you missed, in the order they happened.
 *
 * A notification lives 4.5 seconds and the app fires hundreds of them; a user who
 * looked away, or who was reading the canvas when three fired at once, has no
 * way back to what they said. This panel is that way back.
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
 * Order is OLDEST FIRST — a sequence, read down a timeline rail, with the
 * newest at the bottom where the scroller opens. Scope is the open view:
 * CanvasRouter clears the log whenever the active view or branch changes, and
 * nothing is persisted — a refresh starts clean.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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

interface ActivityRow {
  entry: NotificationHistoryEntry
  count: number
  /** The run's LATEST occurrence — the row answers "when did this last happen?" */
  at: number
}

/**
 * Fold runs of the identical adjacent message into one row. The same message
 * fired five times is one thing that happened five times, not five things.
 * The input is oldest-first, so the run's last entry is its newest.
 */
function foldRuns(oldestFirst: NotificationHistoryEntry[]): ActivityRow[] {
  const rows: ActivityRow[] = []
  for (const entry of oldestFirst) {
    const last = rows[rows.length - 1]
    if (last && last.entry.message === entry.message && last.entry.type === entry.type) {
      last.count += 1
      last.at = entry.createdAt
    } else {
      rows.push({ entry, count: 1, at: entry.createdAt })
    }
  }
  return rows
}

export function ActivityPanel({ className }: { className?: string }) {
  const history = useNotificationStore(s => s.history)
  const clearHistory = useNotificationStore(s => s.clearHistory)
  const [isExpanded, setIsExpanded] = useState(false)
  const bodyId = useId()

  // The store keeps the log newest-first; the sequence reads the other way.
  const rows = useMemo(() => foldRuns([...history].reverse()), [history])

  // Capped at ~7 rows (max-h-52): a load can raise dozens of messages, and a
  // log tall enough to span the canvas is a wall, not a surface. The rest is
  // one scroll away.
  // The newest row is at the BOTTOM, so that is where an opened log starts.
  // A callback ref on the scroller does it as the element mounts — there is
  // no state here, and `react-hooks/set-state-in-effect` is an error in this
  // repo for good reason.
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const openAtNewest = useCallback((el: HTMLDivElement | null) => {
    scrollerRef.current = el
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // Times must keep counting while the panel is open, or the answer to "how
  // long ago?" freezes at whatever it was when the log was opened.
  useSyncExternalStore(isExpanded ? subscribeClock : subscribeNothing, getClockTick, getClockTick)

  // A message arriving while the log is open lands below the fold. Follow it —
  // but only for a reader who was already at the bottom; never yank someone who
  // has scrolled up to read. A DOM write in an effect, not a state update.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) el.scrollTop = el.scrollHeight
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
        title="Messages from loading this view"
        onClick={() => setIsExpanded(v => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
      >
        <span className="flex items-center gap-2 min-w-0">
          <History className="w-4 h-4 text-accent-lineage flex-shrink-0" />
          <span className="text-sm font-medium text-ink">Activity</span>
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
          <div id={bodyId} role="region" aria-label="Activity" className="px-3 pb-3">
            <div ref={openAtNewest} className="max-h-52 overflow-y-auto custom-scrollbar">
              <ol role="list" className="relative pl-1">
                {/* The rail the dots hang on. */}
                <span aria-hidden className="absolute left-[7px] top-2 bottom-2 w-px bg-glass-border" />
                {rows.map(({ entry, count, at }, i) => {
                  const Icon = iconComponents[entry.type]
                  const isNewest = i === rows.length - 1
                  return (
                    <li
                      key={entry.id}
                      className="relative flex items-start gap-2 pl-5 pr-1 py-1.5 rounded-lg hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
                    >
                      {/* The newest event wears a halo, so "where did I get to"
                          is answerable at a glance without reading a time. */}
                      {isNewest && (
                        <span
                          aria-hidden
                          className={cn(
                            'absolute -left-[3px] top-2 w-3 h-3 rounded-full bg-current opacity-20',
                            iconColors[entry.type],
                          )}
                        />
                      )}
                      <span
                        aria-hidden
                        className={cn(
                          'absolute left-0 top-[11px] w-1.5 h-1.5 rounded-full bg-current',
                          iconColors[entry.type],
                        )}
                      />
                      <Icon className={cn('w-3 h-3 mt-0.5 flex-shrink-0', iconColors[entry.type])} />
                      <span className="flex-1 min-w-0 text-xs leading-snug text-ink break-words">
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
                        className="flex-shrink-0 text-[10px] tabular-nums text-ink-muted whitespace-nowrap"
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

export default ActivityPanel
