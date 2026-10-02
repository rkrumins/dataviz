/**
 * TraceSeedsPopover — what a COMBINED trace is about (2026-09-29).
 *
 * Tracing a multi-selection draws one picture from several seeds, and the
 * dock's focus chip can only name one of them. This lists every seed with
 * its type, and lets the reader drop one: the trace narrows in place with no
 * re-walk, because every other seed's walk is already in hand. The chip that
 * opens it only shows for two or more seeds, so the list never offers the
 * last one alone — dropping that would be leaving the trace, and the dock
 * has its own Exit for that.
 *
 * Portaled and fixed-anchored ABOVE the trigger, with no exit animation, for
 * the reasons `TraceRecentPopover` gives: the dock is bottom-anchored and
 * clips its own overflow, and an interrupted exit must never strand an
 * invisible click-blocker.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Layers, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/Kbd'
import { useTraceEscStack } from './useTraceEscStack'

export interface TraceSeed {
  urn: string
  /** The seed's name, resolved by the host. */
  label: string
  /** Its entity type, when the host knows it. */
  typeId?: string
}

export interface TraceSeedsPopoverProps {
  seeds: readonly TraceSeed[]
  /** Drop one seed from the trace. */
  onRemove: (urn: string) => void
  onClose: () => void
  /** The trigger button — the panel anchors above it. */
  triggerRef: React.RefObject<HTMLElement | null>
}

export function TraceSeedsPopover({ seeds, onRemove, onClose, triggerRef }: TraceSeedsPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  /** Row to focus once a removal has re-rendered the list. */
  const refocusAt = useRef<number | null>(null)

  // ESC closes; consume before the trace's own ESC handler.
  useTraceEscStack(true, onClose, 100)

  // Outside-click closes — but not a click on the trigger, which toggles.
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

  // The chip anchors on the dock's LEFT, so the panel grows rightward from it.
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  useEffect(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 6 })
  }, [triggerRef])

  // Focus the first row on open; after a removal, the row that took the
  // removed one's place, so the keyboard stays in the list. Keyed on the
  // COUNT: the host re-resolves names as the walk lands, and a new list of
  // the same seeds must not pull focus back to the top.
  const seedCount = seeds.length
  useEffect(() => {
    if (!anchor) return
    const rows = panelRef.current?.querySelectorAll<HTMLElement>('[data-seed-row]') ?? []
    const at = refocusAt.current ?? 0
    refocusAt.current = null
    rows[Math.min(at, rows.length - 1)]?.focus()
  }, [anchor, seedCount])

  // Roving focus between the rows via Up/Down, Home/End. Kept inside the
  // list: the portal still bubbles through React to the title bar, whose own
  // arrows and Home/End would otherwise pull focus out to its controls.
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    const rows = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[data-seed-row]') ?? [])
    if (rows.length === 0) return
    const current = rows.indexOf(document.activeElement as HTMLElement)
    // Delete on a row drops its seed, as its X does.
    if ((e.key === 'Delete' || e.key === 'Backspace') && current >= 0) {
      e.preventDefault()
      refocusAt.current = current
      onRemove(seeds[current].urn)
      return
    }
    let next: number | null = null
    if (e.key === 'ArrowDown') next = (current + 1 + rows.length) % rows.length
    else if (e.key === 'ArrowUp') next = (current - 1 + rows.length) % rows.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = rows.length - 1
    if (next === null) return
    e.preventDefault()
    rows[next].focus()
  }

  if (!anchor) return null

  return createPortal(
    <motion.div
      ref={panelRef}
      data-canvas-interactive
      role="dialog"
      aria-label="Traced entities"
      initial={{ opacity: 0, y: 4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      onKeyDown={onKeyDown}
      style={{ position: 'fixed', left: anchor.left, bottom: anchor.bottom, zIndex: 1000 }}
      className={cn(
        'w-[320px] rounded-xl overflow-hidden',
        // The same frosted surface as the dock's other popovers: the blur is
        // the surface. Their `bg-canvas-elevated/98` is an alpha suffix on a
        // CSS-variable token, which emits no CSS (noDeadAlphaOnCssVarTokens).
        'backdrop-blur-2xl',
        'border border-glass-border shadow-glass-lg',
      )}
    >
      <div className="flex items-center justify-between px-3.5 pt-2.5 pb-2 border-b border-glass-border">
        <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-ink-muted">
          <Layers className="w-3 h-3" /> Traced together
        </span>
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent-lineage/15 text-accent-lineage text-[10px] font-bold tabular-nums leading-none">
          {seeds.length}
        </span>
      </div>

      <ul className="py-1 max-h-[280px] overflow-y-auto">
        {seeds.map((seed, i) => (
          <motion.li
            key={seed.urn}
            layout="position"
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut', delay: Math.min(i, 8) * 0.02 }}
            // A row is one focus stop: the whole row is what the arrows
            // move between; Delete, or its X one Tab away, removes it.
            data-seed-row
            tabIndex={-1}
            className={cn(
              'group flex items-center gap-2.5 pl-3.5 pr-2 py-1.5',
              'transition-colors duration-100',
              'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
              'focus-visible:bg-accent-lineage/[0.08] focus-visible:outline-none',
            )}
          >
            {/* The seed's focus glow — the same one its row wears on the board. */}
            <span
              aria-hidden
              className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent-lineage shadow-[0_0_6px_1px] shadow-accent-lineage/50"
            />
            <span className="flex-1 min-w-0 text-[12px] font-medium text-ink truncate" title={seed.label}>
              {seed.label}
            </span>
            {seed.typeId && (
              <span className="shrink-0 max-w-[112px] truncate px-1.5 py-0.5 rounded-md bg-accent-lineage/15 text-accent-lineage text-[9.5px] font-bold uppercase tracking-wider border border-accent-lineage/25">
                {seed.typeId}
              </span>
            )}
            <button
              type="button"
              data-seed-remove
              aria-label={`Remove ${seed.label} from the trace`}
              title="Remove from the trace"
              onClick={() => { refocusAt.current = i; onRemove(seed.urn) }}
              className={cn(
                'shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md text-ink-muted',
                'opacity-60 group-hover:opacity-100 group-focus-within:opacity-100',
                'hover:bg-rose-500/15 hover:text-rose-500',
                'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40',
                'transition-all duration-150',
              )}
            >
              <X className="w-3.5 h-3.5" strokeWidth={2.4} />
            </button>
          </motion.li>
        ))}
      </ul>

      <div className="flex items-center justify-between gap-3 px-3.5 py-2 border-t border-glass-border">
        <p className="text-[10px] leading-snug text-ink-muted">
          Removing one narrows the picture — nothing is fetched again.
        </p>
        <Kbd shortcut="esc" className="shrink-0" />
      </div>
    </motion.div>,
    document.body,
  )
}
