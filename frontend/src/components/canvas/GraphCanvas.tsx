/**
 * GraphCanvas - Unified React Flow graph canvas
 *
 * Replaces both LineageCanvas and LayeredLineageCanvas as the main canvas
 * for all free-floating graph views. Composes shared hooks for:
 * - Containment hierarchy (useContainmentHierarchy)
 * - Trace with auto-merge + auto-expand (useCanvasTrace)
 * - Progressive loading (useGraphHydration)
 * - ELK.js layout (useElkLayout)
 * - Progressive edge disclosure (useAggregatedLineage)
 * - Edge roll-up to visible ancestors (useEdgeProjection)
 * - Click/hover highlighting (useHighlightState, useHoverHighlight)
 * - Edge filtering (useEdgeDetailPanel, useEdgeTypeFilters)
 * - Context menu, inline edit, quick create, command palette (useCanvasInteractions)
 * - Keyboard shortcuts (useCanvasKeyboard)
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
  SelectionMode,
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

// UX components
import { CanvasContextMenu } from './CanvasContextMenu'
import { InlineNodeEditor } from './InlineNodeEditor'
import { QuickCreateNode } from './QuickCreateNode'
import { CommandPalette } from './CommandPalette'
import { EditorToolbar } from './EditorToolbar'
import { NodePalette } from './NodePalette'

// Hooks
import { useGraphHydration } from '@/hooks/useGraphHydration'
import { useElkLayout } from '@/hooks/useElkLayout'
import { useContainmentHierarchy } from '@/hooks/useContainmentHierarchy'
import { useCanvasTrace } from '@/hooks/useCanvasTrace'
import { useHighlightState, useHoverHighlight, useHoveredNodeId } from '@/hooks/useHighlightState'
import { useEdgeDetailPanel, useEdgeTypeFilters } from '@/hooks/useEdgeFilters'
import { useSemanticZoom } from '@/hooks/useSemanticZoom'
import { useCanvasInteractions } from '@/hooks/useCanvasInteractions'
import { useCanvasKeyboard } from '@/hooks/useCanvasKeyboard'
import { useLoadingToast } from '@/components/ui/toast'

// Stores
import { useSchemaStore, normalizeEdgeType, useEdgeTypeMetadataMap } from '@/store/schema'
import {
  useViewContainmentEdgeTypes,
  useViewIsContainmentEdge,
  useViewRelationshipTypes,
  useViewEntityTypes,
  useViewSchemaIsReady,
} from '@/hooks/useViewSchema'
import { useCanvasStore, type LineageNode, type LineageEdge as LineageEdgeType } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'

// Types
import type { HierarchyNode } from '@/types/hierarchy'

// ============================================
// Node/Edge type registrations
// ============================================

const nodeTypes = { ghost: GhostNode, generic: GenericNode }
const edgeTypes = { lineage: LineageEdge, aggregated: AggregatedEdge as any }

/** Maximum nodes rendered in the DOM before viewport culling kicks in */
const MAX_VISIBLE_NODES = 2000

// ============================================
// Component
// ============================================

export function GraphCanvas({ className }: { className?: string }) {
  // 1. Schema readiness guard
  const isSchemaReady = useViewSchemaIsReady()

  // 2. Canvas store
  const { setNodes, setEdges, selectNode, clearSelection } = useCanvasStore()
  const rawNodes = useCanvasStore((s) => s.nodes)
  const rawEdges = useCanvasStore((s) => s.edges)
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  const selectedNodeId = selectedNodeIds[0] ?? null
  // 3. Schema / ontology
  const schema = useSchemaStore((s) => s.schema)
  const containmentEdgeTypes = useViewContainmentEdgeTypes()
  const isContainmentEdge = useViewIsContainmentEdge()
  const relationshipTypes = useViewRelationshipTypes()
  const schemaEntityTypes = useViewEntityTypes()
  const edgeTypeMetadata = useEdgeTypeMetadataMap()
  const { showMinimap, showGrid } = usePreferencesStore()

  // 4. Local state
  const [showLineageFlow, setShowLineageFlow] = useState(true)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [isPaletteOpen, setPaletteOpen] = useState(false)
  const [activeEdgeType, setActiveEdgeType] = useState<string>('manual')

  // Viewport-aware node filtering for large graphs
  const [viewportBounds, setViewportBounds] = useState<{ x: number; y: number; zoom: number } | null>(null)

  // Ref to hold semanticZoom.onViewportChange (defined later, avoids declaration order issue)
  const semanticZoomRef = useRef<((viewport: any) => void) | null>(null)

  const handleViewportChange = useCallback((viewport: { x: number; y: number; zoom: number }) => {
    setViewportBounds(viewport)
    semanticZoomRef.current?.(viewport)
  }, [])

  // 5. Containment hierarchy (shared hook)
  const { parentMap, childMap, nodeMap } = useContainmentHierarchy({
    nodes: rawNodes,
    edges: rawEdges,
    isContainmentEdge,
  })

  // 6. Compute VISIBLE nodes — the core expand/collapse logic.
  //
  // A node is visible if:
  //   (a) It's a root (no containment parent), OR
  //   (b) Every ancestor in its containment chain is expanded.
  //
  // This is what makes expand/collapse actually work in the graph:
  // - Roots always show
  // - Children only show when their parent (and grandparent, etc.) are all expanded
  // - Collapsing a parent hides all descendants
  //
  // We also build displayMap for highlight state.
  const { visibleNodeIds, displayMap } = useMemo(() => {
    const visible = new Set<string>()
    const dMap = new Map<string, HierarchyNode>()

    // Helper: check if a node's entire ancestor chain is expanded
    const isAncestorChainExpanded = (nodeId: string): boolean => {
      const parent = parentMap.get(nodeId)
      if (!parent) return true // Root — always visible
      if (!expandedNodes.has(parent)) return false // Parent collapsed — hidden
      return isAncestorChainExpanded(parent) // Check grandparent recursively
    }

    // Process all nodes
    rawNodes.forEach(n => {
      if (n.data.type === 'ghost') return
      if (isAncestorChainExpanded(n.id)) {
        visible.add(n.id)
      }
      // Build displayMap for ALL nodes (needed by highlight to walk children)
      dMap.set(n.id, {
        id: n.id,
        typeId: (n.data.type as string) ?? '',
        name: (n.data.label as string) ?? n.id,
        data: n.data as Record<string, unknown>,
        children: (childMap.get(n.id) ?? [])
          .map(cid => nodeMap.get(cid))
          .filter(Boolean)
          .map(cn => ({
            id: cn!.id,
            typeId: (cn!.data.type as string) ?? '',
            name: (cn!.data.label as string) ?? cn!.id,
            data: cn!.data as Record<string, unknown>,
            children: [],
            depth: 0,
            urn: (cn!.data.urn as string) ?? cn!.id,
            entityTypeOption: (cn!.data.type as string) ?? '',
            tags: (cn!.data.classifications as string[]) ?? [],
          })),
        depth: 0,
        urn: (n.data.urn as string) ?? n.id,
        entityTypeOption: (n.data.type as string) ?? '',
        tags: (n.data.classifications as string[]) ?? [],
      })
    })

    return { visibleNodeIds: visible, displayMap: dMap }
  }, [rawNodes, parentMap, expandedNodes, childMap, nodeMap])

  // Visible nodes and edges — filtered by expansion state
  const visibleNodes = useMemo(() =>
    rawNodes.filter(n => visibleNodeIds.has(n.id)),
    [rawNodes, visibleNodeIds]
  )

  const visibleRawEdges = useMemo(() =>
    rawEdges.filter(e => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)),
    [rawEdges, visibleNodeIds]
  )

  // 7. Progressive loading
  const { loadChildren, isLoading: isLoadingChildren, loadingNodes } = useGraphHydration()
  useLoadingToast('graph-children', isLoadingChildren, 'Expanding hierarchy')

  // 8. Trace system (shared hook)
  const trace = useCanvasTrace({
    nodes: rawNodes,
    edges: rawEdges,
    isContainmentEdge,
    expandedNodes,
    setExpandedNodes,
    setShowLineageFlow,
  })

  // 9. Build traceContextSet
  const traceContextSet = useMemo(() => {
    const set = new Set<string>()
    if (!trace.isTracing) return set
    if (trace.focusId) set.add(trace.focusId)
    if (trace.focusId) {
      let curr = parentMap.get(trace.focusId)
      while (curr) {
        set.add(curr)
        curr = parentMap.get(curr)
      }
    }
    trace.visibleTraceNodes.forEach((id) => {
      set.add(id)
      let curr = parentMap.get(id)
      while (curr) {
        set.add(curr)
        curr = parentMap.get(curr)
      }
    })
    return set
  }, [trace.isTracing, trace.focusId, trace.visibleTraceNodes, parentMap])

  // 10. Lineage edges — non-containment edges between VISIBLE nodes only
  const lineageEdges = useMemo(() => {
    if (!showLineageFlow && !trace.isTracing) return []
    return visibleRawEdges.filter(edge =>
      !isContainmentEdge(normalizeEdgeType(edge))
    )
  }, [visibleRawEdges, showLineageFlow, trace.isTracing, isContainmentEdge])

  // 12. Highlight state — uses lineageEdges directly
  const hoveredNodeId = useHoveredNodeId()
  const { highlightState, isHighlightActive: isClickHighlightActive } = useHighlightState({
    selectedNodeId,
    visibleLineageEdges: lineageEdges,
    isTracing: trace.isTracing,
    displayMap,
    childMap,
  })
  const { hoverHighlight, isHoverActive } = useHoverHighlight({
    hoveredNodeId,
    visibleLineageEdges: lineageEdges,
    isTracing: trace.isTracing,
    displayMap,
    childMap,
    isClickHighlightActive,
  })
  const isHighlightActive = isClickHighlightActive || isHoverActive
  const mergedHighlightNodes = isClickHighlightActive
    ? highlightState.nodes
    : hoverHighlight.nodes
  const mergedHighlightEdges = isClickHighlightActive
    ? highlightState.edges
    : hoverHighlight.edges

  // 13. Edge filters
  const { isOpen: isEdgePanelOpen, toggle: toggleEdgePanel, close: closeEdgePanel } =
    useEdgeDetailPanel()
  const { filters: edgeFilters, toggle: toggleEdgeFilter } = useEdgeTypeFilters()
  const ontologyMetadata = useMemo(() => ({ edgeTypeMetadata }), [edgeTypeMetadata])
  const dynamicEdgeFilters = useMemo(() => {
    if (rawEdges.length === 0) return edgeFilters
    return generateEdgeTypeFilters(
      rawEdges,
      relationshipTypes,
      containmentEdgeTypes,
      ontologyMetadata,
    )
  }, [rawEdges, relationshipTypes, containmentEdgeTypes, ontologyMetadata, edgeFilters])

  // 14. ELK Layout
  const { applyLayout, isLayouting, direction, toggleDirection } = useElkLayout()
  const [layoutedNodes, setLayoutedNodes] = useState<LineageNode[]>([])
  const prevLayoutSig = useRef('')
  const hasAppliedInitialLayout = useRef(false)
  const fitViewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null)

  const scheduleFitView = useCallback(() => {
    if (!rfInstance) return
    if (fitViewTimer.current) clearTimeout(fitViewTimer.current)
    fitViewTimer.current = setTimeout(() => {
      rfInstance.fitView({ padding: 0.2, duration: 300 })
      hasAppliedInitialLayout.current = true
      fitViewTimer.current = null
    }, 250)
  }, [rfInstance])

  const scheduleFitViewRef = useRef(scheduleFitView)
  scheduleFitViewRef.current = scheduleFitView

  useEffect(() => {
    if (rfInstance && layoutedNodes.length > 0 && !hasAppliedInitialLayout.current) {
      scheduleFitView()
    }
  }, [rfInstance, layoutedNodes, scheduleFitView])

  // Layout signature — derived from VISIBLE nodes/edges + direction
  const layoutSignature = useMemo(() => {
    if (visibleNodes.length === 0) return ''
    const nodeIds = visibleNodes.map((n) => n.id).sort().join(',')
    const edgeIds = visibleRawEdges.map((e) => e.id).sort().join(',')
    return `${nodeIds}|${edgeIds}|${direction}`
  }, [visibleNodes, visibleRawEdges, direction])

  // ELK layout on visible nodes + ALL their connecting edges (containment included
  // so ELK knows the structure for positioning, but only visible nodes are laid out)
  useEffect(() => {
    if (visibleNodes.length === 0) {
      setLayoutedNodes([])
      prevLayoutSig.current = ''
      hasAppliedInitialLayout.current = false
      return
    }
    if (layoutSignature === prevLayoutSig.current) return
    prevLayoutSig.current = layoutSignature

    applyLayout(visibleNodes, visibleRawEdges, schemaEntityTypes as any)
      .then((positioned) => {
        setLayoutedNodes(positioned as LineageNode[])
        if (!hasAppliedInitialLayout.current) scheduleFitViewRef.current()
      })
      .catch((err) => {
        console.error('[GraphCanvas] Layout failed:', err)
        setLayoutedNodes(visibleNodes)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutSignature, applyLayout])

  // 16. Semantic zoom — ontology-driven auto-expand/collapse on zoom
  // Disabled by default until layout stabilization is complete — enable via toggle
  const semanticZoom = useSemanticZoom({
    rfInstance,
    expandedNodes,
    setExpandedNodes,
    displayMap,
    parentMap,
    schemaEntityTypes: schemaEntityTypes as any,
    loadChildren,
    enabled: false,
  })
  semanticZoomRef.current = semanticZoom.onViewportChange

  // 17. Toggle node expansion with lazy loading
  // Stable callback refs for node data props (avoids new function refs on every render)
  const loadChildrenRef = useRef(loadChildren)
  loadChildrenRef.current = loadChildren

  const stableOnLoadMore = useCallback((parentId: string) => {
    loadChildrenRef.current(parentId)
  }, [])

  const pendingLoadRef = useRef<Set<string>>(new Set())
  const toggleNode = useCallback(
    async (nodeId: string) => {
      let wasExpanded = false
      setExpandedNodes((prev) => {
        wasExpanded = prev.has(nodeId)
        const next = new Set(prev)
        if (wasExpanded) next.delete(nodeId)
        else next.add(nodeId)
        return next
      })
      if (!wasExpanded && !pendingLoadRef.current.has(nodeId)) {
        pendingLoadRef.current.add(nodeId)
        try {
          await loadChildren(nodeId)
        } finally {
          pendingLoadRef.current.delete(nodeId)
        }
      }
    },
    [loadChildren],
  )

  const toggleNodeRef = useRef(toggleNode)
  toggleNodeRef.current = toggleNode

  const stableOnToggle = useCallback((nodeId: string) => {
    toggleNodeRef.current(nodeId)
  }, [])

  // 15. Convert lineage edges to React Flow display format
  const displayEdges = useMemo(() => {
    return lineageEdges.map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'lineage' as const,
      animated: !isHighlightActive || mergedHighlightEdges.has(edge.id),
      style: {
        opacity: isHighlightActive && !mergedHighlightEdges.has(edge.id) ? 0.15 : 1,
      },
      data: {
        edgeType: edge.data?.edgeType ?? edge.data?.relationship ?? '',
        confidence: edge.data?.confidence ?? 1,
        isTraced: trace.isTracing && trace.result?.traceEdges?.has(edge.id),
      },
    }))
  }, [lineageEdges, trace.isTracing, trace.result, isHighlightActive, mergedHighlightEdges])

  // 16. Display nodes with visual state — only VISIBLE nodes (expand/collapse aware)
  const displayNodes = useMemo(() => {
    const base = layoutedNodes.length > 0 ? layoutedNodes : visibleNodes
    const allNodes = base.map((node) => ({
      ...node,
      data: {
        ...node.data,
        isLoading: loadingNodes.has(node.id),
        isTraced: trace.isInTrace(node.id),
        isDimmed:
          (trace.isTracing && !traceContextSet.has(node.id)) ||
          (isHighlightActive &&
            !mergedHighlightNodes.has(node.id) &&
            !traceContextSet.has(node.id)),
        isUpstream: trace.isUpstream(node.id),
        isDownstream: trace.isDownstream(node.id),
        isFocus: trace.isFocus(node.id),
        isHighlighted: mergedHighlightNodes.has(node.id),
        onLoadMore: stableOnLoadMore,
        onToggleExpanded: stableOnToggle,
      },
    }))

    // Viewport-aware filtering: only activate when node count exceeds threshold
    if (allNodes.length > MAX_VISIBLE_NODES && viewportBounds) {
      const { x: vx, y: vy, zoom } = viewportBounds
      const buffer = 500 // px buffer around viewport
      const viewWidth = (window.innerWidth || 1920) / zoom
      const viewHeight = (window.innerHeight || 1080) / zoom
      const viewLeft = -vx / zoom - buffer / zoom
      const viewTop = -vy / zoom - buffer / zoom
      const viewRight = viewLeft + viewWidth + 2 * buffer / zoom
      const viewBottom = viewTop + viewHeight + 2 * buffer / zoom

      allNodes.forEach((node) => {
        const inView =
          node.position.x < viewRight &&
          node.position.x + 200 > viewLeft &&
          node.position.y < viewBottom &&
          node.position.y + 80 > viewTop
        if (!inView) {
          node.hidden = true
        }
      })

      // Ensure visible count doesn't exceed cap
      const visible = allNodes.filter((n) => !n.hidden)
      if (visible.length > MAX_VISIBLE_NODES) {
        // Prioritize by depth (parents first) -- sort by depth ascending
        visible.sort(
          (a, b) =>
            (((a.data as any)?.depth as number) ?? 0) -
            (((b.data as any)?.depth as number) ?? 0),
        )
        visible.slice(MAX_VISIBLE_NODES).forEach((n) => {
          n.hidden = true
        })
      }
    }

    return allNodes
  }, [
    layoutedNodes,
    rawNodes,
    loadingNodes,
    trace,
    traceContextSet,
    isHighlightActive,
    mergedHighlightNodes,
    stableOnLoadMore,
    stableOnToggle,
    viewportBounds,
  ])

  // 18. Handlers
  // Apply position/selection changes to layoutedNodes so drags are preserved.
  // We DON'T update rawNodes (the store) for position changes — those are layout-managed.
  // We DO update the store for selection changes.
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      // Update layouted nodes with position changes (drag support)
      setLayoutedNodes((prev) => {
        if (prev.length === 0) return prev
        return applyNodeChanges(changes, prev) as LineageNode[]
      })
      // Update the store for non-position changes (selection, etc.)
      const nonPositionChanges = changes.filter(c => c.type !== 'position')
      if (nonPositionChanges.length > 0) {
        setNodes(applyNodeChanges(nonPositionChanges, rawNodes) as LineageNode[])
      }
    },
    [rawNodes, setNodes],
  )

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      setEdges(applyEdgeChanges(changes, rawEdges) as LineageEdgeType[])
    },
    [rawEdges, setEdges],
  )

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => selectNode(node.id),
    [selectNode],
  )

  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (event, node) => {
      if (event.shiftKey) {
        // Shift+Double-click: trace
        trace.toggleTrace(node.id)
      } else {
        // Regular double-click: expand/collapse
        toggleNode(node.id)
      }
    },
    [trace, toggleNode],
  )

  const onPaneClick = useCallback(() => clearSelection(), [clearSelection])

  // 19. Canvas interactions (context menu, inline edit, quick create, command palette)
  const interactions = useCanvasInteractions({
    onTraceNode: (nodeId) => trace.startTrace(nodeId),
    onNodeCreated: (nodeId) => selectNode(nodeId),
    onCloseEdgePanel: () => {
      if (isEdgePanelOpen) {
        closeEdgePanel()
        return true
      }
      return false
    },
    onCloseEntityDrawer: () => {
      if (selectedNodeId) {
        clearSelection()
        return true
      }
      return false
    },
  })

  useCanvasKeyboard({ enabled: true, handlers: interactions.keyboardHandlers })

  // 20. Minimap color
  const minimapNodeColor = useCallback(
    (node: LineageNode) => {
      const entityType = schema?.entityTypes.find((et) => et.id === node.data.type)
      if (entityType) return entityType.visual.color
      return generateColorFromType(node.data.type as string)
    },
    [schema],
  )

  // 21. Hover detection for useHoveredNodeId
  const onNodeMouseEnter: NodeMouseHandler = useCallback((_, node) => {
    document.documentElement.dataset.hoveredNode = node.id
  }, [])
  const onNodeMouseLeave: NodeMouseHandler = useCallback(() => {
    delete document.documentElement.dataset.hoveredNode
  }, [])

  // Schema guard
  if (!isSchemaReady) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-canvas">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-accent-lineage" />
          <span className="text-sm text-ink-muted">Loading schema...</span>
        </div>
      </div>
    )
  }

  // RENDER
  return (
    <div className={cn('w-full h-full relative flex flex-col', className)}>
      {/* Editor Toolbar */}
      <div className="absolute top-4 left-4 z-30">
        <EditorToolbar
          onAddNode={() => setPaletteOpen(true)}
          onSave={() => {
            /* TODO */
          }}
          edgeTypes={relationshipTypes}
          activeEdgeType={activeEdgeType}
          onSelectEdgeType={setActiveEdgeType}
        />
      </div>

      {/* Node Palette */}
      <AnimatePresence>
        {isPaletteOpen && (
          <NodePalette isOpen={isPaletteOpen} onClose={() => setPaletteOpen(false)} />
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
        <div className="pointer-events-auto inline-flex items-center gap-3 bg-canvas-elevated/95 backdrop-blur rounded-xl border border-glass-border px-4 py-2 shadow-lg">
          <h2 className="text-sm font-display font-semibold text-ink">Graph View</h2>
          <span className="px-2 py-0.5 rounded-md bg-accent-lineage/10 text-accent-lineage text-2xs font-medium">
            {trace.isTracing ? 'Tracing' : 'Explore'}
          </span>
          <button
            onClick={() => setShowLineageFlow(!showLineageFlow)}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all',
              showLineageFlow
                ? 'bg-accent-lineage/10 text-accent-lineage'
                : 'bg-black/5 dark:bg-white/10 text-ink-muted',
            )}
          >
            <GitBranch className="w-3.5 h-3.5" />
            {showLineageFlow ? 'Flow On' : 'Flow Off'}
          </button>
          {trace.isTracing && (
            <button
              onClick={() => {
                trace.clearTrace()
                setExpandedNodes(new Set())
              }}
              className="px-2.5 py-1 rounded-lg text-xs font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-all"
            >
              Exit Trace
            </button>
          )}
        </div>
      </div>

      {/* React Flow Canvas */}
      <div className="flex-1">
        <ReactFlow
          onInit={setRfInstance}
          onMoveEnd={(_, viewport) => handleViewportChange(viewport)}
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onPaneClick={onPaneClick}
          onNodeContextMenu={(event, node) => {
            event.preventDefault()
            interactions.openContextMenu(event as any, {
              type: 'node',
              id: node.id,
              data: node.data as Record<string, unknown>,
            })
          }}
          defaultEdgeOptions={{ type: 'lineage', animated: true, interactionWidth: 20 }}
          selectionOnDrag
          multiSelectionKeyCode="Shift"
          selectionMode={SelectionMode.Partial}
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
                'glass-panel-subtle !rounded-xl !overflow-hidden',
                '!bottom-4 !right-4',
              )}
              pannable
              zoomable
            />
          )}
          <Controls
            className={cn(
              'glass-panel-subtle !rounded-xl !overflow-hidden !shadow-lg',
              '!bottom-4 !left-4',
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
            {(() => {
              const visibleCount = displayNodes.filter((n) => !n.hidden).length
              return visibleCount < rawNodes.length
                ? `${visibleCount} of ${rawNodes.length} entities`
                : `${rawNodes.length} entities`
            })()} &middot; {displayEdges.length} relationships
          </span>
        </div>
        <button
          onClick={toggleEdgePanel}
          className={cn(
            'glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2 transition-colors',
            isEdgePanelOpen && 'bg-accent-lineage/10 border-accent-lineage',
          )}
        >
          <GitBranch className="w-3.5 h-3.5 text-accent-lineage" />
          <span className="text-2xs text-ink-muted">Edge Details</span>
        </button>
      </div>

      {/* Edge Legend */}
      <div
        className={cn(
          'absolute bottom-40 z-30 w-64 pointer-events-auto transition-all duration-300 ease-out',
          selectedNodeId ? 'right-[420px]' : 'right-4',
        )}
      >
        <EdgeLegend defaultExpanded={false} visibleEdges={lineageEdges} />
      </div>

      {/* Panels */}
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
      <EntityDrawer
        onTraceUp={(nodeId) => trace.traceUpstream(nodeId)}
        onTraceDown={(nodeId) => trace.traceDownstream(nodeId)}
        onFullTrace={(nodeId) => trace.traceFullLineage(nodeId)}
      />

      {/* UX Components */}
      <CanvasContextMenu
        isOpen={interactions.state.contextMenu.isOpen}
        position={interactions.state.contextMenu.position}
        target={interactions.state.contextMenu.target}
        onClose={interactions.closeContextMenu}
        onEditNode={interactions.editNode}
        onDuplicateNode={interactions.duplicateNode}
        onDeleteNode={interactions.deleteNode}
        onCreateChild={interactions.createChild}
        onTraceNode={(id) => trace.startTrace(id)}
        onCopyUrn={interactions.copyUrn}
        onEditEdge={interactions.editEdge}
        onDeleteEdge={interactions.deleteEdge}
        onReverseEdge={interactions.reverseEdge}
        onCreateNode={(pos) => interactions.openQuickCreate(pos)}
        onSelectAll={interactions.selectAll}
      />
      <InlineNodeEditor
        nodeId={interactions.state.inlineEdit.nodeId}
        value={interactions.state.inlineEdit.value}
        position={interactions.state.inlineEdit.position}
        onSave={interactions.saveInlineEdit}
        onCancel={interactions.cancelInlineEdit}
      />
      <QuickCreateNode
        isOpen={interactions.state.quickCreate.isOpen}
        position={interactions.state.quickCreate.position}
        parentUrn={interactions.state.quickCreate.parentUrn}
        onClose={interactions.closeQuickCreate}
        onCreated={(nodeId) => selectNode(nodeId)}
        variant="centered"
      />
      <CommandPalette
        isOpen={interactions.state.commandPalette.isOpen}
        onClose={interactions.closeCommandPalette}
        onCreateEntity={(_typeId) => {
          interactions.closeCommandPalette()
          interactions.openQuickCreate({
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
          })
        }}
        onSelectEntity={(entityId) => selectNode(entityId)}
      />
    </div>
  )
}

export default GraphCanvas
