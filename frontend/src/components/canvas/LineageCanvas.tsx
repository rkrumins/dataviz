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
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

// Legacy nodes for backward compatibility
import { DomainNode } from './nodes/DomainNode'
import { AppNode } from './nodes/AppNode'
import { AssetNode } from './nodes/AssetNode'
import { GhostNode } from './nodes/GhostNode'
// New generic node for schema-driven rendering
import { GenericNode } from './nodes/GenericNode'
import { LineageEdge } from './edges/LineageEdge'
import { CanvasControls } from './CanvasControls'
import { useSpatialLoading } from '@/hooks/useSpatialLoading'
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
}

export function LineageCanvas() {
  const { nodes, edges, setNodes, setEdges, selectNode, clearSelection } = useCanvasStore()
  const { showMinimap, showGrid, snapToGrid } = usePreferencesStore()
  const schema = useSchemaStore((s) => s.schema)
  const activeView = useSchemaStore((s) => s.getActiveView())
  
  // Spatial loading hook
  const { onViewportChange, isLoadingRegion } = useSpatialLoading()

  // Handle node changes (position, selection, etc.)
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      setNodes(applyNodeChanges(changes, nodes) as LineageNode[])
    },
    [nodes, setNodes]
  )

  // Handle edge changes
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      setEdges(applyEdgeChanges(changes, edges) as LineageEdgeType[])
    },
    [edges, setEdges]
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

  // Handle node double-click for drill navigation
  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      // TODO: Implement drill navigation
      console.log('Drill into:', node.id)
    },
    []
  )

  // Handle pane click to deselect
  const onPaneClick = useCallback(() => {
    clearSelection()
  }, [clearSelection])

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
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        onMoveEnd={onViewportChange}
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
          <div className="absolute top-4 right-4 glass-panel-subtle rounded-lg px-3 py-2 flex items-center gap-2">
            <div className="w-3 h-3 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-ink-secondary">Loading region...</span>
          </div>
        )}
      </ReactFlow>
    </div>
  )
}

