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
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { useInstanceAssignments, useReferenceModelStore } from '@/store/referenceModelStore'
import { useWorkspacesStore } from '@/store/workspaces'
import { useGraphProvider } from '@/providers'
import { useEntityLoader } from '@/hooks/useEntityLoader'
import { useAggregatedLineage } from '@/hooks/useAggregatedLineage'
import { EdgeDetailPanel, generateEdgeTypeFilters } from '../../panels/EdgeDetailPanel'
import { EntityDrawer } from '../../panels/EntityDrawer'
import { EntityCreationPanel } from '../../panels/EntityCreationPanel'
import { EdgeLegend } from '../EdgeLegend'
import { TraceToolbar } from '../TraceToolbar'
import { useUnifiedTrace } from '@/hooks/useUnifiedTrace'
import { useEdgeDetailPanel, useEdgeTypeFilters } from '@/hooks/useEdgeFilters'
import { useOntologyMetadata, normalizeEdgeType } from '@/services/ontologyService'
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
import { useHighlightState } from '@/hooks/useHighlightState'
import { LayerColumn } from './LayerColumn'
import { LineageFlowOverlay } from './LineageFlowOverlay'

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
  const { containmentEdgeTypes, lineageEdgeTypes, isContainmentEdge } = useOntologyMetadata()

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
          const type = String((e.data as any)?.edgeType ?? (e.data as any)?.relationship ?? '').toUpperCase()
          if (containmentEdgeTypes.some(ct => ct.toUpperCase() === type)) {
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
    granularity: lineageGranularity,
    setGranularity: setLineageGranularity,
  } = useAggregatedLineage({ granularity: 'table' })

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
  const loadFromBackend = useReferenceModelStore(s => s.loadFromBackend)
  const loadTemplate = useReferenceModelStore(s => s.loadTemplate)
  const listAvailable = useReferenceModelStore(s => s.listAvailable)
  const listTemplates = useReferenceModelStore(s => s.listTemplates)
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
  useEffect(() => {
    if (nodes.length === 0 || !provider || storeLayers.length === 0) return
    if (assignmentStatus !== 'idle') return

    // Build a fingerprint of layers that affect assignment computation
    const layerFingerprint = storeLayers.map(l => l.id).join(',')

    // Only compute once per unique layer configuration
    if (assignmentComputedRef.current === layerFingerprint) return
    assignmentComputedRef.current = layerFingerprint

    computeAssignments(provider)
  }, [nodes.length, provider, computeAssignments, assignmentStatus, storeLayers])

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Entity creation state
  const [isCreatingEntity, setIsCreatingEntity] = useState(false)
  const [creationParentId, setCreationParentId] = useState<string | null>(null)
  const [creationLayerId, setCreationLayerId] = useState<string | null>(null)

  // Expanded nodes state (for hierarchy expansion, not trace)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())

  // Load Blueprint dropdown state
  const [showLoadDropdown, setShowLoadDropdown] = useState(false)
  const [savedModels, setSavedModels] = useState<Array<{ id: string; name: string }>>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [loadingModelId, setLoadingModelId] = useState<string | null>(null)

  // Quick Start Templates dropdown state
  const [showTemplatesDropdown, setShowTemplatesDropdown] = useState(false)
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; category?: string }>>([])
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false)
  const [loadingTemplateId, setLoadingTemplateId] = useState<string | null>(null)

  // Fetch saved models when Load dropdown opens
  const handleOpenLoadDropdown = useCallback(async () => {
    if (!activeWorkspaceId) return
    setShowLoadDropdown(v => !v)
    setShowTemplatesDropdown(false)
    if (!showLoadDropdown && savedModels.length === 0) {
      setIsLoadingModels(true)
      try {
        const models = await listAvailable(activeWorkspaceId)
        setSavedModels(models.map(m => ({ id: m.id, name: m.name })))
      } catch { /* silent */ } finally {
        setIsLoadingModels(false)
      }
    }
  }, [activeWorkspaceId, showLoadDropdown, savedModels.length, listAvailable])

  // Load a saved blueprint
  const handleLoadModel = useCallback(async (id: string) => {
    if (!activeWorkspaceId) return
    setLoadingModelId(id)
    try {
      await loadFromBackend(activeWorkspaceId, id)
      setShowLoadDropdown(false)
    } catch { /* silent */ } finally {
      setLoadingModelId(null)
    }
  }, [activeWorkspaceId, loadFromBackend])

  // Fetch templates when Templates dropdown opens
  const handleOpenTemplatesDropdown = useCallback(async () => {
    setShowTemplatesDropdown(v => !v)
    setShowLoadDropdown(false)
    if (!showTemplatesDropdown && templates.length === 0) {
      setIsLoadingTemplates(true)
      try {
        const tmpl = await listTemplates()
        setTemplates(tmpl.map(m => ({ id: m.id, name: m.name, category: m.category ?? undefined })))
      } catch { /* silent */ } finally {
        setIsLoadingTemplates(false)
      }
    }
  }, [showTemplatesDropdown, templates.length, listTemplates])

  // Instantiate a Quick Start Template
  const handleLoadTemplate = useCallback(async (templateId: string, templateName: string) => {
    if (!activeWorkspaceId) return
    setLoadingTemplateId(templateId)
    try {
      await loadTemplate(activeWorkspaceId, templateId, `${templateName} (copy)`)
      setShowTemplatesDropdown(false)
    } catch { /* silent */ } finally {
      setLoadingTemplateId(null)
    }
  }, [activeWorkspaceId, loadTemplate])


  // Edit Mode State (unified with LineageCanvas)
  const [isPaletteOpen, setPaletteOpen] = useState(false)
  const [activeEdgeType, setActiveEdgeType] = useState<string>('manual')
  const relationshipTypes = useSchemaStore((s) => s.schema?.relationshipTypes || [])

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
  const { metadata: ontologyMetadata } = useOntologyMetadata()
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

  // Stable fingerprint: only changes when the actual node/edge set changes,
  // not on every array reference swap (which happens on addNodes even with 0 new items)
  const nodeEdgeFingerprint = useMemo(() => {
    const firstNodeId = nodes.length > 0 ? nodes[0].id : ''
    const lastNodeId = nodes.length > 0 ? nodes[nodes.length - 1].id : ''
    return `${nodes.length}:${edges.length}:${firstNodeId}:${lastNodeId}`
  }, [nodes, edges])

  // Build generic hierarchy tree from nodes and containment edges
  // We keep this to visualize structure, but layer assignment is calculated independently
  const { nodeMap, childMap, parentMap } = useMemo(() => {
    const nMap = new Map(nodes.map((n) => [n.id, n]))
    const cMap = new Map<string, string[]>()
    const pMap = new Map<string, string>()

    // Containment logic - use containmentEdgeTypes directly
    const containmentEdges = edges.filter((e) => {
      const edgeType = normalizeEdgeType(e)
      return containmentEdgeTypes.some(type => type.toUpperCase() === edgeType)
    })

    containmentEdges.forEach((edge) => {
      if (!cMap.has(edge.source)) cMap.set(edge.source, [])
      cMap.get(edge.source)!.push(edge.target)
      pMap.set(edge.target, edge.source)
    })

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
    nodes, edges, sortedLayers, nodeEdgeFingerprint,
    containmentEdgeTypes: new Set(containmentEdgeTypes),
    instanceAssignments, effectiveAssignments,
    nodeMap, childMap, parentMap, expandedNodes,
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
  const { loadChildren, searchChildren, isLoading: isLoadingChildren, loadingNodes } = useEntityLoader()

  const toggleNode = useCallback(async (nodeId: string) => {
    // Check if we need to fetch children
    const node = displayMap.get(nodeId)

    if (node?.isLogical) {
      // Just toggle logical nodes
      setExpandedNodes((prev) => {
        const next = new Set(prev)
        if (next.has(nodeId)) next.delete(nodeId)
        else next.add(nodeId)
        return next
      })
      return
    }

    // Toggle expansion state locally first
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
        return next
      } else {
        next.add(nodeId)
        return next
      }
    })

    // Lazy load children if expanding
    if (!expandedNodes.has(nodeId)) {
      await loadChildren(nodeId)
    }

  }, [displayMap, expandedNodes, loadChildren])

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

  // Edge projection: lineageEdges, visibleLineageEdges
  const { visibleLineageEdges } = useEdgeProjection({
    edges, aggregatedEdges, nodesByLayer, expandedNodes,
    displayFlat, displayMap, urnToIdMap,
    showLineageFlow, isTracing: trace.isTracing,
    traceContextSet, isContainmentEdge,
  })

  // Highlight state: connected nodes/edges for selected node
  const { highlightState, isHighlightActive } = useHighlightState({
    selectedNodeId, visibleLineageEdges,
    isTracing: trace.isTracing, displayMap, childMap,
  })

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

      {/* Header - Modern glass morphism style */}
      <div className="flex-shrink-0 bg-gradient-to-r from-canvas-elevated/90 via-canvas-elevated/95 to-canvas-elevated/90 backdrop-blur-xl border-b border-white/[0.06] px-6 py-3 relative">
        {/* Subtle gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-r from-accent-lineage/[0.02] via-transparent to-purple-500/[0.02] pointer-events-none" />

        <div className="flex items-center gap-4 relative">
          {/* Title with icon */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent-lineage/20 to-purple-500/20 flex items-center justify-center shadow-lg shadow-accent-lineage/10">
              <LucideIcons.Network className="w-5 h-5 text-accent-lineage" />
            </div>
            <div>
              <h2 className="text-base font-display font-semibold text-ink tracking-tight">Context View</h2>
              <p className="text-[10px] text-ink-muted/60 flex items-center gap-1.5">
                <LucideIcons.ArrowRight className="w-3 h-3" />
                Data Flow Blueprint
              </p>
            </div>
          </div>

          <div className="flex-1" />

          {/* Search - Modern glass input */}
          <div className="relative group">
            <div className="absolute inset-0 bg-gradient-to-r from-accent-lineage/10 to-purple-500/10 rounded-xl opacity-0 group-focus-within:opacity-100 blur-xl transition-opacity" />
            <div className="relative">
              <LucideIcons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted/50 group-focus-within:text-accent-lineage transition-colors" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search entities..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-52 pl-9 pr-8 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-ink placeholder:text-ink-muted/40 focus:outline-none focus:border-accent-lineage/40 focus:bg-white/[0.06] transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-lg hover:bg-white/10 text-ink-muted hover:text-ink transition-all"
                >
                  <LucideIcons.X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="w-px h-6 bg-gradient-to-b from-transparent via-white/10 to-transparent" />

          {/* Lineage Flow Toggle - Modern pill button */}
          <button
            onClick={() => setShowLineageFlow(!showLineageFlow)}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300",
              showLineageFlow
                ? "bg-gradient-to-r from-accent-lineage/20 to-accent-lineage/10 text-accent-lineage shadow-lg shadow-accent-lineage/20 border border-accent-lineage/30"
                : "bg-white/[0.04] border border-white/[0.08] text-ink-muted hover:bg-white/[0.08] hover:text-ink"
            )}
          >
            <motion.div
              animate={{ rotate: showLineageFlow ? 0 : -180 }}
              transition={{ duration: 0.3 }}
            >
              <LucideIcons.GitBranch className="w-4 h-4" />
            </motion.div>
            <span>{showLineageFlow ? 'Flow Active' : 'Show Flow'}</span>
            <div className={cn(
              "w-2 h-2 rounded-full transition-colors duration-300",
              showLineageFlow ? "bg-green-400 shadow-lg shadow-green-400/50" : "bg-ink-muted/30"
            )} />
          </button>

          {/* Granularity Selector - Modern dropdown */}
          <AnimatePresence>
            {showLineageFlow && (
              <motion.div
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                className="overflow-hidden"
              >
                <select
                  value={lineageGranularity}
                  onChange={(e) => setLineageGranularity(e.target.value as any)}
                  className="px-3 py-2 rounded-xl text-xs font-medium bg-white/[0.04] border border-white/[0.08] text-ink cursor-pointer hover:bg-white/[0.08] focus:outline-none focus:border-accent-lineage/40 transition-all appearance-none pr-8 bg-no-repeat bg-right"
                  style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%239ca3af'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`, backgroundSize: '16px', backgroundPosition: 'right 8px center' }}
                >
                  <option value="column">Column Level</option>
                  <option value="table">Table Level</option>
                  <option value="schema">Schema Level</option>
                  <option value="system">System Level</option>
                  <option value="domain">Domain Level</option>
                </select>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Divider */}
          <div className="w-px h-6 bg-gradient-to-b from-transparent via-white/10 to-transparent" />

          {/* Add Entity Button - Accent gradient */}
          <button
            onClick={() => {
              setIsCreatingEntity(true)
              setCreationParentId(null)
              setCreationLayerId(null)
            }}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-gradient-to-r from-green-500/20 to-emerald-500/10 text-green-400 border border-green-500/30 hover:from-green-500/30 hover:to-emerald-500/20 hover:shadow-lg hover:shadow-green-500/20 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
          >
            <LucideIcons.Plus className="w-4 h-4" />
            <span>Add Entity</span>
          </button>

          {/* Expand/Collapse - Icon buttons */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.06]">
            <button
              onClick={expandAll}
              className="p-1.5 rounded-lg hover:bg-white/[0.08] text-ink-muted hover:text-ink transition-all"
              title="Expand All"
            >
              <LucideIcons.ChevronsDownUp className="w-4 h-4 rotate-180" />
            </button>
            <div className="w-px h-4 bg-white/[0.08]" />
            <button
              onClick={collapseAll}
              className="p-1.5 rounded-lg hover:bg-white/[0.08] text-ink-muted hover:text-ink transition-all"
              title="Collapse All"
            >
              <LucideIcons.ChevronsDownUp className="w-4 h-4" />
            </button>
          </div>

          {/* Divider */}
          <div className="w-px h-6 bg-gradient-to-b from-transparent via-white/10 to-transparent" />

          {/* Load Blueprint dropdown */}
          <div className="relative">
            <button
              onClick={handleOpenLoadDropdown}
              disabled={!activeWorkspaceId}
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all duration-200",
                showLoadDropdown
                  ? "bg-purple-500/15 text-purple-400 border border-purple-500/30"
                  : "bg-white/[0.04] border border-white/[0.08] text-ink-muted hover:bg-white/[0.08] hover:text-ink"
              )}
              title={!activeWorkspaceId ? 'No workspace selected' : 'Load a saved blueprint'}
            >
              {isLoadingModels ? (
                <LucideIcons.Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <LucideIcons.FolderOpen className="w-4 h-4" />
              )}
              <span>Load</span>
              <LucideIcons.ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showLoadDropdown && "rotate-180")} />
            </button>

            <AnimatePresence>
              {showLoadDropdown && (
                <motion.div
                  initial={{ opacity: 0, y: -4, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.97 }}
                  transition={{ duration: 0.15 }}
                  className="absolute right-0 top-full mt-2 w-64 z-50 rounded-xl bg-canvas-elevated/95 backdrop-blur-xl border border-white/[0.1] shadow-2xl shadow-black/40 overflow-hidden"
                >
                  <div className="px-3 py-2 border-b border-white/[0.06]">
                    <p className="text-[11px] font-medium text-ink-muted uppercase tracking-wider">Saved Blueprints</p>
                  </div>
                  <div className="max-h-52 overflow-y-auto py-1">
                    {isLoadingModels ? (
                      <div className="flex items-center justify-center py-6">
                        <LucideIcons.Loader2 className="w-4 h-4 animate-spin text-ink-muted" />
                      </div>
                    ) : savedModels.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
                        <LucideIcons.FolderOpen className="w-8 h-8 text-ink-muted/30 mb-2" />
                        <p className="text-xs text-ink-muted/60">No saved blueprints yet</p>
                        <p className="text-[10px] text-ink-muted/40 mt-1">Use Save Blueprint to persist your configuration</p>
                      </div>
                    ) : (
                      savedModels.map(model => (
                        <button
                          key={model.id}
                          onClick={() => handleLoadModel(model.id)}
                          disabled={loadingModelId === model.id}
                          className={cn(
                            "w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors",
                            activeContextModelName === model.name
                              ? "bg-purple-500/10 text-purple-400"
                              : "text-ink hover:bg-white/[0.05] hover:text-ink"
                          )}
                        >
                          {loadingModelId === model.id ? (
                            <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                          ) : activeContextModelName === model.name ? (
                            <LucideIcons.CheckCircle className="w-3.5 h-3.5 flex-shrink-0 text-purple-400" />
                          ) : (
                            <LucideIcons.FileCode2 className="w-3.5 h-3.5 flex-shrink-0 text-ink-muted" />
                          )}
                          <span className="truncate">{model.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="border-t border-white/[0.06] px-3 py-2">
                    <button
                      onClick={() => {
                        setSavedModels([])
                        if (activeWorkspaceId) {
                          setIsLoadingModels(true)
                          listAvailable(activeWorkspaceId).then(m => {
                            setSavedModels(m.map(x => ({ id: x.id, name: x.name })))
                          }).finally(() => setIsLoadingModels(false))
                        }
                      }}
                      className="w-full flex items-center justify-center gap-1.5 py-1 text-[11px] text-ink-muted/60 hover:text-ink-muted transition-colors"
                    >
                      <LucideIcons.RefreshCw className="w-3 h-3" />
                      Refresh
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Quick Start Templates dropdown */}
          <div className="relative">
            <button
              onClick={handleOpenTemplatesDropdown}
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all duration-200",
                showTemplatesDropdown
                  ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                  : "bg-white/[0.04] border border-white/[0.08] text-ink-muted hover:bg-white/[0.08] hover:text-ink"
              )}
              title="Apply a Quick Start Template"
            >
              {isLoadingTemplates ? (
                <LucideIcons.Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <LucideIcons.Wand2 className="w-4 h-4" />
              )}
              <span>Templates</span>
              <LucideIcons.ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showTemplatesDropdown && "rotate-180")} />
            </button>

            <AnimatePresence>
              {showTemplatesDropdown && (
                <motion.div
                  initial={{ opacity: 0, y: -4, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.97 }}
                  transition={{ duration: 0.15 }}
                  className="absolute right-0 top-full mt-2 w-72 z-50 rounded-xl bg-canvas-elevated/95 backdrop-blur-xl border border-white/[0.1] shadow-2xl shadow-black/40 overflow-hidden"
                >
                  <div className="px-3 py-2 border-b border-white/[0.06]">
                    <p className="text-[11px] font-medium text-ink-muted uppercase tracking-wider">Quick Start Templates</p>
                    <p className="text-[10px] text-ink-muted/50 mt-0.5">Replaces current layers — save first if needed</p>
                  </div>
                  <div className="max-h-72 overflow-y-auto py-1">
                    {isLoadingTemplates ? (
                      <div className="flex items-center justify-center py-6">
                        <LucideIcons.Loader2 className="w-4 h-4 animate-spin text-ink-muted" />
                      </div>
                    ) : templates.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
                        <LucideIcons.Wand2 className="w-8 h-8 text-ink-muted/30 mb-2" />
                        <p className="text-xs text-ink-muted/60">No templates available</p>
                        <p className="text-[10px] text-ink-muted/40 mt-1">Ask your admin to seed Quick Start Templates</p>
                      </div>
                    ) : (
                      templates.map(tmpl => (
                        <button
                          key={tmpl.id}
                          onClick={() => handleLoadTemplate(tmpl.id, tmpl.name)}
                          disabled={loadingTemplateId === tmpl.id || !activeWorkspaceId}
                          className="w-full flex items-start gap-3 px-3 py-2.5 text-left text-sm text-ink hover:bg-white/[0.05] transition-colors"
                        >
                          {loadingTemplateId === tmpl.id ? (
                            <LucideIcons.Loader2 className="w-4 h-4 animate-spin flex-shrink-0 mt-0.5 text-amber-400" />
                          ) : (
                            <LucideIcons.LayoutTemplate className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-400" />
                          )}
                          <div className="min-w-0">
                            <p className="font-medium truncate">{tmpl.name}</p>
                            {tmpl.category && (
                              <p className="text-[10px] text-ink-muted/60 mt-0.5 capitalize">{tmpl.category.replace(/-/g, ' ')}</p>
                            )}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Divider */}
          <div className="w-px h-6 bg-gradient-to-b from-transparent via-white/10 to-transparent" />

          {/* Save Blueprint */}
          <div className="flex items-center gap-2">
            {activeContextModelName && (
              <span className="text-xs text-ink-muted truncate max-w-[120px]" title={activeContextModelName}>
                {activeContextModelName}
              </span>
            )}
            <button
              onClick={() => activeWorkspaceId && saveToBackend(activeWorkspaceId)}
              disabled={(syncStatus !== 'dirty' && syncStatus !== 'error') || !activeWorkspaceId}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300",
                syncStatus === 'dirty'
                  ? "bg-gradient-to-r from-blue-500/20 to-cyan-500/10 text-blue-400 border border-blue-500/30 hover:from-blue-500/30 hover:to-cyan-500/20 hover:shadow-lg hover:shadow-blue-500/20 hover:scale-[1.02] active:scale-[0.98]"
                  : syncStatus === 'error'
                    ? "bg-gradient-to-r from-red-500/20 to-red-500/10 text-red-400 border border-red-500/30"
                    : "bg-white/[0.03] border border-white/[0.06] text-ink-muted/50 cursor-not-allowed"
              )}
              title={
                !activeWorkspaceId ? 'No workspace selected'
                  : syncStatus === 'dirty' ? 'Save changes to backend'
                    : syncStatus === 'error' ? 'Save failed — click to retry'
                      : 'All changes saved'
              }
            >
              {syncStatus === 'saving' ? (
                <LucideIcons.Loader2 className="w-4 h-4 animate-spin" />
              ) : syncStatus === 'error' ? (
                <LucideIcons.AlertCircle className="w-4 h-4" />
              ) : syncStatus === 'synced' ? (
                <LucideIcons.CheckCircle className="w-4 h-4" />
              ) : (
                <LucideIcons.Save className="w-4 h-4" />
              )}
              <span>
                {syncStatus === 'saving' ? 'Saving...'
                  : syncStatus === 'error' ? 'Retry Save'
                    : syncStatus === 'synced' ? 'Saved'
                      : 'Save Blueprint'}
              </span>
              {syncStatus === 'dirty' && (
                <div className="w-2 h-2 rounded-full bg-blue-400 shadow-lg shadow-blue-400/50" />
              )}
            </button>
          </div>
        </div>

        {/* Search Results - Modern pill results */}
        <AnimatePresence>
          {searchResults.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 flex items-center gap-2 flex-wrap relative"
            >
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
                <LucideIcons.Search className="w-3.5 h-3.5 text-amber-500" />
                <span className="text-xs font-medium text-amber-500">{searchResults.length} found</span>
              </div>
              {searchResults.slice(0, 5).map((node, idx) => (
                <motion.button
                  key={node.id}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: idx * 0.05 }}
                  onClick={() => {
                    selectNode(node.id)
                    setExpandedNodes((prev) => new Set([...prev, node.id]))
                  }}
                  className="px-3 py-1.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-ink text-xs font-medium hover:bg-accent-lineage/15 hover:border-accent-lineage/30 hover:text-accent-lineage transition-all duration-200 hover:shadow-lg hover:shadow-accent-lineage/10"
                >
                  {node.name}
                </motion.button>
              ))}
              {searchResults.length > 5 && (
                <span className="px-2 py-1 text-xs text-ink-muted/60">+{searchResults.length - 5} more</span>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Trace Toolbar - Using unified TraceToolbar component */}
        <AnimatePresence>
          {trace.isTracing && (
            <TraceToolbar
              focusNodeName={displayMap.get(trace.focusId || '')?.name || trace.focusId || 'Unknown Node'}
              upstreamCount={trace.upstreamCount}
              downstreamCount={trace.downstreamCount}
              showUpstream={trace.showUpstream}
              showDownstream={trace.showDownstream}
              onToggleUpstream={() => trace.setShowUpstream(!trace.showUpstream)}
              onToggleDownstream={() => trace.setShowDownstream(!trace.showDownstream)}
              onExitTrace={() => {
                trace.clearTrace()
                setExpandedNodes(new Set())
              }}
              onRetrace={trace.retrace}
              onTraceUpstream={() => trace.focusId && trace.traceUpstream(trace.focusId)}
              onTraceDownstream={() => trace.focusId && trace.traceDownstream(trace.focusId)}
              onTraceFullLineage={() => trace.focusId && trace.traceFullLineage(trace.focusId)}
              config={trace.config}
              onConfigChange={trace.setConfig}
              traceResult={trace.result}
              statistics={trace.statistics}
              isLoading={trace.isLoading}
              availableLineageEdgeTypes={lineageEdgeTypes}
              position="floating"
            />
          )}
        </AnimatePresence>
      </div>

      <div className="flex-1 w-full h-full relative overflow-hidden bg-canvas flex flex-col">
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

        {/* Edge Legend - positioned above bottom, fixed position */}
        <div className="absolute bottom-40 right-4 z-30 w-64 pointer-events-auto">
          <EdgeLegend defaultExpanded={false} />
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
              highlightedEdges={highlightState.edges}
              isHighlightActive={isHighlightActive}
              resolveEdgeColor={resolveEdgeColor}
            />
          )}

          <div className="flex h-full min-h-0 relative z-10 divide-x divide-glass-border">
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
                highlightedNodes={highlightState.nodes}
                isHighlightActive={isHighlightActive}
                onAnimationComplete={handleAnimationComplete}
                onLoadMore={loadChildren}
                onSearchChildren={searchChildren}
                isLoadingChildren={isLoadingChildren}
                loadingNodes={loadingNodes}
                onScroll={handleLayerScroll}
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
