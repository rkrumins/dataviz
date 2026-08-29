/**
 * One row of the "Top matches" list.
 *
 * Four facts, in the order a person reads them: what kind of thing it is
 * (the icon's colour), what it is called (with the typed text marked
 * inside it), WHY it is in the list, and where it lives. The last one is
 * the reason this row exists at all rather than a bare name list — a
 * view holds five `customer_id`s and the only thing that tells them
 * apart is the path above them.
 *
 * The path reads top-down and its crumbs are buttons: the container two
 * levels above the hit is very often what the user actually wanted, and
 * revealing it is one click rather than a reveal plus a collapse.
 *
 * DOM focus never comes here. The row is an ARIA `option` in the box's
 * listbox and the input keeps focus throughout, so the crumb buttons are
 * out of the tab order — the keyboard reaches a row with ↑/↓ and takes
 * it with ↵.
 */
import { type FC } from 'react'

import { HighlightedText } from '@/components/ui/HighlightedText'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { cn } from '@/lib/utils'
import { styleFor } from '@/components/canvas/search/SearchHitRow'
import type { AncestorRef, SearchHit } from '@/types/search'

import { depthNote, formatPath } from './dropdownModel'


export interface TopMatchRowProps {
    hit: SearchHit
    /** DOM id — the input points `aria-activedescendant` at it. */
    id: string
    /** Whether this is the row ↵ would reveal. */
    active: boolean
    /** The text to mark inside the name. */
    query: string
    /** The *why* chip. Computed by `whyLabel` on the caller's side so the
     *  row stays a drawing. */
    why: string
    /** Which layer column the hit badges under, if the view has one. */
    layer: string | null
    onActivate: () => void
    onPick: () => void
    /** A crumb was taken. The index is into the hit's WHOLE ancestor
     *  path — the caller slices with it. */
    onCrumb: (ancestor: AncestorRef, index: number) => void
}


export const TopMatchRow: FC<TopMatchRowProps> = ({
    hit, id, active, query, why, layer, onActivate, onPick, onCrumb,
}) => {
    const style = styleFor(hit.node.entityType)
    const ancestors = hit.ancestorPath ?? []
    const { crumbs, depth, full } = formatPath(ancestors)
    const note = depthNote(depth)

    return (
        <div
            id={id}
            role="option"
            aria-selected={active}
            onMouseEnter={onActivate}
            onClick={onPick}
            title={full || undefined}
            className={cn(
                'flex items-start gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer',
                'transition-colors duration-100',
                active ? 'bg-accent-lineage/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
            )}
        >
            <div className={cn(
                'shrink-0 mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center',
                'bg-gradient-to-br border border-glass-border/40',
                style.iconBg,
            )}>
                <DynamicIcon name={style.icon} className={cn('w-3.5 h-3.5', style.iconText)} />
            </div>

            <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 min-w-0">
                    <HighlightedText
                        text={hit.node.displayName || '(unnamed)'}
                        query={query}
                        className="min-w-0 truncate text-[13px] font-medium text-ink"
                    />
                    <span className={cn(
                        'shrink-0 text-[9.5px] uppercase tracking-[0.09em]',
                        style.accentText,
                    )}>
                        {hit.node.entityType}
                    </span>
                    <span className={cn(
                        'ml-auto shrink-0 px-1.5 py-0.5 rounded-md',
                        'text-[10px] font-medium',
                        'bg-accent-lineage/10 text-accent-lineage border border-accent-lineage/20',
                    )}>
                        {why}
                    </span>
                </div>

                <div className="mt-1 flex items-center gap-1 min-w-0 text-[10.5px] text-ink-muted/80">
                    {layer && (
                        <>
                            <span className="shrink-0 font-medium text-ink-muted">{layer}</span>
                            <span aria-hidden className="shrink-0 text-ink-muted/45">▸</span>
                        </>
                    )}
                    {crumbs.map((crumb, i) => (
                        'ellipsis' in crumb ? (
                            <span key={`gap-${i}`} aria-hidden className="shrink-0 text-ink-muted/45">
                                … ›
                            </span>
                        ) : (
                            <span key={crumb.urn} className="inline-flex items-center gap-1 min-w-0">
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        onCrumb(crumb, ancestors.indexOf(crumb))
                                    }}
                                    className={cn(
                                        'max-w-[120px] truncate rounded px-0.5',
                                        'hover:text-accent-lineage hover:underline underline-offset-2',
                                        'transition-colors',
                                    )}
                                >
                                    {crumb.displayName}
                                </button>
                                {i < crumbs.length - 1 && (
                                    <span aria-hidden className="shrink-0 text-ink-muted/45">›</span>
                                )}
                            </span>
                        )
                    ))}
                    {note && (
                        <span className="ml-auto shrink-0 text-ink-muted/55">{note}</span>
                    )}
                </div>
            </div>
        </div>
    )
}
