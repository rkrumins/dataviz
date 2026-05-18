/**
 * Premium row render for one SearchHit.
 *
 * Layout (single row, ≥ 56px tall):
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │ [icon] customer_id                       [PII] [Reveal] [Open]│
 *   │        crm › public › customers › columns                     │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * Hover reveals the action chips on the right; tags stay visible.
 * Stagger-animated on entry, matching AggregateBucketCard's rhythm.
 */
import { motion } from 'framer-motion'
import { ExternalLink, MoveRight } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import { type FC, useMemo } from 'react'

import { cn } from '@/lib/utils'
import type { SearchHit } from '@/types/search'


const ENTITY_TYPE_ICONS: Record<string, string> = {
    domain: 'Globe',
    dataPlatform: 'Database',
    container: 'Folder',
    schema: 'FolderTree',
    dataset: 'Table2',
    schemaField: 'Hash',
    pipeline: 'Workflow',
    dataFlow: 'GitBranch',
    app: 'AppWindow',
    system: 'Cpu',
}

const ENTITY_TYPE_TINT: Record<string, string> = {
    domain: 'text-accent-business',
    dataPlatform: 'text-accent-lineage',
    container: 'text-accent-technical',
    schema: 'text-accent-technical',
    dataset: 'text-accent-lineage',
    schemaField: 'text-ink-secondary',
    pipeline: 'text-accent-warning',
    dataFlow: 'text-accent-lineage',
}

function entityIcon(type: string): FC<{ className?: string }> {
    const name = ENTITY_TYPE_ICONS[type] ?? 'Box'
    const Component = (LucideIcons as unknown as Record<
        string, FC<{ className?: string }>
    >)[name]
    return Component ?? LucideIcons.Box
}


export interface SearchHitRowProps {
    hit: SearchHit
    /** Stagger index for the entry animation. */
    index: number
    /** Reveal-in-canvas action — selects the node + scrolls into view. */
    onReveal?: () => void
    /** Open-inspector action — opens the right-rail details for the node. */
    onOpen?: () => void
}

export const SearchHitRow: FC<SearchHitRowProps> = ({
    hit, index, onReveal, onOpen,
}) => {
    const IconComp = useMemo(
        () => entityIcon(hit.node.entityType),
        [hit.node.entityType],
    )
    const iconTint = ENTITY_TYPE_TINT[hit.node.entityType] ?? 'text-ink-muted'

    // Build the ancestor breadcrumb. If hydration isn't set, fall back
    // to qualifiedName (often a `db.schema.table` style string).
    const breadcrumb = useMemo(() => {
        const ancestors = hit.ancestorPath ?? []
        if (ancestors.length > 0) {
            return ancestors.map((a) => a.displayName).join(' › ')
        }
        return hit.node.qualifiedName ?? ''
    }, [hit])

    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
                duration: 0.2,
                delay: Math.min(index * 0.025, 0.4),
                ease: [0.22, 1, 0.36, 1],
            }}
            className={cn(
                "group relative flex items-center gap-3 px-3 py-3",
                "rounded-lg border border-transparent",
                "hover:bg-glass/30 hover:border-glass-border",
                "transition-colors duration-150",
                "min-h-[56px]",
            )}
        >
            {/* Icon */}
            <div
                className={cn(
                    "shrink-0 w-8 h-8 rounded-md flex items-center justify-center",
                    "bg-canvas-elevated border border-glass-border/60",
                    iconTint,
                )}
            >
                <IconComp className="w-4 h-4" />
            </div>

            {/* Name + breadcrumb */}
            <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-ink truncate">
                        {hit.node.displayName || '(unnamed)'}
                    </span>
                    <span className="text-2xs uppercase tracking-wider text-ink-muted shrink-0">
                        {hit.node.entityType}
                    </span>
                </div>
                {breadcrumb && (
                    <div
                        className="text-xs text-ink-muted truncate mt-0.5 font-mono"
                        title={breadcrumb}
                    >
                        {breadcrumb}
                    </div>
                )}
            </div>

            {/* Tags — always visible */}
            {hit.node.tags && hit.node.tags.length > 0 && (
                <div className="shrink-0 flex items-center gap-1.5">
                    {hit.node.tags.slice(0, 3).map((tag) => (
                        <span
                            key={tag}
                            className={cn(
                                "inline-flex items-center px-1.5 py-0.5 rounded",
                                "text-2xs font-medium",
                                "bg-accent-warning/15 text-accent-warning",
                                "border border-accent-warning/30",
                            )}
                        >
                            {tag}
                        </span>
                    ))}
                    {hit.node.tags.length > 3 && (
                        <span className="text-2xs text-ink-muted">
                            +{hit.node.tags.length - 3}
                        </span>
                    )}
                </div>
            )}

            {/* Action chips — hover-revealed */}
            <div
                className={cn(
                    "shrink-0 flex items-center gap-1",
                    "opacity-0 translate-x-1",
                    "group-hover:opacity-100 group-hover:translate-x-0",
                    "transition-all duration-150",
                )}
            >
                {onReveal && (
                    <button
                        onClick={(e) => { e.stopPropagation(); onReveal() }}
                        className={cn(
                            "inline-flex items-center gap-1 px-2 py-1 rounded-md",
                            "text-2xs font-medium",
                            "bg-accent-lineage/15 text-accent-lineage",
                            "hover:bg-accent-lineage/25",
                            "transition-colors",
                        )}
                        title="Reveal this node in the canvas"
                    >
                        <MoveRight className="w-3 h-3" />
                        Reveal
                    </button>
                )}
                {onOpen && (
                    <button
                        onClick={(e) => { e.stopPropagation(); onOpen() }}
                        className={cn(
                            "inline-flex items-center gap-1 px-2 py-1 rounded-md",
                            "text-2xs font-medium",
                            "bg-glass/40 text-ink-secondary",
                            "hover:bg-glass/60",
                            "border border-glass-border/60",
                            "transition-colors",
                        )}
                        title="Open the node's details panel"
                    >
                        <ExternalLink className="w-3 h-3" />
                        Open
                    </button>
                )}
            </div>
        </motion.div>
    )
}
