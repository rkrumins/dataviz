/**
 * SuggestionListbox — the list under a text field that offers what to type: every match, however
 * many, and every one of them reachable. The field stays the combobox; it owns the open state, the
 * active option and the keys, and points `aria-controls` at `id` and `aria-activedescendant` at
 * `suggestionOptionId(id, active)`.
 *
 * PORTALED AND FIXED, placed against the field: below it, or above when below has less room, its
 * height bound to the room the window leaves. A list positioned inside a scrolling drawer is cut off
 * by the drawer — the property composer's was.
 *
 * THE FIELD KEEPS FOCUS. Mousedown is prevented over the whole list, the scrollbar included. Only the
 * rows did it before, so pressing the scrollbar blurred the field, the field closed its list, and the
 * suggestions could not be scrolled past the first few. `overscroll-contain`, so the end of the list
 * does not scroll the drawer or dialog behind it.
 *
 * The active option is kept in view as the arrow keys move it. Rows are one fixed height, so that is
 * arithmetic, and over `VIRTUAL_FROM` rows only those in view are drawn. A long list says how many
 * it holds, and that typing narrows them.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'

/** Space kept between the list and the window's edges, and between the list and its field. */
const EDGE = 8
const GAP = 4
/** The tallest the list grows when the window has the room. */
const MAX_HEIGHT = 320
/** Narrower fields still get a list wide enough to read a name and its count. */
const MIN_WIDTH = 240
/** The list's own padding, top and bottom (`p-1`). */
const PAD = 4
const FOOTER_HEIGHT = 29
/** Past this many rows the count shows; past `VIRTUAL_FROM`, only the rows in view are drawn. */
const COUNT_FROM = 8
const VIRTUAL_FROM = 100

export const suggestionOptionId = (listId: string, index: number) => `${listId}-option-${index}`

/**
 * Where a list `height` tall goes for a field at `anchor`: below it, or above when below has less
 * room than it needs and above has more. Never past the window's edges; `maxHeight` is the room on
 * the side it opens to.
 */
export function placeSuggestions(
  anchor: { left: number; top: number; bottom: number; width: number },
  height: number,
  view: { width: number; height: number },
): { left: number; top: number; width: number; maxHeight: number; above: boolean } {
  const below = view.height - EDGE - anchor.bottom - GAP
  const roomAbove = anchor.top - GAP - EDGE
  const above = height > below && roomAbove > below
  const maxHeight = Math.max(0, above ? roomAbove : below)
  const width = Math.min(Math.max(anchor.width, MIN_WIDTH), view.width - EDGE * 2)
  const left = Math.max(EDGE, Math.min(anchor.left, view.width - EDGE - width))
  const top = above ? anchor.top - GAP - Math.min(height, maxHeight) : anchor.bottom + GAP
  return { left, top, width, maxHeight, above }
}

export function SuggestionListbox<T>({
  id, label, anchorRef, items, getKey, renderItem, activeIndex, onActiveChange, onPick, rowHeight, narrowing, className,
}: {
  id: string
  /** The listbox's accessible name. */
  label: string
  /** The field the list belongs to. */
  anchorRef: RefObject<HTMLElement | null>
  items: readonly T[]
  getKey: (item: T) => string
  renderItem: (item: T, active: boolean) => ReactNode
  /** -1: none. */
  activeIndex: number
  onActiveChange: (index: number) => void
  onPick: (item: T) => void
  /** Every row's height, in px. */
  rowHeight: number
  /** Something has been typed: the count's hint says to keep typing rather than to start. */
  narrowing: boolean
  /** Text size and colour of the rows. */
  className?: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const counted = items.length > COUNT_FROM
  const natural = Math.min(MAX_HEIGHT, items.length * rowHeight + PAD * 2 + (counted ? FOOTER_HEIGHT : 0))
  const [at, setAt] = useState<ReturnType<typeof placeSuggestions> | null>(null)

  // Placed before paint, and again whenever anything scrolls or the window resizes: the field moves
  // with the drawer it sits in. Capture, because that scroll may be in any ancestor.
  useLayoutEffect(() => {
    const place = () => {
      const el = anchorRef.current
      if (!el) return
      const next = placeSuggestions(el.getBoundingClientRect(), natural, { width: window.innerWidth, height: window.innerHeight })
      setAt((prev) => (prev && prev.left === next.left && prev.top === next.top && prev.width === next.width
        && prev.maxHeight === next.maxHeight && prev.above === next.above ? prev : next))
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchorRef, natural])

  const virtual = items.length > VIRTUAL_FROM
  const virtualizer = useVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: (i) => getKey(items[i]!),
    overscan: 6,
  })

  // The active option in view: rows are one height, so its place is known without measuring.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || activeIndex < 0) return
    const top = activeIndex * rowHeight                       // within the padded list
    const bottom = top + rowHeight + PAD * 2
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }, [activeIndex, rowHeight])

  if (!at || typeof document === 'undefined') return null
  const rows = virtual
    ? virtualizer.getVirtualItems().map((v) => ({ index: v.index, start: v.start }))
    : items.map((_, index) => ({ index, start: 0 }))

  return createPortal(
    <div
      // The field keeps focus whatever is pressed here — a row or the scrollbar.
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: 'fixed', left: at.left, top: at.top, width: at.width, maxHeight: Math.min(MAX_HEIGHT, at.maxHeight) }}
      className={cn(
        'z-[1000] flex flex-col overflow-hidden rounded-lg bg-canvas-elevated',
        'border border-black/[0.08] shadow-[0_1px_2px_rgba(15,23,42,0.10),0_12px_32px_-12px_rgba(15,23,42,0.35)] dark:border-white/[0.10]',
        'animate-in fade-in duration-100', at.above ? 'slide-in-from-bottom-1' : 'slide-in-from-top-1',
      )}
    >
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain custom-scrollbar p-1">
        <ul
          id={id}
          role="listbox"
          aria-label={label}
          className={cn('relative', className)}
          style={virtual ? { height: virtualizer.getTotalSize() } : undefined}
        >
          {rows.map(({ index, start }) => {
            const item = items[index]!
            const active = index === activeIndex
            return (
              <li
                key={getKey(item)}
                id={suggestionOptionId(id, index)}
                role="option"
                aria-selected={active}
                aria-setsize={virtual ? items.length : undefined}
                aria-posinset={virtual ? index + 1 : undefined}
                onMouseDown={(e) => { if (e.button === 0) onPick(item) }}
                // Move, not enter: rows scrolling under a still pointer must not steal the keys' place.
                onMouseMove={() => { if (!active) onActiveChange(index) }}
                style={virtual
                  ? { position: 'absolute', top: 0, left: 0, right: 0, height: rowHeight, transform: `translateY(${start}px)` }
                  : { height: rowHeight }}
                className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2.5',
                  active ? 'bg-accent-lineage/10 text-ink' : 'text-ink-secondary')}
              >
                {renderItem(item, active)}
              </li>
            )
          })}
        </ul>
      </div>
      {counted && (
        <div className="shrink-0 border-t border-black/[0.06] px-3 py-1.5 text-[11px] tabular-nums text-ink-muted dark:border-white/[0.08]"
          style={{ height: FOOTER_HEIGHT }}>
          {items.length.toLocaleString()} suggestions · {narrowing ? 'keep typing to narrow' : 'type to narrow'}
        </div>
      )}
    </div>,
    document.body,
  )
}
