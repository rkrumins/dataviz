/**
 * TraceHistoryPanel — "pick up where you left off".
 *
 * The launcher under the header's Trace Lineage control: this user's
 * trace trails in THIS view, newest first, resumable in one click.
 * Each row leads with its direction glyph in the EXACT colors the trace
 * wires draw — cyan feeds in (Root Cause), amber flows out (Impact),
 * violet both (Full Lineage) — so the palette teaches the vocabulary
 * before the canvas ever shows it.
 *
 * Purely presentational: entries arrive resolved (label + mode +
 * timestamp + STACK index), resume/clear/close are callbacks. Portaled
 * and fixed-anchored below the trigger (no AnimatePresence exit — an
 * interrupted exit must never strand an invisible click-blocker). An
 * empty history is an invitation to act, never a blank.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ArrowUpLeft, ArrowDownRight, Check, GitBranch, History, Link2, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/relativeTime'

export interface TraceHistoryPanelEntry {
  /** Index into the underlying history STACK (not the display order). */
  index: number
  label: string
  mode: 'up' | 'down' | 'both'
  timestamp: number
}

export interface TraceHistoryPanelProps {
  /** Newest first. */
  entries: TraceHistoryPanelEntry[]
  onResume: (index: number) => void
  onClear: () => void
  onClose: () => void
  /** The launcher control — the panel anchors below it. */
  triggerRef: React.RefObject<HTMLElement | null>
  /** A link that reopens the entry at this stack index, or null when there
   *  is nothing to link to. Absent = no share action on the rows, which is
   *  what a host that cannot build links gets. */
  onCopyLink?: (index: number) => string | null
}

const MODE_GLYPH = {
  up: { Icon: ArrowUpLeft, tone: 'text-cyan-600 dark:text-cyan-400 bg-cyan-500/10', title: 'Root Cause — upstream' },
  down: { Icon: ArrowDownRight, tone: 'text-amber-600 dark:text-amber-400 bg-amber-500/10', title: 'Impact — downstream' },
  both: { Icon: GitBranch, tone: 'text-violet-600 dark:text-violet-400 bg-violet-500/10', title: 'Full Lineage — both directions' },
} as const

export function TraceHistoryPanel({
  entries,
  onResume,
  onClear,
  onClose,
  triggerRef,
  onCopyLink,
}: TraceHistoryPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  /** Which row just yielded a link, and whether the clipboard took it. The
   *  confirmation lives on the row itself: a notification for a two-word answer is
   *  more interruption than the gesture is worth. */
  const [copied, setCopied] = useState<{ index: number; ok: boolean } | null>(null)
  const copy = async (index: number) => {
    const link = onCopyLink?.(index)
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied({ index, ok: true })
    } catch {
      setCopied({ index, ok: false })
    }
    window.setTimeout(() => setCopied(null), 1800)
  }

  // Escape closes (window-level so it works before focus lands inside).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Outside-click closes; the trigger toggles cleanly.
  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (panelRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [onClose, triggerRef])

  // Anchored below the trigger's right edge (the header sits at the top).
  const [anchor, setAnchor] = useState<{ right: number; top: number } | null>(null)
  useEffect(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setAnchor({ right: window.innerWidth - rect.right, top: rect.bottom + 8 })
  }, [triggerRef])
  if (!anchor) return null

  return createPortal(
    <motion.div
      ref={panelRef}
      data-canvas-interactive
      role="menu"
      aria-label="Trace history"
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      style={{ position: 'fixed', right: anchor.right, top: anchor.top, zIndex: 1000 }}
      className={cn(
        'w-[300px] py-1.5 rounded-xl overflow-hidden',
        'bg-canvas-elevated/98 backdrop-blur-2xl',
        'border border-glass-border shadow-glass-lg',
      )}
    >
      <div className="px-3.5 pt-1.5 pb-2 border-b border-glass-border/40">
        <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-ink-muted">
          <History className="w-3 h-3" />
          Pick up where you left off
        </span>
      </div>

      {entries.length === 0 ? (
        <p className="px-3.5 py-3 text-xs leading-relaxed text-ink-muted">
          Select an entity, then Trace Lineage maps its whole flow.
          Your traces in this view will appear here, ready to resume.
        </p>
      ) : (
        <>
          <div className="max-h-[300px] overflow-y-auto py-1">
            {entries.map((e) => {
              const glyph = MODE_GLYPH[e.mode]
              const justCopied = copied?.index === e.index
              return (
                <div
                  key={`${e.index}-${e.timestamp}`}
                  className="group/row flex items-stretch hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                >
                  <button
                    type="button"
                    role="menuitem"
                    data-history-resume
                    onClick={() => onResume(e.index)}
                    title={`Resume — ${glyph.title}`}
                    className="flex-1 min-w-0 flex items-center gap-2.5 pl-3.5 pr-2 py-2 text-left focus-visible:outline-none focus-visible:bg-black/[0.04] dark:focus-visible:bg-white/[0.06]"
                  >
                    <span
                      data-mode={e.mode}
                      className={cn('flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0', glyph.tone)}
                    >
                      <glyph.Icon className="w-3.5 h-3.5" strokeWidth={2.2} />
                    </span>
                    <span className="flex-1 min-w-0 truncate text-xs font-medium text-ink">{e.label}</span>
                    <span className="flex-shrink-0 text-[10px] tabular-nums text-ink-muted/70">
                      {relativeTime(e.timestamp)}
                    </span>
                  </button>
                  {/* HAND IT OVER WITHOUT OPENING IT. The trace worth sending
                      is often not the one on screen, and opening it first
                      just to copy a link is a walk nobody needed. */}
                  {onCopyLink && (
                    <button
                      type="button"
                      role="menuitem"
                      data-history-share
                      aria-label={justCopied
                        ? (copied?.ok ? 'Link copied' : 'Copy failed')
                        : `Copy a link to the ${e.label} trace`}
                      title={justCopied
                        ? (copied?.ok ? 'Link copied' : 'Your browser blocked the clipboard')
                        : 'Copy a link to this trace'}
                      onClick={(ev) => { ev.stopPropagation(); void copy(e.index) }}
                      className={cn(
                        'flex items-center justify-center w-9 pr-1.5 flex-shrink-0 transition-all',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-lineage/40',
                        justCopied
                          ? (copied?.ok ? 'text-emerald-500' : 'text-rose-500')
                          : 'text-ink-muted/50 hover:text-accent-lineage group-hover/row:text-ink-muted',
                      )}
                    >
                      {justCopied && copied?.ok
                        ? <Check className="w-3.5 h-3.5" strokeWidth={2.6} />
                        : <Link2 className="w-3.5 h-3.5" strokeWidth={2.2} />}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <span aria-live="polite" role="status" className="sr-only">
            {copied ? (copied.ok ? 'Link copied' : 'Copy failed') : ''}
          </span>
          <div className="flex items-center justify-between px-3.5 py-1.5 border-t border-glass-border/40">
            <span className="text-[10px] text-ink-muted/70">Select an entity to start a new trace</span>
            <button
              type="button"
              onClick={onClear}
              className="inline-flex items-center gap-1 text-[10px] font-medium text-ink-muted hover:text-ink hover:underline"
            >
              <Trash2 className="w-3 h-3" />
              Clear history
            </button>
          </div>
        </>
      )}
    </motion.div>,
    document.body,
  )
}
