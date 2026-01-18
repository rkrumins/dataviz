import { useCallback, useMemo } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AnimatePresence } from 'framer-motion'
import { GitBranch } from 'lucide-react'

// Legacy nodes for backward compatibility
import { DomainNode } from './nodes/DomainNode'
import { AppNode } from './nodes/AppNode'
import { AssetNode } from './nodes/AssetNode'
import { GhostNode } from './nodes/GhostNode'
// New generic node for schema-driven rendering
import { GenericNode } from './nodes/GenericNode'
import { LineageEdge } from './edges/LineageEdge'
import { AggregatedEdge } from './edges/AggregatedEdge'
import { CanvasControls } from './CanvasControls'
import { LineageToolbar } from './LineageToolbar'
import { EdgeDetailPanel } from '../panels/EdgeDetailPanel'
import { EdgeLegend } from './EdgeLegend'
import { useSpatialLoading } from '@/hooks/useSpatialLoading'
import { useLineageExploration } from '@/hooks/useLineageExploration'
import { useEdgeDetailPanel, useEdgeTypeFilters } from '@/hooks/useEdgeFilters'
import { useCanvasStore, type LineageNode, type LineageEdge as LineageEdgeType } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'
import { useSchemaStore } from '@/store/schema'
import { cn } from '@/lib/utils'

// Register custom node types - includes both legacy and generic
const nodeTypes = {
  // Legacy nodes for demo data compatibility
  domain: DomainNode,
  app: AppNode,
  asset: AssetNode,
  ghost: GhostNode,
  // Generic node for schema-driven entities
  generic: GenericNode,
}

// Register custom edge types
const edgeTypes = {
  lineage: LineageEdge,
  aggregated: AggregatedEdge,
}

export function LineageCanvas() {
  // Raw nodes/edges from store (for mutations)
  const { setNodes, setEdges, selectNode, selectEdge, clearSelection } = useCanvasStore()
  const rawNodes = useCanvasStore((s) => s.nodes)
  const rawEdges = useCanvasStore((s) => s.edges)

  // Lineage exploration hook - handles modes, granularity, trace
  const {
    mode,
    granularity,
    focusEntityId,
    visibleNodes,
    visibleEdges,
    aggregatedEdges,
    upstreamCount,
    downstreamCount,
    setFocus,
  } = useLineageExploration()

  // Use exploration-computed data for display, fallback to raw
  const displayNodes = visibleNodes.length > 0 ? visibleNodes : rawNodes
  const displayEdges = visibleEdges.length > 0 ? visibleEdges : rawEdges

  const { showMinimap, showGrid, snapToGrid } = usePreferencesStore()
  const schema = useSchemaStore((s) => s.schema)

  // Edge detail panel
  const { isOpen: isEdgePanelOpen, toggle: toggleEdgePanel, close: closeEdgePanel } = useEdgeDetailPanel()
  const { filters: edgeFilters, toggle: toggleEdgeFilter } = useEdgeTypeFilters()

  // Spatial loading hook
  const { isLoadingRegion } = useSpatialLoading()

  // Handle node changes (position, selection, etc.)
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      // Apply changes to raw nodes (not projected)
      setNodes(applyNodeChanges(changes, rawNodes) as LineageNode[])
    },
    [rawNodes, setNodes]
  )

  // Handle edge changes
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      setEdges(applyEdgeChanges(changes, rawEdges) as LineageEdgeType[])
    },
    [rawEdges, setEdges]
  )

  // Handle new connections (if allowed)
  const onConnect: OnConnect = useCallback(
    (_connection) => {
      // In lineage view, we typically don't allow manual connections
      // This could be enabled for editing mode
    },
    []
  )

  // Handle node click
  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      selectNode(node.id)
    },
    [selectNode]
  )

  // Handle node double-click for focus/drill
  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      // Set focus to this node for lineage trace
      setFocus(node.id)
    },
    [setFocus]
  )

  // Handle pane click to deselect
  const onPaneClick = useCallback(() => {
    clearSelection()
  }, [clearSelection])

  // Handle edge click
  const onEdgeClick: EdgeMouseHandler = useCallback(
    (_, edge) => {
      selectEdge(edge.id)
    },
    [selectEdge]
  )

  // Default edge options
  const defaultEdgeOptions = useMemo(() => ({
    type: 'lineage',
    animated: true,
  }), [])

  // Minimap node color function - now schema-driven
  const minimapNodeColor = useCallback((node: LineageNode) => {
    // Try to get color from schema
    const entityType = schema?.entityTypes.find((et) => et.id === node.data.type)
    if (entityType) {
      return entityType.visual.color
    }

    // Fallback for legacy nodes
    switch (node.data.type) {
      case 'domain':
        return '#8b5cf6'
      case 'app':
        return '#06b6d4'
      case 'asset':
        return '#22c55e'
      case 'ghost':
        return '#94a3b8'
      default:
        return '#6366f1'
    }
  }, [schema])

  return (
    <div className="w-full h-full relative flex flex-col">
      {/* Lineage Exploration Toolbar */}
      <div className="absolute top-4 left-4 right-4 z-10">
        <LineageToolbar />
      </div>

      {/* React Flow Canvas */}
      <div className="flex-1">
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
          defaultEdgeOptions={defaultEdgeOptions}
          snapToGrid={snapToGrid}
          snapGrid={[16, 16]}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
          className="bg-canvas"
          proOptions={{ hideAttribution: true }}
        >
          {/* Background Pattern */}
          {showGrid && (
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              className="opacity-40"
            />
          )}

          {/* Custom Controls */}
          <CanvasControls />

          {/* Minimap */}
          {showMinimap && (
            <MiniMap
              nodeColor={minimapNodeColor}
              maskColor="rgba(0, 0, 0, 0.1)"
              className={cn(
                "glass-panel-subtle !rounded-xl !overflow-hidden",
                "!bottom-4 !right-4"
              )}
              pannable
              zoomable
            />
          )}

          {/* Standard Controls */}
          <Controls
            className={cn(
              "glass-panel-subtle !rounded-xl !overflow-hidden !shadow-lg",
              "!bottom-4 !left-4"
            )}
            showInteractive={false}
          />

          {/* Loading indicator for spatial loading */}
          {isLoadingRegion && (
            <div className="absolute top-20 right-4 glass-panel-subtle rounded-lg px-3 py-2 flex items-center gap-2">
              <div className="w-3 h-3 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-ink-secondary">Loading region...</span>
            </div>
          )}
        </ReactFlow>
      </div>

      {/* Edge Legend - positioned above minimap */}
      <div className="absolute bottom-40 right-4 z-10 w-64">
        <EdgeLegend defaultExpanded={false} />
      </div>

      {/* Stats Bar */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3">
        {/* Mode/Granularity indicator */}
        <div className="glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2">
          <span className="text-2xs text-ink-muted capitalize">
            {mode} · {granularity}
          </span>
        </div>

        {/* Entity counts */}
        <div className="glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2">
          <span className="text-2xs text-ink-muted">
            {displayNodes.length} entities · {displayEdges.length} relationships
          </span>
        </div>

        {/* Trace info (when focused) */}
        {focusEntityId && (upstreamCount > 0 || downstreamCount > 0) && (
          <div className="glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2">
            <span className="text-2xs text-ink-muted">
              ↑{upstreamCount} upstream · ↓{downstreamCount} downstream
            </span>
          </div>
        )}

        {/* Aggregated edges indicator */}
        {aggregatedEdges.size > 0 && (
          <div className="glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
            <span className="text-2xs text-amber-600 dark:text-amber-400">
              {aggregatedEdges.size} inherited
            </span>
          </div>
        )}

        {/* Edge Details Toggle */}
        <button
          onClick={toggleEdgePanel}
          className={cn(
            "glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2 transition-colors",
            isEdgePanelOpen && "bg-accent-lineage/10 border-accent-lineage"
          )}
        >
          <GitBranch className="w-3.5 h-3.5 text-accent-lineage" />
          <span className="text-2xs text-ink-muted">Edge Details</span>
        </button>
      </div>

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

