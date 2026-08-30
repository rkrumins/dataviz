/**
 * LayerStrip — docked horizontal navigator for the layered canvas.
 *
 * Long canvases are scrollable but not NAVIGABLE: nothing shows where
 * you are among the layers or lets you jump. The strip is a slim glass
 * dock at the canvas frame's bottom-center (frame-anchored — never in
 * scroll content, per the "viewport chrome never extends the scrollable
 * area" invariant) with one chip per layer:
 *
 *   ‹  ● Source   ● Staging   [● Transform]   ● Warehouse  ›  +  | Fit
 *      ────▓▓▓▓▓▓▓▓▓▓▓▓────────────────────────────────────────
 *
 * - The chips whose columns are currently in the viewport are lit with
 *   the layer's color — a you-are-here indicator that tracks scrolling.
 * - Click a chip to smooth-scroll that column into view.
 * - Under the chips, a position rail: the whole scrollable width as a
 *   track, the part on screen as a lit window. Click it to go there,
 *   drag it to scrub. It is the one thing on a STILL canvas that says
 *   there is more sideways — the macOS overlay scrollbar has faded out
 *   by then, and the chips read as filters, not as a map.
 * - ‹ and › step one layer column at a time, and go flat at each end.
 *   They live inside the strip, so they cover no canvas: nothing over
 *   the column rows may take a pointer event.
 * - Edit mode appends the "+" chip (one deliberate layer creation at a
 *   time — same action as the trailing AddLayerColumn).
 * - "Fit" runs fit-to-width, so orientation and the way back to
 *   see-everything live on the same surface.
 *
 * The rail and the steps exist ONLY while the canvas actually overflows.
 * A view whose layers all fit gets exactly the strip it always had.
 */
import { useEffect, useRef, useState } from 'react'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useBandReservation } from './useBandReservation'
import { useScrollGeometry } from './useScrollGeometry'

export interface LayerStripLayer {
  id: string
  name: string
  color: string
}

const pct = (fraction: number) => `${(fraction * 100).toFixed(2)}%`

const STEP_BUTTON =
  'flex items-center p-1 rounded-full text-ink-muted/70 hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]'
  + ' transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-muted/70'
  + ' focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'

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

  // How much of the run is on screen, and where — the rail's whole content.
  const { scrollLeft, scrollWidth, clientWidth } = useScrollGeometry(scrollRef)
  const maxScroll = Math.max(0, scrollWidth - clientWidth)
  const overflows = maxScroll > 1

  // The strip floats over the bottom of the columns. Reserve the band it
  // occupies (the way TraceBottomDock reserves `--trace-dock-height`) so a
  // column's last row is never under the pills — a click there would jump
  // layers instead, and nothing could scroll the row clear. The ref is on
  // the whole bar, rail included, so the band grows with it.
  const barRef = useRef<HTMLDivElement>(null)
  useBandReservation(barRef, '--layer-strip-height')

  // Keep the you-are-here pill inside the pill row. On a wide model the row
  // is narrower than its pills, and a lit chip scrolled out of it is a map
  // with the "you" rubbed off. A DOM write in an effect, never a state one.
  const pillsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    const lit = layers.filter(layer => visibleIds.has(layer.id))
    if (!el || lit.length === 0) return
    // Of the lit run, show the end you are heading for: at the right of the
    // canvas that is the LAST one — the pill that proves you reached it.
    const here = el.scrollLeft > (el.scrollWidth - el.clientWidth) / 2 ? lit[lit.length - 1] : lit[0]
    pillsRef.current
      ?.querySelector(`[data-layer-pill="${CSS.escape(here.id)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
  }, [layers, visibleIds, scrollRef])

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

  /** Every layer column's left edge, as a scroll offset in the container. */
  const columnOffsets = (el: HTMLElement) => {
    const boxLeft = el.getBoundingClientRect().left
    const offsets: number[] = []
    for (const layer of layers) {
      const col = el.querySelector(`[data-layer-id="${CSS.escape(layer.id)}"]`)
      if (col) offsets.push(col.getBoundingClientRect().left - boxLeft + el.scrollLeft)
    }
    return offsets
  }

  // One layer column per press — the unit the strip is about. The column
  // nearest the left edge is where we are; the step goes to its neighbour,
  // and past the last one falls back to the extreme (the leading gutter
  // and the trailing add-column are not layers, but they are canvas).
  const step = (direction: 1 | -1) => {
    const el = scrollRef.current
    if (!el) return
    const offsets = columnOffsets(el)
    if (offsets.length === 0) return
    let here = 0
    for (let i = 1; i < offsets.length; i++) {
      if (Math.abs(offsets[i] - el.scrollLeft) < Math.abs(offsets[here] - el.scrollLeft)) here = i
    }
    const next = here + direction
    const left = next >= 0 && next < offsets.length ? offsets[next] : (direction === 1 ? el.scrollWidth : 0)
    el.scrollTo({ left, behavior: 'smooth' })
  }

  // Press or drag anywhere on the rail: centre the visible window there.
  // `behavior: 'auto'` overrides the scroller's CSS `scroll-smooth`, which
  // would otherwise animate every frame of a drag half a second behind the
  // pointer.
  const scrubTo = (clientX: number, rail: HTMLElement) => {
    const el = scrollRef.current
    if (!el) return
    const track = rail.getBoundingClientRect()
    if (track.width === 0) return
    const fraction = (clientX - track.left) / track.width
    const left = Math.min(Math.max(fraction * el.scrollWidth - el.clientWidth / 2, 0), el.scrollWidth - el.clientWidth)
    el.scrollTo({ left, behavior: 'auto' })
  }

  const startScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const rail = e.currentTarget
    scrubTo(e.clientX, rail)
    const move = (ev: PointerEvent) => scrubTo(ev.clientX, rail)
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }

  if (layers.length < 2 && !onAddLayer) return null

  return (
    <div
      // Width-capped against the canvas frame so the bar never reaches the
      // dock at the frame's right — 20rem wide, 1rem in, so 21rem of lane on
      // each side of a centred bar — with a 12rem floor; the pills scroll
      // inside the cap. The old 36rem was measured against a 16rem legend
      // the dock outgrew, and the ‹ › buttons are exactly wide enough to
      // have pushed "Fit" into what is left of that lane.
      className="absolute left-1/2 -translate-x-1/2 z-30 pointer-events-none max-w-[max(12rem,calc(100%-42rem))]"
      style={{ bottom: 'calc(0.5rem + var(--trace-dock-height, 0px))' }}
      data-canvas-interactive
    >
      <div
        ref={barRef}
        data-layer-strip-bar
        className={cn(
          'pointer-events-auto flex flex-col gap-1 px-1.5 py-1 backdrop-blur-md border border-black/10 dark:border-white/10 shadow-lg bg-canvas-elevated/90 max-w-full',
          // A stadium is right for one row and wrong for two: at rail
          // height its end curves would eat the first and last pill.
          overflows ? 'rounded-2xl' : 'rounded-full',
        )}
      >
        <div className="flex items-center gap-1 min-w-0">
          {overflows && (
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={scrollLeft <= 1}
              aria-label="Previous layer"
              title="Previous layer"
              className={STEP_BUTTON}
            >
              <LucideIcons.ChevronLeft className="w-3.5 h-3.5" />
            </button>
          )}
          <div
            ref={pillsRef}
            // Its own scrollbar is hidden: the rail below is the strip's one
            // bar, and a second grey one 10px above it reads as a duplicate
            // rather than as "there are more pills". The lit pill scrolls
            // itself into the row instead (below).
            className="flex items-center gap-1 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {layers.map(layer => {
              const active = visibleIds.has(layer.id)
              return (
                <button
                  key={layer.id}
                  type="button"
                  onClick={() => jumpTo(layer.id)}
                  data-layer-pill={layer.id}
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
          </div>
          {overflows && (
            <button
              type="button"
              onClick={() => step(1)}
              disabled={scrollLeft >= maxScroll - 1}
              aria-label="Next layer"
              title="Next layer"
              className={STEP_BUTTON}
            >
              <LucideIcons.ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}
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
        {overflows && (
          // A pointer-only map. Everything it can do, the pills and the ‹ ›
          // buttons already do from the keyboard, so it stays out of the
          // reading order rather than posing as a half-built slider.
          <div
            aria-hidden
            data-layer-rail
            onPointerDown={startScrub}
            className="relative h-1 mx-1 mb-0.5 rounded-full bg-black/10 dark:bg-white/10 cursor-pointer touch-none"
          >
            <div
              data-layer-rail-window
              className="absolute inset-y-0 min-w-[10px] rounded-full bg-accent-lineage"
              style={{ left: pct(scrollLeft / scrollWidth), width: pct(clientWidth / scrollWidth) }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
