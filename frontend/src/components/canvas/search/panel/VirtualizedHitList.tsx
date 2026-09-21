/**
 * VirtualizedHitList — flat, windowed render path for very large hit
 * pages (W2.4).
 *
 * The default ``HitsByParent`` renders every hit upfront, nested under
 * collapsible parent groups. That's the right UX when the page is
 * small enough to be visually meaningful (50-200 rows). At 1000+
 * hits — the situation cursor pagination (W2.2) makes reachable —
 * mounting every ``SearchHitRow`` synchronously stalls the main
 * thread on first paint.
 *
 * This component is the high-volume fallback: it flattens the hit
 * list (drops the grouping, which no longer carries useful signal at
 * that scale) and uses ``@tanstack/react-virtual`` to mount only the
 * rows currently in view.
 *
 * Threshold and pivot:
 *   * ``HitsByParent`` switches to this component when
 *     ``hits.length > 200``.
 *   * The virtualizer measures the outer scroll container that
 *     ``ResultsPane`` already owns — we don't add a nested scroller.
 *   * Item size estimate is the natural ``SearchHitRow`` height
 *     (~64px); the virtualizer measures the actual painted row and
 *     refines from there.
 *
 * It also keeps the viewport STILL while pages land. "Load all" walks the
 * cursor to the end, and each committed page re-derives the grouping —
 * groups sort by the canvas's column order rather than by arrival, and a hit
 * for a container already on screen is appended inside it. Both insert rows
 * above the fold, which slid the list down under whoever was reading it. The
 * list pins itself to the first visible row and puts it back (see
 * ``scrollAnchor``), twice: once when the rows change, and again after the
 * new rows have been measured, since a row above the fold is an estimate
 * until it has been painted.
 *
 * It also serves a second, GROUPED caller. ``HitsByLayer`` flattens its
 * layer › container tree into one row list — headers and hits together —
 * and passes it as ``rows`` with a per-kind size and its own painter.
 * One virtualizer for the whole tree is the point: nesting a second one
 * per group would mean a scroll element per group, and rendering the
 * headers outside the window would put the O(N) mount cost back.
 */
import {
    type FC,
    type ReactNode,
    type RefObject,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
} from 'react'

import { useVirtualizer } from '@tanstack/react-virtual'

import type { AncestorRef, SearchHit } from '@/types/search'

import { SearchHitRow } from '../SearchHitRow'
import { captureAnchor, restoreScrollTop, type ScrollAnchor } from './scrollAnchor'


export interface VirtualizedHitListProps {
    /** Flat-hit mode: HitsByParent's large-page fallback. Every row is a
     *  ``SearchHitRow`` of the same estimated height. */
    hits?: SearchHit[]
    /** Row mode: a pre-flattened list of HETEROGENEOUS rows — group
     *  headers interleaved with hits (``HitsByLayer.flattenRows``). Only
     *  the key is read here; the caller owns the size and the paint, so
     *  a header and a hit can differ in both. Takes precedence over
     *  ``hits`` when supplied. */
    rows?: ReadonlyArray<{ key: string }>
    /** Row mode: estimated painted height of ``rows[index]``, per kind. */
    estimateRowSize?: (index: number) => number
    /** Row mode: paint ``rows[index]``. */
    renderRow?: (index: number) => ReactNode
    /** Ref to the scrollable parent owned by ``ResultsPane``. The
     *  virtualizer measures its viewport from this element and only
     *  paints rows in the visible range + overscan. */
    scrollElementRef: RefObject<HTMLElement | null>
    onReveal?: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpen?: (urn: string) => void
    /** Estimated row height in px. Used until the virtualizer measures
     *  actual rows. SearchHitRow's natural height is ~64px. */
    estimatedRowHeightPx?: number
    /** Rows to keep mounted outside the visible range — smooths fast
     *  scrolling. Default 6. */
    overscan?: number
}


export const VirtualizedHitList: FC<VirtualizedHitListProps> = ({
    hits, rows, estimateRowSize, renderRow, scrollElementRef, onReveal, onOpen,
    estimatedRowHeightPx = 64, overscan = 6,
}) => {
    const measureRef = useRef<Map<number, HTMLDivElement>>(new Map())

    const virtualizer = useVirtualizer({
        count: rows ? rows.length : (hits?.length ?? 0),
        getScrollElement: () => scrollElementRef.current,
        estimateSize: (index) => (rows && estimateRowSize
            ? estimateRowSize(index)
            : estimatedRowHeightPx),
        // Measured sizes are cached under this key, NOT under the index.
        // Without it, collapsing a layer re-indexes every row below and
        // the 34px measurement of a group header gets reused for the
        // 64px hit row that lands on its index.
        getItemKey: (index) => (rows
            ? rows[index].key
            : (hits?.[index]?.node.urn ?? index)),
        overscan,
    })

    const items = virtualizer.getVirtualItems()
    const totalSize = virtualizer.getTotalSize()

    // ---- Scroll anchoring -------------------------------------------------
    // Latest-value refs so the scroll listener never closes over a stale
    // window, and is bound once instead of on every paint.
    const itemsRef = useRef(items)
    itemsRef.current = items
    const anchorRef = useRef<ScrollAnchor | null>(null)
    // Set when the rows change; survives one measurement pass so the
    // correction can run again once newly-inserted rows have real heights.
    const pendingRef = useRef(false)

    const rowKeys = rows ?? hits
    const indexOfKey = useMemo(() => {
        const map = new Map<string, number>()
        if (rows) rows.forEach((r, i) => map.set(String(r.key), i))
        else hits?.forEach((h, i) => map.set(String(h.node.urn), i))
        return map
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rowKeys])

    useEffect(() => {
        const el = scrollElementRef.current
        if (!el) return
        const onScroll = () => {
            anchorRef.current = captureAnchor(itemsRef.current, el.scrollTop)
        }
        el.addEventListener('scroll', onScroll, { passive: true })
        return () => el.removeEventListener('scroll', onScroll)
    }, [scrollElementRef])

    const applyAnchor = useCallback(() => {
        const el = scrollElementRef.current
        if (!el) return
        const next = restoreScrollTop(anchorRef.current, (key) => {
            const index = indexOfKey.get(key)
            if (index === undefined) return null
            return virtualizer.getOffsetForIndex(index, 'start')?.[0] ?? null
        })
        // A sub-pixel difference is not worth a scroll event of its own —
        // assigning scrollTop re-enters the listener above.
        if (next !== null && Math.abs(next - el.scrollTop) > 0.5) el.scrollTop = next
    }, [scrollElementRef, indexOfKey, virtualizer])

    // Rows changed (a page landed): put the anchored row back before paint.
    useLayoutEffect(() => {
        pendingRef.current = true
        applyAnchor()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rowKeys])

    // ...and once more after the inserted rows have been measured, since
    // until then their contribution to the offset was only an estimate.
    useLayoutEffect(() => {
        if (!pendingRef.current) return
        pendingRef.current = false
        applyAnchor()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [totalSize])

    return (
        <div
            className="relative px-2 py-1"
            style={{ height: `${totalSize}px` }}
        >
            {items.map((vRow) => {
                const hit = hits?.[vRow.index]
                return (
                    <div
                        key={vRow.key}
                        ref={(el) => {
                            if (el) {
                                measureRef.current.set(vRow.index, el)
                                virtualizer.measureElement(el)
                            } else {
                                measureRef.current.delete(vRow.index)
                            }
                        }}
                        data-index={vRow.index}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${vRow.start}px)`,
                        }}
                    >
                        {rows && renderRow
                            ? renderRow(vRow.index)
                            : hit && (
                                <SearchHitRow
                                    hit={hit}
                                    index={vRow.index}
                                    onReveal={onReveal}
                                    onOpen={onOpen}
                                />
                            )}
                    </div>
                )
            })}
        </div>
    )
}
