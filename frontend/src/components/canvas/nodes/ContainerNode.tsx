/**
 * ContainerNode - Expandable node that shows children inline
 * 
 * Used for entities that contain children (Table → Columns, Schema → Tables, etc.)
 * Shows a collapsed view by default with child count badge.
 * On expansion, children are rendered inline within the node.
 */

import { memo, useState } from 'react'
import { Handle, Position, type NodeProps, NodeToolbar } from '@xyflow/react'
import {
    ChevronDown,
    ChevronRight,
    Table2,
    Columns3,
    Database,
    FolderOpen,
    ArrowUpRight,
    ArrowDownLeft,
    Pin,
    MoreHorizontal,
    Loader2,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { usePersonaStore } from '@/store/persona'
import { useChildren } from '@/providers'
import { cn } from '@/lib/utils'
import type { LineageNode } from '@/store/canvas'
import type { GraphNode } from '@/providers'

export type ContainerNodeProps = NodeProps<LineageNode>

export const ContainerNode = memo(function ContainerNode({
    data,
    selected,
    dragging
}: ContainerNodeProps) {
    const mode = usePersonaStore((s) => s.mode)
    const [isExpanded, setIsExpanded] = useState(false)

    // Get the URN for this node
    const urn = data.urn || ''

    // Fetch children using the graph provider
    const { children, loading } = useChildren(isExpanded ? urn : null)

    const label = mode === 'business'
        ? (data.businessLabel || data.label)
        : (data.technicalLabel || data.label)

    // Determine icon based on asset type
    const getIcon = () => {
        const assetType = data.metadata?.assetType as string
        const nodeType = data.type

        if (nodeType === 'schema' || assetType === 'schema') {
            return FolderOpen
        }
        if (nodeType === 'database' || assetType === 'database') {
            return Database
        }
        if (assetType === 'table' || nodeType === 'asset') {
            return Table2
        }
        return Database
    }
    const Icon = getIcon()

    // Child count from metadata or fetched children
    const childCount = data.metadata?.childCount as number ??
        (data as Record<string, unknown>)._collapsedChildCount as number ??
        children.length

    const toggleExpand = (e: React.MouseEvent) => {
        e.stopPropagation()
        setIsExpanded(!isExpanded)
    }

    return (
        <>
            {/* Toolbar (appears on selection) */}
            <NodeToolbar
                isVisible={selected}
                position={Position.Top}
                className="flex items-center gap-1 glass-panel-subtle rounded-lg p-1"
            >
                <ToolbarButton icon={ArrowUpRight} label="Trace Upstream" />
                <ToolbarButton icon={ArrowDownLeft} label="Trace Downstream" />
                <div className="w-px h-4 bg-glass-border mx-0.5" />
                <ToolbarButton icon={Pin} label="Pin" />
                <ToolbarButton icon={MoreHorizontal} label="More" />
            </NodeToolbar>

            {/* Input Handle */}
            <Handle
                type="target"
                position={Position.Left}
                className={cn(
                    "!w-2 !h-2 !rounded-full !border-2 !border-amber-500",
                    "!bg-canvas-elevated",
                    "hover:!bg-amber-500 transition-colors"
                )}
            />

            {/* Node Content */}
            <motion.div
                layout
                className={cn(
                    "nx-node nx-node-container min-w-[200px] max-w-[280px]",
                    "px-3 py-2 rounded-xl border-2",
                    "bg-canvas-elevated border-amber-500/30",
                    "shadow-lg",
                    selected && "border-amber-500 ring-2 ring-amber-500/20",
                    dragging && "opacity-80 cursor-grabbing"
                )}
            >
                {/* Header */}
                <div className="flex items-center gap-2">
                    {/* Expand/Collapse Toggle */}
                    <button
                        onClick={toggleExpand}
                        className={cn(
                            "w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0",
                            "hover:bg-amber-500/10 transition-colors",
                            childCount === 0 && "opacity-30 pointer-events-none"
                        )}
                    >
                        {loading ? (
                            <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin" />
                        ) : isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5 text-amber-500" />
                        ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-amber-500" />
                        )}
                    </button>

                    {/* Icon */}
                    <div className={cn(
                        "w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0",
                        "bg-amber-500/10"
                    )}>
                        <Icon className="w-3.5 h-3.5 text-amber-500" />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                        <span className="text-2xs font-medium text-amber-600 dark:text-amber-400 uppercase tracking-wider">
                            {(data.metadata?.assetType as string) || data.type || 'Container'}
                        </span>
                        <h3 className="font-medium text-sm text-ink leading-tight truncate">
                            {label}
                        </h3>
                    </div>

                    {/* Child Count Badge */}
                    {!isExpanded && childCount > 0 && (
                        <span className={cn(
                            "px-2 py-0.5 rounded-full text-2xs font-medium",
                            "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        )}>
                            {childCount}
                        </span>
                    )}
                </div>

                {/* Technical Details (Technical Mode) */}
                {mode === 'technical' && !isExpanded && (
                    <div className="mt-2 space-y-1 ml-8">
                        {data.urn && (
                            <code className="text-2xs font-mono text-ink-muted bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded block truncate">
                                {data.urn}
                            </code>
                        )}
                    </div>
                )}

                {/* Classifications */}
                {!isExpanded && data.classifications && data.classifications.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1 ml-8">
                        {data.classifications.slice(0, 2).map((tag) => (
                            <span
                                key={tag}
                                className={cn(
                                    "px-1.5 py-0.5 rounded text-2xs font-medium",
                                    "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                                )}
                            >
                                {tag}
                            </span>
                        ))}
                    </div>
                )}

                {/* Expanded Children */}
                <AnimatePresence>
                    {isExpanded && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                        >
                            <div className="mt-3 pt-2 border-t border-amber-500/20 space-y-1.5 ml-2">
                                {loading && (
                                    <div className="flex items-center gap-2 text-ink-muted text-xs py-2">
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                        Loading children...
                                    </div>
                                )}

                                {!loading && children.length === 0 && (
                                    <div className="text-ink-muted text-xs py-2">
                                        No children
                                    </div>
                                )}

                                {!loading && children.map((child) => (
                                    <ChildItem
                                        key={child.urn}
                                        node={child}
                                        mode={mode}
                                    />
                                ))}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.div>

            {/* Output Handle */}
            <Handle
                type="source"
                position={Position.Right}
                className={cn(
                    "!w-2 !h-2 !rounded-full !border-2 !border-amber-500",
                    "!bg-canvas-elevated",
                    "hover:!bg-amber-500 transition-colors"
                )}
            />
        </>
    )
})

// ============================================
// Child Item Component
// ============================================

interface ChildItemProps {
    node: GraphNode
    mode: 'business' | 'technical'
}

function ChildItem({ node, mode }: ChildItemProps) {
    const label = mode === 'business'
        ? node.displayName
        : node.qualifiedName || node.displayName

    const isColumn = node.entityType === 'schemaField'
    const dataType = node.properties?.dataType as string ||
        (node.properties?.metadata as Record<string, unknown>)?.dataType as string

    return (
        <div className={cn(
            "flex items-center gap-2 px-2 py-1.5 rounded-lg",
            "hover:bg-amber-500/5 transition-colors cursor-pointer",
            "group"
        )}>
            <div className={cn(
                "w-5 h-5 rounded flex items-center justify-center flex-shrink-0",
                "bg-cyan-500/10"
            )}>
                <Columns3 className="w-3 h-3 text-cyan-500" />
            </div>

            <div className="flex-1 min-w-0">
                <span className="text-xs font-medium text-ink truncate block">
                    {label}
                </span>
                {isColumn && dataType && mode === 'technical' && (
                    <span className="text-2xs text-ink-muted font-mono">
                        {dataType}
                    </span>
                )}
            </div>

            {/* Tags */}
            {node.tags && node.tags.length > 0 && (
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {node.tags.slice(0, 1).map((tag) => (
                        <span
                            key={tag}
                            className={cn(
                                "px-1 py-0.5 rounded text-2xs",
                                tag === 'PII' || tag === 'GDPR'
                                    ? "bg-red-500/10 text-red-500"
                                    : "bg-cyan-500/10 text-cyan-500"
                            )}
                        >
                            {tag}
                        </span>
                    ))}
                </div>
            )}
        </div>
    )
}

// ============================================
// Toolbar Button
// ============================================

interface ToolbarButtonProps {
    icon: React.ComponentType<{ className?: string }>
    label: string
    onClick?: () => void
}

function ToolbarButton({ icon: Icon, label, onClick }: ToolbarButtonProps) {
    return (
        <button
            onClick={onClick}
            title={label}
            className={cn(
                "w-7 h-7 rounded-md flex items-center justify-center",
                "text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/10",
                "transition-colors"
            )}
        >
            <Icon className="w-3.5 h-3.5" />
        </button>
    )
}

export default ContainerNode
