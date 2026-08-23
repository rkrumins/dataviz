/**
 * ControlTip — a control's name and meaning, on hover and on focus.
 *
 * "Add labels/popovers on each icon to make sure the user actually knows
 * what it is and what it means" (2026-08-22). The Lens header is a row of
 * segmented controls — NEXT · WALK · STEPS · DENSITY · direction · body —
 * whose captions are one word each and whose only explanation was the
 * browser's own `title`: a second's wait for an unstyled grey box that
 * most readers never see. This is the styled, instant version: the
 * control's NAME in bold and ONE sentence of what it does, shown the
 * moment the pointer rests on it or keyboard focus reaches it, and wired
 * as the control's accessible description so a screen reader gets the
 * same sentence.
 *
 * CSS-only (`peer-hover` / `peer-focus-visible`), like the board's own
 * `IconTip`: a dozen controls, no portal per button, nothing to keep.
 * The short show delay stops a pointer sweeping along the row from
 * firing a popover on every control it crosses. The popover never takes
 * pointer events, so it can never eat the click it explains.
 *
 * The child is a render function so the control can carry the two
 * things the mechanism needs — the `peer` class and `aria-describedby`
 * — without `cloneElement` guessing at its props.
 */
import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface ControlTipProps {
  /** What the control is called — bold, first. */
  name: string
  /** What it does, in one sentence. */
  meaning: string
  /** Where the popover opens. Bottom by default (the header sits at the top
   *  of the dialog, so there is always room below). */
  side?: 'bottom' | 'top'
  /** Renders the control; it MUST put `peer` on the element and spread
   *  `aria-describedby`. */
  children: (tip: { 'aria-describedby': string; peer: 'peer' }) => ReactNode
  /** Hold the popover back — while the control's own menu is open, say.
   *  The description stays wired for assistive tech. */
  quiet?: boolean
}

export function ControlTip({ name, meaning, side = 'bottom', children, quiet = false }: ControlTipProps) {
  const id = useId()
  return (
    <span className="relative flex items-center">
      {children({ 'aria-describedby': id, peer: 'peer' })}
      <span
        id={id}
        role="tooltip"
        className={cn(
          'pointer-events-none absolute left-1/2 -translate-x-1/2 z-50 w-max max-w-[240px]',
          'rounded-lg border border-black/10 dark:border-white/10 bg-canvas-elevated shadow-lg',
          'px-2.5 py-1.5 text-left whitespace-normal',
          'opacity-0 transition-opacity duration-100 delay-0',
          !quiet && 'peer-hover:opacity-100 peer-hover:delay-150 peer-focus-visible:opacity-100',
          side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
        )}
      >
        <span className="block text-[11px] font-semibold text-ink leading-snug">{name}</span>
        <span className="block mt-0.5 text-[10.5px] text-ink-muted leading-snug">{meaning}</span>
      </span>
    </span>
  )
}
