/**
 * ReferenceModelCanvas - Hierarchy-style Reference Model with User-Defined Layers
 * 
 * Displays entities in a horizontal left-to-right flow with:
 * - User-defined layer columns (Source → Staging → Refinery → Report)
 * - Collapsible containers within each layer
 * - Entities flow from left (sources) to right (consumers)
 * - Configurable layer definitions via schema
 * - Lineage flow overlay support
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { useInstanceAssignments, useReferenceModelStore } from '@/store/referenceModelStore'
import {
  type GraphNode,
  resolveLayerAssignment,
  type LayerAssignmentRule,
  type EntityType,
} from '@/providers/GraphDataProvider'
import { useGraphProvider } from '@/providers'
import { useEntityLoader } from '@/hooks/useEntityLoader'
import { useAggregatedLineage, aggregatedEdgeToFlowEdge } from '@/hooks/useAggregatedLineage'
import { EdgeDetailPanel, generateEdgeTypeFilters } from '../panels/EdgeDetailPanel'
import { EntityDrawer } from '../panels/EntityDrawer'
import { EntityCreationPanel } from '../panels/EntityCreationPanel'
import { EdgeLegend } from './EdgeLegend'
import { TraceToolbar } from './TraceToolbar'
import { useUnifiedTrace, useTraceStore } from '@/hooks/useUnifiedTrace'
import { useEdgeDetailPanel, useEdgeTypeFilters } from '@/hooks/useEdgeFilters'
import { useOntologyMetadata, isContainmentEdge, normalizeEdgeType } from '@/services/ontologyService'

// UX-first interaction components
import { CanvasContextMenu, type ContextMenuTarget } from './CanvasContextMenu'
import { InlineNodeEditor } from './InlineNodeEditor'
import { QuickCreateNode } from './QuickCreateNode'
import { CommandPalette } from './CommandPalette'
import { useCanvasInteractions } from '@/hooks/useCanvasInteractions'
import { useCanvasKeyboard } from '@/hooks/useCanvasKeyboard'

// Editor components (unified with LineageCanvas)
import { EditorToolbar } from './EditorToolbar'
import { NodePalette } from './NodePalette'

// Dynamic icon component
function DynamicIcon({ name, className, style }: { name: string; className?: string; style?: React.CSSProperties }) {
  const IconComponent = (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>>)[name]
  if (!IconComponent) {
    return <LucideIcons.Box className={className} style={style} />
  }
  return <IconComponent className={className} style={style} />
}

import type { ViewLayerConfig, LogicalNodeConfig } from '@/types/schema'

// Default layers matching typical data flow
export const defaultReferenceModelLayers: ViewLayerConfig[] = [
  {
    id: 'source',
    name: 'Source Layer',
    description: 'Raw data sources and ingestion',
    icon: 'Database',
    color: '#8b5cf6', // Purple
    entityTypes: ['domain', 'system'],
    order: 0,
  },
  {
    id: 'staging',
    name: 'Staging',
    description: 'Raw data landing zone',
    icon: 'Inbox',
    color: '#06b6d4', // Cyan
    entityTypes: ['schema'],
    order: 1,
  },
  {
    id: 'refinery',
    name: 'Refinery',
    description: 'Transformation and processing',
    icon: 'Workflow',
    color: '#f59e0b', // Amber
    entityTypes: ['pipeline', 'asset'],
    order: 2,
  },
  {
    id: 'consumption',
    name: 'Consumption',
    description: 'Analytics and reporting',
    icon: 'BarChart3',
    color: '#22c55e', // Green
    entityTypes: ['dashboard', 'report'],
    order: 3,
  },
]

interface HierarchyNode {
  id: string
  typeId: string
  name: string
  data: Record<string, unknown>
  children: HierarchyNode[]
  parentId?: string
  depth: number
  // GraphNode properties for layer logic
  urn: string
  entityTypeOption: EntityType
  tags: string[]
  // Logical Node extensions
  isLogical?: boolean
  logicalConfig?: LogicalNodeConfig
}

interface ReferenceModelCanvasProps {
  className?: string
  layers?: ViewLayerConfig[]
  showLineageFlow?: boolean
}

export function ReferenceModelCanvas({
  className,
  layers = defaultReferenceModelLayers,
  showLineageFlow: initialShowLineageFlow = true
}: ReferenceModelCanvasProps) {
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
  const { containmentEdgeTypes, isContainmentEdge } = useOntologyMetadata()
  
  // UX-first Canvas Interactions (context menu, inline edit, quick create, command palette)
  const interactions = useCanvasInteractions({
    onTraceNode: (nodeId) => setTraceFocusId(nodeId),
    onNodeCreated: (nodeId) => selectNode(nodeId),
    layers: layers,
    onMoveToLayer: (nodeId, layerId) => {
      // Implementation handled by the existing moveToLayer function
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
    expandEdge: expandAggregatedEdge,
    collapseEdge: collapseAggregatedEdge,
    isExpanded: isAggregatedEdgeExpanded,
    granularity: lineageGranularity,
    setGranularity: setLineageGranularity,
    getEdgeCount,
    getEdgeTypes,
  } = useAggregatedLineage({ granularity: 'table' })

  // Instance-level assignments from store (user drag-and-drop)
  const instanceAssignments = useInstanceAssignments()
  const effectiveAssignments = useReferenceModelStore(s => s.effectiveAssignments)
  const computeAssignments = useReferenceModelStore(s => s.computeAssignments)
  const assignmentStatus = useReferenceModelStore(s => s.assignmentStatus)
  const setLayers = useReferenceModelStore(s => s.setLayers)
  const storeLayers = useReferenceModelStore(s => s.layers)

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
  useEffect(() => {
    // Only compute if:
    // 1. We have nodes
    // 2. We have a provider
    // 3. Layers are synced from view (store has layers)
    // 4. Status is idle (not already computing)
    // 5. We don't already have assignments OR layers have changed
    if (nodes.length > 0 && provider && storeLayers.length > 0) {
      if (assignmentStatus === 'idle') {
        // Check if we need to recompute (no assignments or layers changed)
        const hasAssignments = effectiveAssignments.size > 0
        const shouldCompute = !hasAssignments || 
          // Recompute if layers changed (entityAssignments might have changed)
          storeLayers.some(layer => 
            layer.entityAssignments && layer.entityAssignments.length > 0
          )
        
        if (shouldCompute) {
          computeAssignments(provider)
        }
      }
    }
  }, [nodes.length, provider, computeAssignments, assignmentStatus, storeLayers.length, effectiveAssignments.size])

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  
  // Entity creation state
  const [isCreatingEntity, setIsCreatingEntity] = useState(false)
  const [creationParentId, setCreationParentId] = useState<string | null>(null)
  const [creationLayerId, setCreationLayerId] = useState<string | null>(null)

  // Trace / Focus State
  const [traceFocusId, setTraceFocusId] = useState<string | null>(null)
  const [traceNodes, setTraceNodes] = useState<Set<string>>(new Set()) // Combined set for quick lookups
  const [traceUpstreamNodes, setTraceUpstreamNodes] = useState<Set<string>>(new Set())
  const [traceDownstreamNodes, setTraceDownstreamNodes] = useState<Set<string>>(new Set())
  const [showUpstream, setShowUpstream] = useState(true)
  const [showDownstream, setShowDownstream] = useState(true)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())


  // Edit Mode State (unified with LineageCanvas)
  const isEditing = useCanvasStore((s) => s.isEditing)
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
    
    // TRACE MODE: Toggle trace off if clicking the same node
    if (traceFocusId === nodeId) {
      setTraceFocusId(null)
      setTraceNodes(new Set())
      setTraceUpstreamNodes(new Set())
      setTraceDownstreamNodes(new Set())
      return
    }

    // Resolve URN from the clicked node
    // We assume nodes in store have data.urn. Fallback to ID if not found.
    const targetNode = nodes.find(n => n.id === nodeId)
    const targetUrn = (targetNode?.data?.urn as string) || nodeId

    // Optimistically highlight the clicked node (using ID)
    setTraceFocusId(nodeId)
    setTraceNodes(new Set([nodeId]))
    setTraceUpstreamNodes(new Set())
    setTraceDownstreamNodes(new Set())

    if (!provider) return

    try {
      // 1. Fetch Trace Data
      const result = await provider.getFullLineage(targetUrn, 3, 3)

      // 2. Resolve IDs (URN -> Existing Store ID or URN)
      // This maps backend URNs to whatever ID is currently in the store, 
      // preventing dupes and ensuring traceNodes matches UI IDs.
      const urnToId = new Map<string, string>()
      nodes.forEach(n => {
        if (n.data?.urn) urnToId.set(n.data.urn as string, n.id)
        // Also map ID acting as URN?
        urnToId.set(n.id, n.id)
      })

      const resolveId = (urn: string) => urnToId.get(urn) || urn

      // 3. Prepare New Nodes / Edges for Store
      const newNodes: any[] = []
      const newEdges: any[] = []

      // Nodes
      result.nodes.forEach(n => {
        const existingId = urnToId.get(n.urn)
        // Only add if we don't know this URN (or ID)
        if (!existingId) {
          newNodes.push({
            id: n.urn, // Use URN as ID for new nodes
            type: 'generic',
            position: { x: 0, y: 0 },
            data: {
              ...n.properties,
              label: n.displayName,
              type: n.entityType,
              urn: n.urn,
              childCount: n.childCount
            }
          })
          // Update local map for edges processing
          urnToId.set(n.urn, n.urn)
        }
      })

      // Edges
      const existingEdgeIds = new Set(edges.map(e => e.id))
      result.edges.forEach(e => {
        if (!existingEdgeIds.has(e.id)) {
          newEdges.push({
            id: e.id,
            source: resolveId(e.sourceUrn),
            target: resolveId(e.targetUrn),
            type: 'lineage',
            data: {
              relationship: e.edgeType,
              edgeType: e.edgeType,
              confidence: e.confidence
            }
          })
        }
      })

      // 4. Update Store
      if (newNodes.length > 0) addNodes(newNodes)
      if (newEdges.length > 0) addEdges(newEdges)

      // 5. Update Trace Highlight (using IDs)
      const visibleIds = new Set<string>()

      // Add the start node ID
      visibleIds.add(nodeId)

      // Add traced nodes (resolved to IDs)
      result.nodes.forEach(n => {
        const id = resolveId(n.urn)
        if (id) visibleIds.add(id)
      })

      // Add upstream/downstream URNs (resolved to IDs)
      const upstreamSet = new Set<string>()
      const downstreamSet = new Set<string>()

      result.upstreamUrns.forEach(u => {
        const id = resolveId(u)
        if (id) {
          visibleIds.add(id)
          upstreamSet.add(id)
        }
      })
      result.downstreamUrns.forEach(u => {
        const id = resolveId(u)
        if (id) {
          visibleIds.add(id)
          downstreamSet.add(id)
        }
      })

      setTraceNodes(visibleIds)
      setTraceUpstreamNodes(upstreamSet)
      setTraceDownstreamNodes(downstreamSet)
      setShowUpstream(true) // Reset visibility on new trace
      setShowDownstream(true)

      // 6. Style: Auto-expand ancestors of visible nodes
      const nodesToExpand = new Set(expandedNodes)

      const properParentMap = new Map<string, string>()
      const containmentEdges = edges.filter(e => {
        const type = normalizeEdgeType(e)
        return isContainmentEdge(type)
      })
      containmentEdges.forEach(e => properParentMap.set(e.target, e.source))

      visibleIds.forEach(id => {
        let curr = id
        while (properParentMap.has(curr)) {
          curr = properParentMap.get(curr)!
          nodesToExpand.add(curr)
        }
      })

      setExpandedNodes(nodesToExpand)

    } catch (err) {
      console.error("Failed to fetch trace", err)
      // Reset if failed?
      // setTraceFocusId(null)
    }
  }, [traceFocusId, provider, nodes, edges, addNodes, addEdges, expandedNodes])


  // Lineage flow toggle
  const [showLineageFlow, setShowLineageFlow] = useState(initialShowLineageFlow)
  
  // Ref to trigger edge redraw from child components
  const triggerEdgeRedrawRef = useRef<(() => void) | null>(null)
  
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
  }, [nodes, edges, containmentEdgeTypes])

  // Fetch aggregated edges when visible nodes change
  useEffect(() => {
    if (showLineageFlow && nodes.length > 0) {
      // Get top-level container URNs for aggregation
      const containerUrns = nodes
        .filter(n => !parentMap.has(n.id) || !expandedNodes.has(parentMap.get(n.id) || ''))
        .map(n => (n.data?.urn as string) || n.id)
        .filter(Boolean)
      
      if (containerUrns.length > 0 && containerUrns.length < 500) {
        fetchAggregated(containerUrns)
      }
    }
  }, [nodes.length, showLineageFlow, fetchAggregated, parentMap, expandedNodes])

  // Build layer assignment rules
  const layerRules = useMemo<LayerAssignmentRule[]>(() => {
    const generatedRules: LayerAssignmentRule[] = []

    sortedLayers.forEach(layer => {
      // 1. Explicit rules from config
      if (layer.rules) {
        layer.rules.forEach(rule => {
          generatedRules.push({
            id: rule.id,
            layerId: layer.id,
            entityTypes: (rule.entityTypes ?? []) as EntityType[],
            tags: rule.tags,
            urnPattern: rule.urnPattern,
            propertyMatch: rule.propertyMatch,
            priority: rule.priority
          })
        })
      }

      // 2. Default entity type rules - REMOVED to prevent implicit auto-assignment
      // If users want type-based assignment, they should add an explicit rule.
      /*
      layer.entityTypes.forEach((entityType, idx) => {
        generatedRules.push({
          id: `${layer.id}-${entityType}`,
          layerId: layer.id,
          entityTypes: [entityType as any],
          priority: layer.order * 10 + idx,
        })
      })
      */
    })

    return generatedRules
  }, [sortedLayers])

  // Core Logic: Group nodes by layer with Deep Inheritance support
  const nodesByLayer = useMemo(() => {
    const grouped = new Map<string, HierarchyNode[]>()

    // Initialize layers
    sortedLayers.forEach(l => grouped.set(l.id, []))

    // 1. Build explicit assignments from view layers (lowest priority, used as fallback)
    // These come from saved entityAssignments in the view configuration
    const explicitAssignments = new Map<string, string>() // nodeId -> layerId
    sortedLayers.forEach(l => {
      l.entityAssignments?.forEach(a => {
        explicitAssignments.set(a.entityId, l.id)
      })
    })

    // 2. Build rule-based assignments (fallback if no explicit assignment)
    const ruleAssignments = new Map<string, string>() // nodeId -> layerId
    nodes.forEach(node => {
      // Skip if already has explicit assignment from view
      if (explicitAssignments.has(node.id)) return

      // Rule match 
      const graphNode: GraphNode = {
        urn: node.data.urn || node.id,
        entityType: (node.data.type as EntityType) || 'dataset', // Generic fallback
        displayName: node.data.label || node.data.businessLabel || node.id,
        properties: node.data as Record<string, unknown>,
        tags: node.data.classifications || []
      }

      const ruleLayerId = resolveLayerAssignment(graphNode, layerRules)
      if (ruleLayerId) {
        ruleAssignments.set(node.id, ruleLayerId)
      }
    })

    // 2. Determine "Effective Layer" for every node, considering inheritance
    // We traverse top-down. If a node has explicit, it wins. If not, it inherits.
    const effectiveLayer = new Map<string, string>() // nodeId -> layerId

    // We can't just iterate nodes orderless. We need top-down.
    // Use a Set to track processed.
    const processed = new Set<string>()

    const calculateEffectiveLayer = (nodeId: string, inheritedLayerId?: string) => {
      // Allow revisiting if we are providing a layer assignment where there was none?
      // For simple containment tree, we visit once.
      if (processed.has(nodeId)) return
      processed.add(nodeId)

      // Priority order (highest to lowest):
      // 1. effectiveAssignments (from backend computation - source of truth)
      // 2. instanceAssignments (from store - user drag-and-drop)
      // 3. explicitAssignments (from view layers - saved assignments)
      // 4. ruleAssignments (from rules - pattern/tag/type matching)
      // 5. inheritance (from parent)

      let myLayerId: string | undefined

      // 1. Backend-computed effective assignment (highest priority)
      const backendAssignment = effectiveAssignments.get(nodeId)
      if (backendAssignment?.layerId) {
        myLayerId = backendAssignment.layerId
      }

      // 2. Instance assignment from store (user manual assignment)
      if (!myLayerId) {
        const instanceAssignment = instanceAssignments.get(nodeId)
        if (instanceAssignment) {
          myLayerId = instanceAssignment.layerId
        }
      }

      // 3. Explicit assignment from view layers (saved in view config)
      if (!myLayerId) {
        myLayerId = explicitAssignments.get(nodeId)
      }

      // 4. Rule-based assignment
      if (!myLayerId) {
        myLayerId = ruleAssignments.get(nodeId)
      }

      // 5. Inheritance from parent
      if (!myLayerId && inheritedLayerId) {
        myLayerId = inheritedLayerId
      }

      if (myLayerId === '__UNASSIGNED__') {
        myLayerId = undefined
      }

      if (myLayerId) {
        effectiveLayer.set(nodeId, myLayerId)
      }

      const children = childMap.get(nodeId) || []
      children.forEach(childId => calculateEffectiveLayer(childId, myLayerId))
    }

    // Find true roots (nodes with no parents) and start there
    const roots = nodes.filter(n => !parentMap.has(n.id))
    roots.forEach(r => calculateEffectiveLayer(r.id))

    // Also handle orphans (cycles or disconnected) if any missed?
    // The recursive step above should cover all reachable from roots. 
    // If there are unparented nodes that are not in `roots` (impossible by definition), they are covered.

    // 3. Construct Hierarchy Trees per Layer
    // A node is a "Visual Root" in Layer L if:
    // - It is effectively in Layer L
    // - AND (Its parent is NOT in Layer L OR it has no parent)

    // Helper to build hierarchy node
    const buildHierarchyNode = (nodeId: string, depth: number): HierarchyNode | null => {
      const node = nodeMap.get(nodeId)
      if (!node) return null

      const childrenIds = childMap.get(nodeId) || []
      // Filter children: Only include those that are effectively in the SAME layer
      const validChildren = childrenIds
        .filter(cid => effectiveLayer.get(cid) === effectiveLayer.get(nodeId))
        .map(cid => buildHierarchyNode(cid, depth + 1))
        .filter((n): n is HierarchyNode => n !== null)
        .sort((a, b) => a.name.localeCompare(b.name))

      return {
        id: node.id,
        typeId: node.data.type,
        name: node.data.label ?? node.data.businessLabel ?? node.id,
        data: node.data as Record<string, unknown>,
        children: validChildren,
        depth,
        urn: node.data.urn || node.id,
        entityTypeOption: (node.data.type as EntityType) || 'dataset',
        tags: node.data.classifications || []
      }
    }

    nodes.forEach(node => {
      const layerId = effectiveLayer.get(node.id)
      if (!layerId) return // Unassigned

      // Check if this is a Visual Root for this layer
      const parentId = parentMap.get(node.id)
      const parentLayerId = parentId ? effectiveLayer.get(parentId) : undefined

      if (layerId !== parentLayerId) {
        // It's a root in this layer context!
        const hNode = buildHierarchyNode(node.id, 0)
        if (hNode) {
          const list = grouped.get(layerId)
          if (list) list.push(hNode)
        }
      }
    })

    // Sort all lists
    grouped.forEach(list => list.sort((a, b) => a.name.localeCompare(b.name)))

    return grouped
  }, [nodes, edges, sortedLayers, layerRules, instanceAssignments, nodeMap, childMap, parentMap, effectiveAssignments])

  // Flatten logical/physical nodes for search and lookup
  const { displayFlat, displayMap } = useMemo(() => {
    const flat: HierarchyNode[] = []
    const map = new Map<string, HierarchyNode>()

    nodesByLayer.forEach((layerNodes) => {
      const traverse = (node: HierarchyNode) => {
        flat.push(node)
        map.set(node.id, node)
        node.children.forEach(traverse)
      }
      layerNodes.forEach(traverse)
    })

    return { displayFlat: flat, displayMap: map }
  }, [nodesByLayer])

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
  const { loadChildren } = useEntityLoader()

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



  // Style: Enhanced Trace Context
  // Compute the set of all "Contextual Nodes" for the active trace.
  // This includes:
  // 1. The traced nodes themselves (traceNodes)
  // 2. ALL ancestors of traced nodes (so containers stay lit)
  const traceContextSet = useMemo(() => {
    const set = new Set<string>()
    if (traceFocusId) set.add(traceFocusId)

    // Add ancestors for the focus node
    if (traceFocusId) {
      let curr = parentMap.get(traceFocusId)
      while (curr) {
        set.add(curr)
        curr = parentMap.get(curr)
      }
    }

    // Add traced nodes and their ancestors, filtered by direction
    traceNodes.forEach(id => {
      const isUpstream = traceUpstreamNodes.has(id)
      const isDownstream = traceDownstreamNodes.has(id)
      const isFocus = id === traceFocusId

      if (!isFocus && ((isUpstream && !showUpstream) || (isDownstream && !showDownstream))) {
        return // Skip if not focus and direction is hidden
      }

      set.add(id) // Add the node itself

      let curr = parentMap.get(id)
      while (curr) {
        set.add(curr)
        curr = parentMap.get(curr)
      }
    })

    return set
  }, [traceNodes, traceFocusId, parentMap, traceUpstreamNodes, traceDownstreamNodes, showUpstream, showDownstream])
  const lineageEdges = useMemo(() => {
    if (!showLineageFlow) return []
    // Filter out containment edges
    const regularEdges = edges.filter(edge => {
      return !isContainmentEdge(normalizeEdgeType(edge))
    })
    
    // Add aggregated edges from the hook
    const aggEdges = Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'collapsed')
      .map(e => ({
        id: e.aggregated.id,
        source: e.aggregated.sourceUrn,
        target: e.aggregated.targetUrn,
        data: {
          edgeType: 'AGGREGATED',
          relationship: 'aggregated',
          isAggregated: true,
          edgeCount: e.aggregated.edgeCount,
          edgeTypes: e.aggregated.edgeTypes,
          confidence: e.aggregated.confidence,
        }
      }))
    
    // Add expanded detailed edges
    const expandedDetailedEdges = Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'expanded')
      .flatMap(e => e.detailedEdges.map(de => ({
        id: de.id,
        source: de.sourceUrn,
        target: de.targetUrn,
        data: {
          edgeType: de.edgeType,
          relationship: de.edgeType,
          confidence: de.confidence,
        }
      })))
    
    return [...regularEdges, ...aggEdges, ...expandedDetailedEdges]
  }, [edges, showLineageFlow, aggregatedEdges, isContainmentEdge])

  // Lineage Roll-up: Project edges to visible ancestors
  const visibleLineageEdges = useMemo(() => {
    if (!showLineageFlow) return []

    // 1. Build Ancestor Map: Physical URN -> Visible Node ID
    const ancestorMap = new Map<string, string>()

    // Helper to traverse and map
    // currentVisibleAnchor: The ID of the node that 'node' should roll up to
    const processNode = (node: HierarchyNode, currentVisibleAnchor: string) => {
      // Map current node to the anchor
      if (node.urn) ancestorMap.set(node.urn, currentVisibleAnchor)
      ancestorMap.set(node.id, currentVisibleAnchor)

      // Determine anchor for children
      // Logic:
      // 1. If I am the current anchor (i.e. I am visible)
      // 2. AND I am expanded
      // -> My children become their own anchors (initially)
      // Else -> My children roll up to me (if I'm anchor) or whoever I rolled up to

      let childAnchor = currentVisibleAnchor

      // If I am the visible node, check if I allow my children to be seen
      if (node.id === currentVisibleAnchor) {
        if (expandedNodes.has(node.id)) {
          // I am expanded. Children are revealed. 
          // BUT we pass the child's ID as the NEW anchor in the recursion loop
          // Special flag to indicate "Use Child ID"
          childAnchor = 'USE_CHILD_ID'
        } else {
          // I am collapsed. Children roll up to me.
          childAnchor = node.id
        }
      }

      // Recurse
      if (node.children) {
        node.children.forEach(child => {
          const nextAnchor = childAnchor === 'USE_CHILD_ID' ? child.id : childAnchor
          processNode(child, nextAnchor)
        })
      }
    }

    // Process all layers
    nodesByLayer.forEach(roots => roots.forEach(root => {
      // Roots are always initially visible anchors
      processNode(root, root.id)
    }))

    // 1.5. Ensure all nodes in displayMap are at least mapped to themselves if visible
    // This is a safety catch for any nodes that might have been missed by the root traversal
    displayFlat.forEach(node => {
      if (!ancestorMap.has(node.id)) {
        ancestorMap.set(node.id, node.id)
      }
      if (node.urn && !ancestorMap.has(node.urn)) {
        ancestorMap.set(node.urn, node.id)
      }
    })

    // 2. Project Edges
    const projected: any[] = []

    // Group edges by their VISUAL source->target pair
    // This allows us to assign an index to each edge for parallel routing
    const edgeGroups = new Map<string, any[]>()

    lineageEdges.forEach(edge => {
      // Resolve source/target to effective visible nodes
      // If not in map, fallback to edge source (might be a node that isn't in hierarchy but is on canvas?)
      // Actually strictly rely on map for consistency logic
      const sourceId = ancestorMap.get(edge.source) || (displayMap.has(edge.source) ? edge.source : null)
      const targetId = ancestorMap.get(edge.target) || (displayMap.has(edge.target) ? edge.target : null)

      if (sourceId && targetId && sourceId !== targetId) {
        // Trace Filtering: If trace is active, ONLY show edges relevant to the trace
        if (traceFocusId) {
          // Check if this edge connects two nodes in the trace context?
          // Ideally, we want edges ON the trace path.
          // visibleLineageEdges projects edges. 
          // If the source/target are part of the 'traceNodes', show.
          // But 'traceNodes' are leaf nodes mostly. 
          // traceContextSet has ancestors.
          // Let's rely on 'traceNodes' for the strictest filtering (actual data flow),
          // OR check if source/target are in 'traceContextSet' AND the edge is part of the path?
          // Simpler: If source OR target is not in traceContextSet, hide it.
          // Even stricter: BOTH must be in traceContextSet?
          // Yes, let's try strictly showing flow between relevant nodes.

          if (!traceContextSet.has(sourceId) || !traceContextSet.has(targetId)) {
            return
          }
        }

        // Group edges
        // Key for grouping visual connections
        const groupKey = `${sourceId}->${targetId}`
        if (!edgeGroups.has(groupKey)) edgeGroups.set(groupKey, [])
        edgeGroups.get(groupKey)!.push({
          ...edge,
          source: sourceId,
          target: targetId,
          // Original edge type for distinction
          originalType: normalizeEdgeType(edge)
        })
      }
    })

    // Process groups to assign indices
    edgeGroups.forEach((groupEdges, key) => {
      // Deduplicate within group based on edge type
      const distinctTypes = new Map<string, any>()
      groupEdges.forEach(e => {
        const typeKey = e.originalType
        if (!distinctTypes.has(typeKey)) {
          distinctTypes.set(typeKey, e)
        }
      })

      const distinctEdges = Array.from(distinctTypes.values())
      const total = distinctEdges.length

      distinctEdges.forEach((edge, index) => {
        projected.push({
          ...edge,
          id: `proj-${key}-${edge.originalType}`,
          groupIndex: index,
          groupTotal: total
        })
      })
    })

    return projected
  }, [lineageEdges, nodesByLayer, expandedNodes, displayMap, showLineageFlow, traceFocusId, traceContextSet])

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
              <h2 className="text-base font-display font-semibold text-ink tracking-tight">Reference Model</h2>
              <p className="text-[10px] text-ink-muted/60 flex items-center gap-1.5">
                <LucideIcons.ArrowRight className="w-3 h-3" />
                Data Flow View
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
          {traceFocusId && (
            <TraceToolbar
              focusNodeName={displayMap.get(traceFocusId)?.name || 'Unknown Node'}
              upstreamCount={traceUpstreamNodes.size}
              downstreamCount={traceDownstreamNodes.size}
              showUpstream={showUpstream}
              showDownstream={showDownstream}
              onToggleUpstream={() => setShowUpstream(!showUpstream)}
              onToggleDownstream={() => setShowDownstream(!showDownstream)}
              onExitTrace={() => {
                setTraceFocusId(null)
                setTraceNodes(new Set())
                setTraceUpstreamNodes(new Set())
                setTraceDownstreamNodes(new Set())
                setExpandedNodes(new Set())
              }}
              config={{
                upstreamDepth: 5,
                downstreamDepth: 5,
                includeColumnLineage: true,
                autoExpandAncestors: true,
                pathOnly: false,
              }}
              onConfigChange={(newConfig) => {
                // Could re-trigger trace with new config
                console.log('Config changed:', newConfig)
              }}
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
            onTraceUp={(nodeId) => handleDoubleClick(nodeId)}
            onTraceDown={(nodeId) => handleDoubleClick(nodeId)}
            onFullTrace={(nodeId) => handleDoubleClick(nodeId)}
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
            onEntityCreated={(nodeId, parentUrn) => {
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
        <div className="flex-1 overflow-auto relative scroll-smooth">
          {/* Lineage Flow Overlay - Render BEFORE columns to be behind them (z-index managed in component to 0, cols should be higher) */}
          {showLineageFlow && (
            <LineageFlowOverlay
              nodes={displayFlat}
              edges={visibleLineageEdges}
              expandedNodes={expandedNodes}
              selectEdge={selectEdge}
              isEdgePanelOpen={isEdgePanelOpen}
              toggleEdgePanel={toggleEdgePanel}
              triggerRedrawRef={triggerEdgeRedrawRef}
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
                traceFocusId={traceFocusId}
                traceNodes={traceNodes}
                traceContextSet={traceContextSet}
                onAnimationComplete={handleAnimationComplete}
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
        onTraceNode={(id) => setTraceFocusId(id)}
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
        onCreateEntity={(typeId) => {
          interactions.closeCommandPalette()
          interactions.openQuickCreate({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
        }}
        onSelectEntity={(entityId) => selectNode(entityId)}
      />
    </div>
  )
}

// Helper for Lineage Roll-up
// This must be inside component to access state, or mapped outside.
// Use memo inside component.

// ... (Rest of file)

// ============================================
// FLAT TREE NODE ITEM - Single row in the flat tree
// ============================================

interface FlatTreeNode {
  node: HierarchyNode
  depth: number
  isLast: boolean
  parentIsLast: boolean[]  // Track which parents are "last" for proper tree lines
}

interface LayerColumnProps {
  layer: ViewLayerConfig
  nodes: HierarchyNode[]
  schema: ReturnType<typeof useSchemaStore.getState>['schema']
  selectedNodeId: string | null
  expandedNodes: Set<string>
  searchResults: string[]
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void
  onDoubleClick: (id: string, event?: React.MouseEvent) => void
  onAddChild?: (parentId: string) => void
  onAddToLayer?: (layerId: string) => void
  traceFocusId: string | null
  traceNodes: Set<string>
  traceContextSet: Set<string>
  onAnimationComplete?: () => void
  onFocusNode?: (nodeId: string | null) => void
  focusedNodeId?: string | null
}

function LayerColumn({
  layer,
  nodes,
  schema,
  selectedNodeId,
  expandedNodes,
  searchResults,
  onSelect,
  onToggle,
  onContextMenu,
  onDoubleClick,
  onAddChild,
  onAddToLayer,
  traceFocusId,
  traceNodes,
  traceContextSet,
  onAnimationComplete,
  onFocusNode,
  focusedNodeId
}: LayerColumnProps) {
  // Local focus state for drilling into subtrees
  const [localFocusId, setLocalFocusId] = useState<string | null>(null)
  const [breadcrumb, setBreadcrumb] = useState<HierarchyNode[]>([])
  const [isCollapsed, setIsCollapsed] = useState(false)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  
  // Build flat tree from hierarchy (visible items only)
  const flatTree = useMemo(() => {
    const result: FlatTreeNode[] = []
    
    // If focused on a specific node, only show that subtree
    const rootNodes = localFocusId 
      ? nodes.flatMap(function findNode(n: HierarchyNode): HierarchyNode[] {
          if (n.id === localFocusId) return [n]
          return n.children.flatMap(findNode)
        })
      : nodes
    
    const traverse = (
      node: HierarchyNode, 
      depth: number, 
      isLast: boolean,
      parentIsLast: boolean[]
    ) => {
      result.push({ node, depth, isLast, parentIsLast: [...parentIsLast] })
      
      // Only traverse children if expanded
      if (expandedNodes.has(node.id) && node.children.length > 0) {
        node.children.forEach((child, idx) => {
          traverse(
            child, 
            depth + 1, 
            idx === node.children.length - 1,
            [...parentIsLast, isLast]
          )
        })
      }
    }
    
    rootNodes.forEach((node, idx) => {
      traverse(node, 0, idx === rootNodes.length - 1, [])
    })
    
    return result
  }, [nodes, expandedNodes, localFocusId])
  
  // Count total including nested
  const totalCount = useMemo(() => {
    const count = (n: HierarchyNode): number => 
      1 + n.children.reduce((acc, c) => acc + count(c), 0)
    return nodes.reduce((acc, n) => acc + count(n), 0)
  }, [nodes])
  
  // Handle focus (zoom into subtree)
  const handleFocus = useCallback((node: HierarchyNode | null) => {
    if (!node) {
      setLocalFocusId(null)
      setBreadcrumb([])
      return
    }
    
    // Build breadcrumb trail
    const trail: HierarchyNode[] = []
    const findPath = (n: HierarchyNode, target: string, path: HierarchyNode[]): boolean => {
      if (n.id === target) {
        trail.push(...path, n)
        return true
      }
      for (const child of n.children) {
        if (findPath(child, target, [...path, n])) return true
      }
      return false
    }
    
    nodes.forEach(root => findPath(root, node.id, []))
    
    setLocalFocusId(node.id)
    setBreadcrumb(trail.slice(0, -1)) // Exclude current node from breadcrumb
    
    // Auto-expand the focused node
    if (!expandedNodes.has(node.id)) {
      onToggle(node.id)
    }
  }, [nodes, expandedNodes, onToggle])
  
  // Navigate breadcrumb
  const handleBreadcrumbClick = useCallback((node: HierarchyNode | null) => {
    if (!node) {
      handleFocus(null)
    } else {
      handleFocus(node)
    }
  }, [handleFocus])
  
  // Get total items at current level
  const visibleCount = flatTree.length
  
  return (
    <motion.div 
      className={cn(
        "flex flex-col bg-gradient-to-b from-canvas to-canvas-elevated/20 relative group/column transition-all duration-300",
        isCollapsed ? "min-w-[60px] max-w-[60px]" : "flex-1 min-w-[320px] max-w-[480px]"
      )}
      layout
    >
      {/* Subtle column separator line with gradient fade */}
      <div className="absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-glass-border/50 to-transparent" />
      
      {/* Layer Header - Glass morphism style */}
      <div
        className={cn(
          "flex-shrink-0 sticky top-0 z-10 backdrop-blur-xl border-b border-white/[0.08] dark:border-white/[0.05] cursor-pointer",
          isCollapsed ? "px-2 py-4" : "px-4 py-3"
        )}
        style={{ 
          background: `linear-gradient(135deg, ${layer.color}12 0%, ${layer.color}05 100%)`,
        }}
        onClick={() => isCollapsed && setIsCollapsed(false)}
      >
        <div className={cn(
          "flex items-center",
          isCollapsed ? "flex-col gap-3" : "gap-3"
        )}>
          {/* Collapse/Expand Toggle + Icon Container */}
          <div className="flex items-center gap-2">
            {!isCollapsed && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setIsCollapsed(true)
                }}
                className="p-1 rounded-lg hover:bg-white/[0.1] text-ink-muted hover:text-ink transition-all"
                title="Collapse layer"
              >
                <LucideIcons.PanelLeftClose className="w-4 h-4" />
              </button>
            )}
            <div
              className={cn(
                "rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm transition-all duration-300",
                isCollapsed ? "w-10 h-10" : "w-9 h-9 group-hover/column:scale-105 group-hover/column:shadow-md"
              )}
              style={{ 
                background: `linear-gradient(145deg, ${layer.color}25 0%, ${layer.color}15 100%)`,
                boxShadow: `0 2px 8px ${layer.color}20`
              }}
            >
              <DynamicIcon
                name={layer.icon ?? 'Layers'}
                className={cn(
                  "transition-transform duration-300",
                  isCollapsed ? "w-5 h-5" : "w-4 h-4 group-hover/column:scale-110"
                )}
                style={{ color: layer.color }}
              />
            </div>
          </div>
          
          {/* Collapsed state - vertical text */}
          {isCollapsed ? (
            <div className="flex flex-col items-center gap-2">
              <span 
                className="text-xs font-semibold writing-mode-vertical transform rotate-180"
                style={{ color: layer.color, writingMode: 'vertical-rl' }}
              >
                {layer.name}
              </span>
              <div 
                className="px-1.5 py-1 rounded-full text-[10px] font-semibold"
                style={{ backgroundColor: `${layer.color}20`, color: layer.color }}
              >
                {totalCount}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setIsCollapsed(false)
                }}
                className="p-1.5 rounded-lg hover:bg-white/[0.1] text-ink-muted hover:text-ink transition-all mt-2"
                title="Expand layer"
              >
                <LucideIcons.PanelLeftOpen className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <>
              <div className="flex-1 min-w-0">
                <h3 
                  className="text-sm font-semibold truncate tracking-tight"
                  style={{ color: layer.color }}
                >
                  {layer.name}
                </h3>
                {layer.description && (
                  <p className="text-[10px] text-ink-muted/70 truncate mt-0.5">{layer.description}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Entity count pill */}
                <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-white/[0.06] dark:bg-white/[0.04] backdrop-blur-sm border border-white/[0.08]">
                  <span className="text-[10px] font-semibold text-ink" style={{ color: layer.color }}>
                    {visibleCount}
                  </span>
                  <span className="text-[9px] text-ink-muted/60">/</span>
                  <span className="text-[10px] text-ink-muted/60">{totalCount}</span>
                </div>
                {onAddToLayer && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onAddToLayer(layer.id)
                    }}
                    className="p-1.5 rounded-lg bg-green-500/10 hover:bg-green-500/20 text-green-500 transition-all duration-200 hover:scale-110 active:scale-95"
                    title={`Add entity to ${layer.name}`}
                  >
                    <LucideIcons.Plus className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        
        {/* Breadcrumb Navigation - Modern pill style (hidden when collapsed) */}
        {!isCollapsed && (
          <AnimatePresence>
            {breadcrumb.length > 0 && (
              <motion.div 
                initial={{ opacity: 0, height: 0, marginTop: 0 }}
                animate={{ opacity: 1, height: 'auto', marginTop: 8 }}
                exit={{ opacity: 0, height: 0, marginTop: 0 }}
                className="flex items-center gap-1 overflow-x-auto no-scrollbar"
              >
                <button
                  onClick={() => handleBreadcrumbClick(null)}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-ink-muted hover:text-ink transition-all duration-200 flex-shrink-0"
                >
                  <LucideIcons.Home className="w-3 h-3" />
                  <span className="text-[10px] font-medium">Root</span>
                </button>
                {breadcrumb.map((node, idx) => (
                  <React.Fragment key={node.id}>
                    <LucideIcons.ChevronRight className="w-3 h-3 text-ink-muted/40 flex-shrink-0" />
                  <button
                    onClick={() => handleBreadcrumbClick(node)}
                    className="px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-ink-muted hover:text-ink transition-all duration-200 truncate max-w-[100px] flex-shrink-0 text-[10px] font-medium"
                    title={node.name}
                  >
                    {node.name}
                  </button>
                </React.Fragment>
              ))}
              <LucideIcons.ChevronRight className="w-3 h-3 text-ink-muted/40 flex-shrink-0" />
              <span 
                className="px-2 py-1 rounded-lg text-[10px] font-semibold truncate"
                style={{ backgroundColor: `${layer.color}20`, color: layer.color }}
              >
                Current
              </span>
            </motion.div>
          )}
          </AnimatePresence>
        )}
      </div>

      {/* Flat Tree Content - Hidden when collapsed */}
      {!isCollapsed && (
        <div 
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar relative"
        >
          {/* Subtle top fade for scroll indication */}
          <div className="absolute top-0 left-0 right-0 h-4 bg-gradient-to-b from-canvas/80 to-transparent pointer-events-none z-10" />
          
          {flatTree.length === 0 ? (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center justify-center py-16 px-4"
            >
              <div 
                className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                style={{ backgroundColor: `${layer.color}10` }}
              >
                <LucideIcons.FolderOpen 
                  className="w-8 h-8" 
                  style={{ color: `${layer.color}40` }}
                />
              </div>
              <p className="text-sm font-medium text-ink-muted/60">No entities yet</p>
              <p className="text-xs text-ink-muted/40 mt-1">Click + to add entities</p>
          </motion.div>
        ) : (
          <div className="py-2 px-1">
            {flatTree.map(({ node, depth, isLast, parentIsLast }, index) => (
              <FlatTreeItem
                key={node.id}
                node={node}
                depth={depth}
                isLast={isLast}
                parentIsLast={parentIsLast}
                layer={layer}
                schema={schema}
                isSelected={selectedNodeId === node.id}
                isExpanded={expandedNodes.has(node.id)}
                isSearchResult={searchResults.includes(node.id)}
                isTraceActive={traceFocusId !== null}
                isHighlighted={traceContextSet.has(node.id)}
                isFocusNode={traceFocusId === node.id}
                onSelect={onSelect}
                onToggle={onToggle}
                onContextMenu={onContextMenu}
                onDoubleClick={onDoubleClick}
                onAddChild={onAddChild}
                onFocus={handleFocus}
                animationDelay={index * 0.02}
              />
            ))}
          </div>
        )}
        
        {/* Bottom fade */}
        <div className="absolute bottom-0 left-0 right-0 h-4 bg-gradient-to-t from-canvas/80 to-transparent pointer-events-none z-10" />
      </div>
      )}
    </motion.div>
  )
}

// ============================================
// FLAT TREE ITEM - Individual row with tree lines
// ============================================

interface FlatTreeItemProps {
  node: HierarchyNode
  depth: number
  isLast: boolean
  parentIsLast: boolean[]
  layer: ViewLayerConfig
  schema: ReturnType<typeof useSchemaStore.getState>['schema']
  isSelected: boolean
  isExpanded: boolean
  isSearchResult: boolean
  isTraceActive: boolean
  isHighlighted: boolean
  isFocusNode: boolean
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void
  onDoubleClick: (id: string, event?: React.MouseEvent) => void
  onAddChild?: (parentId: string) => void
  onFocus: (node: HierarchyNode) => void
  animationDelay?: number
}

function FlatTreeItem({
  node,
  depth,
  isLast,
  parentIsLast,
  layer,
  schema,
  isSelected,
  isExpanded,
  isSearchResult,
  isTraceActive,
  isHighlighted,
  isFocusNode,
  onSelect,
  onToggle,
  onContextMenu,
  onDoubleClick,
  onAddChild,
  onFocus,
  animationDelay = 0
}: FlatTreeItemProps) {
  const itemRef = useRef<HTMLDivElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const entityType = schema?.entityTypes.find((et) => et.id === node.typeId)
  const visual = entityType?.visual
  const nodeColor = visual?.color ?? layer.color
  
  const childCount = (node.data.childCount as number) || (node.data._collapsedChildCount as number) || 0
  const hasChildren = node.children.length > 0 || childCount > 0
  const descendantCount = hasChildren && !isExpanded ? (childCount || node.children.length) : 0
  
  // IMPROVED SIZING - Keep items readable at ALL depths
  // Root items are slightly larger, but children remain very readable
  const isRoot = depth === 0
  const heightClass = isRoot ? 'min-h-[52px]' : 'min-h-[44px]'
  const paddingClass = isRoot ? 'py-3' : 'py-2.5'
  const textClass = isRoot ? 'text-sm' : 'text-[13px]'
  const iconSize = isRoot ? 'w-5 h-5' : 'w-4 h-4'
  const iconContainerSize = isRoot ? 'w-9 h-9' : 'w-7 h-7'
  
  // Calculate dimming
  const isDimmed = isTraceActive && !isHighlighted
  
  // Tree line indent - reduced to save horizontal space
  const indentWidth = depth * 16
  
  // Auto-scroll when this node becomes the focus of a trace
  useEffect(() => {
    if (isFocusNode && itemRef.current) {
      setTimeout(() => {
        itemRef.current?.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'center', 
          inline: 'nearest' 
        })
      }, 100)
    }
  }, [isFocusNode])
  
  return (
    <motion.div
      ref={itemRef}
      id={`layer-node-${node.id}`}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, delay: Math.min(animationDelay, 0.3) }}
      className={cn(
        "flex items-center gap-2 mx-1 rounded-xl cursor-pointer transition-all duration-200 group/item relative",
        heightClass,
        paddingClass,
        // Base hover state with gradient
        "hover:bg-gradient-to-r hover:from-white/[0.06] hover:to-transparent",
        // Selected state with accent glow
        isSelected && "bg-gradient-to-r from-accent-lineage/15 via-accent-lineage/10 to-transparent shadow-[inset_0_0_0_1px_rgba(var(--accent-lineage-rgb),0.3)]",
        // Search result highlight
        isSearchResult && !isSelected && "bg-gradient-to-r from-amber-500/15 to-transparent shadow-[inset_0_0_0_1px_rgba(245,158,11,0.3)]",
        // Focus node (trace target)
        isFocusNode && "ring-2 ring-accent-lineage/60 ring-offset-1 ring-offset-canvas shadow-lg shadow-accent-lineage/20",
        // Highlighted in trace
        isHighlighted && !isFocusNode && "bg-gradient-to-r from-accent-lineage/10 to-transparent",
        // Dimmed when not in trace path
        isDimmed && "opacity-30 blur-[0.3px]"
      )}
      style={{ 
        paddingLeft: 12 + indentWidth,
        // Subtle left border accent for root items
        ...(depth === 0 && {
          borderLeft: `3px solid ${nodeColor}40`,
        })
      }}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(node.id)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onDoubleClick(node.id, e)
      }}
      onContextMenu={(e) => onContextMenu(e, node.id)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Modern Tree Lines with gradient effect */}
      <div className="flex items-center absolute left-3" style={{ width: indentWidth }}>
        {parentIsLast.map((pIsLast, idx) => (
          <div key={idx} className="w-5 h-full flex justify-center">
            {!pIsLast && (
              <div className="w-px h-full bg-gradient-to-b from-white/[0.08] via-white/[0.12] to-white/[0.08]" />
            )}
          </div>
        ))}
        {depth > 0 && (
          <div className="w-5 h-full relative">
            {/* Vertical line with gradient */}
            <div className={cn(
              "absolute left-1/2 -translate-x-1/2 w-px",
              isLast ? "top-0 h-1/2" : "top-0 bottom-0"
            )} style={{ background: 'linear-gradient(to bottom, transparent, rgba(255,255,255,0.12), transparent)' }} />
            {/* Horizontal connector with dot */}
            <div className="absolute left-1/2 top-1/2 -translate-y-1/2 flex items-center">
              <div className="w-3 h-px bg-gradient-to-r from-white/[0.12] to-white/[0.06]" />
              <div 
                className="w-1.5 h-1.5 rounded-full -ml-0.5"
                style={{ backgroundColor: `${nodeColor}40` }}
              />
            </div>
          </div>
        )}
      </div>
      
      {/* Expand/Collapse Toggle - Modern circular button */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onToggle(node.id)
        }}
        className={cn(
          "flex-shrink-0 rounded-lg transition-all duration-200",
          hasChildren 
            ? "hover:bg-white/[0.1] hover:scale-110 active:scale-95" 
            : "opacity-0 pointer-events-none",
          isRoot ? "w-7 h-7" : "w-6 h-6"
        )}
      >
        {hasChildren && (
          <motion.div 
            animate={{ rotate: isExpanded ? 90 : 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="w-full h-full flex items-center justify-center"
          >
            <LucideIcons.ChevronRight 
              className={cn(
                "transition-colors",
                isHovered ? "text-ink" : "text-ink-muted/60",
                isRoot ? "w-4 h-4" : "w-4 h-4"
              )} 
            />
          </motion.div>
        )}
      </button>
      
      {/* Entity Icon - Glass morphism container */}
      <div
        className={cn(
          "rounded-xl flex items-center justify-center flex-shrink-0 transition-all duration-200 shadow-sm",
          iconContainerSize,
          isSelected && "scale-110 shadow-md",
          isHovered && "scale-105"
        )}
        style={{ 
          background: `linear-gradient(135deg, ${nodeColor}25 0%, ${nodeColor}10 100%)`,
          boxShadow: isSelected ? `0 4px 12px ${nodeColor}30` : `0 2px 4px ${nodeColor}15`
        }}
      >
        <DynamicIcon
          name={visual?.icon ?? 'Box'}
          className={cn(iconSize, "transition-transform duration-200")}
          style={{ color: nodeColor }}
        />
      </div>
      
      {/* Name - IMPROVED: Better visibility with tooltip */}
      <div className="flex-1 min-w-0 flex flex-col justify-center" title={node.name}>
        <span className={cn(
          "font-medium tracking-tight transition-colors duration-200",
          textClass,
          isHighlighted ? "text-accent-lineage" : isSelected ? "text-ink" : "text-ink/90",
          isHovered && !isSelected && "text-ink",
          // Allow text to wrap to 2 lines for better readability
          "line-clamp-2"
        )}>
          {node.name}
        </span>
        {/* Type badge - show for all items to help identify entity types */}
        <span className={cn(
          "text-[10px] text-ink-muted/60 truncate mt-0.5 flex items-center gap-1",
          isRoot && "text-[11px]"
        )}>
          <span 
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: nodeColor }}
          />
          {entityType?.name ?? node.typeId}
        </span>
      </div>
      
      {/* Badges - Descendant count */}
      <AnimatePresence>
        {descendantCount > 0 && (
          <motion.span 
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            className="text-[11px] px-2 py-1 rounded-lg bg-white/[0.06] border border-white/[0.08] text-ink-muted font-semibold tabular-nums flex-shrink-0"
          >
            +{descendantCount}
          </motion.span>
        )}
      </AnimatePresence>
      
      {/* Action buttons - Glass morphism style, appear on hover */}
      <motion.div 
        initial={false}
        animate={{ opacity: isHovered ? 1 : 0, x: isHovered ? 0 : 8 }}
        transition={{ duration: 0.15 }}
        className="flex items-center gap-1 flex-shrink-0"
      >
        {/* Focus/Drill button */}
        {hasChildren && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onFocus(node)
            }}
            className="p-1.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 hover:text-blue-300 transition-all duration-200 hover:scale-110 active:scale-95"
            title="Focus on this subtree"
          >
            <LucideIcons.Maximize2 className="w-3 h-3" />
          </button>
        )}
        
        {/* Add child button */}
        {entityType?.hierarchy?.canContain && entityType.hierarchy.canContain.length > 0 && onAddChild && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onAddChild(node.id)
            }}
            className="p-1.5 rounded-lg bg-green-500/10 hover:bg-green-500/20 text-green-400 hover:text-green-300 transition-all duration-200 hover:scale-110 active:scale-95"
            title="Add child entity"
          >
            <LucideIcons.Plus className="w-3 h-3" />
          </button>
        )}
      </motion.div>
      
      {/* Hover indicator line */}
      <motion.div
        className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full"
        style={{ backgroundColor: nodeColor }}
        initial={false}
        animate={{ 
          height: isSelected ? '70%' : isHovered ? '50%' : '0%',
          opacity: isSelected ? 1 : isHovered ? 0.6 : 0
        }}
        transition={{ duration: 0.2 }}
      />
    </motion.div>
  )
}

// LayerNodeCard replaced with FlatTreeItem above for better UX

// ----------------------------------------------------
// SVG Overlay Component
// ----------------------------------------------------

function LineageFlowOverlay({
  nodes,
  edges,
  expandedNodes,
  selectEdge,
  isEdgePanelOpen,
  toggleEdgePanel,
  triggerRedrawRef
}: {
  nodes: any[],
  edges: any[],
  expandedNodes: Set<string>,
  selectEdge: (id: string) => void,
  isEdgePanelOpen: boolean,
  toggleEdgePanel: () => void,
  triggerRedrawRef?: React.MutableRefObject<(() => void) | null>
}) {
  const [paths, setPaths] = useState<React.ReactNode[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const updateFlowRef = useRef<(() => void) | null>(null)
  const rafIdRef = useRef<number | null>(null)

  // Serialize expandedNodes Set to array for proper React dependency tracking
  const expandedNodesArray = useMemo(() => {
    return Array.from(expandedNodes).sort().join(',')
  }, [expandedNodes])

  // Debounced update function using requestAnimationFrame
  const scheduleUpdate = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
    }
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null
      if (updateFlowRef.current) {
        updateFlowRef.current()
      }
    })
  }, [])

  // Update paths function with optimizations
  const updateFlow = useCallback(() => {
    if (!containerRef.current) return

    const containerRect = containerRef.current.getBoundingClientRect()
    const newPaths: React.ReactNode[] = []

    // Batch DOM reads by collecting all elements first
    const elementCache = new Map<string, HTMLElement>()
    
    edges.forEach(edge => {
      const sourceId = `layer-node-${edge.source}`
      const targetId = `layer-node-${edge.target}`

      // Cache element lookups
      let sourceEl = elementCache.get(sourceId)
      if (!sourceEl) {
        sourceEl = document.getElementById(sourceId)
        if (sourceEl) elementCache.set(sourceId, sourceEl)
      }

      let targetEl = elementCache.get(targetId)
      if (!targetEl) {
        targetEl = document.getElementById(targetId)
        if (targetEl) elementCache.set(targetId, targetEl)
      }

      if (sourceEl && targetEl) {
        const sRect = sourceEl.getBoundingClientRect()
        const tRect = targetEl.getBoundingClientRect()

        // Relative coordinates
        // Offset sx/tx slightly from the card boundary to make arrowheads/terminals visible
        const sx = sRect.right - containerRect.left + 2
        const sy = sRect.top + sRect.height / 2 - containerRect.top

        // Target: point slightly before the card boundary
        let tx = tRect.left - containerRect.left - 4
        const ty = tRect.top + tRect.height / 2 - containerRect.top

        // Smart Routing Logic
        let d = ''
        const isSameColumn = Math.abs(sRect.left - tRect.left) < 50
        const isSelf = edge.source === edge.target

        // Multi-edge offsetting
        // If there are multiple edges (groupTotal > 1), we offset the control points vertically
        // or curve magnitude to separate them.
        const total = edge.groupTotal || 1
        const index = edge.groupIndex || 0

        // Vertical separation at the midpoint
        const verticalSpread = 30
        const vOffset = (index - (total - 1) / 2) * verticalSpread

        if (isSameColumn && !isSelf) {
          // "Bracket" routing: Right -> Right
          tx = tRect.right - containerRect.left

          const curveDist = 40 + (index * 10) // Push out further for outer lines
          const cp1x = sx + curveDist
          const cp1y = sy
          const cp2x = tx + curveDist
          const cp2y = ty

          d = `M ${sx} ${sy} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${tx} ${ty}`
        } else {
          // Standard Left-to-Right Bezier
          const dist = Math.abs(tx - sx)
          // Adjust curvature based on distance
          const curvature = Math.max(0.4, Math.min(0.8, dist / 500))

          const cp1x = sx + dist * curvature
          const cp2x = tx - dist * curvature

          // Apply vertical offset to control points to separate the bundle
          const cp1y = sy + vOffset
          const cp2y = ty + vOffset

          d = `M ${sx} ${sy} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${tx} ${ty}`
        }

        // Color based on edge type or just consistent?
        // Default blue-500 (#3b82f6). 
        // Could map edge.originalType to different colors.
        const color = edge.originalType === 'TRANSFORMS' ? '#3b82f6' :
          edge.originalType === 'CONSUMES' ? '#22c55e' :
            edge.originalType === 'PRODUCES' ? '#f59e0b' : '#3b82f6'

        newPaths.push(
          <g
            key={edge.id}
            className="pointer-events-auto cursor-pointer group"
            onClick={(e) => {
              e.stopPropagation()
              selectEdge(edge.id)
              if (!isEdgePanelOpen) toggleEdgePanel()
            }}
            style={{ color }}
          >
            {/* Invisible thicker path for easier hover */}
            <path d={d} fill="none" stroke="transparent" strokeWidth="15" />

            {/* Main Path */}
            <path
              d={d}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              markerEnd="url(#arrowhead)"
              className={cn(
                "transition-all duration-300 opacity-40 group-hover:opacity-100 group-hover:stroke-[2.5px]",
              )}
            />

            {/* Animated Flow Layer (particles) */}
            <path
              d={d}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeDasharray="1 12"
              strokeLinecap="round"
              className="animate-flow"
              style={{
                opacity: 0.6,
                animationDuration: `${1.5 + index * 0.2}s`,
                filter: 'url(#glow)'
              }}
            />

            {/* Terminals */}
            <circle cx={sx} cy={sy} r="2.5" fill="currentColor" className="opacity-40 group-hover:opacity-80" />

            <title>{edge.source} → {edge.target} ({edge.originalType})</title>
          </g>
        )
      }
    })
    setPaths(newPaths)
  }, [edges, selectEdge, isEdgePanelOpen, toggleEdgePanel])

  // Store updateFlow in ref for ResizeObserver access and expose to parent
  useEffect(() => {
    updateFlowRef.current = updateFlow
    if (triggerRedrawRef) {
      triggerRedrawRef.current = scheduleUpdate
    }
  }, [updateFlow, scheduleUpdate, triggerRedrawRef])

  // ResizeObserver to detect when node elements finish resizing/moving
  useEffect(() => {
    if (!containerRef.current) return

    const observer = new ResizeObserver(() => {
      // Debounce using requestAnimationFrame to avoid excessive calls
      scheduleUpdate()
    })

    // Observe all visible node elements
    nodes.forEach(node => {
      const el = document.getElementById(`layer-node-${node.id}`)
      if (el) {
        observer.observe(el)
      }
    })

    return () => {
      observer.disconnect()
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [nodes, expandedNodesArray, scheduleUpdate])

  // Listeners for window resize and scroll
  useEffect(() => {
    // Initial draw with longer timeout to account for animation duration
    const timer = setTimeout(() => {
      requestAnimationFrame(() => {
        updateFlow()
      })
    }, 400)

    // Resize
    const handleResize = () => scheduleUpdate()
    window.addEventListener('resize', handleResize)

    // Scroll
    const handleScroll = () => scheduleUpdate()
    window.addEventListener('scroll', handleScroll, true)

    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('scroll', handleScroll, true)
      clearTimeout(timer)
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [updateFlow, scheduleUpdate, expandedNodesArray])

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none z-20">
      <style>{`
          @keyframes dashDraw {
            from { stroke-dashoffset: 1000; }
            to { stroke-dashoffset: 0; }
          }
        `}</style>
      <svg className="w-full h-full overflow-visible">
        <defs>
          {/* arrowhead marker */}
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="7"
            refX="9"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill="currentColor" opacity="0.8" />
          </marker>

          {/* Glow filter */}
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>
        {paths}
      </svg>
    </div>
  )
}

export default ReferenceModelCanvas

