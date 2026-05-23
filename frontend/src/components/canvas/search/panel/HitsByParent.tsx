/**
 * HitsByParent — group SearchHits under their nearest shared parent.
 *
 * When a search returns many hits sitting under the same container
 * ("T2" returns 14 children of INTERMEDIATE_T2), a flat list buries
 * the hierarchical signal the user is hunting for. This component
 * groups hits client-side by the LAST element of their ``ancestorPath``
 * — i.e. their immediate parent — and renders a collapsible header per
 * group when the group has 3+ siblings. Singletons stay flat at the
 * top so we don't burden the user with a header for one row.
 *
 * The grouping is client-side only and operates on the current results
 * page (50 hits by default). Backend aggregation by parent across the
 * full candidate set would be a richer follow-up.
 */
import { ChevronDown, ChevronRight, Folder } from 'lucide-react'
import { type FC, useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import type { AncestorRef, SearchHit } from '@/types/search'

import { SearchHitRow } from '../SearchHitRow'


export interface HitsByParentProps {
    hits: SearchHit[]
    onReveal?: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpen?: (urn: string) => void
    /** Above this group size, render as a collapsible folder header.
     *  Smaller groups (and singletons) render flat. Default 1 — every
     *  hit appears under its parent's folder so the layout is uniform;
     *  the prior "≥3 only" threshold was confusing because it left a
     *  flat "Top results" island floating above grouped folders.
     */
    minGroupSize?: number
}


interface Group {
    parent: AncestorRef | null
    hits: SearchHit[]
}


export const HitsByParent: FC<HitsByParentProps> = ({
    hits, onReveal, onOpen, minGroupSize = 1,
}) => {
    const { flat, groups } = useMemo(() => groupByParent(hits, minGroupSize), [hits, minGroupSize])

    if (flat.length === 0 && groups.length === 0) {
        return (
            <div className="px-3 py-6 text-[12px] text-ink-muted italic text-center">
                No matches.
            </div>
        )
    }

    return (
        <div className="flex flex-col">
            {flat.length > 0 && (
                <div className="px-2 py-1 flex flex-col gap-0.5">
                    {flat.map((hit, i) => (
                        <SearchHitRow
                            key={hit.node.urn ?? `flat-${i}`}
                            hit={hit}
                            index={i}
                            onReveal={onReveal}
                            onOpen={onOpen}
                        />
                    ))}
                </div>
            )}
            {groups.map((group, gi) => (
                <ParentGroup
                    key={group.parent?.urn ?? `g-${gi}`}
                    group={group}
                    onReveal={onReveal}
                    onOpen={onOpen}
                />
            ))}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Group renderer
// ---------------------------------------------------------------------------

function ParentGroup({
    group, onReveal, onOpen,
}: {
    group: Group
    onReveal?: HitsByParentProps['onReveal']
    onOpen?: HitsByParentProps['onOpen']
}) {
    const [open, setOpen] = useState(true)
    const parent = group.parent
    const title = parent?.displayName ?? 'No parent'
    const subtitle = parent?.entityType ?? ''

    return (
        <div className="border-t border-glass-border/30 first:border-t-0">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    'w-full flex items-center gap-2 px-3 py-2',
                    'text-left hover:bg-glass/30 transition-colors',
                )}
                aria-expanded={open}
            >
                {open
                    ? <ChevronDown className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                    : <ChevronRight className="w-3.5 h-3.5 text-ink-muted shrink-0" />}
                <Folder className="w-3.5 h-3.5 text-accent-lineage shrink-0" />
                <div className="flex-1 min-w-0 flex items-baseline gap-2">
                    <span className="text-[12px] font-semibold text-ink truncate">
                        {title}
                    </span>
                    {subtitle && (
                        <span className="text-[10px] font-mono uppercase tracking-wider text-ink-muted/70">
                            {subtitle}
                        </span>
                    )}
                </div>
                <span className="text-[10.5px] text-ink-muted tabular-nums shrink-0">
                    {group.hits.length} match{group.hits.length === 1 ? '' : 'es'}
                </span>
            </button>
            {open && (
                <div className="px-2 pb-1 flex flex-col gap-0.5">
                    {group.hits.map((hit, i) => (
                        <SearchHitRow
                            key={hit.node.urn ?? `${title}-${i}`}
                            hit={hit}
                            index={i}
                            onReveal={onReveal}
                            onOpen={onOpen}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Group computation
// ---------------------------------------------------------------------------

/**
 * Bucket hits by their immediate parent (the last entry on each hit's
 * ``ancestorPath``). Buckets with fewer than ``minGroupSize`` entries
 * are unrolled into the flat list at the top so we don't render a
 * "1 match" folder header — they'd just add noise.
 */
function groupByParent(
    hits: SearchHit[],
    minGroupSize: number,
): { flat: SearchHit[]; groups: Group[] } {
    const buckets = new Map<string, Group>()
    const order: string[] = []

    for (const hit of hits) {
        const parent = (hit.ancestorPath && hit.ancestorPath.length > 0)
            ? hit.ancestorPath[hit.ancestorPath.length - 1]
            : null
        const key = parent?.urn ?? '__noparent__'
        let bucket = buckets.get(key)
        if (!bucket) {
            bucket = { parent, hits: [] }
            buckets.set(key, bucket)
            order.push(key)
        }
        bucket.hits.push(hit)
    }

    const flat: SearchHit[] = []
    const groups: Group[] = []
    for (const key of order) {
        const bucket = buckets.get(key)!
        if (bucket.hits.length >= minGroupSize) groups.push(bucket)
        else flat.push(...bucket.hits)
    }

    // Sort groups by size, descending — the most-relevant cluster
    // surfaces first.
    groups.sort((a, b) => b.hits.length - a.hits.length)

    return { flat, groups }
}
