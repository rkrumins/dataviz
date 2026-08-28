/**
 * GroupedHitBrowser — browse every match, at any scale, without losing
 * the shape of the canvas.
 *
 * The problem this replaces: ``HitsByParent`` grouped hits under their
 * immediate parent and then THREW THE GROUPING AWAY above 200 hits,
 * falling back to a flat list — exactly when a term appears hundreds of
 * times and the grouping is the only thing making the list readable.
 *
 * Here the grouping survives at any size, because it is by TOP-LEVEL
 * canvas node (few groups, one per column entry) and because headers and
 * rows share ONE virtualized list:
 *
 *   ┌ WAREHOUSE ─────────────────────────────────────────────────┐
 *   │ ▾ Snowflake                                    ✦ 214  Show  │  ← sticky
 *   │     ◆ dim_customer123    GOLD ›                    dataset  │
 *   │     ◆ customer_id        GOLD › dim_orders ›        column  │
 *   │ ▸ Commerce                                       ✦ 3  Show  │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Everything is one flat array of rows — group headers included — so a
 * 500-hit result set mounts the ~15 rows on screen and nothing else, and
 * collapsing a group is a slice of that array rather than a re-layout.
 *
 * Paging is continuous: scrolling within ``PREFETCH_ROWS`` of the tail
 * asks for the next page, so a user who keeps scrolling keeps getting
 * results without hunting for a button. The button stays anyway, for
 * anyone who would rather ask than scroll, alongside "Load all" for the
 * user who wants the complete set before they start reading.
 */
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, Layers, Loader2, MapPin } from 'lucide-react'
import {
    type FC, type RefObject,
    useCallback, useEffect, useMemo, useState,
} from 'react'

import { cn } from '@/lib/utils'
import type { AncestorRef, SearchHit } from '@/types/search'

import { SearchHitRow } from '../SearchHitRow'
import {
    type CanvasRoot, type HitGroup,
    groupHitsByTopLevel,
} from './groupHitsByTopLevel'


/** Groups larger than this open collapsed: at that size the header IS
 *  the answer ("214 under Snowflake"), and opening it buries every other
 *  group below a wall of rows the user has to scroll past. */
const AUTO_COLLAPSE_ABOVE = 40

/** Rows from the tail at which scrolling triggers the next page. Two
 *  screens of lead time, so the list keeps flowing on a fast scroll. */
const PREFETCH_ROWS = 12

const HEADER_H = 34
const ROW_H = 96

/** Floor for the measured viewport height.
 *
 *  ``virtual-core`` returns ZERO virtual items when the scroll element
 *  measures 0px — so a panel caught mid-entry-animation, in a collapsed
 *  flex parent, or in an environment without a layout engine renders an
 *  empty results list over a correctly-sized scroll area. That is the
 *  "I search and nothing happens" failure, and it is silent. Flooring
 *  the reported height costs a few extra mounted rows in the degenerate
 *  case and nothing at all once a real measurement arrives. */
const MIN_VIEWPORT_H = 320


/** ``getBoundingClientRect`` on the scroll element, with the height
 *  floored — see ``MIN_VIEWPORT_H``. Re-reports on resize. */
function observeFlooredRect(
    instance: { scrollElement: Element | Window | null },
    cb: (rect: { width: number; height: number }) => void,
): (() => void) | undefined {
    const el = instance.scrollElement
    if (!el || !(el instanceof Element)) return
    const report = () => {
        const rect = el.getBoundingClientRect()
        cb({ width: rect.width, height: Math.max(rect.height, MIN_VIEWPORT_H) })
    }
    report()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
}


type VRow =
    | { kind: 'header'; group: HitGroup }
    | { kind: 'hit'; group: HitGroup; hit: SearchHit; index: number }
    | { kind: 'tail' }


export interface GroupedHitBrowserProps {
    hits: readonly SearchHit[]
    /** Top-level nodes the canvas renders, by URN. Empty map is valid —
     *  every hit then lands in the single "elsewhere" group, which still
     *  reads correctly, just without canvas vocabulary. */
    canvasRoots: ReadonlyMap<string, CanvasRoot>
    /** The panel's scroll container. The virtualizer measures its
     *  viewport; we never nest a second scroller. */
    scrollElementRef: RefObject<HTMLElement | null>
    onReveal?: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpen?: (urn: string) => void
    /** Scroll the canvas to a group's top-level node. */
    onRevealRoot?: (root: CanvasRoot) => void
    /** More pages exist on the server. */
    hasMore: boolean
    /** Fetch the next page and append it. */
    loadMore: () => void
    isLoadingMore: boolean
    /** Page to completion. Absent when there is nothing left to load. */
    loadAll?: () => void
    isLoadingAll?: boolean
    /** Server-reported total, for "N not loaded yet". */
    serverTotal: number | null
}


export const GroupedHitBrowser: FC<GroupedHitBrowserProps> = ({
    hits, canvasRoots, scrollElementRef,
    onReveal, onOpen, onRevealRoot,
    hasMore, loadMore, isLoadingMore, loadAll, isLoadingAll, serverTotal,
}) => {
    const groups = useMemo(
        () => groupHitsByTopLevel(hits, canvasRoots),
        [hits, canvasRoots],
    )

    // Only DIVERGENCE from the size-derived default is stored, so a group
    // that grows past the threshold as pages land still collapses itself
    // — while a group the user opened by hand stays open.
    const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map())
    const toggle = useCallback((key: string, nextOpen: boolean) => {
        setOverrides((prev) => {
            const next = new Map(prev)
            next.set(key, nextOpen)
            return next
        })
    }, [])

    const rows = useMemo<VRow[]>(() => {
        const out: VRow[] = []
        const single = groups.length === 1
        for (const group of groups) {
            // One group means the header is restating the only thing on
            // screen. Skip it and give the rows the whole panel.
            if (!single) out.push({ kind: 'header', group })
            const open = overrides.get(group.key)
                ?? (single || group.hits.length <= AUTO_COLLAPSE_ABOVE)
            if (!open) continue
            group.hits.forEach((hit, index) => {
                out.push({ kind: 'hit', group, hit, index })
            })
        }
        if (hasMore) out.push({ kind: 'tail' })
        return out
    }, [groups, overrides, hasMore])

    // The scroll container is an ANCESTOR of this component, and React
    // attaches a parent's ref AFTER a child's layout effect has run — so
    // reading the ref directly, the virtualizer's first pass finds no
    // viewport and renders zero rows. A fresh panel's first paint would
    // be an empty list sitting on a correctly-sized scroll area. Holding
    // the element in state gives it a second pass with the element
    // attached, and re-attaches if the container is ever swapped.
    const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
    useEffect(() => { setScrollEl(scrollElementRef.current) }, [scrollElementRef])

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollEl,
        estimateSize: (i) => (rows[i]?.kind === 'hit' ? ROW_H : HEADER_H),
        observeElementRect: observeFlooredRect,
        overscan: 8,
        getItemKey: (i) => {
            const row = rows[i]
            if (!row) return i
            if (row.kind === 'tail') return 'tail'
            if (row.kind === 'header') return `h:${row.group.key}`
            return `r:${row.group.key}:${row.hit.node?.urn ?? row.index}`
        },
    })

    const items = virtualizer.getVirtualItems()

    // Continuous paging. Keyed on the last painted index so one scroll
    // past the threshold asks once; `loadMore` itself no-ops while a
    // request is in flight.
    const lastIndex = items.length > 0 ? items[items.length - 1].index : 0
    const nearTail = hasMore && lastIndex >= rows.length - PREFETCH_ROWS
    useEffect(() => {
        if (nearTail && !isLoadingMore && !isLoadingAll) loadMore()
    }, [nearTail, isLoadingMore, isLoadingAll, loadMore])

    if (rows.length === 0) {
        return (
            <div className="px-3 py-6 text-[12px] text-ink-muted italic text-center">
                No matches.
            </div>
        )
    }

    return (
        <div
            className="relative px-1"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
            {items.map((v) => {
                const row = rows[v.index]
                if (!row) return null
                return (
                    <div
                        key={v.key}
                        ref={virtualizer.measureElement}
                        data-index={v.index}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${v.start}px)`,
                        }}
                    >
                        {row.kind === 'header' ? (
                            <GroupHeader
                                group={row.group}
                                open={overrides.get(row.group.key)
                                    ?? row.group.hits.length <= AUTO_COLLAPSE_ABOVE}
                                onToggle={toggle}
                                onRevealRoot={onRevealRoot}
                            />
                        ) : row.kind === 'hit' ? (
                            <div className="px-1">
                                <SearchHitRow
                                    hit={row.hit}
                                    index={row.index}
                                    fromDepth={row.group.depth + 1}
                                    onReveal={onReveal}
                                    onOpen={onOpen}
                                />
                            </div>
                        ) : (
                            <TailRow
                                loadMore={loadMore}
                                isLoadingMore={isLoadingMore}
                                loadAll={loadAll}
                                isLoadingAll={isLoadingAll}
                                loaded={hits.length}
                                serverTotal={serverTotal}
                            />
                        )}
                    </div>
                )
            })}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Group header
// ---------------------------------------------------------------------------

const GroupHeader: FC<{
    group: HitGroup
    open: boolean
    onToggle: (key: string, nextOpen: boolean) => void
    onRevealRoot?: (root: CanvasRoot) => void
}> = ({ group, open, onToggle, onRevealRoot }) => {
    const root = group.root
    const color = root?.layerColor ?? undefined
    return (
        <div
            className={cn(
                'group/gh flex items-center gap-1.5 px-2 h-[34px]',
                'border-b border-black/[0.05] dark:border-white/[0.05]',
            )}
        >
            <button
                type="button"
                onClick={() => onToggle(group.key, !open)}
                aria-expanded={open}
                className={cn(
                    'flex-1 min-w-0 flex items-center gap-1.5 h-full text-left',
                    'text-ink-muted hover:text-ink transition-colors',
                )}
            >
                {open
                    ? <ChevronDown className="w-3.5 h-3.5 shrink-0" strokeWidth={2.4} />
                    : <ChevronRight className="w-3.5 h-3.5 shrink-0" strokeWidth={2.4} />}
                {root?.layerName && (
                    <span
                        className="text-[9.5px] font-mono uppercase tracking-[0.14em] shrink-0"
                        style={{ color }}
                    >
                        {root.layerName}
                    </span>
                )}
                <span className="text-[12px] font-semibold text-ink truncate">
                    {root?.displayName ?? 'Elsewhere in this view'}
                </span>
                {!root && (
                    <span
                        className="text-[10px] text-ink-muted/70 shrink-0"
                        title="These matches sit outside the top-level nodes this canvas draws — open them in Advanced Search to see their full path."
                    >
                        <Layers className="inline w-2.5 h-2.5 -mt-px mr-0.5" strokeWidth={2.4} />
                        not on this canvas
                    </span>
                )}
            </button>

            <span className={cn(
                'shrink-0 px-1.5 py-0.5 rounded-md tabular-nums',
                'text-[10px] font-semibold leading-none',
                'bg-amber-500/15 text-amber-700 dark:text-amber-300',
            )}>
                {group.hits.length.toLocaleString()}
            </span>

            {root && onRevealRoot && (
                <button
                    type="button"
                    onClick={() => onRevealRoot(root)}
                    title={`Scroll the canvas to ${root.displayName}`}
                    className={cn(
                        'shrink-0 p-1 rounded-md transition-all',
                        'text-ink-muted/60 hover:text-accent-lineage',
                        'opacity-0 group-hover/gh:opacity-100 focus:opacity-100',
                    )}
                >
                    <MapPin className="w-3 h-3" strokeWidth={2.4} />
                </button>
            )}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Tail
// ---------------------------------------------------------------------------

const TailRow: FC<{
    loadMore: () => void
    isLoadingMore: boolean
    loadAll?: () => void
    isLoadingAll?: boolean
    loaded: number
    serverTotal: number | null
}> = ({ loadMore, isLoadingMore, loadAll, isLoadingAll, loaded, serverTotal }) => {
    const remaining = serverTotal !== null ? Math.max(0, serverTotal - loaded) : null
    const busy = isLoadingMore || isLoadingAll
    return (
        <div className="px-2 py-2 flex items-center gap-2">
            <button
                onClick={loadMore}
                disabled={busy}
                className={cn(
                    'flex-1 px-3 py-2 rounded-lg text-[12px] font-medium',
                    'border border-dashed border-black/[0.10] dark:border-white/[0.12]',
                    'text-ink-secondary hover:text-ink',
                    'hover:border-accent-lineage/40 hover:bg-accent-lineage/[0.06]',
                    'transition-colors disabled:opacity-60',
                )}
            >
                {busy ? (
                    <span className="inline-flex items-center gap-2">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2.4} />
                        {isLoadingAll ? 'Loading every match…' : 'Loading…'}
                    </span>
                ) : (
                    <>
                        Load more
                        {remaining !== null && remaining > 0 && (
                            <span className="ml-1 text-ink-muted/70 font-normal">
                                ({remaining.toLocaleString()} not loaded yet)
                            </span>
                        )}
                    </>
                )}
            </button>
            {loadAll && (
                <button
                    onClick={loadAll}
                    disabled={busy}
                    title="Fetch every remaining match so the counts, isolate and exclude cover the whole view"
                    className={cn(
                        'shrink-0 px-3 py-2 rounded-lg text-[12px] font-medium',
                        'border border-accent-lineage/35 text-accent-lineage',
                        'hover:bg-accent-lineage/[0.10] transition-colors disabled:opacity-60',
                    )}
                >
                    Load all
                </button>
            )}
        </div>
    )
}
