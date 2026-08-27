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
 */
import { type FC, type RefObject, useRef } from 'react'

import { useVirtualizer } from '@tanstack/react-virtual'

import type { AncestorRef, SearchHit } from '@/types/search'

import { SearchHitRow } from '../SearchHitRow'


export interface VirtualizedHitListProps {
    hits: readonly SearchHit[]
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
    hits, scrollElementRef, onReveal, onOpen,
    estimatedRowHeightPx = 64, overscan = 6,
}) => {
    const measureRef = useRef<Map<number, HTMLDivElement>>(new Map())

    const virtualizer = useVirtualizer({
        count: hits.length,
        getScrollElement: () => scrollElementRef.current,
        estimateSize: () => estimatedRowHeightPx,
        overscan,
    })

    const items = virtualizer.getVirtualItems()
    const totalSize = virtualizer.getTotalSize()

    return (
        <div
            className="relative px-2 py-1"
            style={{ height: `${totalSize}px` }}
        >
            {items.map((vRow) => {
                const hit = hits[vRow.index]
                return (
                    <div
                        key={hit.node.urn ?? `v-${vRow.index}`}
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
                        <SearchHitRow
                            hit={hit}
                            index={vRow.index}
                            onReveal={onReveal}
                            onOpen={onOpen}
                        />
                    </div>
                )
            })}
        </div>
    )
}
