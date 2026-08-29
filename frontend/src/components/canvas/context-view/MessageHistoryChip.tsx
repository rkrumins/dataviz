/**
 * MessageHistoryChip — the toasts you missed.
 *
 * A toast lives 4.5 seconds and the app fires hundreds of them; a user who
 * looked away, or who was reading the canvas when three fired at once, has no
 * way back to what they said. This chip sits in the canvas status cluster and
 * opens the messages that appeared in THIS view, newest first.
 *
 * Scope is the open view: CanvasRouter clears the log whenever the active view
 * or branch changes, and nothing is persisted — a refresh starts clean.
 *
 * Anchoring follows TraceHistoryPanel (portal to body + `position: fixed`
 * against the trigger's measured rect) with one change: the rect is measured
 * during render from a callback-ref element, and a `useSyncExternalStore`
 * viewport tick re-renders on resize/scroll. No setState inside an effect.
 * No AnimatePresence exit — an interrupted exit on a portaled surface strands
 * an invisible click-blocker.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { History, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/relativeTime'
import { iconColors, iconComponents, useToastStore, type ToastHistoryEntry } from '@/components/ui/toast'

// ── Viewport tick ──────────────────────────────────────────────────────────
// A counter bumped on resize/scroll (capture phase, so scrolling containers
// count too). Subscribers re-render, which re-measures the anchor.

let viewportTick = 0
const viewportSubscribers = new Set<() => void>()

function bumpViewport() {
  viewportTick += 1
  viewportSubscribers.forEach(fn => fn())
}

function subscribeViewport(onChange: () => void) {
  if (viewportSubscribers.size === 0) {
    window.addEventListener('resize', bumpViewport)
    window.addEventListener('scroll', bumpViewport, true)
  }
  viewportSubscribers.add(onChange)
  return () => {
    viewportSubscribers.delete(onChange)
    if (viewportSubscribers.size === 0) {
      window.removeEventListener('resize', bumpViewport)
      window.removeEventListener('scroll', bumpViewport, true)
    }
  }
}

const getViewportTick = () => viewportTick

// ── Rows ───────────────────────────────────────────────────────────────────

interface MessageRow {
  entry: ToastHistoryEntry
  count: number
}

/**
 * Fold runs of the identical adjacent message into one row. The same message
 * fired five times is one thing that happened five times, not five things.
 * History is newest-first, so the row keeps the NEWEST timestamp.
 */
function foldRuns(history: ToastHistoryEntry[]): MessageRow[] {
  const rows: MessageRow[] = []
  for (const entry of history) {
    const last = rows[rows.length - 1]
    if (last && last.entry.message === entry.message && last.entry.type === entry.type) last.count += 1
    else rows.push({ entry, count: 1 })
  }
  return rows
}

// ── Chip ───────────────────────────────────────────────────────────────────

export function MessageHistoryChip({ className }: { className?: string }) {
  const history = useToastStore(s => s.history)
  const clearHistory = useToastStore(s => s.clearHistory)
  const [open, setOpen] = useState(false)
  const [chipEl, setChipEl] = useState<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const tick = useSyncExternalStore(subscribeViewport, getViewportTick)

  // Escape closes (window-level so it works before focus lands inside).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Outside mousedown closes; the chip is excluded so its click toggles cleanly.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (panelRef.current?.contains(target)) return
      if (chipEl?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open, chipEl])

  // Anchored above the chip's right edge. `tick` is the dependency that makes
  // resize/scroll re-measure — it is read for exactly that reason.
  const anchor = useMemo(() => {
    if (!open || !chipEl) return null
    void tick
    const rect = chipEl.getBoundingClientRect()
    return { right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.top + 8 }
  }, [open, chipEl, tick])

  const rows = useMemo(() => foldRuns(history), [history])

  // Nothing to show — and the panel must not survive the emptying. The chip
  // unmounts but the component instance does not (its sibling status chips keep
  // it rendered), so an `open` left standing would spring the panel back over
  // the canvas the moment the next toast refills the log. Reset during render,
  // not in an effect.
  if (history.length === 0) {
    if (open) setOpen(false)
    return null
  }

  return (
    <>
      <button
        type="button"
        ref={setChipEl}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        title="Messages that appeared in this view"
        className={cn(className, 'cursor-pointer hover:scale-105 active:scale-95 transition-transform')}
      >
        <History className="w-3 h-3 text-ink-muted/70" />
        {/* One span, one space: the accessible name must read "3 messages",
            not the "3messages" that adjacent flex children would produce. */}
        <span>
          <span className="tabular-nums">{history.length.toLocaleString()}</span>{' '}
          <span className="text-ink-muted/70">{history.length === 1 ? 'message' : 'messages'}</span>
        </span>
      </button>

      {anchor && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Messages in this view"
          data-canvas-interactive
          style={{ position: 'fixed', right: anchor.right, bottom: anchor.bottom, zIndex: 1000 }}
          className="w-80 rounded-xl bg-canvas-elevated border border-glass-border shadow-lg overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-glass-border/40">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-ink-muted">
              Messages in this view
            </span>
          </div>

          <ul className="max-h-[320px] overflow-y-auto custom-scrollbar">
            {rows.map(({ entry, count }) => {
              const Icon = iconComponents[entry.type]
              return (
                <li
                  key={entry.id}
                  className="flex items-start gap-2 px-3 py-2 border-b border-glass-border/20 last:border-b-0"
                >
                  <Icon className={cn('w-3.5 h-3.5 mt-0.5 flex-shrink-0', iconColors[entry.type])} />
                  <span className="flex-1 min-w-0 text-xs leading-snug text-ink break-words">
                    {entry.message}
                    {count > 1 && (
                      <span className="ml-1.5 inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold bg-black/5 dark:bg-white/10 text-ink-muted align-middle">
                        ×{count}
                      </span>
                    )}
                  </span>
                  <span className="flex-shrink-0 text-[10px] tabular-nums text-ink-muted/70">
                    {relativeTime(entry.createdAt)}
                  </span>
                </li>
              )
            })}
          </ul>

          <div className="flex items-center justify-between px-3 py-1.5 border-t border-glass-border/40">
            <span className="text-[10px] text-ink-muted/70">Only this view, this session</span>
            <button
              type="button"
              onClick={clearHistory}
              className="inline-flex items-center gap-1 text-[10px] font-medium text-ink-muted hover:text-ink hover:underline"
            >
              <Trash2 className="w-3 h-3" />
              Clear
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
