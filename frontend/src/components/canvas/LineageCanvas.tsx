import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AnimatePresence, motion } from 'framer-motion'
import { GitBranch, ArrowRight, ArrowDown, Loader2 } from 'lucide-react'

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
import { EdgeDetailPanel, generateEdgeTypeFilters } from '../panels/EdgeDetailPanel'
import { EdgeLegend } from './EdgeLegend'
import { TraceToolbar } from './TraceToolbar'
import { useSpatialLoading } from '@/hooks/useSpatialLoading'
import { useLineageExploration } from '@/hooks/useLineageExploration'
import { useEdgeDetailPanel, useEdgeTypeFilters } from '@/hooks/useEdgeFilters'
import { useLevelOfDetail } from '@/hooks/useLevelOfDetail'
import { useElkLayout } from '@/hooks/useElkLayout'
import { EditorToolbar } from './EditorToolbar'
import { NodePalette } from './NodePalette'
import { EditNodePanel } from '../panels/EditNodePanel'
import { useCanvasStore, type LineageNode, type LineageEdge as LineageEdgeType } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'
import { useSchemaStore } from '@/store/schema'
import { useOntologyMetadata } from '@/services/ontologyService'
import { cn } from '@/lib/utils'
import { useGraphProvider } from '@/providers'
import * as LucideIcons from 'lucide-react'

// New UX-first interaction components
import { CanvasContextMenu, type ContextMenuTarget } from './CanvasContextMenu'
import { InlineNodeEditor } from './InlineNodeEditor'
import { QuickCreateNode } from './QuickCreateNode'
import { CommandPalette } from './CommandPalette'
import { useCanvasInteractions } from '@/hooks/useCanvasInteractions'
import { useCanvasKeyboard } from '@/hooks/useCanvasKeyboard'


// Register custom node types - includes both legacy and generic
const nodeTypes = {
  // Legacy nodes for demo data compatibility
  domain: DomainNode,
  app: AppNode,
  asset: AssetNode,
  ghost: GhostNode,
  // Generic node for schema-driven entities
  generic: GenericNode,
  // Schema types mapped to generic node
  system: GenericNode,
  dataset: GenericNode,
  pipeline: GenericNode,
  dashboard: GenericNode,
  column: GenericNode,
  schemaField: GenericNode,
}

// Register custom edge types
const edgeTypes = {
  lineage: LineageEdge,
  aggregated: AggregatedEdge as any,
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
    expandedIds,
  } = useLineageExploration()

  const { showMinimap, showGrid, snapToGrid } = usePreferencesStore()
  const schema = useSchemaStore((s) => s.schema)
  const relationshipTypes = useSchemaStore((s) => s.schema?.relationshipTypes || [])
  const { containmentEdgeTypes, metadata: ontologyMetadata } = useOntologyMetadata()

  // Edge detail panel
  const { isOpen: isEdgePanelOpen, toggle: toggleEdgePanel, close: closeEdgePanel } = useEdgeDetailPanel()
  const { filters: edgeFilters, toggle: toggleEdgeFilter } = useEdgeTypeFilters()

  // Generate dynamic edge filters from actual edges and schema
  const dynamicEdgeFilters = useMemo(() => {
    if (rawEdges.length === 0) return edgeFilters
    return generateEdgeTypeFilters(
      rawEdges,
      relationshipTypes,
      containmentEdgeTypes,
      ontologyMetadata
    )
  }, [rawEdges, relationshipTypes, containmentEdgeTypes, ontologyMetadata, edgeFilters])

  const provider = useGraphProvider()

  // Trace State
  const [traceUpstreamNodes, setTraceUpstreamNodes] = useState<Set<string>>(new Set())
  const [traceDownstreamNodes, setTraceDownstreamNodes] = useState<Set<string>>(new Set())
  const [showUpstream, setShowUpstream] = useState(true)
  const [showDownstream, setShowDownstream] = useState(true)

  // Clear trace when focus is cleared (external change)
  useEffect(() => {
    if (!focusEntityId) {
      setTraceUpstreamNodes(new Set())
      setTraceDownstreamNodes(new Set())
    }
  }, [focusEntityId])


  // Spatial loading hook
  const { isLoadingRegion } = useSpatialLoading()

  // UX-first Canvas Interactions (context menu, inline edit, quick create, command palette)
  const interactions = useCanvasInteractions({
    onTraceNode: (nodeId) => setFocus(nodeId),
    onNodeCreated: (nodeId) => selectNode(nodeId),
  })

  // Keyboard shortcuts
  useCanvasKeyboard({
    enabled: true,
    handlers: interactions.keyboardHandlers,
  })

  // ELK layout hook
  const { applyLayout, isLayouting, direction, toggleDirection } = useElkLayout()

  // Track if we've applied initial layout
  const hasAppliedInitialLayout = useRef(false)
  const [layoutedNodes, setLayoutedNodes] = useState<LineageNode[]>([])

  // Apply ELK layout when visible nodes change
  // Apply ELK layout when visible nodes change
  // Optimization: Check for structural changes to prevent infinite loops
  const prevNodeSignature = useRef<string>('')
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null)
  const prevExpandedIds = useRef<Set<string>>(new Set())
  const stableNodeRef = useRef<{ id: string, x: number, y: number } | null>(null)
  const prevFocusId = useRef<string | null>(null)
  const shouldCenterOnFocus = useRef(false)

  // Track focus changes
  useEffect(() => {
    if (focusEntityId !== prevFocusId.current) {
      if (focusEntityId) {
        shouldCenterOnFocus.current = true
      }
      prevFocusId.current = focusEntityId
    }
  }, [focusEntityId])

  // Explicit Layout Anchor Handler
  const handleLoadMore = useCallback((nodeId: string) => {
    if (rfInstance) {
      const node = rfInstance.getNode(nodeId)
      if (node) {
        console.log(`[Layout] Anchoring logic triggered for ${nodeId}`)
        stableNodeRef.current = { id: nodeId, x: node.position.x, y: node.position.y }
      }
    }
  }, [rfInstance])

  // Track expansion to stabilize viewport
  useEffect(() => {
    // Check for NEWLY expanded IDs
    const newIds = [...expandedIds].filter(id => !prevExpandedIds.current.has(id))
    if (newIds.length === 1 && rfInstance) {
      const id = newIds[0]
      // Get current node position before layout update
      const node = rfInstance.getNode(id)
      if (node) {
        stableNodeRef.current = { id, x: node.position.x, y: node.position.y }
      }
    }
    prevExpandedIds.current = expandedIds
  }, [expandedIds, rfInstance])

  useEffect(() => {
    const nodesToLayout = visibleNodes.length > 0 ? visibleNodes : rawNodes
    const edgesToLayout = visibleEdges.length > 0 ? visibleEdges : rawEdges

    // Don't auto-layout if editing (manual mode)
    if (isEditing && nodesToLayout.length > 0) {
      return
    }

    if (nodesToLayout.length === 0) {
      setLayoutedNodes([])
      return
    }

    // Generate specific signature for layout-relevant properties
    // We only care about IDs and adjacency, not all properties
    const nodeIds = nodesToLayout.map(n => n.id).sort().join(',')
    const edgeIds = edgesToLayout.map(e => e.id).sort().join(',')
    const signature = `${nodeIds}|${edgeIds}|${direction}`

    // If signature hasn't changed, skip layout
    if (signature === prevNodeSignature.current) {
      return
    }

    prevNodeSignature.current = signature

    // Apply layout
    applyLayout(nodesToLayout, edgesToLayout).then((positioned) => {
      // Stabilize Viewport if we have an anchor node
      if (stableNodeRef.current && rfInstance) {
        const { id, x: oldX, y: oldY } = stableNodeRef.current
        const newNode = positioned.find(n => n.id === id)

        if (newNode) {
          const dx = newNode.position.x - oldX
          const dy = newNode.position.y - oldY

          if (dx !== 0 || dy !== 0) {
            const { x, y, zoom } = rfInstance.getViewport()
            // Pan viewport to keep node stationary relative to screen (account for zoom!)
            rfInstance.setViewport({ x: x - (dx * zoom), y: y - (dy * zoom), zoom })
            console.log(`[Layout] Stabilized viewport on node ${id}, shifted by ${dx}, ${dy}`)
          }
        }
        stableNodeRef.current = null // Reset
      }

      // 2. Focus Logic: Center on new focus node
      if (shouldCenterOnFocus.current && rfInstance && focusEntityId) {
        const focusNode = positioned.find(n => n.id === focusEntityId)
        if (focusNode) {
          // Fit view to this node with some padding
          rfInstance.fitView({
            nodes: [{
              id: focusNode.id,
              position: focusNode.position,
              // Fallback dimensions if not measured yet
              width: focusNode.measured?.width ?? focusNode.width ?? 200,
              height: focusNode.measured?.height ?? focusNode.height ?? 80
            }],
            duration: 1000,
            padding: 0.5,
            minZoom: 0.5,
            maxZoom: 1.2,
          })
          shouldCenterOnFocus.current = false
        }
      }

      setLayoutedNodes(positioned as LineageNode[])
      hasAppliedInitialLayout.current = true
    })
  }, [visibleNodes, visibleEdges, rawNodes, rawEdges, applyLayout, direction, rfInstance])

  // Use layouted nodes or fall back to raw/visible
  const baseDisplayNodes = layoutedNodes.length > 0 ? layoutedNodes :
    (visibleNodes.length > 0 ? visibleNodes : rawNodes)

  // Inject Trace Props
  const displayNodes = useMemo(() => {
    if (!focusEntityId) return baseDisplayNodes

    const traceNodes = new Set<string>([focusEntityId])
    if (showUpstream) traceUpstreamNodes.forEach(id => traceNodes.add(id))
    if (showDownstream) traceDownstreamNodes.forEach(id => traceNodes.add(id))

    return baseDisplayNodes.map(node => {
      const isTraced = traceNodes.has(node.id)
      const isUpstream = traceUpstreamNodes.has(node.id)
      const isDownstream = traceDownstreamNodes.has(node.id)
      // const isFocus = node.id === focusEntityId

      // Logic: If trace active, dim everything that is NOT in the trace
      // BUT: Maybe we shouldn't hide untraced nodes completely in Lineage view?
      // Default behavior: Dim untraced
      const isDimmed = !isTraced

      // If node is Upstream and showUpstream is false -> Hidden? 
      // ReactFlow handles hiding via 'hidden' prop, but we might just want to dim really hard?
      // Or literally not render?
      // For now, let's just control dimming/styling.

      return {
        ...node,
        data: {
          ...node.data,
          isTraced,
          isDimmed,
          isUpstream,
          isDownstream,
          onLoadMore: () => handleLoadMore(node.id)
        }
      }
    })
  }, [baseDisplayNodes, focusEntityId, traceUpstreamNodes, traceDownstreamNodes, showUpstream, showDownstream, handleLoadMore])

  const displayEdges = visibleEdges.length > 0 ? visibleEdges : rawEdges

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

  // Store access
  const { addEdges, isEditing, addNodes, nodes, edges } = useCanvasStore()

  const onSave = useCallback(async () => {
    try {
      const response = await fetch('http://localhost:8002/api/v1/graph/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          nodes: nodes,
          edges: edges
        })
      })

      if (!response.ok) {
        throw new Error('Failed to save graph')
      }

      // Disable edit mode after save? Or just show success?
      // setEditing(false) 
      alert('Graph saved successfully!')
    } catch (error) {
      console.error('Error saving graph:', error)
      alert('Failed to save graph')
    }
  }, [nodes, edges])

  // Active edge type for editor
  const [activeEdgeType, setActiveEdgeType] = useState<string>('manual')

  // Handle new connections (if allowed)
  const onConnect: OnConnect = useCallback(
    (connection) => {
      // Allow connection only in edit mode
      if (isEditing) {
        addEdges([{
          id: `e-${connection.source}-${connection.target}-${activeEdgeType}`,
          source: connection.source,
          target: connection.target,
          data: { relationship: activeEdgeType },
          type: 'lineage', // Force type
          animated: true
        }])
      }
    },
    [isEditing, addEdges, activeEdgeType]
  )

  // Handle edge reconnection
  const onReconnect = useCallback((oldEdge: any, newConnection: any) => {
    if (isEditing) {
      // Remove old edge and add new one
      const { removeEdge, addEdges } = useCanvasStore.getState()
      removeEdge(oldEdge.id)
      addEdges([{
        id: `e-${newConnection.source}-${newConnection.target}`,
        source: newConnection.source,
        target: newConnection.target,
        data: { relationship: activeEdgeType }, // Use active type or preserve old? User wants to assign type.
        type: 'lineage',
        animated: true
      }])
    }
  }, [isEditing, activeEdgeType])

  // Sync layout positions to store when entering edit mode
  useEffect(() => {
    if (isEditing && layoutedNodes.length > 0) {
      // Commit layout positions to store so we can edit manually
      setNodes(layoutedNodes)
      // Clear layouted nodes so we fallback to displaying the store nodes (rawNodes)
      setLayoutedNodes([])
    }
  }, [isEditing])

  /**
   * Validate connections based on Ontology/Schema
   */
  const isValidConnection = useCallback(
    (connection: any) => {
      // 1. Basic self-loop check
      if (connection.source === connection.target) return false

      // 2. If 'manual' type, allow everything (or maybe restrict to known types?)
      // Let's allow everything for manual for maximum flexibility
      if (activeEdgeType === 'manual') return true

      // 3. Get Schema definition for this edge type
      const edgeSchema = relationshipTypes.find((r) => r.id === activeEdgeType)
      if (!edgeSchema) return true // Should indicate error, but allow fallback

      // 4. Get Source and Target Node Types
      // We need to look up the nodes from the store
      const sourceNode = nodes.find((n) => n.id === connection.source)
      const targetNode = nodes.find((n) => n.id === connection.target)

      if (!sourceNode || !targetNode) return false

      const sourceType = sourceNode.data.type
      const targetType = targetNode.data.type

      // 5. Check constraints
      // sourceTypes/targetTypes can contain '*' or specific IDs
      const isSourceValid =
        edgeSchema.sourceTypes.includes('*') || edgeSchema.sourceTypes.includes(sourceType)
      const isTargetValid =
        edgeSchema.targetTypes.includes('*') || edgeSchema.targetTypes.includes(targetType)

      return isSourceValid && isTargetValid
    },
    [activeEdgeType, relationshipTypes, nodes]
  )

  // Drag and Drop
  const [isPaletteOpen, setPaletteOpen] = useState(false)

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()

      const type = event.dataTransfer.getData('application/reactflow')

      // check if the dropped element is valid
      if (typeof type === 'undefined' || !type || !rfInstance) {
        return
      }

      const position = rfInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })

      const newNode: LineageNode = {
        id: `node-${Date.now()}`,
        type: 'generic', // Always use generic node
        position,
        data: {
          type: type, // The actual entity type ID
          label: `New ${type}`,
          urn: `urn:manual:${type}:${Date.now()}`,
          // Add other default data if needed
        },
      }

      addNodes([newNode])
    },
    [rfInstance, addNodes]
  )

  // Handle node click
  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      selectNode(node.id)
    },
    [selectNode]
  )

  // Handle node double-click - INLINE EDIT for UX-first experience
  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (event, node) => {
      // Get node element position for inline editing
      const element = document.querySelector(`[data-id="${node.id}"]`)
      if (element) {
        const rect = element.getBoundingClientRect()
        interactions.startInlineEdit(
          node.id,
          (node.data.label as string) || node.id,
          { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        )
      }
    },
    [interactions]
  )

  // Handle node right-click for context menu
  const onNodeContextMenu: NodeMouseHandler = useCallback(
    (event, node) => {
      event.preventDefault()
      interactions.openContextMenu(event as unknown as React.MouseEvent, {
        type: 'node',
        id: node.id,
        data: node.data as Record<string, unknown>,
      })
    },
    [interactions]
  )

  // Handle edge right-click for context menu
  const onEdgeContextMenu: EdgeMouseHandler = useCallback(
    (event, edge) => {
      event.preventDefault()
      interactions.openContextMenu(event as unknown as React.MouseEvent, {
        type: 'edge',
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })
    },
    [interactions]
  )

  // Handle pane right-click for quick create
  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      if (rfInstance) {
        const position = rfInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        })
        interactions.openContextMenu(event, {
          type: 'canvas',
          position,
        })
      }
    },
    [rfInstance, interactions]
  )

  // Handle pane double-click for quick create
  const onPaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (rfInstance) {
        const position = rfInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        })
        interactions.openQuickCreate(position)
      }
    },
    [rfInstance, interactions]
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
      {!isEditing && (
        <div className="absolute top-4 left-4 right-4 z-10 pointer-events-none">
          <div className="pointer-events-auto">
            <LineageToolbar />
          </div>

          {/* Trace Toolbar Overlay - Using unified TraceToolbar component */}
          <AnimatePresence>
            {focusEntityId && (
              <div className="pointer-events-auto absolute top-12 left-1/2 -translate-x-1/2 z-50">
                <TraceToolbar
                  focusNodeName={focusEntityId}
                  upstreamCount={traceUpstreamNodes.size}
                  downstreamCount={traceDownstreamNodes.size}
                  showUpstream={showUpstream}
                  showDownstream={showDownstream}
                  onToggleUpstream={() => setShowUpstream(!showUpstream)}
                  onToggleDownstream={() => setShowDownstream(!showDownstream)}
                  onExitTrace={() => setFocus(null)}
                  config={{
                    upstreamDepth: 5,
                    downstreamDepth: 5,
                    includeColumnLineage: true,
                    autoExpandAncestors: true,
                    pathOnly: false,
                  }}
                  onConfigChange={(newConfig) => {
                    console.log('Config changed:', newConfig)
                  }}
                  position="top"
                />
              </div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* React Flow Canvas */}
      <div className="flex-1">
        <ReactFlow
          onInit={setRfInstance}
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onNodeContextMenu={onNodeContextMenu}
          onEdgeClick={onEdgeClick}
          onEdgeContextMenu={onEdgeContextMenu}
          onPaneClick={onPaneClick}
          onPaneContextMenu={onPaneContextMenu}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onReconnect={onReconnect}
          onReconnectStart={() => { }}
          onReconnectEnd={() => { }}
          isValidConnection={isValidConnection}
          defaultEdgeOptions={{
            type: 'lineage',
            animated: true,
            interactionWidth: 20, // Easier to click
          }}
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

          {/* LOD Controller - invisible hook manager */}
          <LODController />
        </ReactFlow>
      </div>

      {/* Edge Legend - positioned above minimap */}
      <div className="absolute bottom-40 right-4 z-10 w-64">
        <EdgeLegend defaultExpanded={false} />
      </div>

      {/* Stats Bar */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3">
        {/* Layout Direction Toggle */}
        <button
          onClick={toggleDirection}
          className={cn(
            "glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2 transition-colors",
            "hover:bg-accent-lineage/10"
          )}
          title={`Layout: ${direction === 'LR' ? 'Left to Right' : 'Top to Bottom'}`}
        >
          {direction === 'LR' ? (
            <ArrowRight className="w-3.5 h-3.5 text-accent-lineage" />
          ) : (
            <ArrowDown className="w-3.5 h-3.5 text-accent-lineage" />
          )}
          <span className="text-2xs text-ink-muted">{direction}</span>
        </button>

        {/* Layout Loading Indicator */}
        {isLayouting && (
          <div className="glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2">
            <Loader2 className="w-3 h-3 text-accent-lineage animate-spin" />
            <span className="text-2xs text-ink-muted">Layouting...</span>
          </div>
        )}

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
            edgeFilters={dynamicEdgeFilters}
            onToggleFilter={toggleEdgeFilter}
          />
        )}
      </AnimatePresence>

      {/* Editor Controls Overlay */}
      <div className="absolute top-4 left-4 z-20">
        <EditorToolbar
          onAddNode={() => setPaletteOpen(true)}
          onSave={onSave}
          edgeTypes={relationshipTypes}
          activeEdgeType={activeEdgeType}
          onSelectEdgeType={setActiveEdgeType}
        />
      </div>

      {/* Node Palette */}
      <AnimatePresence>
        {isPaletteOpen && (
          <NodePalette
            isOpen={isPaletteOpen}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Edit Node Panel */}
      <EditNodePanel />

      {/* === UX-FIRST INTERACTION COMPONENTS === */}
      
      {/* Context Menu - Right-click on nodes/edges/canvas */}
      <CanvasContextMenu
        isOpen={interactions.state.contextMenu.isOpen}
        position={interactions.state.contextMenu.position}
        target={interactions.state.contextMenu.target}
        onClose={interactions.closeContextMenu}
        onEditNode={interactions.editNode}
        onDuplicateNode={interactions.duplicateNode}
        onDeleteNode={interactions.deleteNode}
        onCreateChild={interactions.createChild}
        onTraceNode={(id) => setFocus(id)}
        onCopyUrn={interactions.copyUrn}
        onEditEdge={interactions.editEdge}
        onDeleteEdge={interactions.deleteEdge}
        onReverseEdge={interactions.reverseEdge}
        onCreateNode={(pos) => interactions.openQuickCreate(pos)}
        onSelectAll={interactions.selectAll}
      />
      
      {/* Inline Node Editor - Double-click to edit names */}
      <InlineNodeEditor
        nodeId={interactions.state.inlineEdit.nodeId}
        value={interactions.state.inlineEdit.value}
        position={interactions.state.inlineEdit.position}
        onSave={interactions.saveInlineEdit}
        onCancel={interactions.cancelInlineEdit}
      />
      
      {/* Quick Create - Double-click canvas or press 'N' */}
      <QuickCreateNode
        isOpen={interactions.state.quickCreate.isOpen}
        position={interactions.state.quickCreate.position}
        parentUrn={interactions.state.quickCreate.parentUrn}
        onClose={interactions.closeQuickCreate}
        onCreated={(nodeId) => selectNode(nodeId)}
      />
      
      {/* Command Palette - Press Cmd+K */}
      <CommandPalette
        isOpen={interactions.state.commandPalette.isOpen}
        onClose={interactions.closeCommandPalette}
        onCreateEntity={(typeId) => {
          interactions.closeCommandPalette()
          interactions.openQuickCreate({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
        }}
        onSelectEntity={(entityId) => selectNode(entityId)}
        onRunAction={(actionId) => {
          if (actionId === 'fit-view' && rfInstance) {
            rfInstance.fitView()
          }
        }}
      />
    </div>
  )
}

/**
 * LODController - Invisible component that manages zoom-to-granularity mapping
 * Must be rendered inside ReactFlow to have access to zoom state
 */
function LODController() {
  // The hook handles all the logic - just calling it activates it
  useLevelOfDetail()
  return null
}
