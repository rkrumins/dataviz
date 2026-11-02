/**
 * ConnectionDragLayer — the rubber-band edge shown while a connection is being
 * made. Mounted as an absolute sibling of LineageFlowOverlay inside the same
 * scroll container, so it shares the overlay's coordinate space: anchors are
 * `getBoundingClientRect()` minus this layer's own container rect (matching how
 * LineageFlowOverlay computes its paths). Pointer-events are off so it never
 * intercepts the drop or the click.
 *
 * A drag that carries a selection draws a band from every selected card that
 * is on screen, gathering at the cursor, with how many are being carried and —
 * over a card — what dropping there would do.
 *
 * Connect mode (`live`): nothing is held, so this layer follows the pointer and
 * the scroll ITSELF — the canvas does not re-render on every pointer move while
 * a connection stays armed for as long as the reader needs. Armed, it rings the
 * source, draws the band to the pointer, rings the card under it in the colour
 * of what linking there would do, and numbers the targets collected so far.
 * With the Connect tool waiting for a source, it rings the card a click would
 * start from.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/** Bands drawn at most; the count badge carries the rest. */
const MAX_BANDS = 24

type HintLevel = 'all' | 'some' | 'none'
export interface ConnectionHint { level: HintLevel; text: string }

export interface ConnectionDragLayerProps {
  /** The cards being connected from (layer-node-<id>); empty when not connecting. */
  sourceIds: readonly string[]
  /** Live pointer in viewport coordinates while DRAGGING; null otherwise. */
  pointer: { x: number; y: number } | null
  /** What dropping on the hovered card would do; null when over no card. */
  hint?: ConnectionHint | null
  /** Connect mode: 'armed' follows the pointer from the source; 'tool' rings
   *  the card a click would start from. Null while dragging or at rest. */
  live?: 'armed' | 'tool' | null
  /** Connect mode: what linking into a card would do — asked once per card hovered. */
  hintFor?: (hoverId: string) => ConnectionHint | null
  /** Connect mode: the targets collected so far, numbered in click order. */
  targetIds?: readonly string[]
}

interface Box { left: number; top: number; width: number; height: number }

const toneOf = (level: HintLevel | null | undefined) =>
  level === 'all'
    ? 'var(--nx-lineage-out-rgb)'
    : level === 'some'
      ? '245 158 11'
      : level === 'none'
        ? '239 68 68'
        : 'var(--nx-accent-lineage-rgb)'

function cardIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)
  const card = el?.closest('[id^="layer-node-"]') as HTMLElement | null
  return card ? card.id.slice('layer-node-'.length) : null
}

/** Follow the pointer and the scroll while connect mode is on — this layer only. */
function useLivePointer(live: ConnectionDragLayerProps['live'], exclude: readonly string[]) {
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [, setFrame] = useState(0)
  const excluded = useRef(exclude)
  useLayoutEffect(() => { excluded.current = exclude })

  useEffect(() => {
    if (!live) return
    let raf = 0
    let last: { x: number; y: number } | null = null
    const read = () => {
      raf = 0
      if (!last) return
      const over = cardIdAt(last.x, last.y)
      setHoverId(over && !excluded.current.includes(over) ? over : null)
      setPointer(last)
      setFrame((f) => f + 1)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(read) }
    const onMove = (e: PointerEvent) => { last = { x: e.clientX, y: e.clientY }; schedule() }
    // Columns scroll under a still pointer: re-read what is under it, and re-measure.
    const onScroll = () => schedule()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('scroll', onScroll, true)
      // A new session starts from nothing, never from where the last one left off.
      setPointer(null)
      setHoverId(null)
    }
  }, [live])

  return { pointer: live ? pointer : null, hoverId: live ? hoverId : null }
}

export function ConnectionDragLayer({ sourceIds, pointer, hint = null, live = null, hintFor, targetIds = [] }: ConnectionDragLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const followed = useLivePointer(live, sourceIds)
  const armed = live === 'armed'
  const at = armed ? followed.pointer : live ? null : pointer
  const hoverId = live ? followed.hoverId : null
  const liveHint = useMemo(
    () => (armed && hoverId && !targetIds.includes(hoverId) ? hintFor?.(hoverId) ?? null : null),
    [armed, hoverId, hintFor, targetIds],
  )
  const shownHint = live ? liveHint : hint

  const container = containerRef.current?.getBoundingClientRect() ?? null
  const boxOf = (id: string): Box | null => {
    if (!container) return null
    const el = document.getElementById(`layer-node-${id}`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left - container.left, top: r.top - container.top, width: r.width, height: r.height }
  }

  const paths: string[] = []
  let head: { x: number; y: number } | null = null
  if (sourceIds.length > 0 && at && container) {
    const px = at.x - container.left
    const py = at.y - container.top
    head = { x: px, y: py }
    for (const id of sourceIds) {
      if (paths.length >= MAX_BANDS) break
      const s = boxOf(id)
      if (!s) continue
      const sx = s.left + s.width + 6
      const sy = s.top + s.height / 2
      const dx = Math.max(40, Math.abs(px - sx) * 0.4)
      paths.push(`M ${sx} ${sy} C ${sx + dx} ${sy}, ${px - dx} ${py}, ${px} ${py}`)
    }
  }

  const bulk = sourceIds.length > 1
  const tone = `rgb(${toneOf(shownHint?.level)})`
  const sourceRings = live ? sourceIds.slice(0, MAX_BANDS).map((id) => ({ id, box: boxOf(id) })) : []
  const targetRings = live ? targetIds.map((id, i) => ({ id, n: i + 1, box: boxOf(id) })) : []
  const hoverBox = hoverId && !targetIds.includes(hoverId) ? boxOf(hoverId) : null
  const hoverTone = live === 'tool' ? toneOf(null) : toneOf(liveHint?.level ?? null)

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none z-[6]">
      {/* Where the line starts: the source glows, so the reader never loses it. */}
      {sourceRings.map(({ id, box }) => box && (
        <span
          key={`s-${id}`}
          aria-hidden="true"
          className="absolute rounded-lg nx-connect-source-ring"
          style={{
            left: box.left - 3, top: box.top - 3, width: box.width + 6, height: box.height + 6,
            boxShadow: '0 0 0 2px rgb(var(--nx-accent-lineage-rgb)), 0 0 0 7px rgb(var(--nx-accent-lineage-rgb) / 0.16)',
          }}
        />
      ))}
      {/* The card a click would link into (armed), or start from (tool). */}
      {hoverBox && (
        <span
          aria-hidden="true"
          className="absolute rounded-lg transition-[box-shadow] duration-100"
          style={{
            left: hoverBox.left - 3, top: hoverBox.top - 3, width: hoverBox.width + 6, height: hoverBox.height + 6,
            boxShadow: `0 0 0 2px rgb(${hoverTone}), 0 0 0 8px rgb(${hoverTone} / 0.18)`,
          }}
        />
      )}
      {/* Targets collected with ⌘/Ctrl-click, numbered in the order they'll link. */}
      {targetRings.map(({ id, n, box }) => box && (
        <span
          key={`t-${id}`}
          aria-hidden="true"
          className="absolute rounded-lg"
          style={{
            left: box.left - 3, top: box.top - 3, width: box.width + 6, height: box.height + 6,
            boxShadow: '0 0 0 2px rgb(var(--nx-lineage-out-rgb)), 0 0 0 7px rgb(var(--nx-lineage-out-rgb) / 0.16)',
          }}
        >
          <span className="absolute -top-2.5 -right-2.5 min-w-[20px] h-5 px-1 rounded-full grid place-items-center bg-lineage-out text-white text-[10.5px] font-semibold tabular-nums shadow-md ring-2 ring-canvas-elevated">
            {n}
          </span>
        </span>
      ))}
      <svg className="absolute inset-0 w-full h-full overflow-visible">
        {paths.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={tone}
            strokeWidth={bulk ? 1.6 : 2}
            strokeOpacity={bulk ? 0.8 : 1}
            strokeDasharray="6 4"
            strokeLinecap="round"
            className="animate-pulse motion-reduce:animate-none"
          />
        ))}
        {head && <circle cx={head.x} cy={head.y} r={4} fill={tone} />}
      </svg>
      {head && (bulk || shownHint) && (
        <div
          className="absolute flex items-center gap-1.5"
          style={{ left: head.x + 12, top: head.y + 10 }}
        >
          {bulk && (
            <span className="min-w-[22px] h-[22px] px-1.5 rounded-full grid place-items-center bg-accent-lineage text-white text-[11px] font-semibold tabular-nums shadow-md ring-2 ring-canvas-elevated">
              {sourceIds.length.toLocaleString()}
            </span>
          )}
          {shownHint && (
            <span
              className={cn(
                'max-w-[280px] truncate px-2 py-1 rounded-lg bg-canvas-elevated border shadow-md text-[11.5px] font-medium',
                shownHint.level === 'all' && 'border-lineage-out/40 text-ink',
                shownHint.level === 'some' && 'border-amber-500/40 text-ink',
                shownHint.level === 'none' && 'border-red-500/40 text-red-600 dark:text-red-400',
              )}
            >
              {shownHint.text}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export default ConnectionDragLayer
