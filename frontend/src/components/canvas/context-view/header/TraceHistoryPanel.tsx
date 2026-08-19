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
import { ArrowUpLeft, ArrowDownRight, GitBranch, History, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

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
}

const MODE_GLYPH = {
  up: { Icon: ArrowUpLeft, tone: 'text-cyan-600 dark:text-cyan-400 bg-cyan-500/10', title: 'Root Cause — upstream' },
  down: { Icon: ArrowDownRight, tone: 'text-amber-600 dark:text-amber-400 bg-amber-500/10', title: 'Impact — downstream' },
  both: { Icon: GitBranch, tone: 'text-violet-600 dark:text-violet-400 bg-violet-500/10', title: 'Full Lineage — both directions' },
} as const

function relativeTime(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function TraceHistoryPanel({
  entries,
  onResume,
  onClear,
  onClose,
  triggerRef,
}: TraceHistoryPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)

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
              return (
                <button
                  key={`${e.index}-${e.timestamp}`}
                  type="button"
                  role="menuitem"
                  onClick={() => onResume(e.index)}
                  title={`Resume — ${glyph.title}`}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:bg-black/[0.04] dark:focus-visible:bg-white/[0.06]"
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
              )
            })}
          </div>
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
