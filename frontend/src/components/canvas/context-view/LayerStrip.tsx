/**
 * LayerStrip — docked horizontal navigator for the layered canvas.
 *
 * Long canvases are scrollable but not NAVIGABLE: nothing shows where
 * you are among the layers or lets you jump. The strip is a slim glass
 * dock at the canvas frame's bottom-center (frame-anchored — never in
 * scroll content, per the "viewport chrome never extends the scrollable
 * area" invariant) with one chip per layer:
 *
 *   ● Source   ● Staging   [● Transform]   ● Warehouse   +   | Fit
 *
 * - The chips whose columns are currently in the viewport are lit with
 *   the layer's color — a you-are-here indicator that tracks scrolling.
 * - Click a chip to smooth-scroll that column into view.
 * - Edit mode appends the "+" chip (one deliberate layer creation at a
 *   time — same action as the trailing AddLayerColumn).
 * - "Fit" runs fit-to-width, so orientation and the way back to
 *   see-everything live on the same surface.
 */
import { useEffect, useState } from 'react'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'

export interface LayerStripLayer {
  id: string
  name: string
  color: string
}

export function LayerStrip({
  layers,
  scrollRef,
  onAddLayer,
  onFit,
}: {
  layers: LayerStripLayer[]
  /** The canvas's horizontal scroll container. */
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** Draft mode only — append the "+ layer" chip. */
  onAddLayer?: () => void
  onFit?: () => void
}) {
  // Layer ids whose columns are currently (mostly) inside the viewport.
  const [visibleIds, setVisibleIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf: number | null = null
    const measure = () => {
      raf = null
      const box = el.getBoundingClientRect()
      const next = new Set<string>()
      for (const layer of layers) {
        const col = el.querySelector(`[data-layer-id="${CSS.escape(layer.id)}"]`)
        if (!col) continue
        const r = col.getBoundingClientRect()
        const overlap = Math.min(r.right, box.right) - Math.max(r.left, box.left)
        // "In view" = a meaningful share of the column is on screen —
        // 40% of its width, capped so very wide columns still register
        // while partially visible.
        if (overlap > Math.min(r.width * 0.4, 160)) next.add(layer.id)
      }
      setVisibleIds(prev => {
        if (prev.size === next.size && [...next].every(id => prev.has(id))) return prev
        return next
      })
    }
    const schedule = () => { if (raf === null) raf = requestAnimationFrame(measure) }
    schedule()
    el.addEventListener('scroll', schedule, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', schedule)
      ro?.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [layers, scrollRef])

  const jumpTo = (layerId: string) => {
    const col = scrollRef.current?.querySelector(`[data-layer-id="${CSS.escape(layerId)}"]`)
    col?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }

  if (layers.length < 2 && !onAddLayer) return null

  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 z-30 pointer-events-none"
      style={{ bottom: 'calc(0.5rem + var(--trace-dock-height, 0px))' }}
      data-canvas-interactive
    >
      <div className="pointer-events-auto flex items-center gap-1 px-1.5 py-1 rounded-full backdrop-blur-md border border-black/10 dark:border-white/10 shadow-lg bg-canvas-elevated/90 max-w-[70vw] overflow-x-auto custom-scrollbar">
        {layers.map(layer => {
          const active = visibleIds.has(layer.id)
          return (
            <button
              key={layer.id}
              type="button"
              onClick={() => jumpTo(layer.id)}
              title={`Jump to ${layer.name}`}
              aria-current={active}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-[background-color,color,transform] hover:scale-[1.03] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                active ? 'text-ink' : 'text-ink-muted/70 hover:text-ink',
              )}
              style={active
                ? { backgroundColor: `${layer.color}1f`, boxShadow: `inset 0 0 0 1px ${layer.color}55` }
                : undefined}
            >
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: layer.color }} />
              {layer.name}
            </button>
          )
        })}
        {onAddLayer && (
          <button
            type="button"
            onClick={onAddLayer}
            title="Add a layer"
            className="flex items-center px-2 py-1 rounded-full text-ink-muted/70 hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
          >
            <LucideIcons.Plus className="w-3 h-3" />
          </button>
        )}
        {onFit && (
          <>
            <div className="w-px self-stretch my-0.5 bg-black/10 dark:bg-white/10" />
            <button
              type="button"
              onClick={onFit}
              title="Fit all layers to the window (⌘0)"
              className="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium text-ink-muted/70 hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
            >
              <LucideIcons.Maximize2 className="w-3 h-3" />
              Fit
            </button>
          </>
        )}
      </div>
    </div>
  )
}
