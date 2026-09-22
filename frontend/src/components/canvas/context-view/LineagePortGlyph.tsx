/**
 * A lineage port as drawn — on a card's edge (FlatTreeItem), and in the
 * legends and tips that explain it (LineageGuide, PortHoverTip, Display >
 * Lineage). One drawing, so a legend can never show a port the canvas does
 * not.
 *
 * A rail down the card's edge in the lineage direction colours — incoming
 * (upstream) and outgoing (downstream), the pair every lineage surface uses
 * — split incoming-above-outgoing when a side carries both. It runs the
 * card's full height, stopping short of the rounded corners, so every card of
 * a column carries the same rail and a column reads as one rhythm; a port
 * sized by volume made a column of cards read as a column of different
 * things. Colour alone, no glyph: the hover tip and the legends say what the
 * colours mean. Solid for lines to entities on this canvas, glowing brighter
 * the more they carry; hollow for lineage in the data with none of it on
 * this canvas. Styles: `.nx-lineage-port` in globals.css.
 */
import type React from 'react'
import { cn } from '@/lib/utils'
import type { PortSide, PortView } from './lineagePorts'

export function LineagePortGlyph({
  side,
  view,
  strength = 0,
  className,
  standalone = false,
  counts,
}: {
  side: PortSide
  view: PortView
  /** 0..1 — the side's volume against its column's busiest: the glow. */
  strength?: number
  className?: string
  /** A legend's copy — laid out inline, not on a card's edge. */
  standalone?: boolean
  /** Lines meeting this side, by direction — read by the port's hover tip. */
  counts?: { in: number; out: number }
}) {
  return (
    <span
      aria-hidden
      data-lineage-port={standalone ? undefined : side}
      data-port={view.kind}
      data-dir={view.dir}
      data-in={counts?.in}
      data-out={counts?.out}
      className={cn(
        'nx-lineage-port',
        standalone ? 'nx-lineage-port-inline' : side === 'left' ? 'nx-lineage-port-left' : 'nx-lineage-port-right',
        className,
      )}
      style={{ '--port-strength': view.kind === 'here' ? strength : 0 } as React.CSSProperties}
    >
      {view.dir !== 'out' && <span className="nx-lineage-port-body nx-lineage-port-in" />}
      {view.dir !== 'in' && <span className="nx-lineage-port-body nx-lineage-port-out" />}
    </span>
  )
}
