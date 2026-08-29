/**
 * Premium row render for one SearchHit.
 *
 * Visual language matches AggregateBucketCard's per-entity-type
 * gradient icon container. The ancestor breadcrumb is rendered as
 * separate chip-style segments (not a single string) so the user
 * can see at a glance WHERE in their hierarchy each match lives —
 * this is the "highlight the ancestor tree" requirement.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ ┌──┐  customer_id                            [PII]            │
 *   │ │🔢│  COLUMN                                                   │
 *   │ └──┘  ◯crm ▸ ◯public ▸ ◯customers ▸ ◯columns  [Reveal][Open]  │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Each ancestor chip is colored by its entity type (using the same
 * palette as AggregateBucketCard) so the path reads as a typed
 * hierarchy, not a string. Hover reveals action chips; tags stay
 * visible.
 */
import { motion } from 'framer-motion'
import { ChevronRight, ExternalLink, Sparkles } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import { type FC, useMemo } from 'react'

import { cn } from '@/lib/utils'
import { useIsFocusedMatch } from '@/store/searchStore'
import type { AncestorRef, SearchHit } from '@/types/search'


/**
 * Stable DOM-id prefix for hit rows. Used by ResultsPane's
 * focused-match effect to ``scrollIntoView`` the focused row without
 * having to thread refs through HitsByParent → VirtualizedHitList.
 */
export const HIT_ROW_ID_PREFIX = 'search-hit-row-'


/**
 * The wire name of a matched field, in the words the user searched with.
 *
 * A bare word now matches the name, the path, the description, the tags
 * AND every property value, so a row that shows only a name leaves the
 * user guessing why it is in the list. The backend answers with
 * ``highlights``; this turns its field spelling into something readable
 * — ``qualifiedName`` is the "path" everywhere else in this UI, and a
 * property key arrives prefixed.
 */
function matchedFieldLabel(field: string): string {
    if (field.startsWith('property:')) return `property ${field.slice('property:'.length)}`
    switch (field) {
        case 'displayName':
        case 'name':
            return 'name'
        case 'qualifiedName':
            return 'path'
        default:
            return field
    }
}


interface EntityTypeStyle {
    icon: string
    iconBg: string
    iconText: string
    accentText: string
    chipBg: string
    chipText: string
}

const ENTITY_STYLES: Record<string, EntityTypeStyle> = {
    domain: {
        icon: 'Globe',
        iconBg: 'from-amber-500/20 to-orange-500/15',
        iconText: 'text-amber-600 dark:text-amber-400',
        accentText: 'text-amber-700 dark:text-amber-300',
        chipBg: 'bg-amber-500/10 border-amber-500/25',
        chipText: 'text-amber-700 dark:text-amber-300',
    },
    dataPlatform: {
        icon: 'Database',
        iconBg: 'from-accent-lineage/20 to-cyan-500/15',
        iconText: 'text-accent-lineage',
        accentText: 'text-accent-lineage',
        chipBg: 'bg-accent-lineage/10 border-accent-lineage/25',
        chipText: 'text-accent-lineage',
    },
    container: {
        icon: 'Folder',
        iconBg: 'from-purple-500/20 to-violet-500/15',
        iconText: 'text-purple-600 dark:text-purple-400',
        accentText: 'text-purple-700 dark:text-purple-300',
        chipBg: 'bg-purple-500/10 border-purple-500/25',
        chipText: 'text-purple-700 dark:text-purple-300',
    },
    schema: {
        icon: 'FolderTree',
        iconBg: 'from-violet-500/20 to-fuchsia-500/15',
        iconText: 'text-violet-600 dark:text-violet-400',
        accentText: 'text-violet-700 dark:text-violet-300',
        chipBg: 'bg-violet-500/10 border-violet-500/25',
        chipText: 'text-violet-700 dark:text-violet-300',
    },
    dataset: {
        icon: 'Table2',
        iconBg: 'from-emerald-500/20 to-teal-500/15',
        iconText: 'text-emerald-600 dark:text-emerald-400',
        accentText: 'text-emerald-700 dark:text-emerald-300',
        chipBg: 'bg-emerald-500/10 border-emerald-500/25',
        chipText: 'text-emerald-700 dark:text-emerald-300',
    },
    schemaField: {
        icon: 'Hash',
        iconBg: 'from-sky-500/20 to-blue-500/15',
        iconText: 'text-sky-600 dark:text-sky-400',
        accentText: 'text-sky-700 dark:text-sky-300',
        chipBg: 'bg-sky-500/10 border-sky-500/25',
        chipText: 'text-sky-700 dark:text-sky-300',
    },
    pipeline: {
        icon: 'Workflow',
        iconBg: 'from-rose-500/20 to-pink-500/15',
        iconText: 'text-rose-600 dark:text-rose-400',
        accentText: 'text-rose-700 dark:text-rose-300',
        chipBg: 'bg-rose-500/10 border-rose-500/25',
        chipText: 'text-rose-700 dark:text-rose-300',
    },
    dataFlow: {
        icon: 'GitBranch',
        iconBg: 'from-indigo-500/20 to-blue-500/15',
        iconText: 'text-indigo-600 dark:text-indigo-400',
        accentText: 'text-indigo-700 dark:text-indigo-300',
        chipBg: 'bg-indigo-500/10 border-indigo-500/25',
        chipText: 'text-indigo-700 dark:text-indigo-300',
    },
}

const DEFAULT_STYLE: EntityTypeStyle = {
    icon: 'Box',
    iconBg: 'from-glass/40 to-glass/20',
    iconText: 'text-ink-secondary',
    accentText: 'text-ink-muted',
    chipBg: 'bg-glass/30 border-glass-border',
    chipText: 'text-ink-muted',
}

function styleFor(type: string): EntityTypeStyle {
    return ENTITY_STYLES[type] ?? DEFAULT_STYLE
}

function lucideIcon(name: string): FC<{ className?: string; strokeWidth?: number }> {
    const Component = (LucideIcons as unknown as Record<
        string, FC<{ className?: string; strokeWidth?: number }>
    >)[name]
    return Component ?? LucideIcons.Box
}


export interface SearchHitRowProps {
    hit: SearchHit
    /** Stagger index for the entry animation. */
    index: number
    /** Reveal-in-canvas action — selects + scrolls + pulses. Receives both
     * the hit URN and the ancestor chain so the caller can walk it. */
    onReveal?: (urn: string, ancestorPath: AncestorRef[]) => void
    /** Open-inspector action — opens the right-rail details for the node. */
    onOpen?: (urn: string) => void
    /** Click an ancestor chip → re-scope the panel to that ancestor. */
    onAncestorClick?: (ancestor: AncestorRef) => void
}

export const SearchHitRow: FC<SearchHitRowProps> = ({
    hit, index, onReveal, onOpen, onAncestorClick,
}) => {
    // Per-row focused subscription. Re-renders only when THIS row's
    // focus state flips, not on every MatchBar step — see the
    // useIsFocusedMatch selector doc.
    const isFocused = useIsFocusedMatch(hit.node.urn)
    const style = useMemo(
        () => styleFor(hit.node.entityType),
        [hit.node.entityType],
    )
    const IconComp = useMemo(() => lucideIcon(style.icon), [style.icon])
    const ancestors = hit.ancestorPath ?? []
    // Best highlight only. The backend orders them by score, and a row
    // that listed every field a broad word touched would be taller than
    // the hit itself.
    const highlight = hit.highlights?.[0]

    return (
        <motion.div
            id={`${HIT_ROW_ID_PREFIX}${hit.node.urn}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
                duration: 0.22,
                delay: Math.min(index * 0.025, 0.4),
                ease: [0.22, 1, 0.36, 1],
            }}
            className={cn(
                "group relative flex items-start gap-3 p-3.5",
                "rounded-xl border border-transparent",
                "hover:bg-glass/40 hover:border-glass-border",
                "hover:shadow-sm",
                "transition-all duration-150",
                // Focus state — driven by the MatchBar stepper /
                // J-K keyboard. Ring overlay (instead of border) so
                // the focus indicator doesn't compete with the
                // existing hover border treatment.
                isFocused && "ring-2 ring-accent-lineage/60 ring-inset bg-accent-lineage/10",
            )}
        >
            {/* Icon — gradient container matching bucket cards */}
            <div className={cn(
                "shrink-0 w-10 h-10 rounded-xl flex items-center justify-center",
                "bg-gradient-to-br border border-glass-border/40",
                style.iconBg,
            )}>
                <IconComp
                    className={cn("w-[18px] h-[18px]", style.iconText)}
                    strokeWidth={2}
                />
            </div>

            <div className="flex-1 min-w-0">
                {/* Row 1: name + type label + tags + action chips */}
                <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-sm font-display font-semibold text-ink truncate">
                        {hit.node.displayName || '(unnamed)'}
                    </span>
                    <span className={cn(
                        "text-[10px] uppercase tracking-[0.1em] font-medium shrink-0",
                        style.accentText,
                    )}>
                        {hit.node.entityType}
                    </span>

                    {/* Tags */}
                    {hit.node.tags && hit.node.tags.length > 0 && (
                        <div className="ml-auto shrink-0 flex items-center gap-1">
                            {hit.node.tags.slice(0, 2).map((tag) => (
                                <span
                                    key={tag}
                                    className={cn(
                                        "inline-flex items-center px-1.5 py-0.5 rounded-md",
                                        "text-[10px] font-medium",
                                        "bg-amber-500/15 text-amber-700 dark:text-amber-300",
                                        "border border-amber-500/30",
                                    )}
                                >
                                    {tag}
                                </span>
                            ))}
                            {hit.node.tags.length > 2 && (
                                <span className="text-[10px] text-ink-muted px-1">
                                    +{hit.node.tags.length - 2}
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {/* Row 2: ancestor breadcrumb as colored chips */}
                {ancestors.length > 0 ? (
                    <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                        {ancestors.map((anc, i) => (
                            <AncestorChip
                                key={`${anc.urn}-${i}`}
                                ancestor={anc}
                                isLast={i === ancestors.length - 1}
                                onClick={
                                    onAncestorClick
                                        ? () => onAncestorClick(anc)
                                        : undefined
                                }
                            />
                        ))}
                    </div>
                ) : hit.node.qualifiedName ? (
                    <div
                        className="mt-1.5 text-[11px] text-ink-muted font-mono truncate"
                        title={hit.node.qualifiedName}
                    >
                        {hit.node.qualifiedName}
                    </div>
                ) : null}

                {/* Row 2b: where the match actually landed */}
                {highlight && (
                    <div className="mt-1.5 flex items-baseline gap-1.5 min-w-0">
                        <span className={cn(
                            "inline-flex items-center px-1.5 py-0.5 rounded-md shrink-0",
                            "text-[10px] font-medium",
                            "bg-accent-lineage/10 text-accent-lineage",
                            "border border-accent-lineage/25",
                        )}>
                            in {matchedFieldLabel(highlight.field)}
                        </span>
                        <span
                            className="min-w-0 truncate text-[11px] text-ink-muted"
                            title={highlight.snippet}
                        >
                            {highlight.snippet}
                        </span>
                    </div>
                )}

                {/* Row 3: action chips, hover-revealed */}
                {(onReveal || onOpen) && (
                    <div className={cn(
                        "mt-2.5 flex items-center gap-1.5",
                        "opacity-0 -translate-y-0.5",
                        "group-hover:opacity-100 group-hover:translate-y-0",
                        "transition-all duration-150",
                    )}>
                        {onReveal && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onReveal(hit.node.urn, ancestors)
                                }}
                                className={cn(
                                    "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg",
                                    "text-[11px] font-medium",
                                    "bg-gradient-to-r from-accent-lineage/20 to-accent-lineage/10",
                                    "text-accent-lineage",
                                    "border border-accent-lineage/30",
                                    "hover:from-accent-lineage/30 hover:to-accent-lineage/15",
                                    "hover:shadow-sm hover:shadow-accent-lineage/20",
                                    "transition-all",
                                )}
                                title="Reveal this node in the canvas — expands the ancestor chain and scrolls to the node"
                            >
                                <Sparkles className="w-3 h-3" />
                                Reveal in canvas
                            </button>
                        )}
                        {onOpen && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onOpen(hit.node.urn)
                                }}
                                className={cn(
                                    "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg",
                                    "text-[11px] font-medium",
                                    "bg-glass/50 text-ink-secondary",
                                    "border border-glass-border",
                                    "hover:bg-glass/70 hover:text-ink",
                                    "transition-all",
                                )}
                                title="Open the node's details panel"
                            >
                                <ExternalLink className="w-3 h-3" />
                                Inspect
                            </button>
                        )}
                    </div>
                )}
            </div>
        </motion.div>
    )
}


/** One colored chip in the ancestor breadcrumb. Clickable when an
 * `onClick` is supplied (re-scopes the panel to that ancestor). */
function AncestorChip({
    ancestor, isLast, onClick,
}: {
    ancestor: AncestorRef
    isLast: boolean
    onClick?: () => void
}) {
    const style = styleFor(ancestor.entityType)
    const Inner = (
        <span
            className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md",
                "text-[10.5px] font-medium",
                "border",
                style.chipBg,
                style.chipText,
                onClick && "hover:brightness-110 transition-all",
            )}
            title={`${ancestor.entityType} · ${ancestor.urn}`}
        >
            <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />
            {ancestor.displayName}
        </span>
    )
    return (
        <span className="inline-flex items-center gap-1">
            {onClick ? (
                <button
                    onClick={(e) => { e.stopPropagation(); onClick() }}
                    className="inline-flex"
                >
                    {Inner}
                </button>
            ) : (
                Inner
            )}
            {!isLast && (
                <ChevronRight className="w-3 h-3 text-ink-muted/50 shrink-0" />
            )}
        </span>
    )
}
