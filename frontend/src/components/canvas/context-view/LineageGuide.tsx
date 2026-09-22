/**
 * LineageGuide — what Adaptive is drawing, and the way to the rest.
 *
 * Above its budget Adaptive draws only the strongest lines. A count chip said
 * so ("Top 2,000 of 40,399 lines") and left the rest to a paragraph in its
 * tooltip, so a line not drawn read as lineage that did not exist. The guide
 * says it in one line, shows how much is drawn, names the entities carrying
 * the most lineage — each one click from ALL of its lines, incoming and
 * outgoing — and says how to read the ports on every card. The budget always
 * holds for the board; a selected entity's own lines are drawn on top of it.
 *
 * It lives at the end of the layer strip, the canvas's own bar: a pill with a
 * small meter that opens the guide upward. In the strip it covers no card —
 * the strip's band is already reserved — where a card floating over the
 * columns sat on the rows it was describing. Hovering an entry lights that
 * entity on the canvas exactly as hovering its row does (the overlay's
 * spotlight reads the same attribute).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ChevronUp, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { resolveEntityName, type EntityNameFields } from '@/lib/entityDisplayName'
import { usePersonaMode } from '@/store/persona'
import { unitNoun } from './connections/connectionUnits'
import { LineagePortGlyph } from './LineagePortGlyph'

export interface LineageHub {
  id: string
  /** The entity's own fields, named by the reader's persona like its row. */
  data?: EntityNameFields | null
  name?: string
  /** Lines on this canvas touching it, in and out. */
  lines: number
  layerColor?: string
}

const ACTION_CLASS =
  'px-2 py-1 rounded-md text-[11.5px] font-medium text-accent-lineage hover:bg-accent-lineage/10 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 transition-colors'

const PANEL_WIDTH = 320

const lightUp = (id: string | null) => {
  if (id) document.documentElement.dataset.hoveredNode = id
  else delete document.documentElement.dataset.hoveredNode
}

export function LineageGuide({
  shown,
  total,
  hubs,
  onFocusHub,
  onShowAll,
}: {
  shown: number
  total: number
  hubs: LineageHub[]
  onFocusHub: (id: string) => void
  onShowAll?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const share = total > 0 ? shown / total : 0

  // Anchored above the pill, kept inside the window.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (!r) return
      const left = Math.max(8, Math.min(window.innerWidth - PANEL_WIDTH - 8, r.right - PANEL_WIDTH))
      setAnchor({ left, bottom: window.innerHeight - r.top + 10 })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  // Closes on a click anywhere else, or Esc.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Adaptive is drawing the strongest lines — see which, and how to show the rest"
        className={cn(
          'flex items-center gap-2 px-2 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
          open
            ? 'bg-accent-lineage/15 text-accent-lineage'
            : 'text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]',
        )}
      >
        <span className="relative w-7 h-1 rounded-full bg-black/10 dark:bg-white/15 overflow-hidden" aria-hidden>
          <span className="absolute inset-y-0 left-0 rounded-full bg-accent-lineage" style={{ width: `${Math.max(8, share * 100)}%` }} />
        </span>
        <span className="tabular-nums">
          {shown.toLocaleString()} of {total.toLocaleString()} {unitNoun(total, 'lines')}
        </span>
        <ChevronUp className={cn('w-3 h-3 transition-transform duration-150', !open && 'rotate-180')} />
      </button>

      {/* Portaled above everything; no exit animation, so a closed panel can
          never strand an invisible click-blocker over the canvas. */}
      {open && anchor && typeof document !== 'undefined' && createPortal(
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-label="Lineage guide"
          initial={{ opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          style={{ position: 'fixed', left: anchor.left, bottom: anchor.bottom, width: PANEL_WIDTH, zIndex: 1000 }}
          className={cn(
            'rounded-2xl bg-canvas-elevated border border-black/[0.08] dark:border-white/[0.10]',
            'shadow-[0_1px_2px_rgba(15,23,42,0.10),0_18px_48px_-16px_rgba(15,23,42,0.40)]',
            'dark:shadow-[0_1px_2px_rgba(0,0,0,0.60),0_22px_56px_-18px_rgba(0,0,0,0.90)]',
          )}
        >
          <div className="px-4 pt-3.5 pb-3.5">
            <header className="flex items-start gap-3">
              <span className="mt-0.5 w-8 h-8 flex-shrink-0 rounded-xl bg-accent-lineage/15 flex items-center justify-center">
                <GitBranch className="w-4 h-4 text-accent-lineage" strokeWidth={2.2} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-ink leading-tight">Showing the strongest lines</p>
                <p className="mt-0.5 text-[11.5px] text-ink-muted tabular-nums">
                  {shown.toLocaleString()} of {total.toLocaleString()} {unitNoun(total, 'lines')} on this canvas
                </p>
              </div>
            </header>

            <div
              role="meter"
              aria-label="Lines drawn"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={shown}
              className="mt-3 h-1.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden"
            >
              <div
                className="h-full rounded-full bg-accent-lineage"
                style={{ width: `${Math.max(2, Math.min(100, share * 100))}%` }}
              />
            </div>

            {hubs.length > 0 && <HubList hubs={hubs} onFocusHub={(id) => { setOpen(false); onFocusHub(id) }} />}

            <p className="mt-3 text-[11.5px] leading-snug text-ink-muted">
              Select any entity to see all of its incoming and outgoing lines. Adaptive
              keeps the rest of the board to the strongest.
            </p>

            <div className="mt-3 pt-3 border-t border-black/[0.06] dark:border-white/[0.06] flex items-center gap-3">
              <PortLegend />
              {onShowAll && (
                <button type="button" className={cn(ACTION_CLASS, 'ml-auto')} onClick={() => { setOpen(false); onShowAll() }}>
                  Show all lines
                </button>
              )}
            </div>
          </div>
        </motion.div>,
        document.body,
      )}
    </>
  )
}

/** The most-connected entities — each a click from all of its lines. */
function HubList({ hubs, onFocusHub }: { hubs: LineageHub[]; onFocusHub: (id: string) => void }) {
  const persona = usePersonaMode()
  const maxLines = Math.max(1, ...hubs.map(h => h.lines))
  return (
    <div className="mt-3.5">
      <p className="mb-1 text-[11.5px] font-medium text-ink">Most connected</p>
      <ul className="flex flex-col -mx-1.5">
        {hubs.map(hub => {
          const name = resolveEntityName(hub.data, persona, hub.name ?? hub.id)
          return (
            <li key={hub.id}>
              <button
                type="button"
                onClick={() => { lightUp(null); onFocusHub(hub.id) }}
                onMouseEnter={() => lightUp(hub.id)}
                onMouseLeave={() => lightUp(null)}
                onFocus={() => lightUp(hub.id)}
                onBlur={() => lightUp(null)}
                aria-label={`Show all ${hub.lines.toLocaleString()} ${unitNoun(hub.lines, 'lines')} of ${name}`}
                className={cn(
                  'group w-full flex items-center gap-2.5 px-1.5 py-1.5 rounded-lg text-left',
                  'hover:bg-accent-lineage/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                  'transition-colors',
                )}
              >
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: hub.layerColor ?? 'rgb(var(--nx-accent-lineage-rgb))' }}
                />
                <span className="flex-1 min-w-0 truncate text-[12px] text-ink group-hover:text-accent-lineage">{name}</span>
                <span className="w-14 h-1 flex-shrink-0 rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
                  <span
                    className="block h-full rounded-full bg-accent-lineage"
                    style={{ width: `${Math.max(8, (hub.lines / maxLines) * 100)}%` }}
                  />
                </span>
                <span className="w-9 flex-shrink-0 text-right text-[11px] tabular-nums text-ink-muted">
                  {hub.lines.toLocaleString()}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** How to read the ports on every card — drawn with the cards' own glyph. */
export function PortLegend({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-3 text-[11px] text-ink-muted', className)}>
      <span className="flex items-center gap-1.5">
        <LineagePortGlyph side="left" view={{ kind: 'here', dir: 'in' }} standalone />
        Incoming
      </span>
      <span className="flex items-center gap-1.5">
        <LineagePortGlyph side="right" view={{ kind: 'here', dir: 'out' }} standalone />
        Outgoing
      </span>
    </span>
  )
}
