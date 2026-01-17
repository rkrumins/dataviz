/**
 * LayeredLineageCanvas - Combines Reference Model layers with Lineage visualization
 * 
 * Features:
 * - Horizontal layer columns (Source → Staging → Refinery → Consumption)
 * - Entities organized within their assigned layers
 * - Lineage edges flowing between layers (toggle-able)
 * - Lazy loading per layer
 * - Integration with useLineageExploration for tracing
 */

import { useState, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore, type LineageEdge as CanvasLineageEdge } from '@/store/canvas'
import { useLineageExploration } from '@/hooks/useLineageExploration'
import { useEdgeDetailPanel, useEdgeTypeFilters } from '@/hooks/useEdgeFilters'
import { useGraphProvider } from '@/providers'
import { resolveLayerAssignment, type LayerAssignmentRule, type GraphNode } from '@/providers'
import { EdgeDetailPanel } from '../panels/EdgeDetailPanel'
import type { ViewLayerConfig } from '@/types/schema'

// ============================================
// Dynamic Icon Component
// ============================================

function DynamicIcon({
    name,
    className,
    style
}: {
    name: string
    className?: string
    style?: React.CSSProperties
}) {
    const IconComponent = (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>>)[name]
    if (!IconComponent) {
        return <LucideIcons.Box className={className} style={style} />
    }
    return <IconComponent className={className} style={style} />
}

// ============================================
// Default Layers
// ============================================

export const defaultLayers: ViewLayerConfig[] = [
    {
        id: 'source',
        name: 'Source Layer',
        description: 'Raw data sources and ingestion',
        icon: 'Database',
        color: '#8b5cf6', // Purple
        entityTypes: ['domain', 'dataPlatform'],
        order: 0,
    },
    {
        id: 'staging',
        name: 'Staging',
        description: 'Raw data landing zone',
        icon: 'Inbox',
        color: '#06b6d4', // Cyan
        entityTypes: ['container', 'schema'],
        order: 1,
    },
    {
        id: 'refinery',
        name: 'Refinery',
        description: 'Transformation and processing',
        icon: 'Workflow',
        color: '#f59e0b', // Amber
        entityTypes: ['dataJob', 'dataset'],
        order: 2,
    },
    {
        id: 'consumption',
        name: 'Consumption',
        description: 'Analytics and reporting',
        icon: 'BarChart3',
        color: '#22c55e', // Green
        entityTypes: ['dashboard', 'chart'],
        order: 3,
    },
]

// ============================================
// Props & Types
// ============================================

interface LayeredLineageCanvasProps {
    className?: string
    layers?: ViewLayerConfig[]
    showLineageFlow?: boolean
}

// ============================================
// Main Component
// ============================================

export function LayeredLineageCanvas({
    className,
    layers = defaultLayers,
    showLineageFlow: initialShowLineageFlow = true,
}: LayeredLineageCanvasProps) {
    // Provider available for future lazy-loading implementation
    useGraphProvider()
    const nodes = useCanvasStore((s) => s.nodes)
    const edges = useCanvasStore((s) => s.edges)
    const selectNode = useCanvasStore((s) => s.selectNode)
    const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)

    // Lineage exploration hook
    const {
        mode,
        granularity,
        focusEntityId,
        setFocus,
    } = useLineageExploration()

    // Local state
    const [showLineageFlow, setShowLineageFlow] = useState(initialShowLineageFlow)
    const [searchQuery, setSearchQuery] = useState('')

    // Edge detail panel
    const { isOpen: isEdgePanelOpen, toggle: toggleEdgePanel, close: closeEdgePanel } = useEdgeDetailPanel()
    const { filters: edgeFilters, toggle: toggleEdgeFilter } = useEdgeTypeFilters()

    // Sort layers by order
    const sortedLayers = useMemo(() =>
        [...layers].sort((a, b) => a.order - b.order),
        [layers]
    )

    // Build layer assignment rules from entity types
    const layerRules = useMemo<LayerAssignmentRule[]>(() =>
        sortedLayers.flatMap(layer =>
            layer.entityTypes.map((entityType, idx) => ({
                id: `${layer.id}-${entityType}`,
                layerId: layer.id,
                entityTypes: [entityType as never],
                priority: layer.order * 10 + idx,
            }))
        ),
        [sortedLayers]
    )

    // Assign nodes to layers using the provider's GraphNode format
    const nodesByLayer = useMemo(() => {
        const grouped = new Map<string, GraphNode[]>()

        // Initialize all layers
        sortedLayers.forEach((layer) => {
            grouped.set(layer.id, [])
        })

        // Map canvas nodes to GraphNode format and assign to layers
        nodes.forEach((node) => {
            if (node.data.type === 'ghost') return

            const graphNode: GraphNode = {
                urn: node.data.urn || node.id,
                entityType: mapNodeType(node.data.type),
                displayName: node.data.label || node.id,
                qualifiedName: node.data.technicalLabel,
                description: (node.data as Record<string, unknown>).description as string | undefined,
                properties: node.data as Record<string, unknown>,
                tags: node.data.classifications || [],
            }

            // Find which layer this node belongs to
            const layerId = resolveLayerAssignment(graphNode, layerRules)
            if (layerId) {
                grouped.get(layerId)?.push(graphNode)
            } else {
                // Default to refinery for unassigned nodes
                grouped.get('refinery')?.push(graphNode)
            }
        })

        return grouped
    }, [nodes, sortedLayers, layerRules])

    // Get lineage edges for visualization
    const lineageEdges = useMemo(() => {
        if (!showLineageFlow) return []

        return edges.filter(edge => {
            const edgeType = edge.data?.edgeType || edge.data?.relationship
            return edgeType !== 'contains' && edgeType !== 'CONTAINS'
        })
    }, [edges, showLineageFlow])

    // Search filter
    const filteredNodesByLayer = useMemo(() => {
        if (!searchQuery.trim()) return nodesByLayer

        const query = searchQuery.toLowerCase()
        const filtered = new Map<string, GraphNode[]>()

        nodesByLayer.forEach((nodes, layerId) => {
            filtered.set(layerId, nodes.filter(node =>
                node.displayName.toLowerCase().includes(query) ||
                node.qualifiedName?.toLowerCase().includes(query) ||
                node.tags?.some(t => t.toLowerCase().includes(query))
            ))
        })

        return filtered
    }, [nodesByLayer, searchQuery])

    // Toggle lineage flow
    const toggleLineageFlow = useCallback(() => {
        setShowLineageFlow(prev => !prev)
    }, [])

    return (
        <div className={cn("h-full w-full flex flex-col overflow-hidden bg-canvas", className)}>
            {/* Header */}
            <div className="flex-shrink-0 bg-canvas-elevated/95 backdrop-blur border-b border-glass-border px-6 py-3">
                <div className="flex items-center gap-4">
                    <h2 className="text-lg font-display font-semibold text-ink">Layered Lineage</h2>
                    <span className="px-2 py-1 rounded-md bg-accent-lineage/10 text-accent-lineage text-xs font-medium">
                        Business View
                    </span>
                    <div className="flex-1" />

                    {/* Search */}
                    <div className="relative">
                        <LucideIcons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                        <input
                            type="text"
                            placeholder="Search..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="input pl-9 pr-8 py-1.5 w-48 text-sm"
                        />
                        {searchQuery && (
                            <button
                                onClick={() => setSearchQuery('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink"
                            >
                                <LucideIcons.X className="w-4 h-4" />
                            </button>
                        )}
                    </div>

                    {/* Lineage Flow Toggle */}
                    <button
                        onClick={toggleLineageFlow}
                        className={cn(
                            "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                            showLineageFlow
                                ? "bg-accent-lineage/10 text-accent-lineage"
                                : "bg-black/5 dark:bg-white/10 text-ink-muted"
                        )}
                    >
                        <LucideIcons.GitBranch className="w-4 h-4" />
                        {showLineageFlow ? 'Flow On' : 'Flow Off'}
                    </button>

                    {/* Mode/Granularity */}
                    <div className="flex items-center gap-2 text-sm text-ink-muted">
                        <span className="capitalize">{mode}</span>
                        <span>·</span>
                        <span className="capitalize">{granularity}</span>
                    </div>
                </div>

                {/* Stats Bar */}
                <div className="mt-2 flex items-center gap-4 text-xs text-ink-muted">
                    <span>{nodes.length} entities</span>
                    {showLineageFlow && <span>{lineageEdges.length} flows</span>}
                    {focusEntityId && <span>Focused: {focusEntityId}</span>}
                </div>
            </div>

            {/* Layer Columns */}
            <div className="flex-1 overflow-auto">
                <div className="flex h-full min-h-0 relative">
                    {sortedLayers.map((layer) => (
                        <LayerColumn
                            key={layer.id}
                            layer={layer}
                            nodes={filteredNodesByLayer.get(layer.id) ?? []}
                            selectedNodeId={selectedNodeIds[0] ?? null}
                            onSelect={selectNode}
                            onFocus={setFocus}
                            showLineageFlow={showLineageFlow}
                        />
                    ))}

                    {/* Lineage Flow Overlay */}
                    {showLineageFlow && lineageEdges.length > 0 && (
                        <LineageFlowOverlay
                            edges={lineageEdges}
                            nodesByLayer={nodesByLayer}
                        />
                    )}
                </div>
            </div>

            {/* Edge Details Toggle */}
            <button
                onClick={toggleEdgePanel}
                className={cn(
                    "absolute bottom-4 right-4 z-10 glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2 transition-colors",
                    isEdgePanelOpen && "bg-accent-lineage/10 border-accent-lineage"
                )}
            >
                <LucideIcons.GitBranch className="w-3.5 h-3.5 text-accent-lineage" />
                <span className="text-2xs text-ink-muted">Edge Details</span>
            </button>

            {/* Edge Detail Panel */}
            <AnimatePresence>
                {isEdgePanelOpen && (
                    <EdgeDetailPanel
                        isOpen={isEdgePanelOpen}
                        onClose={closeEdgePanel}
                        edgeFilters={edgeFilters}
                        onToggleFilter={toggleEdgeFilter}
                    />
                )}
            </AnimatePresence>
        </div>
    )
}

// ============================================
// Layer Column
// ============================================

interface LayerColumnProps {
    layer: ViewLayerConfig
    nodes: GraphNode[]
    selectedNodeId: string | null
    onSelect: (id: string) => void
    onFocus: (id: string | null) => void
    showLineageFlow: boolean
}

function LayerColumn({
    layer,
    nodes,
    selectedNodeId,
    onSelect,
    onFocus,
    showLineageFlow,
}: LayerColumnProps) {
    const [isCollapsed, setIsCollapsed] = useState(false)

    return (
        <div className={cn(
            "flex-1 min-w-[260px] max-w-[350px] border-r border-glass-border last:border-r-0 flex flex-col",
            isCollapsed && "max-w-[60px] min-w-[60px]"
        )}>
            {/* Layer Header */}
            <div
                className="flex-shrink-0 px-4 py-3 border-b border-glass-border cursor-pointer"
                style={{ backgroundColor: `${layer.color}10` }}
                onClick={() => setIsCollapsed(!isCollapsed)}
            >
                <div className="flex items-center gap-3">
                    <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center"
                        style={{ backgroundColor: `${layer.color}20` }}
                    >
                        <DynamicIcon
                            name={layer.icon ?? 'Layers'}
                            className="w-4 h-4"
                            style={{ color: layer.color }}
                        />
                    </div>

                    {!isCollapsed && (
                        <>
                            <div className="flex-1 min-w-0">
                                <h3 className="text-sm font-semibold" style={{ color: layer.color }}>
                                    {layer.name}
                                </h3>
                                {layer.description && (
                                    <p className="text-2xs text-ink-muted truncate">{layer.description}</p>
                                )}
                            </div>
                            <span className="px-2 py-0.5 rounded-full text-2xs font-medium bg-black/5 dark:bg-white/10 text-ink-muted">
                                {nodes.length}
                            </span>
                        </>
                    )}
                </div>
            </div>

            {/* Layer Content */}
            {!isCollapsed && (
                <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
                    {nodes.length === 0 ? (
                        <div className="text-center py-8 text-ink-muted text-sm">
                            No entities
                        </div>
                    ) : (
                        nodes.map((node) => (
                            <LayerNodeCard
                                key={node.urn}
                                node={node}
                                layer={layer}
                                isSelected={selectedNodeId === node.urn}
                                onSelect={() => onSelect(node.urn)}
                                onDoubleClick={() => onFocus(node.urn)}
                                showLineageFlow={showLineageFlow}
                            />
                        ))
                    )}
                </div>
            )}
        </div>
    )
}

// ============================================
// Layer Node Card
// ============================================

interface LayerNodeCardProps {
    node: GraphNode
    layer: ViewLayerConfig
    isSelected: boolean
    onSelect: () => void
    onDoubleClick: () => void
    showLineageFlow: boolean
}

function LayerNodeCard({
    node,
    layer,
    isSelected,
    onSelect,
    onDoubleClick,
    showLineageFlow,
}: LayerNodeCardProps) {
    return (
        <motion.div
            layout
            id={`layer-node-${node.urn}`}
            className={cn(
                "rounded-lg border transition-all duration-200",
                "bg-canvas-elevated hover:shadow-md cursor-pointer",
                isSelected && "ring-2 ring-offset-1",
            )}
            style={{
                borderColor: layer.color ?? '#6b7280',
                borderLeftWidth: '3px',
                ['--tw-ring-color' as string]: layer.color ?? '#6b7280',
            }}
            onClick={onSelect}
            onDoubleClick={onDoubleClick}
        >
            <div className="flex items-center gap-2 px-3 py-2">
                <div
                    className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: `${layer.color}15` }}
                >
                    <EntityIcon
                        entityType={node.entityType}
                        color={layer.color}
                    />
                </div>

                <div className="flex-1 min-w-0">
                    <span className="text-2xs font-medium uppercase tracking-wider text-ink-muted">
                        {node.entityType}
                    </span>
                    <h4 className="text-sm font-medium text-ink truncate">
                        {node.displayName}
                    </h4>
                </div>

                {/* Child count */}
                {node.childCount && node.childCount > 0 && (
                    <span className="text-2xs text-ink-muted px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10">
                        +{node.childCount}
                    </span>
                )}

                {/* Lineage indicator */}
                {showLineageFlow && (
                    <div className="w-2 h-2 rounded-full bg-green-500 opacity-60" />
                )}
            </div>

            {/* Tags */}
            {node.tags && node.tags.length > 0 && (
                <div className="px-3 pb-2 flex flex-wrap gap-1">
                    {node.tags.slice(0, 2).map((tag) => (
                        <span
                            key={tag}
                            className={cn(
                                "px-1.5 py-0.5 rounded text-2xs font-medium",
                                tag === 'PII' || tag === 'GDPR'
                                    ? "bg-red-500/10 text-red-500"
                                    : "bg-black/5 dark:bg-white/10 text-ink-muted"
                            )}
                        >
                            {tag}
                        </span>
                    ))}
                </div>
            )}
        </motion.div>
    )
}

// ============================================
// Lineage Flow Overlay
// ============================================

interface LineageFlowOverlayProps {
    edges: CanvasLineageEdge[]
    nodesByLayer: Map<string, GraphNode[]>
}

// Note: layers parameter reserved for future SVG path drawing implementation
function LineageFlowOverlay({ edges, nodesByLayer }: LineageFlowOverlayProps) {
    // This is a simplified overlay - in a full implementation,
    // we'd calculate actual positions and draw SVG paths

    // For now, show a summary indicator
    const crossLayerFlows = useMemo(() => {
        const flows: { from: string; to: string; count: number }[] = []

        // Build node-to-layer map
        const nodeLayerMap = new Map<string, string>()
        nodesByLayer.forEach((nodes, layerId) => {
            nodes.forEach(node => {
                nodeLayerMap.set(node.urn, layerId)
            })
        })

        // Count cross-layer edges
        const flowCounts = new Map<string, number>()
        edges.forEach(edge => {
            const sourceLayer = nodeLayerMap.get(edge.source)
            const targetLayer = nodeLayerMap.get(edge.target)
            if (sourceLayer && targetLayer && sourceLayer !== targetLayer) {
                const key = `${sourceLayer}->${targetLayer}`
                flowCounts.set(key, (flowCounts.get(key) ?? 0) + 1)
            }
        })

        flowCounts.forEach((count, key) => {
            const [from, to] = key.split('->')
            flows.push({ from, to, count })
        })

        return flows
    }, [edges, nodesByLayer])

    if (crossLayerFlows.length === 0) return null

    return (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
            <div className="glass-panel-subtle rounded-lg px-4 py-2 flex items-center gap-3">
                <LucideIcons.GitBranch className="w-4 h-4 text-accent-lineage" />
                <span className="text-xs text-ink-muted">
                    {crossLayerFlows.reduce((sum, f) => sum + f.count, 0)} cross-layer flows
                </span>
                <div className="flex gap-2">
                    {crossLayerFlows.slice(0, 3).map((flow, idx) => (
                        <span
                            key={idx}
                            className="text-2xs px-2 py-0.5 rounded bg-accent-lineage/10 text-accent-lineage"
                        >
                            {flow.from} → {flow.to}: {flow.count}
                        </span>
                    ))}
                </div>
            </div>
        </div>
    )
}

// ============================================
// Helper Functions
// ============================================

function mapNodeType(type: string): GraphNode['entityType'] {
    const mapping: Record<string, GraphNode['entityType']> = {
        domain: 'container',
        app: 'dataPlatform',
        asset: 'dataset',
        column: 'schemaField',
        ghost: 'dataset',
    }
    return mapping[type] ?? 'dataset'
}

function EntityIcon({ entityType, color }: { entityType: string; color?: string }) {
    const iconMap: Record<string, string> = {
        dataPlatform: 'Database',
        container: 'Folder',
        dataset: 'Table2',
        schemaField: 'Columns3',
        dataJob: 'Workflow',
        dashboard: 'BarChart3',
    }

    return (
        <DynamicIcon
            name={iconMap[entityType] ?? 'Box'}
            className="w-3.5 h-3.5"
            style={{ color }}
        />
    )
}

export default LayeredLineageCanvas
