/**
 * LineKindMenu — the Lineage button's menu: which lines the canvas draws.
 *
 * Relationships only (the default): every line is a relationship — one you can open, and in a
 * draft change — drawn between the cards that hold its two ends. With roll-ups: the summaries the
 * aggregation job computes between cards are drawn too, for an overview of lineage inside cards
 * nobody has opened. The same choice as the chip at the end of the canvas's layer strip.
 *
 * Portalled to the body and placed below its button: the header is `backdrop-blur`, a stacking
 * context a menu inside it could never rise out of.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, GitBranch, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePreferencesStore } from '@/store/preferences'
import { keyboardScopeProps } from '@/lib/keyboardScope'

const OPTIONS = [
  {
    rollups: false,
    icon: GitBranch,
    title: 'Relationships only',
    detail: 'Every line is a relationship you can open and change, drawn between the cards that hold its ends.',
  },
  {
    rollups: true,
    icon: Layers,
    title: 'Include roll-ups',
    detail: 'Also draw summaries of the lineage inside cards, computed by the aggregation job. Read-only.',
  },
] as const

const WIDTH = 320

export function LineKindMenu({ onClose, triggerRef }: {
  onClose: () => void
  /** The button that opened the menu — a click on it is its own toggle, not an outside click. */
  triggerRef: React.RefObject<HTMLElement | null>
}) {
  const showRollups = usePreferencesStore((s) => s.showLineageRollups)
  const setShowRollups = usePreferencesStore((s) => s.setShowLineageRollups)
  const menuRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)

  // Below the button, kept inside the window; it follows a resize or a scroll.
  useLayoutEffect(() => {
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (r) setAnchor({ top: r.bottom + 8, left: Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8)) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [triggerRef])

  // Opens on the current choice, once it is placed.
  const placed = anchor !== null
  useEffect(() => {
    if (placed) menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
  }, [placed])
  // Closes on a click anywhere else, or Esc — which hands focus back to the button.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      onClose()
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, triggerRef])

  if (!anchor) return null
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Lines on the canvas"
      // Keys pressed in the menu are the menu's, not the canvas's (Esc must not clear the selection).
      {...keyboardScopeProps('line-kind-menu')}
      style={{ position: 'fixed', top: anchor.top, left: anchor.left, width: WIDTH, zIndex: 1000 }}
      className="p-1.5 rounded-xl border border-glass-border bg-canvas-elevated shadow-xl"
    >
      <p className="px-2.5 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Lines on the canvas</p>
      {OPTIONS.map(({ rollups, icon: Icon, title, detail }) => {
        const checked = showRollups === rollups
        return (
          <button
            key={title}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            onClick={() => { setShowRollups(rollups); onClose() }}
            className={cn(
              'w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
              checked ? 'bg-accent-lineage/10' : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
            )}
          >
            <Icon className={cn('w-4 h-4 mt-0.5 flex-shrink-0', checked ? 'text-accent-lineage' : 'text-ink-muted')} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className={cn('block text-sm font-medium', checked ? 'text-accent-lineage' : 'text-ink')}>{title}</span>
              <span className="block text-xs text-ink-muted">{detail}</span>
            </span>
            {checked && <Check className="w-4 h-4 mt-0.5 flex-shrink-0 text-accent-lineage" aria-hidden />}
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
