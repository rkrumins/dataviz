/**
 * HitsByLayer — results grouped by WHERE THEY LIVE.
 *
 *   ▾ Raw                                              40 matches
 *     ▾ CRM                                            40 matches
 *         customer_id      COLUMN   crm ▸ public ▸ …
 *         customer_name    COLUMN   crm ▸ public ▸ …
 *   ▾ Curated                                           3 matches
 *   ▸ Not on this canvas                                1 match
 *
 * The user's mental model of a Context View is layer columns holding
 * top-level containers, so that is the shape the results take: layer ›
 * top-level container › the hits themselves. ``HitsByParent`` groups by
 * IMMEDIATE parent instead, which on a deep hierarchy produces a flat
 * list of leaf folders that all look alike — it stays for the canvases
 * that have no layers.
 *
 * Two numbers, two sources:
 *   * a container's count is the SERVER's per-ancestor aggregation over
 *     the whole match set (``searchStore.ancestorMatchCounts``), so a
 *     container showing two rows can honestly say "40 matches" — the
 *     other 38 are on later pages;
 *   * the hits under it are only this page's.
 * The layer count is the sum of its containers, which inherits that
 * exactness. Where the server did not count an ancestor, the page
 * rollup stands in.
 *
 * Everything renders through ONE virtualizer: the group headers are
 * rows in the same flattened list as the hits (``flattenRows``), so a
 * 12 000-hit result costs the same paint as a 12-hit one and collapsing
 * a layer removes rows rather than unmounting a subtree.
 */
import { ChevronDown, ChevronRight, Folder, Layers } from 'lucide-react'
import { type FC, type RefObject, useCallback, useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import type { AncestorRef, SearchHit } from '@/types/search'
import type { ViewLayerConfig } from '@/types/schema'

import { SearchHitRow } from '../SearchHitRow'

import { VirtualizedHitList } from './VirtualizedHitList'


/** What a hit whose chain touches no layer of this view is filed under.
 *  It is a real answer — the match exists, the canvas just doesn't show
 *  that part of the graph — so it gets a group instead of being dropped. */
export const OFF_CANVAS_LAYER_NAME = 'Not on this canvas'

/** Per-kind row heights for the virtualizer's first pass. It measures the
 *  painted row afterwards; these only need to be close enough that the
 *  scrollbar doesn't jump. */
const ROW_HEIGHT_PX: Record<Row['kind'], number> = {
    layer: 34,
    container: 30,
    hit: 64,
}


export interface ContainerGroup {
    /** The top-level container's URN — or the hit's own, when the hit
     *  IS a top-level node. */
    urn: string
    /** Null when the hit has no ancestors on this page. */
    ref: AncestorRef | null
    /** Server-exact where the aggregation covered this container;
     *  otherwise the number of its hits on this page. */
    count: number
    hits: SearchHit[]
    /** Stable identity — the collapse set holds these. */
    key: string
}

export interface LayerGroup {
    /** Null for {@link OFF_CANVAS_LAYER_NAME}. */
    layerId: string | null
    layerName: string
    /** Σ of the containers' counts. */
    count: number
    containers: ContainerGroup[]
    key: string
}

export type Row =
    | { kind: 'layer'; key: string; group: LayerGroup }
    | { kind: 'container'; key: string; group: ContainerGroup }
    | { kind: 'hit'; key: string; hit: SearchHit; index: number }


// ---------------------------------------------------------------------------
// Grouping (pure)
// ---------------------------------------------------------------------------

/**
 * Bucket hits into layer › top-level container.
 *
 * Groups and containers both keep first-appearance order, which is the
 * server's relevance order — the layers are then re-ordered to match the
 * canvas's own column order so the panel reads left-to-right like the
 * board behind it.
 */
export function groupHitsByLayer(
    hits: SearchHit[],
    resolveLayer: (hit: SearchHit) => string | null,
    ancestorMatchCounts: ReadonlyMap<string, number>,
    layers: ViewLayerConfig[],
): LayerGroup[] {
    const byLayer = new Map<string, LayerGroup>()
    const order: string[] = []

    for (const hit of hits) {
        const layerId = resolveLayer(hit)
        const layerKey = `L:${layerId ?? '__off-canvas'}`
        let group = byLayer.get(layerKey)
        if (!group) {
            group = {
                layerId,
                layerName: layerId === null
                    ? OFF_CANVAS_LAYER_NAME
                    : (layers.find((l) => l.id === layerId)?.name ?? layerId),
                count: 0,
                containers: [],
                key: layerKey,
            }
            byLayer.set(layerKey, group)
            order.push(layerKey)
        }

        const ref = hit.ancestorPath?.[0] ?? null
        const urn = ref?.urn ?? hit.node.urn
        let container = group.containers.find((c) => c.urn === urn)
        if (!container) {
            container = { urn, ref, count: 0, hits: [], key: `${layerKey}|C:${urn}` }
            group.containers.push(container)
        }
        container.hits.push(hit)
    }

    const groups = order.map((key) => byLayer.get(key)!)
    for (const group of groups) {
        for (const container of group.containers) {
            container.count = ancestorMatchCounts.get(container.urn)
                ?? container.hits.length
        }
        group.count = group.containers.reduce((sum, c) => sum + c.count, 0)
    }

    // Canvas column order, with the off-canvas group last. A layer the
    // view no longer declares sorts after the ones it does — it is still
    // a real placement, just not one with a column.
    const rank = (g: LayerGroup) => {
        if (g.layerId === null) return Number.MAX_SAFE_INTEGER
        const i = layers.findIndex((l) => l.id === g.layerId)
        return i < 0 ? layers.length : i
    }
    return groups.sort((a, b) => rank(a) - rank(b))
}


/**
 * Flatten the groups into the one list the virtualizer walks.
 *
 * ``collapsed`` holds group keys: a collapsed LAYER hides its containers
 * and their hits, a collapsed CONTAINER hides only its hits. Headers
 * always survive — collapsing must not hide the count that tells the
 * user what they collapsed.
 */
export function flattenRows(
    groups: LayerGroup[],
    collapsed: ReadonlySet<string>,
): Row[] {
    const rows: Row[] = []
    let hitIndex = 0
    for (const group of groups) {
        rows.push({ kind: 'layer', key: group.key, group })
        if (collapsed.has(group.key)) continue
        for (const container of group.containers) {
            rows.push({ kind: 'container', key: container.key, group: container })
            if (collapsed.has(container.key)) continue
            for (const hit of container.hits) {
                rows.push({
                    kind: 'hit',
                    key: `${container.key}|H:${hit.node.urn}`,
                    hit,
                    index: hitIndex++,
                })
            }
        }
    }
    return rows
}


// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface HitsByLayerProps {
    /** Already grouped, because the pane above also reports how many
     *  layers the page landed in — grouping twice is how the two
     *  numbers would come to disagree. */
    groups: LayerGroup[]
    /** The scroll container ``ResultsPane`` owns. */
    scrollElementRef: RefObject<HTMLElement | null>
    onReveal?: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpen?: (urn: string) => void
}


export const HitsByLayer: FC<HitsByLayerProps> = ({
    groups, scrollElementRef, onReveal, onOpen,
}) => {
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

    const rows = useMemo(() => flattenRows(groups, collapsed), [groups, collapsed])

    const toggle = useCallback((key: string) => {
        setCollapsed((prev) => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }, [])

    const renderRow = useCallback((index: number) => {
        const row = rows[index]
        switch (row.kind) {
            case 'layer':
                return (
                    <GroupHeader
                        title={row.group.layerName}
                        count={row.group.count}
                        open={!collapsed.has(row.key)}
                        onToggle={() => toggle(row.key)}
                        Icon={Layers}
                    />
                )
            case 'container':
                return (
                    <GroupHeader
                        title={row.group.ref?.displayName
                            ?? row.group.hits[0]?.node.displayName
                            ?? row.group.urn}
                        subtitle={row.group.ref?.entityType
                            ?? row.group.hits[0]?.node.entityType}
                        count={row.group.count}
                        open={!collapsed.has(row.key)}
                        onToggle={() => toggle(row.key)}
                        Icon={Folder}
                        indented
                    />
                )
            default:
                return (
                    <div className="px-2">
                        <SearchHitRow
                            hit={row.hit}
                            index={row.index}
                            onReveal={onReveal}
                            onOpen={onOpen}
                        />
                    </div>
                )
        }
    }, [rows, collapsed, toggle, onReveal, onOpen])

    if (rows.length === 0) {
        return (
            <div className="px-3 py-6 text-[12px] text-ink-muted italic text-center">
                No matches.
            </div>
        )
    }

    return (
        <VirtualizedHitList
            rows={rows}
            estimateRowSize={(index) => ROW_HEIGHT_PX[rows[index].kind]}
            renderRow={renderRow}
            scrollElementRef={scrollElementRef}
        />
    )
}


/** One collapsible header. Same visual language as ``ParentGroup`` in
 *  HitsByParent — chevron, typed icon, name, count on the right — with a
 *  left inset for the container tier so the nesting reads at a glance. */
function GroupHeader({
    title, subtitle, count, open, onToggle, Icon, indented,
}: {
    title: string
    subtitle?: string
    count: number
    open: boolean
    onToggle: () => void
    Icon: typeof Folder
    indented?: boolean
}) {
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5',
                'text-left hover:bg-glass/30 transition-colors',
                indented && 'pl-7',
            )}
        >
            {open
                ? <ChevronDown className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                : <ChevronRight className="w-3.5 h-3.5 text-ink-muted shrink-0" />}
            <Icon className="w-3.5 h-3.5 text-accent-lineage shrink-0" />
            <div className="flex-1 min-w-0 flex items-baseline gap-2">
                <span className={cn(
                    'truncate text-ink',
                    indented ? 'text-[12px] font-medium' : 'text-[12px] font-semibold',
                )}>
                    {title}
                </span>
                {subtitle && (
                    <span className="text-[10px] font-mono uppercase tracking-wider text-ink-muted/70">
                        {subtitle}
                    </span>
                )}
            </div>
            <span className="text-[10.5px] text-ink-muted tabular-nums shrink-0">
                {count.toLocaleString()} match{count === 1 ? '' : 'es'}
            </span>
        </button>
    )
}
