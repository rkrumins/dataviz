/**
 * LayeredLineageCanvas - React Flow graph with layer-aware layout
 *
 * A free-floating graph canvas where:
 * - Nodes are auto-positioned via ELK layout respecting lineage flow
 * - Layer backgrounds show visual grouping based on ontology assignment
 * - Edges are native React Flow edges with smooth curves
 * - Progressive loading: roots first, expand children on double-click (20 per batch)
 * - Handles large graphs with capped loading + expand-on-demand
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type OnNodesChange,
  type OnEdgesChange,
  type NodeMouseHandler,
  type ReactFlowInstance,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AnimatePresence } from 'framer-motion'
import { ArrowRight, ArrowDown, Loader2, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { generateColorFromType } from '@/lib/type-visuals'

// Node/Edge components
import { GhostNode } from './nodes/GhostNode'
import { GenericNode } from './nodes/GenericNode'
import { LineageEdge } from './edges/LineageEdge'
import { AggregatedEdge } from './edges/AggregatedEdge'
import { CanvasControls } from './CanvasControls'
import { EdgeLegend } from './EdgeLegend'
import { EntityDrawer } from '../panels/EntityDrawer'
import { EdgeDetailPanel, generateEdgeTypeFilters } from '../panels/EdgeDetailPanel'

// Hooks
import { useGraphHydration } from '@/hooks/useGraphHydration'
import { useElkLayout } from '@/hooks/useElkLayout'
import { useEdgeDetailPanel, useEdgeTypeFilters } from '@/hooks/useEdgeFilters'

// Stores
import {
  useSchemaStore,
  useContainmentEdgeTypes,
  useIsContainmentEdge,
  useRelationshipTypes,
  normalizeEdgeType,
  useEdgeTypeMetadataMap,
} from '@/store/schema'
import { useCanvasStore, type LineageNode, type LineageEdge as LineageEdgeType } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'

import type { ViewLayerConfig } from '@/types/schema'

// ============================================
// Node / Edge type registrations (stable module-level refs)
// ============================================

const nodeTypes = {
  ghost: GhostNode,
  generic: GenericNode,
  domain: GenericNode,
  app: GenericNode,
  asset: GenericNode,
  system: GenericNode,
  dataset: GenericNode,
  pipeline: GenericNode,
  dashboard: GenericNode,
  column: GenericNode,
  schemaField: GenericNode,
  container: GenericNode,
}

const edgeTypes = {
  lineage: LineageEdge,
  aggregated: AggregatedEdge as any,
}

// ============================================
// Props
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
  showLineageFlow: initialShowLineageFlow = true,
}: LayeredLineageCanvasProps) {
  // Mount confirmation
  useEffect(() => {
    console.log('[LayeredLineageCanvas] MOUNTED')
    return () => console.log('[LayeredLineageCanvas] UNMOUNTED')
  }, [])

  // ── Canvas store ──────────────────────────────────────────────────────
  const { setNodes, setEdges, selectNode, clearSelection } = useCanvasStore()
  const rawNodes = useCanvasStore((s) => s.nodes)
  const rawEdges = useCanvasStore((s) => s.edges)

  // ── Schema / ontology ─────────────────────────────────────────────────
  const schema = useSchemaStore((s) => s.schema)
  const containmentEdgeTypes = useContainmentEdgeTypes()
  const isContainmentEdge = useIsContainmentEdge()
  const relationshipTypes = useRelationshipTypes()
  const edgeTypeMetadata = useEdgeTypeMetadataMap()
  const { showMinimap, showGrid } = usePreferencesStore()

  // ── Local state ───────────────────────────────────────────────────────
  const [showLineageFlow, setShowLineageFlow] = useState(initialShowLineageFlow)

  // ── Edge detail panel ─────────────────────────────────────────────────
  const { isOpen: isEdgePanelOpen, toggle: toggleEdgePanel, close: closeEdgePanel } = useEdgeDetailPanel()
  const { filters: edgeFilters, toggle: toggleEdgeFilter } = useEdgeTypeFilters()
  const ontologyMetadata = useMemo(() => ({ edgeTypeMetadata }), [edgeTypeMetadata])

  const dynamicEdgeFilters = useMemo(() => {
    if (rawEdges.length === 0) return edgeFilters
    return generateEdgeTypeFilters(rawEdges, relationshipTypes, containmentEdgeTypes, ontologyMetadata)
  }, [rawEdges, relationshipTypes, containmentEdgeTypes, ontologyMetadata, edgeFilters])

  // ── Filter edges for display: hide containment, show lineage ──────────
  const displayEdges = useMemo(() => {
    if (!showLineageFlow) return []
    return rawEdges.filter(edge => !isContainmentEdge(normalizeEdgeType(edge)))
  }, [rawEdges, showLineageFlow, isContainmentEdge])

  // ── Progressive loading ───────────────────────────────────────────────
  const { loadChildren, isLoading: isLoadingChildren, loadingNodes } = useGraphHydration()

  const handleExpand = useCallback(async (nodeId: string) => {
    await loadChildren(nodeId)
  }, [loadChildren])

  // ── ELK Layout ────────────────────────────────────────────────────────
  const { applyLayout, isLayouting, direction, toggleDirection } = useElkLayout()
  const [layoutedNodes, setLayoutedNodes] = useState<LineageNode[]>([])
  const prevNodeSignature = useRef<string>('')
  const hasAppliedInitialLayout = useRef(false)
  const fitViewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null)

  // Debounced fitView: schedules a fitView after layout settles.
  const scheduleFitView = useCallback(() => {
    if (!rfInstance) return
    if (fitViewTimer.current) clearTimeout(fitViewTimer.current)
    fitViewTimer.current = setTimeout(() => {
      rfInstance.fitView({ padding: 0.2, duration: 300 })
      hasAppliedInitialLayout.current = true
      fitViewTimer.current = null
    }, 250)
  }, [rfInstance])

  // Stable ref so scheduleFitView doesn't trigger the layout effect
  const scheduleFitViewRef = useRef(scheduleFitView)
  scheduleFitViewRef.current = scheduleFitView

  // If rfInstance arrives after layout already completed, fit now
  useEffect(() => {
    if (rfInstance && layoutedNodes.length > 0 && !hasAppliedInitialLayout.current) {
      scheduleFitView()
    }
  }, [rfInstance, layoutedNodes, scheduleFitView])

  // Stable signature so the layout effect only fires on actual node/edge changes
  const layoutSignature = useMemo(() => {
    if (rawNodes.length === 0) return ''
    const nodeIds = rawNodes.map(n => n.id).sort().join(',')
    const edgeIds = rawEdges.map(e => e.id).sort().join(',')
    return `${nodeIds}|${edgeIds}|${direction}`
  }, [rawNodes, rawEdges, direction])

  // Use ALL edges for layout (including containment) so ELK knows the hierarchy
  useEffect(() => {
    if (rawNodes.length === 0) {
      setLayoutedNodes([])
      prevNodeSignature.current = ''
      hasAppliedInitialLayout.current = false
      return
    }

    if (layoutSignature === prevNodeSignature.current) return
    prevNodeSignature.current = layoutSignature

    applyLayout(rawNodes, rawEdges)
      .then((positioned) => {
        setLayoutedNodes(positioned as LineageNode[])

        if (!hasAppliedInitialLayout.current) {
          scheduleFitViewRef.current()
        }
      })
      .catch((err) => {
        console.error('[LayeredLineageCanvas] Layout failed:', err)
        setLayoutedNodes(rawNodes)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutSignature, applyLayout, rfInstance])

  // ── Display nodes: layouted if available, else raw ────────────────────
  const displayNodes = useMemo(() => {
    const base = layoutedNodes.length > 0 ? layoutedNodes : rawNodes

    return base.map(node => ({
      ...node,
      data: {
        ...node.data,
        isLoading: loadingNodes.has(node.id),
      },
    }))
  }, [layoutedNodes, rawNodes, loadingNodes])

  // ── Handlers ──────────────────────────────────────────────────────────
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      setNodes(applyNodeChanges(changes, rawNodes) as LineageNode[])
    },
    [rawNodes, setNodes]
  )

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      setEdges(applyEdgeChanges(changes, rawEdges) as LineageEdgeType[])
    },
    [rawEdges, setEdges]
  )

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      selectNode(node.id)
    },
    [selectNode]
  )

  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_, node) => {
      handleExpand(node.id)
    },
    [handleExpand]
  )

  const onPaneClick = useCallback(() => {
    clearSelection()
  }, [clearSelection])

  // Minimap node color
  const minimapNodeColor = useCallback((node: LineageNode) => {
    const entityType = schema?.entityTypes.find((et) => et.id === node.data.type)
    if (entityType) return entityType.visual.color
    return generateColorFromType(node.data.type as string)
  }, [schema])

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className={cn("w-full h-full relative flex flex-col", className)}>
      {/* Header */}
      <div className="absolute top-4 left-4 right-4 z-10 pointer-events-none">
        <div className="pointer-events-auto inline-flex items-center gap-3 bg-canvas-elevated/95 backdrop-blur rounded-xl border border-glass-border px-4 py-2 shadow-lg">
          <h2 className="text-sm font-display font-semibold text-ink">Layered Lineage</h2>
          <span className="px-2 py-0.5 rounded-md bg-accent-lineage/10 text-accent-lineage text-2xs font-medium">
            Graph View
          </span>

          {/* Lineage Flow Toggle */}
          <button
            onClick={() => setShowLineageFlow(!showLineageFlow)}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all",
              showLineageFlow
                ? "bg-accent-lineage/10 text-accent-lineage"
                : "bg-black/5 dark:bg-white/10 text-ink-muted"
            )}
          >
            <GitBranch className="w-3.5 h-3.5" />
            {showLineageFlow ? 'Flow On' : 'Flow Off'}
          </button>
        </div>
      </div>

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
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onPaneClick={onPaneClick}
          defaultEdgeOptions={{
            type: 'lineage',
            animated: true,
            interactionWidth: 20,
          }}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.05}
          maxZoom={2}
          className="bg-canvas"
          proOptions={{ hideAttribution: true }}
        >
          {showGrid && (
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              className="opacity-40"
            />
          )}

          <CanvasControls />

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

          <Controls
            className={cn(
              "glass-panel-subtle !rounded-xl !overflow-hidden !shadow-lg",
              "!bottom-4 !left-4"
            )}
            showInteractive={false}
          />

          {isLoadingChildren && (
            <div className="absolute top-20 right-4 glass-panel-subtle rounded-lg px-3 py-2 flex items-center gap-2">
              <div className="w-3 h-3 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-ink-secondary">Loading children...</span>
            </div>
          )}
        </ReactFlow>
      </div>

      {/* Stats Bar */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3">
        <button
          onClick={toggleDirection}
          className="glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2 hover:bg-accent-lineage/10 transition-colors"
          title={`Layout: ${direction === 'LR' ? 'Left to Right' : 'Top to Bottom'}`}
        >
          {direction === 'LR' ? (
            <ArrowRight className="w-3.5 h-3.5 text-accent-lineage" />
          ) : (
            <ArrowDown className="w-3.5 h-3.5 text-accent-lineage" />
          )}
          <span className="text-2xs text-ink-muted">{direction}</span>
        </button>

        {isLayouting && (
          <div className="glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2">
            <Loader2 className="w-3 h-3 text-accent-lineage animate-spin" />
            <span className="text-2xs text-ink-muted">Layouting...</span>
          </div>
        )}

        <div className="glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2">
          <span className="text-2xs text-ink-muted">
            {rawNodes.length} entities · {displayEdges.length} relationships
          </span>
        </div>

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

      {/* Edge Legend */}
      <div className="absolute bottom-40 right-4 z-10 w-64">
        <EdgeLegend defaultExpanded={false} visibleEdges={displayEdges} />
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

      {/* Entity Drawer */}
      <EntityDrawer />
    </div>
  )
}

export default LayeredLineageCanvas
