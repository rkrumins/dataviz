/**
 * ContextViewCanvas - Enterprise-grade Context View with User-Defined Layers
 *
 * Displays entities in a horizontal left-to-right flow with:
 * - User-defined layer columns (Source → Staging → Refinery → Report)
 * - Collapsible containers within each layer
 * - Entities flow from left (sources) to right (consumers)
 * - Configurable layer definitions via schema
 * - Lineage flow overlay support
 * - Backend-persisted blueprints (Save / Load / Quick Start Templates)
 *
 * Orchestrator component — delegates layer assignment, edge projection,
 * highlight state, and rendering to extracted hooks and components.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import {
  useSchemaStore,
  useContainmentEdgeTypes,
  useLineageEdgeTypes,
  useIsContainmentEdge,
  normalizeEdgeType,
  useEdgeTypeMetadataMap,
  useRelationshipTypes,
  useEntityTypes,
} from '@/store/schema'
import { useCanvasStore, useCanvasVersion } from '@/store/canvas'
import { useInstanceAssignments, useReferenceModelStore } from '@/store/referenceModelStore'
import { useWorkspacesStore } from '@/store/workspaces'
import { useGraphProvider } from '@/providers'
import { useGraphHydration } from '@/hooks/useGraphHydration'
import { useAggregatedLineage } from '@/hooks/useAggregatedLineage'
import { EdgeDetailPanel, generateEdgeTypeFilters } from '../../panels/EdgeDetailPanel'
import { EntityDrawer } from '../../panels/EntityDrawer'
import { EntityCreationPanel } from '../../panels/EntityCreationPanel'
import { EdgeLegend } from '../EdgeLegend'

import { useUnifiedTrace } from '@/hooks/useUnifiedTrace'
import { useEdgeDetailPanel, useEdgeTypeFilters } from '@/hooks/useEdgeFilters'
import { getEdgeTypeDefinition } from '@/utils/edgeTypeUtils'

// UX-first interaction components
import { CanvasContextMenu } from '../CanvasContextMenu'
import { InlineNodeEditor } from '../InlineNodeEditor'
import { QuickCreateNode } from '../QuickCreateNode'
import { CommandPalette } from '../CommandPalette'
import { useCanvasInteractions } from '@/hooks/useCanvasInteractions'
import { useCanvasKeyboard } from '@/hooks/useCanvasKeyboard'

// Editor components (unified with LineageCanvas)
import { EditorToolbar } from '../EditorToolbar'
import { NodePalette } from '../NodePalette'

import type { ViewLayerConfig, LogicalNodeConfig } from '@/types/schema'

// Extracted types, constants, hooks, and components
import { defaultReferenceModelLayers } from './constants'
import { useLayerAssignment } from '@/hooks/useLayerAssignment'
import { useEdgeProjection } from '@/hooks/useEdgeProjection'
import { useHighlightState, useHoverHighlight, useHoveredNodeId } from '@/hooks/useHighlightState'
import { LayerColumn } from './LayerColumn'
import { LineageFlowOverlay } from './LineageFlowOverlay'
import { ContextViewHeader } from './ContextViewHeader'

// Re-export for backward compatibility
export { defaultReferenceModelLayers } from './constants'

export interface ContextViewCanvasProps {
  className?: string
  layers?: ViewLayerConfig[]
  showLineageFlow?: boolean
}

export function ContextViewCanvas({
  className,
  layers = defaultReferenceModelLayers,
  showLineageFlow: initialShowLineageFlow = true
}: ContextViewCanvasProps) {
  const nodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)
  const addNodes = useCanvasStore((s) => s.addNodes)
  const addEdges = useCanvasStore((s) => s.addEdges)
  const selectNode = useCanvasStore((s) => s.selectNode)
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  const selectedNodeId = selectedNodeIds[0] ?? null
  const schema = useSchemaStore((s) => s.schema)
  const activeView = useSchemaStore((s) => s.getActiveView())
  const updateView = useSchemaStore((s) => s.updateView)
  const provider = useGraphProvider()
  const containmentEdgeTypes = useContainmentEdgeTypes()
  const lineageEdgeTypes = useLineageEdgeTypes()
  const isContainmentEdge = useIsContainmentEdge()
  const edgeTypeMetadata = useEdgeTypeMetadataMap()

  // URN resolver for trace
  const urnResolver = useCallback((nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId)
    return (node?.data?.urn as string) || nodeId
  }, [nodes])

  // Unified Trace System - replaces local trace state
  const trace = useUnifiedTrace({
    provider,
    urnResolver,
    onTraceComplete: async (result) => {
      console.log('[ReferenceModelCanvas] Trace complete:', result.traceNodes.size, 'nodes')

      // Auto-enable lineage flow so edges are visible
      setShowLineageFlow(true)

      // CRITICAL: Merge trace result nodes/edges into canvas store
      // Without this, LineageFlowOverlay can't draw trace edges
      if (result.lineageResult) {
        const lr = result.lineageResult

        // Convert GraphNode[] → LineageNode[] and add to canvas
        const newCanvasNodes = lr.nodes.map(gn => ({
          id: gn.urn,
          type: 'default' as const,
          position: { x: 0, y: 0 },
          data: {
            label: gn.displayName,
            urn: gn.urn,
            type: gn.entityType,
            classifications: gn.tags ?? [],
            metadata: {
              ...gn.properties,
              childCount: gn.childCount,
              sourceSystem: gn.sourceSystem,
            },
          },
        }))
        if (newCanvasNodes.length > 0) {
          addNodes(newCanvasNodes as any[])
        }

        // Convert GraphEdge[] → LineageEdge[] and add to canvas
        const newCanvasEdges = lr.edges.map(ge => ({
          id: ge.id,
          source: ge.sourceUrn,
          target: ge.targetUrn,
          data: {
            edgeType: ge.edgeType,
            relationship: ge.edgeType,
            confidence: ge.confidence,
          },
        }))
        if (newCanvasEdges.length > 0) {
          addEdges(newCanvasEdges as any[])
        }

        // Auto-expand ancestors of traced nodes
        const nodesToExpand = new Set(expandedNodes)

        // Build parent map from ALL edges (including newly added)
        const allCurrentEdges = [...edges, ...newCanvasEdges]
        const traceParentMap = new Map<string, string>()
        allCurrentEdges.forEach(e => {
          if (isContainmentEdge(normalizeEdgeType(e))) {
            traceParentMap.set(e.target ?? (e as any).targetUrn, e.source ?? (e as any).sourceUrn)
          }
        })

        // For each traced node, expand its ancestors
        result.traceNodes.forEach(id => {
          let curr = traceParentMap.get(id)
          while (curr) {
            nodesToExpand.add(curr)
            curr = traceParentMap.get(curr)
          }
        })

        setExpandedNodes(nodesToExpand)
      }
    }
  })

  // UX-first Canvas Interactions (context menu, inline edit, quick create, command palette)
  const interactions = useCanvasInteractions({
    onTraceNode: (nodeId) => trace.startTrace(nodeId),
    onNodeCreated: (nodeId) => selectNode(nodeId),
    layers: layers,
    onMoveToLayer: (_nodeId, _layerId) => {
      // Implementation handled by the existing moveToLayer function
    },
    onCloseEdgePanel: () => {
      if (isEdgePanelOpen) { closeEdgePanel(); return true }
      return false
    },
    onCloseEntityDrawer: () => {
      if (selectedNodeId) { clearSelection(); return true }
      return false
    },
  })

  // Keyboard shortcuts
  useCanvasKeyboard({
    enabled: true,
    handlers: interactions.keyboardHandlers,
  })

  // Aggregated lineage for progressive edge disclosure
  const {
    aggregatedEdges,
    fetchAggregated,
    clearCache: clearAggregationCache,
    granularity: lineageGranularity,
    setGranularity: setLineageGranularity,
  } = useAggregatedLineage({ granularity: null })

  // Instance-level assignments from store (user drag-and-drop)
  const instanceAssignments = useInstanceAssignments()
  const effectiveAssignments = useReferenceModelStore(s => s.effectiveAssignments)
  const computeAssignments = useReferenceModelStore(s => s.computeAssignments)
  const assignmentStatus = useReferenceModelStore(s => s.assignmentStatus)
  const setLayers = useReferenceModelStore(s => s.setLayers)
  const storeLayers = useReferenceModelStore(s => s.layers)
  const syncStatus = useReferenceModelStore(s => s.syncStatus)
  const activeContextModelName = useReferenceModelStore(s => s.activeContextModelName)
  const saveToBackend = useReferenceModelStore(s => s.saveToBackend)
  const assignEntityToLayer = useReferenceModelStore(s => s.assignEntityToLayer)
  const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)

  // Step 1: Sync view layers to store when activeView changes
  useEffect(() => {
    if (!activeView) return

    const viewLayers = activeView.layout?.referenceLayout?.layers
    if (!viewLayers || viewLayers.length === 0) return

    // Only sync if layers have changed (avoid unnecessary updates)
    const layersChanged =
      storeLayers.length !== viewLayers.length ||
      storeLayers.some((layer, idx) => {
        const viewLayer = viewLayers[idx]
        return !viewLayer ||
          layer.id !== viewLayer.id ||
          JSON.stringify(layer.entityAssignments) !== JSON.stringify(viewLayer.entityAssignments)
      })

    if (layersChanged) {
      setLayers(viewLayers)
    }
  }, [activeView?.id, activeView?.layout?.referenceLayout?.layers, setLayers, storeLayers])

  // Step 2: Load assignments from backend when layers are synced and nodes are available
  // Uses a ref to track what we've computed for, preventing cascading re-fetches.
  const assignmentComputedRef = useRef<string | null>(null)

  // Reset the assignment guard when the active view changes so recomputation
  // always happens for the new view (even if layer IDs happen to match).
  useEffect(() => {
    assignmentComputedRef.current = null
  }, [activeView?.id])

  useEffect(() => {
    if (nodes.length === 0 || !provider || storeLayers.length === 0) return
    if (assignmentStatus !== 'idle') return

    // Include activeView ID so switching between views with identical layer IDs
    // still triggers recomputation.
    const layerFingerprint = `${activeView?.id ?? ''}:${storeLayers.map(l => l.id).join(',')}`

    // Only compute once per unique view+layer configuration
    if (assignmentComputedRef.current === layerFingerprint) return
    assignmentComputedRef.current = layerFingerprint

    computeAssignments(provider)
  }, [nodes.length, provider, computeAssignments, assignmentStatus, storeLayers, activeView?.id])

  // Search state
  const [searchQuery, setSearchQuery] = useState('')

  // Entity creation state
  const [isCreatingEntity, setIsCreatingEntity] = useState(false)
  const [creationParentId, setCreationParentId] = useState<string | null>(null)
  const [creationLayerId, setCreationLayerId] = useState<string | null>(null)

  // Expanded nodes state (for hierarchy expansion, not trace)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())

  // Per-view expanded state: save/restore on view switch to prevent stale data
  const expandedByViewRef = useRef<Map<string, Set<string>>>(new Map())
  const prevViewIdRef = useRef<string | null>(null)

  useEffect(() => {
    const currentViewId = activeView?.id ?? null
    // Save current expanded state for the previous view
    if (prevViewIdRef.current && prevViewIdRef.current !== currentViewId) {
      expandedByViewRef.current.set(prevViewIdRef.current, new Set(expandedNodes))
    }
    // Restore or reset for the new view
    if (currentViewId !== prevViewIdRef.current) {
      const restored = expandedByViewRef.current.get(currentViewId ?? '') ?? new Set<string>()
      setExpandedNodes(restored)
      // Reset aggregation cache so stale data doesn't bleed into the new view
      prevAggregationKeyRef.current = ''
      clearAggregationCache()
    }
    prevViewIdRef.current = currentViewId
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView?.id])

  // Edit Mode State (unified with LineageCanvas)
  const [isPaletteOpen, setPaletteOpen] = useState(false)
  const [activeEdgeType, setActiveEdgeType] = useState<string>('manual')
  const relationshipTypes = useRelationshipTypes()

  // Granularity options for the lineage aggregation selector — driven by the
  // active ontology's entity types, sorted coarsest-first (lowest level first).
  const schemaEntityTypes = useEntityTypes()
  const granularityOptions = useMemo(
    () => schemaEntityTypes
      .filter(et => et.hierarchy?.level !== undefined)
      .map(et => ({ id: et.id, name: et.name, level: et.hierarchy.level })),
    [schemaEntityTypes]
  )

  // Handle save graph
  const handleSave = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/graph/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodes, edges })
      })
      if (!response.ok) throw new Error('Failed to save graph')
      alert('Graph saved successfully!')
    } catch (error) {
      console.error('Error saving graph:', error)
      alert('Failed to save graph')
    }
  }, [nodes, edges])

  // Handle right click - now uses unified CanvasContextMenu
  const handleContextMenu = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const node = nodes.find(n => n.id === nodeId)
    interactions.openContextMenu(e, {
      type: 'node',
      id: nodeId,
      data: node?.data as Record<string, unknown> || {},
    })
  }, [nodes, interactions])



  // Edge details
  const { isOpen: isEdgePanelOpen, toggle: toggleEdgePanel, close: closeEdgePanel } = useEdgeDetailPanel()
  const { filters: edgeFilters, toggle: toggleEdgeFilter } = useEdgeTypeFilters()
  const ontologyMetadata = useMemo(() => ({ edgeTypeMetadata }), [edgeTypeMetadata])
  const selectEdge = useCanvasStore((s) => s.selectEdge)

  // Generate dynamic edge filters from actual edges and schema
  const dynamicEdgeFilters = useMemo(() => {
    if (edges.length === 0) return edgeFilters
    return generateEdgeTypeFilters(
      edges,
      relationshipTypes,
      containmentEdgeTypes,
      ontologyMetadata
    )
  }, [edges, relationshipTypes, containmentEdgeTypes, ontologyMetadata, edgeFilters])

  // Schema-driven edge color resolver — used by LineageFlowOverlay
  // Resolves edge type → color from backend schema, falling back to defaults
  const resolveEdgeColor = useCallback((edgeType: string) => {
    return getEdgeTypeDefinition(
      edgeType,
      relationshipTypes,
      containmentEdgeTypes,
      ontologyMetadata ? { edgeTypeMetadata: ontologyMetadata.edgeTypeMetadata } : undefined
    ).color
  }, [relationshipTypes, containmentEdgeTypes, ontologyMetadata])

  // Trace Calculation for Double Click
  // We import computeTrace dynamically or assume it's available via utility
  // Since we can't easily import from hook file if it's not exported, we'll implement a lightweight version
  // OR rely on the hook if possible.
  // Actually, we can assume the user meant "computeTrace" is importable.
  // Checking previous file view: "export function computeTrace" exists in hooks/useLineageExploration.ts

  const handleDoubleClick = useCallback(async (nodeId: string, event?: React.MouseEvent) => {
    // UX-first: Double-click = inline edit (modern approach)
    // Use Shift+Double-click for trace (power user feature)
    if (event && !event.shiftKey) {
      // Find the node element to get its position
      const element = document.getElementById(`layer-node-${nodeId}`)
      if (element) {
        const rect = element.getBoundingClientRect()
        const targetNode = nodes.find(n => n.id === nodeId)
        interactions.startInlineEdit(
          nodeId,
          (targetNode?.data?.label as string) || nodeId,
          { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        )
        return
      }
    }

    // TRACE MODE: Toggle trace using unified trace hook
    trace.toggleTrace(nodeId)
  }, [trace.toggleTrace, nodes, interactions])


  // Lineage flow toggle
  const [showLineageFlow, setShowLineageFlow] = useState(initialShowLineageFlow)

  // Ref to trigger edge redraw from child components
  const triggerEdgeRedrawRef = useRef<(() => void) | null>(null)

  const handleLayerScroll = useCallback(() => {
    if (triggerEdgeRedrawRef.current) {
      triggerEdgeRedrawRef.current()
    }
  }, [])

  // Callback for animation completion to trigger edge redraw
  const handleAnimationComplete = useCallback(() => {
    // Small delay to ensure DOM is fully updated after animation
    requestAnimationFrame(() => {
      if (triggerEdgeRedrawRef.current) {
        triggerEdgeRedrawRef.current()
      }
    })
  }, [])

  // Sort layers by order
  const activeLayers = useMemo(() => {
    if (layers && layers !== defaultReferenceModelLayers && layers.length > 0) return layers
    if (activeView?.layout?.referenceLayout?.layers?.length) return activeView.layout.referenceLayout.layers
    return defaultReferenceModelLayers
  }, [layers, activeView])

  const sortedLayers = useMemo(() =>
    [...activeLayers].sort((a, b) => a.order - b.order),
    [activeLayers]
  )

  // Monotonic version counter — replaces brittle fingerprint sampling.
  // Incremented automatically by canvas store middleware on every node/edge mutation.
  const canvasVersion = useCanvasVersion()
  const nodeEdgeFingerprint = `${activeView?.id ?? ''}:${canvasVersion}`

  // Build generic hierarchy tree from nodes and containment edges.
  // Incremental: only processes new edges when addGraph appends (the common path).
  // Full rebuild when edges shrink (removeEdges/setGraph) or containmentEdgeTypes change.
  const prevEdgeLenRef = useRef(0)
  const prevContainmentTypesRef = useRef(containmentEdgeTypes)
  const childSetsRef = useRef(new Map<string, Set<string>>())
  const parentMapRef = useRef(new Map<string, string>())
  const childMapRef = useRef(new Map<string, string[]>())

  const { nodeMap, childMap, parentMap } = useMemo(() => {
    const nMap = new Map(nodes.map((n) => [n.id, n]))

    const typesChanged = prevContainmentTypesRef.current !== containmentEdgeTypes
    const edgesShrank = edges.length < prevEdgeLenRef.current
    const needsFullRebuild = typesChanged || edgesShrank

    let cSets: Map<string, Set<string>>
    let pMap: Map<string, string>

    if (needsFullRebuild) {
      // Full rebuild
      cSets = new Map<string, Set<string>>()
      pMap = new Map<string, string>()
      edges.filter((e) => isContainmentEdge(normalizeEdgeType(e))).forEach((edge) => {
        if (!cSets.has(edge.source)) cSets.set(edge.source, new Set())
        cSets.get(edge.source)!.add(edge.target)
        pMap.set(edge.target, edge.source)
      })
    } else {
      // Incremental: reuse previous maps, only process new edges
      cSets = childSetsRef.current
      pMap = parentMapRef.current
      const startIdx = prevEdgeLenRef.current
      for (let i = startIdx; i < edges.length; i++) {
        const edge = edges[i]
        if (!isContainmentEdge(normalizeEdgeType(edge))) continue
        if (!cSets.has(edge.source)) cSets.set(edge.source, new Set())
        cSets.get(edge.source)!.add(edge.target)
        pMap.set(edge.target, edge.source)
      }
    }

    // Convert Sets to arrays for downstream consumers
    const cMap = new Map<string, string[]>()
    cSets.forEach((children, parent) => cMap.set(parent, Array.from(children)))

    // Update refs for next incremental pass
    prevEdgeLenRef.current = edges.length
    prevContainmentTypesRef.current = containmentEdgeTypes
    childSetsRef.current = cSets
    parentMapRef.current = pMap
    childMapRef.current = cMap

    return { nodeMap: nMap, childMap: cMap, parentMap: pMap }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeEdgeFingerprint, containmentEdgeTypes])

  // Helper: Calculate currently visible top-level nodes (containers)
  const getVisibleContainerUrns = useCallback(() => {
    return nodes
      .filter(n => {
        const parentId = parentMap.get(n.id)
        if (!parentId) return true // Root
        return expandedNodes.has(parentId)
      })
      .map(n => (n.data?.urn as string) || n.id)
      .filter(Boolean)
  }, [nodes, parentMap, expandedNodes])

  // Track previous aggregation target fingerprint to avoid redundant fetches
  const prevAggregationKeyRef = useRef<string>('')

  // Stable node URN-to-ID map (updated via ref to avoid effect dependency on nodes)
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  // Optimized Effect: Fetch aggregated edges only when the visible set actually changes
  // Uses expandedNodes (user-driven) as the primary trigger, not nodes array reference.
  // A 500ms debounce coalesces rapid expand/collapse actions.
  useEffect(() => {
    if (!showLineageFlow || nodes.length === 0) return

    const fetchDebounced = setTimeout(() => {
      const currentVisibleList = getVisibleContainerUrns()

      if (currentVisibleList.length > 500) return

      // Exclude expanded nodes from aggregation targets.
      // When a node is expanded, its children are already in the visible list and will
      // represent it. Including BOTH parent and children causes the Cypher CONTAINS*0..5
      // traversal to find the same TRANSFORMS edges at multiple hierarchy levels,
      // producing duplicate/inflated aggregated edge counts.
      // (Earlier this caused missing lineage because orphan nodes like Snowflake weren't
      // loaded — that's now fixed by the initial graph load fetching orphan nodes.)
      const urnToIdMap = new Map(nodesRef.current.map(n => [(n.data?.urn as string) || n.id, n.id]))
      const aggregationTargets = currentVisibleList.filter(urn => {
        const nodeId = urnToIdMap.get(urn)
        return nodeId && !expandedNodes.has(nodeId)
      })

      // Only fetch if the target set actually changed
      const aggregationKey = aggregationTargets.sort().join(',')
      if (aggregationKey === prevAggregationKeyRef.current) return
      prevAggregationKeyRef.current = aggregationKey

      if (aggregationTargets.length > 0) {
        fetchAggregated(aggregationTargets, aggregationTargets)
      }
    }, 500) // 500ms debounce — coalesces rapid expand/collapse

    return () => clearTimeout(fetchDebounced)
  }, [showLineageFlow, getVisibleContainerUrns, fetchAggregated, nodes.length, expandedNodes])

  // === Extracted Hooks ===

  // Layer assignment: rules, nodesByLayer, displayFlat, displayMap, urnToIdMap
  const { nodesByLayer, displayFlat, displayMap, urnToIdMap } = useLayerAssignment({
    nodes, sortedLayers, nodeEdgeFingerprint,
    instanceAssignments, effectiveAssignments,
    nodeMap, childMap, parentMap,
  })

  // Search results
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return []
    const query = searchQuery.toLowerCase()
    return displayFlat.filter((node) =>
      node.name.toLowerCase().includes(query) ||
      node.typeId.toLowerCase().includes(query)
    )
  }, [searchQuery, displayFlat])

  // Action: Move entity to layer (updated for unified context menu)
  const moveToLayer = useCallback((nodeId: string, layerId: string) => {
    if (!activeView || !activeView.id) return

    const entity = displayMap.get(nodeId)
    if (!entity) return

    // If moving a logical node, we might need different logic (e.g. reparenting)
    // For now, we assume we are moving a PHYSICAL entity into a layer/group
    if (entity.isLogical) {
      console.warn("Moving logical nodes not yet supported via context menu")
      return
    }

    const layers = activeView.layout.referenceLayout?.layers || defaultReferenceModelLayers

    // Helper to recursively add rule to the correct logical node
    const addRuleToNode = (nodes: LogicalNodeConfig[], targetId: string): LogicalNodeConfig[] => {
      return nodes.map(node => {
        if (node.id === targetId) {
          return {
            ...node,
            rules: [
              ...(node.rules || []),
              {
                id: `rule-${Date.now()}`,
                priority: 100,
                urnPattern: entity.urn
              }
            ]
          }
        }
        if (node.children) {
          return {
            ...node,
            children: addRuleToNode(node.children, targetId)
          }
        }
        return node
      })
    }

    // Clone layers to update
    const updatedLayers = layers.map(l => {
      // Check if target is the layer itself
      if (l.id === layerId) {
        return {
          ...l,
          rules: [
            ...(l.rules || []),
            {
              id: `rule-${Date.now()}`,
              priority: 100, // High priority for manual moves
              urnPattern: entity.urn // Strict instance match
            }
          ]
        }
      }

      // Check if target is a logical node within this layer
      if (l.logicalNodes) {
        const updatedLogicalNodes = addRuleToNode(l.logicalNodes, layerId)
        if (updatedLogicalNodes !== l.logicalNodes) {
          return { ...l, logicalNodes: updatedLogicalNodes }
        }
      }

      return l
    })

    // Update View
    updateView(activeView.id, {
      layout: {
        ...activeView.layout,
        referenceLayout: {
          ...activeView.layout.referenceLayout,
          layers: updatedLayers
        }
      }
    })

    // Close context menu
    interactions.closeContextMenu()
  }, [activeView, displayMap, updateView, interactions])

  // Handler for adding child entities
  const handleAddChildEntity = useCallback((parentId: string) => {
    setCreationParentId(parentId)
    setIsCreatingEntity(true)
  }, [])

  // Toggle node expansion with Lazy Loading
  const { loadChildren, searchChildren, isLoading: isLoadingChildren, loadingNodes, failedNodes } = useGraphHydration()

  // Tracks nodes currently being fetched — prevents duplicate fetches on rapid clicks.
  // A ref (not state) because we need synchronous reads inside the toggle callback.
  const pendingLoadRef = useRef<Set<string>>(new Set())

  const toggleNode = useCallback(async (nodeId: string) => {
    const node = displayMap.get(nodeId)

    if (node?.isLogical) {
      setExpandedNodes((prev) => {
        const next = new Set(prev)
        if (next.has(nodeId)) next.delete(nodeId)
        else next.add(nodeId)
        return next
      })
      return
    }

    // Determine action from committed state via updater function — avoids stale closure read.
    let wasExpanded = false
    setExpandedNodes((prev) => {
      wasExpanded = prev.has(nodeId)
      const next = new Set(prev)
      if (wasExpanded) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })

    // Trigger fetch only when expanding, and only once per node (guard against rapid clicks).
    if (!wasExpanded && !pendingLoadRef.current.has(nodeId)) {
      pendingLoadRef.current.add(nodeId)
      try {
        await loadChildren(nodeId)
      } finally {
        pendingLoadRef.current.delete(nodeId)
      }
    }
  }, [displayMap, loadChildren])

  // Expand all / collapse all
  const expandAll = useCallback(() => {
    const allIds = displayFlat.map((n) => n.id)
    setExpandedNodes(new Set(allIds))
  }, [displayFlat])

  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set())
  }, [])



  // Style: Enhanced Trace Context using unified trace hook
  // Compute the set of all "Contextual Nodes" for the active trace.
  // This includes:
  // 1. The traced nodes themselves (from trace.visibleTraceNodes)
  // 2. ALL ancestors of traced nodes (so containers stay lit)
  const traceContextSet = useMemo(() => {
    const set = new Set<string>()

    if (!trace.isTracing) return set

    // Add focus node
    if (trace.focusId) set.add(trace.focusId)

    // Add ancestors for the focus node
    if (trace.focusId) {
      let curr = parentMap.get(trace.focusId)
      while (curr) {
        set.add(curr)
        curr = parentMap.get(curr)
      }
    }

    // Add visible traced nodes and their ancestors
    trace.visibleTraceNodes.forEach(id => {
      set.add(id) // Add the node itself

      let curr = parentMap.get(id)
      while (curr) {
        set.add(curr)
        curr = parentMap.get(curr)
      }
    })

    return set
  }, [trace.isTracing, trace.focusId, trace.visibleTraceNodes, parentMap])

  // Hovered node — needed by both edge projection (delegation) and hover highlight
  const hoveredNodeId = useHoveredNodeId()

  // Edge projection: lineageEdges, visibleLineageEdges
  const { visibleLineageEdges } = useEdgeProjection({
    edges, aggregatedEdges, nodesByLayer, expandedNodes,
    displayFlat, displayMap, urnToIdMap,
    showLineageFlow, isTracing: trace.isTracing,
    traceContextSet, isContainmentEdge,
    hoveredNodeId,
  })

  // Highlight state: connected nodes/edges for selected node
  const { highlightState, isHighlightActive: isClickHighlightActive } = useHighlightState({
    selectedNodeId, visibleLineageEdges,
    isTracing: trace.isTracing, displayMap, childMap,
  })

  // Hover highlight: same visual effect on hover (lighter), defers to click-highlight
  const { hoverHighlight, isHoverActive } = useHoverHighlight({
    hoveredNodeId,
    visibleLineageEdges,
    isTracing: trace.isTracing,
    displayMap, childMap,
    isClickHighlightActive,
  })

  // Merge: click takes priority, hover used when no click selection
  const isHighlightActive = isClickHighlightActive || isHoverActive
  const mergedHighlightNodes = isClickHighlightActive ? highlightState.nodes : hoverHighlight.nodes
  const mergedHighlightEdges = isClickHighlightActive ? highlightState.edges : hoverHighlight.edges

  const clearSelection = useCanvasStore((s) => s.clearSelection)

  // Background click handler to clear selection/highlight
  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    // Skip if clicking on an interactive element (tree items, edges, search boxes, etc.)
    if ((e.target as HTMLElement).closest('[data-canvas-interactive]')) return
    clearSelection()
  }, [clearSelection])

  return (
    <div className={cn("h-full w-full flex flex-col overflow-hidden bg-gradient-to-br from-canvas via-canvas to-canvas-elevated/30", className)}>
      {/* Editor Toolbar - Unified with LineageCanvas */}
      <div className="absolute top-4 left-4 z-30">
        <EditorToolbar
          onAddNode={() => setPaletteOpen(true)}
          onSave={handleSave}
          edgeTypes={relationshipTypes}
          activeEdgeType={activeEdgeType}
          onSelectEdgeType={setActiveEdgeType}
        />
      </div>

      {/* Node Palette - Drag and drop entity creation */}
      <AnimatePresence>
        {isPaletteOpen && (
          <NodePalette
            isOpen={isPaletteOpen}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </AnimatePresence>

      <ContextViewHeader
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchResults={searchResults}
        onSearchResultClick={(node) => {
          selectNode(node.id)
          setExpandedNodes((prev) => new Set([...prev, node.id]))
        }}
        showLineageFlow={showLineageFlow}
        onToggleLineageFlow={() => setShowLineageFlow(!showLineageFlow)}
        lineageGranularity={lineageGranularity}
        onGranularityChange={setLineageGranularity}
        granularityOptions={granularityOptions}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
        onAddEntity={() => { setIsCreatingEntity(true); setCreationParentId(null); setCreationLayerId(null) }}
        activeWorkspaceId={activeWorkspaceId}
        activeContextModelName={activeContextModelName}
        syncStatus={syncStatus}
        onSave={() => activeWorkspaceId && saveToBackend(activeWorkspaceId)}
        trace={trace}
        focusNodeName={displayMap.get(trace.focusId || '')?.name || trace.focusId || 'Unknown Node'}
        lineageEdgeTypes={lineageEdgeTypes}
        onExitTrace={() => { trace.clearTrace(); setExpandedNodes(new Set()) }}
      />

      <div className="flex-1 w-full h-full relative overflow-hidden bg-canvas flex flex-col">
        {/* Warning: missing ontology configuration */}
        {schema && containmentEdgeTypes.length === 0 && edges.length > 0 && (
          <div className="mx-4 mt-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs flex items-center gap-2 z-20">
            <span className="font-medium">No containment types configured.</span>
            <span className="text-amber-600 dark:text-amber-500">Hierarchy is disabled — all nodes appear flat. Configure your ontology to enable parent-child nesting.</span>
          </div>
        )}
        {/* Edge Panel */}
        <AnimatePresence>
          {isEdgePanelOpen && (
            <EdgeDetailPanel
              isOpen={isEdgePanelOpen}
              onClose={closeEdgePanel}
              edgeFilters={dynamicEdgeFilters}
              onToggleFilter={toggleEdgeFilter}
            />
          )}

          {/* Entity Drawer - Unified view & edit */}
          <EntityDrawer
            onTraceUp={(nodeId) => trace.traceUpstream(nodeId)}
            onTraceDown={(nodeId) => trace.traceDownstream(nodeId)}
            onFullTrace={(nodeId) => trace.traceFullLineage(nodeId)}
          />

          {/* Entity Creation Panel */}
          <EntityCreationPanel
            isOpen={isCreatingEntity}
            onClose={() => {
              setIsCreatingEntity(false)
              setCreationParentId(null)
              setCreationLayerId(null)
            }}
            parentId={creationParentId}
            layerId={creationLayerId}
            onEntityCreated={(_nodeId, parentUrn) => {
              // Auto-expand parent if a child was created
              if (parentUrn) {
                setExpandedNodes(prev => new Set([...prev, parentUrn]))
              }
            }}
          />
        </AnimatePresence>

        {/* Edge Legend — shifts left when EntityDrawer is open to avoid overlap (3.3)
             receives only the projected visible edges, not all canvas edges (3.2) */}
        <div className={cn(
          "absolute bottom-40 z-30 w-64 pointer-events-auto transition-all duration-300 ease-out",
          selectedNodeId ? "right-[420px]" : "right-4"
        )}>
          <EdgeLegend defaultExpanded={false} visibleEdges={visibleLineageEdges} />
        </div>

        {/* Layer Columns */}
        <div className="flex-1 overflow-auto relative scroll-smooth" onClick={handleBackgroundClick}>
          {/* Lineage Flow Overlay - Render BEFORE columns to be behind them (z-index managed in component to 0, cols should be higher) */}
          {(showLineageFlow || trace.isTracing) && (
            <LineageFlowOverlay
              nodes={displayFlat}
              edges={visibleLineageEdges}
              expandedNodes={expandedNodes}
              selectEdge={selectEdge}
              isEdgePanelOpen={isEdgePanelOpen}
              toggleEdgePanel={toggleEdgePanel}
              triggerRedrawRef={triggerEdgeRedrawRef}
              isTracing={trace.isTracing}
              traceResult={trace.result}
              highlightedEdges={mergedHighlightEdges}
              isHighlightActive={isHighlightActive}
              resolveEdgeColor={resolveEdgeColor}
            />
          )}

          <div className="flex h-full min-h-0 relative z-10 gap-12">
            {sortedLayers.map((layer) => (
              <LayerColumn
                key={layer.id}
                layer={layer}
                nodes={nodesByLayer.get(layer.id) ?? []}
                schema={schema}
                selectedNodeId={selectedNodeId}
                expandedNodes={expandedNodes}
                searchResults={searchResults.map((n) => n.id)}
                onSelect={selectNode}
                onToggle={toggleNode}
                onContextMenu={handleContextMenu}
                onDoubleClick={handleDoubleClick}
                onAddChild={handleAddChildEntity}
                onAddToLayer={(layerId) => {
                  setCreationLayerId(layerId)
                  setCreationParentId(null)
                  setIsCreatingEntity(true)
                }}
                traceFocusId={trace.focusId}
                traceNodes={trace.visibleTraceNodes}
                traceContextSet={traceContextSet}
                highlightedNodes={mergedHighlightNodes}
                isHighlightActive={isHighlightActive}
                isHoverHighlight={isHoverActive && !isClickHighlightActive}
                onAnimationComplete={handleAnimationComplete}
                onLoadMore={loadChildren}
                onSearchChildren={searchChildren}
                isLoadingChildren={isLoadingChildren}
                loadingNodes={loadingNodes}
                failedNodes={failedNodes}
                onScroll={handleLayerScroll}
                onAssignToLayer={(entityId) => assignEntityToLayer(entityId, layer.id)}
              />
            ))}
          </div>


        </div>
      </div>

      {/* === UX-FIRST INTERACTION COMPONENTS === */}

      {/* Modern Context Menu - Full CRUD operations */}
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
        layers={sortedLayers}
        onMoveToLayer={(nodeId, layerId) => moveToLayer(nodeId, layerId)}
      />

      {/* Inline Node Editor - Double-click to edit names */}
      <InlineNodeEditor
        nodeId={interactions.state.inlineEdit.nodeId}
        value={interactions.state.inlineEdit.value}
        position={interactions.state.inlineEdit.position}
        onSave={interactions.saveInlineEdit}
        onCancel={interactions.cancelInlineEdit}
      />

      {/* Quick Create - Press 'N' or use context menu */}
      <QuickCreateNode
        isOpen={interactions.state.quickCreate.isOpen}
        position={interactions.state.quickCreate.position}
        parentUrn={interactions.state.quickCreate.parentUrn}
        onClose={interactions.closeQuickCreate}
        onCreated={(nodeId) => selectNode(nodeId)}
        variant="centered"
      />

      {/* Command Palette - Press Cmd+K */}
      <CommandPalette
        isOpen={interactions.state.commandPalette.isOpen}
        onClose={interactions.closeCommandPalette}
        onCreateEntity={(_typeId) => {
          interactions.closeCommandPalette()
          interactions.openQuickCreate({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
        }}
        onSelectEntity={(entityId) => selectNode(entityId)}
      />
    </div>
  )
}
