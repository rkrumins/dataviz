/**
 * What a lineage port means, said on hover — for every port on the canvas.
 *
 * ONE listener on the canvas scroller and one bubble, not a tooltip per card:
 * a column can mount hundreds of ports, and a tip that costs nothing until
 * hovered keeps them free. The port carries its own facts as data attributes
 * (LineagePortGlyph); the tip only reads them. Styled as the app's one
 * tooltip (HoverTip): same panel, type and shadow.
 */
import { useEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { formatUnitCount, unitNoun } from './connections/connectionUnits'
import { LineagePortGlyph } from './LineagePortGlyph'
import type { PortSide, PortView } from './lineagePorts'

interface Tip {
  x: number
  y: number
  side: PortSide
  view: PortView
  inCount: number
  outCount: number
}

function describe(tip: Tip): { lead: string; detail: string } {
  const lines = (n: number) => `${n.toLocaleString()} ${unitNoun(n, 'lines')}`
  if (tip.view.kind === 'unknown') {
    return {
      lead: 'Lineage for this entity could not be counted — retrying',
      detail: 'Grey says neither direction yet. The port takes its colours when the count comes back.',
    }
  }
  if (tip.view.kind === 'beyond') {
    // The count is the degree's — flows in the data, as the stubs say. A
    // container whose own count is 0 is hollow for what its roll-up cells
    // say of the rows inside it: that it has some, not how many.
    const n = tip.view.dir === 'in' ? tip.inCount : tip.outCount
    const said = n > 0 ? formatUnitCount(n, 'flows') : 'Lineage inside it'
    const one = n <= 1
    return {
      lead: tip.view.dir === 'in'
        ? `${said} ${one ? 'arrives' : 'arrive'} from entities outside this view`
        : `${said} ${one ? 'leads' : 'lead'} to entities outside this view`,
      detail: 'None of its other ends is in this view — trace it to see where it leads.',
    }
  }
  if (tip.view.dir === 'both') {
    return {
      lead: `${lines(tip.inCount)} in · ${lines(tip.outCount)} out`,
      detail: 'Incoming (upstream) above, outgoing (downstream) below. Select the entity to draw all of them.',
    }
  }
  return tip.view.dir === 'in'
    ? { lead: `${lines(tip.inCount)} come in here`, detail: 'Upstream — data flows into this entity. Select it to draw all of them.' }
    : { lead: `${lines(tip.outCount)} go out here`, detail: 'Downstream — data flows out of this entity. Select it to draw all of them.' }
}

export function PortHoverTip({ scrollerRef }: { scrollerRef: RefObject<HTMLElement | null> }) {
  const [tip, setTip] = useState<Tip | null>(null)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const over = (e: PointerEvent) => {
      const port = (e.target as Element | null)?.closest?.('[data-lineage-port]') as HTMLElement | null
      if (!port) return
      const r = port.getBoundingClientRect()
      const d = port.dataset
      setTip({
        x: r.left + r.width / 2,
        y: r.top,
        side: d.lineagePort as PortSide,
        view: { kind: d.port as PortView['kind'], dir: d.dir as PortView['dir'] },
        inCount: Number(d.in ?? 0),
        outCount: Number(d.out ?? 0),
      })
    }
    const out = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-lineage-port]')) setTip(null)
    }
    const clear = () => setTip(null)
    scroller.addEventListener('pointerover', over)
    scroller.addEventListener('pointerout', out)
    scroller.addEventListener('scroll', clear, { capture: true, passive: true })
    return () => {
      scroller.removeEventListener('pointerover', over)
      scroller.removeEventListener('pointerout', out)
      scroller.removeEventListener('scroll', clear, { capture: true })
    }
  }, [scrollerRef])

  if (!tip || typeof document === 'undefined') return null
  const { lead, detail } = describe(tip)
  return createPortal(
    <span
      role="tooltip"
      style={{ position: 'fixed', left: tip.x, top: tip.y - 8, transform: 'translate(-50%, -100%)', maxWidth: 280 }}
      className={cn(
        'z-[9998] block pointer-events-none rounded-xl',
        'text-[12px] leading-[1.45] tabular-nums',
        'border border-black/[0.08] dark:border-white/[0.10]',
        'bg-canvas-elevated px-3 py-2',
        'shadow-[0_1px_2px_rgba(15,23,42,0.10),0_10px_30px_-10px_rgba(15,23,42,0.35)]',
        'dark:shadow-[0_1px_2px_rgba(0,0,0,0.60),0_14px_36px_-12px_rgba(0,0,0,0.85)]',
        'animate-in fade-in-0 zoom-in-95 duration-[90ms] ease-out slide-in-from-bottom-1',
      )}
    >
      <span className="flex items-center gap-2 font-medium text-ink">
        <LineagePortGlyph side={tip.side} view={tip.view} standalone />
        {lead}
      </span>
      <span className="mt-1 block text-[11px] leading-snug text-ink-muted">{detail}</span>
    </span>,
    document.body,
  )
}
