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
 * Single authoritative canvas — ContextViewCanvas.tsx deleted as dead code.
 * Store: referenceModelStore.ts (autoDirty + backend sync, no localStorage).
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { useInstanceAssignments, useReferenceModelStore } from '@/store/referenceModelStore'
import { useWorkspacesStore } from '@/store/workspaces'
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
import { useOntologyMetadata, normalizeEdgeType } from '@/services/ontologyService'
import { getEdgeTypeDefinition } from '@/utils/edgeTypeUtils'

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

interface ContextViewCanvasProps {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeEdgeFingerprint, sortedLayers, layerRules, instanceAssignments, nodeMap, childMap, parentMap, effectiveAssignments])

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

  // O(1) URN→ID lookup (replaces O(N) displayFlat.find() per edge)
  const urnToIdMap = useMemo(() => {
    const map = new Map<string, string>()
    displayFlat.forEach(node => {
      if (node.urn) map.set(node.urn, node.id)
    })
    return map
  }, [displayFlat])

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
  const { loadChildren, searchChildren, isLoading: isLoadingChildren } = useEntityLoader()

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
  const lineageEdges = useMemo(() => {
    // When tracing, always compute edges even if flow toggle is off (Trace overrides)
    if (!showLineageFlow && !trace.isTracing) return []

    // 1. Aggregated Edges (Always show if Flow is ON)
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

    // 2. Expanded Detailed Edges (User explicitly expanded an edge)
    const expandedDetailedEdges = Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'expanded')
      .flatMap(e => e.detailedEdges
        // Filter out containment edges from detailed view to avoid "sneaky" structural edges
        .filter(de => !isContainmentEdge(de.edgeType))
        .map(de => ({
          id: de.id,
          source: de.sourceUrn,
          target: de.targetUrn,
          data: {
            edgeType: de.edgeType,
            relationship: de.edgeType,
            confidence: de.confidence,
          }
        })))

    // 3. Trace / Regular Edges (ONLY when Tracing is Active)
    // "Sneaky" edges fix: Don't show raw granular edges in the high-level view 
    // unless we are specifically in a granular trace mode.
    let regularEdges: any[] = []
    if (trace.isTracing) {
      regularEdges = edges.filter(edge => {
        return !isContainmentEdge(normalizeEdgeType(edge))
      })
    }

    return [...aggEdges, ...expandedDetailedEdges, ...regularEdges]
  }, [edges, showLineageFlow, trace.isTracing, aggregatedEdges, isContainmentEdge])

  // Lineage Roll-up: Project edges to visible ancestors
  const visibleLineageEdges = useMemo(() => {
    if (!showLineageFlow && !trace.isTracing) return []

    // 1. Build Ancestor Map: Physical URN -> Visible Node ID
    // ONLY needed for granular edges (Trace) or if we have non-aggregated edges mixed in.
    const ancestorMap = new Map<string, string>()

    // We only need to build this map if we have Regular (non-aggregated) edges to project
    // OR if we want to validte aggregated edges against visible nodes (safety)

    // Helper to traverse and map
    const processNode = (node: HierarchyNode, currentVisibleAnchor: string) => {
      // Map current node to the anchor
      if (node.urn) ancestorMap.set(node.urn, currentVisibleAnchor)
      ancestorMap.set(node.id, currentVisibleAnchor)

      let childAnchor = currentVisibleAnchor

      // If I am the visible node, check if I allow my children to be seen
      if (node.id === currentVisibleAnchor) {
        if (expandedNodes.has(node.id)) {
          childAnchor = 'USE_CHILD_ID' // Special flag
        } else {
          childAnchor = node.id
        }
      }

      if (node.children) {
        node.children.forEach(child => {
          const nextAnchor = childAnchor === 'USE_CHILD_ID' ? child.id : childAnchor
          processNode(child, nextAnchor)
        })
      }
    }

    // Always build map for consistency and to handle Trace edges
    nodesByLayer.forEach(roots => roots.forEach(root => {
      processNode(root, root.id)
    }))

    // Ensure all visible nodes map to themselves
    displayFlat.forEach(node => {
      if (!ancestorMap.has(node.id)) ancestorMap.set(node.id, node.id)
      if (node.urn && !ancestorMap.has(node.urn)) ancestorMap.set(node.urn, node.id)
    })

    // 2. Project Edges
    const projected: any[] = []
    const edgeGroups = new Map<string, any[]>()

    // Helper to add edge to group
    const addEdgeToGroup = (sourceId: string, targetId: string, edge: any, type: string) => {
      const groupKey = `${sourceId}->${targetId}`
      if (!edgeGroups.has(groupKey)) edgeGroups.set(groupKey, [])
      edgeGroups.get(groupKey)!.push({
        ...edge,
        source: sourceId,
        target: targetId,
        originalType: type
      })
    }

    // Process Edges
    // A. Aggregated Edges (Optimization: Skip lookup if possible, or fast lookup)
    const aggEdgesRaw = Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'collapsed')

    aggEdgesRaw.forEach(e => {
      const agg = e.aggregated
      // For Aggregated Edges, the backend guarantees they match the requested visible URNs.
      // However, we verify they map to valid visible nodes to avoid dangling edges.
      // Usually sourceUrn == visibleNodeId (or URN).

      // Fast check: Is the source/target directly in displayMap (visible)?
      let sId = displayMap.has(agg.sourceUrn) ? agg.sourceUrn : ancestorMap.get(agg.sourceUrn)
      let tId = displayMap.has(agg.targetUrn) ? agg.targetUrn : ancestorMap.get(agg.targetUrn)

      // Fallback for ID vs URN mismatch if map keys differ
      if (!sId) sId = urnToIdMap.get(agg.sourceUrn)
      if (!tId) tId = urnToIdMap.get(agg.targetUrn)

      if (sId && tId && sId !== tId) {
        // Create flow edge directly
        addEdgeToGroup(sId, tId, {
          id: agg.id,
          data: {
            edgeType: 'AGGREGATED',
            relationship: 'aggregated',
            isAggregated: true,
            edgeCount: agg.edgeCount,
            edgeTypes: agg.edgeTypes,
            confidence: agg.confidence,
            sourceEdgeIds: agg.sourceEdgeIds
          }
        }, 'AGGREGATED')
      }
    })

    // B. Regular / Trace Edges
    // These require full ancestor projection
    const regularEdges = edges.filter(edge => !isContainmentEdge(normalizeEdgeType(edge)))

    regularEdges.forEach(edge => {
      const sId = ancestorMap.get(edge.source) || (displayMap.has(edge.source) ? edge.source : null)
      const tId = ancestorMap.get(edge.target) || (displayMap.has(edge.target) ? edge.target : null)

      if (sId && tId && sId !== tId) {
        if (trace.isTracing) {
          if (!traceContextSet.has(sId) || !traceContextSet.has(tId)) return
        }

        addEdgeToGroup(sId, tId, {
          ...edge,
          data: edge.data || {}
        }, normalizeEdgeType(edge))
      }
    })

    // C. Expanded Detailed Edges from Aggregation
    Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'expanded')
      .flatMap(e => e.detailedEdges)
      .forEach(edge => {
        // These are real edges, need projection just in case, though they likely connect visible children
        const sId = ancestorMap.get(edge.sourceUrn)
        const tId = ancestorMap.get(edge.targetUrn)
        if (sId && tId && sId !== tId) {
          addEdgeToGroup(sId, tId, {
            id: edge.id,
            data: {
              edgeType: edge.edgeType,
              relationship: edge.edgeType,
              confidence: edge.confidence
            }
          }, edge.edgeType)
        }
      })

    // Finalize Groups (Semantic Edge Bundling & Ghost Edges)
    edgeGroups.forEach((groupEdges, key) => {
      const distinctTypes = new Set<string>()
      let isGhost = false
      let isAggregated = false
      let totalConfidence = 0
      let maxConfidence = 0

      const sourceId = groupEdges[0].source
      const targetId = groupEdges[0].target

      // We consider it a "Ghost" edge only if the projected container is collapsed OR has unloaded paginated items.
      // For now, let's keep all aggregated/bundled edges fully vibrant and just use dash styling
      // to imply that they are abstracted (source !== originalSource).
      if (groupEdges.some((e: any) => e.target !== e.originalTargetId || e.source !== e.originalSourceId)) {
        isGhost = true
      }

      groupEdges.forEach(e => {
        if (e.data?.isAggregated) isAggregated = true
        if (e.data?.edgeTypes) {
          e.data.edgeTypes.forEach((et: string) => distinctTypes.add(et))
        } else if (e.originalType) {
          distinctTypes.add(e.originalType)
        }

        const conf = e.data?.confidence ?? 1
        totalConfidence += conf
        maxConfidence = Math.max(maxConfidence, conf)
      })

      const edgeCount = groupEdges.length
      const avgConfidence = edgeCount > 0 ? totalConfidence / edgeCount : 1
      const typesArray = Array.from(distinctTypes)

      projected.push({
        id: `bundle-${key}`,
        source: sourceId,
        target: targetId,
        isBundled: edgeCount > 1,
        isGhost,
        edgeCount,
        types: typesArray,
        confidence: maxConfidence,
        // Let the renderer know if it should use aggregated styles
        isAggregated,
        data: { edgeTypes: typesArray, confidence: maxConfidence, edgeCount }
      })
    })

    return projected
  }, [lineageEdges, edges, aggregatedEdges, nodesByLayer, expandedNodes, displayFlat, displayMap, urnToIdMap, showLineageFlow, trace.isTracing, traceContextSet])

  // Click-to-highlight: compute connected nodes/edges for selected node (client-side only, no backend call)
  const highlightState = useMemo(() => {
    if (trace.isTracing || !selectedNodeId) {
      return { nodes: new Set<string>(), edges: new Set<string>() }
    }
    const connectedNodes = new Set<string>([selectedNodeId])
    const connectedEdges = new Set<string>()
    const selectedUrn = displayMap.get(selectedNodeId)?.urn

    visibleLineageEdges.forEach((edge: any) => {
      const matches = edge.source === selectedNodeId || edge.target === selectedNodeId ||
        (selectedUrn && (edge.source === selectedUrn || edge.target === selectedUrn))
      if (matches) {
        connectedEdges.add(edge.id)
        connectedNodes.add(edge.source)
        connectedNodes.add(edge.target)
      }
    })
    return { nodes: connectedNodes, edges: connectedEdges }
  }, [selectedNodeId, visibleLineageEdges, trace.isTracing, displayMap])

  const isHighlightActive = highlightState.edges.size > 0
  const clearSelection = useCanvasStore((s) => s.clearSelection)

  // Background click handler to clear selection/highlight
  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    // Only clear if clicking directly on the background container, not a child
    if (e.target === e.currentTarget) {
      clearSelection()
    }
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
  isLoadMore?: boolean
  loadMoreCount?: number
  isSearchBox?: boolean
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
  highlightedNodes?: Set<string>
  isHighlightActive?: boolean
  onAnimationComplete?: () => void
  onLoadMore?: (parentId: string) => void
  onSearchChildren?: (parentId: string, query: string) => void
  isLoadingChildren?: boolean
  onScroll?: () => void
}

const LayerColumn = React.memo(function LayerColumn({
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
  highlightedNodes,
  isHighlightActive = false,
  onLoadMore,
  onSearchChildren,
  isLoadingChildren,
  onScroll
}: LayerColumnProps) {
  // Local focus state for drilling into subtrees
  const [localFocusId, setLocalFocusId] = useState<string | null>(null)
  const [breadcrumb, setBreadcrumb] = useState<HierarchyNode[]>([])
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [childSearchQueries, setChildSearchQueries] = useState<Record<string, string>>({})
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
      if (expandedNodes.has(node.id) && (node.children.length > 0 || (node.data.childCount as number || 0) > 0)) {
        const childCount = (node.data.childCount as number) || (node.data._collapsedChildCount as number) || node.children.length

        // Push the inline search box item
        result.push({
          node,
          depth: depth + 1,
          isLast: node.children.length === 0,
          parentIsLast: [...parentIsLast, isLast],
          isSearchBox: true
        })

        // Filter children if there's an active query for this node
        let displayChildren = node.children
        const activeQuery = childSearchQueries[node.id]?.trim().toLowerCase()
        if (activeQuery) {
          displayChildren = displayChildren.filter(c =>
            c.name.toLowerCase().includes(activeQuery) ||
            c.id.toLowerCase().includes(activeQuery)
          )
        }

        const hasMore = node.children.length < childCount && !activeQuery // Disable load more if actively searching

        displayChildren.forEach((child, idx) => {
          traverse(
            child,
            depth + 1,
            idx === displayChildren.length - 1 && !hasMore,
            [...parentIsLast, isLast]
          )
        })

        if (hasMore) {
          result.push({
            node,
            depth: depth + 1,
            isLast: true,
            parentIsLast: [...parentIsLast, isLast],
            isLoadMore: true,
            loadMoreCount: childCount - node.children.length
          })
        }
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
                initial={{ opacity: 0, height: 0, marginTop: 8 }}
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
          onScroll={onScroll}
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
              {flatTree.map((item, index) => {
                if (item.isSearchBox) {
                  return (
                    <SearchBoxItem
                      key={`search-${item.node.id}`}
                      parentId={item.node.id}
                      depth={item.depth}
                      parentIsLast={item.parentIsLast}
                      value={childSearchQueries[item.node.id] || ''}
                      onChange={(val) => {
                        setChildSearchQueries(prev => ({ ...prev, [item.node.id]: val }))
                        if (val.trim()) {
                          // Allow 300ms debounce visually by immediately showing it's ready, actual fetch is done, but UI will reflect
                          onSearchChildren && onSearchChildren(item.node.id, val)
                        } else {
                          // If search is cleared, refetch the original children
                          onLoadMore && onLoadMore(item.node.id)
                        }
                      }}
                      isLoading={isLoadingChildren}
                      layer={layer}
                    />
                  )
                }

                if (item.isLoadMore) {
                  return (
                    <LoadMoreItem
                      key={`load-more-${item.node.id}`}
                      parentId={item.node.id}
                      depth={item.depth}
                      parentIsLast={item.parentIsLast}
                      count={item.loadMoreCount!}
                      onLoadMore={() => onLoadMore && onLoadMore(item.node.id)}
                      layer={layer}
                    />
                  )
                }

                const { node, depth, isLast, parentIsLast } = item
                return (
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
                    isClickHighlighted={isHighlightActive && (highlightedNodes?.has(node.id) ?? false)}
                    isDimmedByHighlight={isHighlightActive && !(highlightedNodes?.has(node.id) ?? false)}
                    onSelect={onSelect}
                    onToggle={onToggle}
                    onContextMenu={onContextMenu}
                    onDoubleClick={onDoubleClick}
                    onAddChild={onAddChild}
                    onFocus={handleFocus}
                    animationDelay={index * 0.02}
                  />
                )
              })}
            </div>
          )}

          {/* Bottom fade */}
          <div className="absolute bottom-0 left-0 right-0 h-4 bg-gradient-to-t from-canvas/80 to-transparent pointer-events-none z-10" />
        </div>
      )}
    </motion.div>
  )
})

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
  isClickHighlighted?: boolean
  isDimmedByHighlight?: boolean
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void
  onDoubleClick: (id: string, event?: React.MouseEvent) => void
  onAddChild?: (parentId: string) => void
  onFocus: (node: HierarchyNode) => void
  animationDelay?: number
}

const FlatTreeItem = React.memo(function FlatTreeItem({
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
  isClickHighlighted = false,
  isDimmedByHighlight = false,
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

  // Calculate dimming — trace takes priority over click-highlight
  const isDimmed = (isTraceActive && !isHighlighted) || isDimmedByHighlight

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
        // Click-highlight: subtle glow on connected nodes
        isClickHighlighted && !isSelected && "ring-1 ring-blue-400/40 bg-gradient-to-r from-blue-500/10 to-transparent",
        // Dimmed when not in trace path or not connected to highlighted node
        isDimmed && "opacity-40"
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
})

// ----------------------------------------------------
// LOAD MORE ITEM (Pagination within Flat Tree)
// ----------------------------------------------------

function LoadMoreItem({
  parentId,
  depth,
  parentIsLast,
  count,
  onLoadMore,
  layer
}: {
  parentId: string
  depth: number
  parentIsLast: boolean[]
  count: number
  onLoadMore: () => void
  layer: ViewLayerConfig
}) {
  const [isHovered, setIsHovered] = useState(false)
  const indentWidth = depth * 16

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex items-center gap-2 mx-1 rounded-xl cursor-pointer transition-all duration-200 group/item relative min-h-[36px] py-1.5"
      style={{ paddingLeft: 12 + indentWidth }}
    >
      <div className="flex items-center absolute left-3 pointer-events-none" style={{ width: indentWidth }}>
        {parentIsLast.map((pIsLast, idx) => (
          <div key={idx} className="w-5 h-full flex justify-center">
            {!pIsLast && (
              <div className="w-px h-full bg-gradient-to-b from-white/[0.08] via-white/[0.12] to-white/[0.08]" />
            )}
          </div>
        ))}
        {depth > 0 && (
          <div className="w-5 h-full relative">
            <div className="absolute left-1/2 -translate-x-1/2 w-px top-0 h-1/2" style={{ background: 'linear-gradient(to bottom, transparent, rgba(255,255,255,0.12), transparent)' }} />
            <div className="absolute left-1/2 top-1/2 -translate-y-1/2 flex items-center">
              <div className="w-3 h-px bg-gradient-to-r from-white/[0.12] to-white/[0.06]" />
            </div>
          </div>
        )}
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation()
          onLoadMore()
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className={cn(
          "flex flex-1 items-center justify-center gap-2 py-1.5 rounded-lg border text-[11px] font-medium transition-all duration-200",
          "bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.06] hover:border-white/[0.15] text-ink-muted hover:text-ink/90 active:scale-[0.98]"
        )}
      >
        <span className="flex items-center justify-center w-5 h-5 rounded-full bg-white/[0.05]">
          <LucideIcons.Plus className={cn("w-3.5 h-3.5 transition-transform", isHovered ? "scale-125 text-blue-400" : "text-ink-muted/70")} />
        </span>
        <span className="tracking-wide">Load {Math.min(20, count)} more nodes ({count} remaining)</span>
      </button>
    </motion.div>
  )
}

// ----------------------------------------------------
// SEARCH BOX ITEM (Inline search for children)
// ----------------------------------------------------

function SearchBoxItem({
  parentId,
  depth,
  parentIsLast,
  value,
  onChange,
  isLoading,
  layer
}: {
  parentId: string
  depth: number
  parentIsLast: boolean[]
  value: string
  onChange: (val: string) => void
  isLoading?: boolean
  layer: ViewLayerConfig
}) {
  const [isFocused, setIsFocused] = useState(false)
  const indentWidth = depth * 16

  // Using a local state for input to not jump cursors
  const [localValue, setLocalValue] = useState(value)

  useEffect(() => {
    setLocalValue(value)
  }, [value])

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex items-center gap-2 mx-1 rounded-xl transition-all duration-200 group/item relative min-h-[36px] py-1.5"
      style={{ paddingLeft: 12 + indentWidth }}
    >
      <div className="flex items-center absolute left-3 pointer-events-none" style={{ width: indentWidth }}>
        {parentIsLast.map((pIsLast, idx) => (
          <div key={idx} className="w-5 h-full flex justify-center">
            {!pIsLast && (
              <div className="w-px h-full bg-gradient-to-b from-white/[0.08] via-white/[0.12] to-white/[0.08]" />
            )}
          </div>
        ))}
        {depth > 0 && (
          <div className="w-5 h-full relative">
            <div className="absolute left-1/2 -translate-x-1/2 w-px top-0 h-full" style={{ background: 'linear-gradient(to bottom, transparent, rgba(255,255,255,0.12), transparent)' }} />
            <div className="absolute left-1/2 top-1/2 -translate-y-1/2 flex items-center">
              <div className="w-3 h-px bg-gradient-to-r from-white/[0.12] to-white/[0.06]" />
            </div>
          </div>
        )}
      </div>

      <div
        className={cn(
          "flex flex-1 items-center gap-2.5 px-3 py-2 mx-1 rounded-xl border text-xs font-medium transition-all duration-300 shadow-sm relative group/searchbox overflow-hidden",
          isFocused
            ? "bg-canvas-elevated/90 backdrop-blur-xl border-transparent shadow-xl translate-y-[0px]"
            : "bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04] hover:border-white/[0.12] hover:shadow-md"
        )}
        style={isFocused ? {
          boxShadow: `0 8px 24px -4px ${layer.color}25, inset 0 0 0 1.5px ${layer.color}50`
        } : {}}
      >
        {/* Subtle focus glow background */}
        <div
          className={cn(
            "absolute inset-0 transition-opacity duration-500 pointer-events-none",
            isFocused ? "opacity-100" : "opacity-0"
          )}
          style={{ background: `radial-gradient(ellipse at center, ${layer.color}15 0%, transparent 70%)` }}
        />

        <LucideIcons.Search
          className={cn("w-4 h-4 transition-all duration-300 relative z-10", isFocused ? "scale-110" : "text-ink-muted/50")}
          style={isFocused ? { color: layer.color } : {}}
        />

        <input
          type="text"
          value={localValue}
          onChange={(e) => {
            setLocalValue(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onChange(localValue)
            }
          }}
          onBlur={() => {
            setIsFocused(false)
            if (localValue !== value) onChange(localValue)
          }}
          onFocus={() => setIsFocused(true)}
          placeholder={`Search ${parentId ? 'node' : 'children'}...`}
          className="flex-1 bg-transparent border-none outline-none text-ink placeholder-ink-muted/40 relative z-10 transition-all duration-300 min-w-0"
        />

        <div className="flex items-center gap-1.5 relative z-10 flex-shrink-0">
          {isLoading ? (
            <div className="flex items-center justify-center w-5 h-5 rounded-md bg-white/[0.05]">
              <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: layer.color }} />
            </div>
          ) : (
            <AnimatePresence>
              {isFocused && !localValue && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase text-ink-muted/50 bg-white/[0.05] border border-white/[0.05]"
                >
                  Enter
                </motion.div>
              )}
            </AnimatePresence>
          )}

          <AnimatePresence>
            {localValue && !isLoading && (
              <motion.button
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                onClick={(e) => {
                  e.stopPropagation()
                  setLocalValue('')
                  onChange('')
                }}
                className="flex items-center justify-center w-5 h-5 rounded-md hover:bg-white/[0.1] text-ink-muted/60 hover:text-ink transition-colors bg-white/[0.03]"
              >
                <LucideIcons.X className="w-3 h-3" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  )
}

// ----------------------------------------------------
// SVG Overlay Component
// ----------------------------------------------------

// Global visibility tracker for extreme performance on 10k+ nodes
const globalVisibleNodes = new Set<string>()
let globalNodeObserver: IntersectionObserver | null = null

function getSharedNodeObserver(triggerRedraw: () => void) {
  if (typeof window === 'undefined') return null
  if (!globalNodeObserver) {
    globalNodeObserver = new IntersectionObserver((entries) => {
      let changed = false
      entries.forEach(entry => {
        const id = entry.target.id
        if (!id) return
        if (entry.isIntersecting) {
          if (!globalVisibleNodes.has(id)) {
            globalVisibleNodes.add(id)
            changed = true
          }
        } else {
          if (globalVisibleNodes.has(id)) {
            globalVisibleNodes.delete(id)
            changed = true
          }
        }
      })
      if (changed) {
        // Schedule redraw if visibility changes
        triggerRedraw()
      }
    }, {
      root: null, // observe relative to viewport
      rootMargin: '100px', // start rendering slightly before it enters screen
      threshold: 0
    })
  }
  return globalNodeObserver
}

type ComputedEdge = {
  id: string
  source: string
  target: string
  minY: number
  maxY: number
  pathD: string
  color: string
  dynamicStrokeWidth: number
  edgeOpacity: number
  isGhost: boolean
  isBundled: boolean
  edgeCount: number
  sx: number
  sy: number
  tx: number
  ty: number
}

function LineageFlowOverlay({
  nodes,
  edges,
  expandedNodes,
  selectEdge,
  isEdgePanelOpen,
  toggleEdgePanel,
  triggerRedrawRef,
  isTracing = false,
  traceResult = null,
  highlightedEdges,
  isHighlightActive = false,
  resolveEdgeColor,
}: {
  nodes: any[],
  edges: any[],
  expandedNodes: Set<string>,
  selectEdge: (id: string) => void,
  isEdgePanelOpen: boolean,
  toggleEdgePanel: () => void,
  triggerRedrawRef?: React.MutableRefObject<(() => void) | null>
  isTracing?: boolean,
  traceResult?: any | null,
  highlightedEdges?: Set<string>,
  isHighlightActive?: boolean,
  resolveEdgeColor?: (edgeType: string) => string,
}) {
  // Store computed abstract edges instead of direct React nodes for virtualization
  const [computedEdges, setComputedEdges] = useState<ComputedEdge[]>([])

  // Viewport tracking for virtualization
  const [viewport, setViewport] = useState({ scrollTop: 0, clientHeight: typeof window !== 'undefined' ? window.innerHeight : 1000 })
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollParentRef = useRef<HTMLElement | null>(null)
  const updateFlowRef = useRef<(() => void) | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)

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
    // Find scroll parent once
    if (!scrollParentRef.current) {
      scrollParentRef.current = containerRef.current.closest('.overflow-y-auto') as HTMLElement
      if (scrollParentRef.current) {
        setViewport({
          scrollTop: scrollParentRef.current.scrollTop,
          clientHeight: scrollParentRef.current.clientHeight
        })
      } else {
        setViewport({
          scrollTop: 0,
          clientHeight: containerRect.height || window.innerHeight
        })
      }
    }

    const newComputedEdges: ComputedEdge[] = []

    // Batch DOM reads by collecting all elements first
    const elementCache = new Map<string, HTMLElement>()

    // ONLY compute paths for edges where BOTH nodes are strictly visible on screen!
    // This fully prevents the tornado of 10,000 edges pointing to clipped items, unlocking ultra fast 60fps scrolling.
    const activeEdges = edges.filter(edge => {
      const sourceId = `layer-node-${edge.source}`
      const targetId = `layer-node-${edge.target}`

      return globalVisibleNodes.has(sourceId) && globalVisibleNodes.has(targetId)
    })

    activeEdges.forEach(edge => {
      const sourceId = `layer-node-${edge.source}`
      const targetId = `layer-node-${edge.target}`

      // Cache element lookups
      let sourceEl: HTMLElement | null = elementCache.get(sourceId) || null
      if (!sourceEl) {
        sourceEl = document.getElementById(sourceId)
        if (sourceEl) elementCache.set(sourceId, sourceEl)
      }

      let targetEl: HTMLElement | null = elementCache.get(targetId) || null
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

        // We no longer cull here based on window.innerHeight, because the container itself scrolls.
        // Instead, we calculate local bounding Y coordinates and cull in the render loop (Virtualization).
        // `sy` and `ty` are relative to the top of the canvas container.
        const minY = Math.min(sy, ty)
        const maxY = Math.max(sy, ty)

        // Smart Routing Logic
        let pathD = ''
        const isSameColumn = Math.abs(sRect.left - tRect.left) < 50
        const isSelf = edge.source === edge.target

        // Multi-edge offsetting
        // If there are multiple edges (groupTotal > 1), we offset the control points vertically
        // or curve magnitude to separate them.
        const index = edge.groupIndex || 0

        if (isSameColumn && !isSelf) {
          // "Bracket" routing: Right -> Right (Cleaner layout)
          // Use a tighter loop for same-column edges
          tx = tRect.right - containerRect.left

          const curveDist = 30 + (index * 8)
          const cp1x = sx + curveDist
          const cp2x = tx + curveDist

          // Keep Y aligned with source/target for straight horizontal exit/entry
          const cp1y = sy
          const cp2y = ty

          pathD = `M ${sx} ${sy} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${tx} ${ty}`
        } else {
          // Standard Left-to-Right S-Curve (Sigmoid)
          // This creates a beautiful, simple flow without "ballooning"
          const dist = Math.abs(tx - sx)

          // Fixed curvature creates a uniform look. 0.5 = standard S-curve.
          const curvature = 0.5

          const cp1x = sx + dist * curvature
          const cp2x = tx - dist * curvature

          // CRITICAL: Keep control point Ys aligned with Source/Target Ys
          // This ensures the line leaves horizontally and enters horizontally.
          // We apply vOffset ONLY to the middle if we wanted separation, 
          // but for "prettiness", pure S-curves usually look best.
          // If we really need separation for multi-edges, we can adjust the CP x-values slightly
          // or just let them overlap cleanly as "highways".
          const cp1y = sy
          const cp2y = ty

          pathD = `M ${sx} ${sy} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${tx} ${ty}`
        }

        // Theme color priority
        const primaryType = edge.types && edge.types.length > 0 ? edge.types[0] : (edge.originalType || '')
        const typeColor = resolveEdgeColor
          ? resolveEdgeColor(primaryType)
          : '#3b82f6'

        let color = typeColor
        // Base opacity varies by confidence (if available) - increased base for vibrancy
        let edgeOpacity = 0.5 + (edge.confidence || 0.4) * 0.5

        // Base stroke width depends on bundling!
        let baseStrokeWidth = 1.5
        if (edge.isBundled) {
          // Logarithmic scaling for bundle volume 
          baseStrokeWidth = Math.min(2 + Math.log2(edge.edgeCount) * 1.5, 10)
        } else if (edge.isAggregated) {
          baseStrokeWidth = 2.5
        }

        let dynamicStrokeWidth = baseStrokeWidth

        // Determine if this edge is highlighted (click-to-highlight)
        const isEdgeHighlighted = isHighlightActive && highlightedEdges?.has(edge.id)
        const isEdgeDimmed = isHighlightActive && !highlightedEdges?.has(edge.id)

        if (isTracing && traceResult) {
          // TRACE MODE
          edgeOpacity = edge.isGhost ? 0.4 : 0.8
          dynamicStrokeWidth = baseStrokeWidth + 1
          const srcInUpstream = traceResult.upstreamNodes?.has(edge.source)
          const tgtInUpstream = traceResult.upstreamNodes?.has(edge.target)
          const srcInDownstream = traceResult.downstreamNodes?.has(edge.source)
          const tgtInDownstream = traceResult.downstreamNodes?.has(edge.target)

          if (srcInUpstream || tgtInUpstream) {
            color = '#06b6d4' // cyan
          } else if (srcInDownstream || tgtInDownstream) {
            color = '#f59e0b' // amber
          } else if (!edge.isGhost) {
            color = '#a78bfa' // purple
          }

          if (!srcInUpstream && !tgtInUpstream && !srcInDownstream && !tgtInDownstream) {
            edgeOpacity = edge.isGhost ? 0.05 : 0.1
            dynamicStrokeWidth = Math.max(1, baseStrokeWidth - 1)
          }
        } else {
          // Normal/highlight mode
          if (isEdgeHighlighted) {
            edgeOpacity = 0.9
            dynamicStrokeWidth = baseStrokeWidth + 1
          } else if (isEdgeDimmed) {
            edgeOpacity = edge.isGhost ? 0.05 : 0.1
            dynamicStrokeWidth = Math.max(1, baseStrokeWidth - 1)
          }
        }

        // Ghost styling for abstracted/bundled edges
        if (edge.isGhost) {
          edgeOpacity = Math.min(0.7, edgeOpacity)
        }

        newComputedEdges.push({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          minY,
          maxY,
          pathD,
          color,
          dynamicStrokeWidth,
          edgeOpacity,
          isGhost: edge.isGhost || false,
          isBundled: edge.isBundled || false,
          edgeCount: edge.edgeCount || 0,
          sx, sy, tx, ty
        })
      }
    })
    setComputedEdges(newComputedEdges)
  }, [edges, selectEdge, isEdgePanelOpen, toggleEdgePanel, isTracing, traceResult, highlightedEdges, isHighlightActive, resolveEdgeColor, hoveredEdgeId])

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

    const visibilityObserver = getSharedNodeObserver(scheduleUpdate)

    // Observe all visible node elements
    nodes.forEach(node => {
      const el = document.getElementById(`layer-node-${node.id}`)
      if (el) {
        observer.observe(el)
        if (visibilityObserver) visibilityObserver.observe(el)
      }
    })

    return () => {
      observer.disconnect()
      if (visibilityObserver) visibilityObserver.disconnect()
      globalVisibleNodes.clear()
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [nodes, expandedNodesArray, scheduleUpdate])

  // Attach scroll listener to the parent container for Viewport Edge Virtualization
  useEffect(() => {
    if (!containerRef.current) return
    const scrollParent = containerRef.current.closest('.overflow-y-auto') as HTMLElement
    if (!scrollParent) return

    let rafId: number | null = null
    const handleScroll = () => {
      if (rafId !== null) return // debounce
      rafId = requestAnimationFrame(() => {
        setViewport({
          scrollTop: scrollParent.scrollTop,
          clientHeight: scrollParent.clientHeight
        })
        rafId = null
      })
    }

    // Capture initial
    handleScroll()

    scrollParent.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', handleScroll, { passive: true })

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      scrollParent.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)
    }
  }, [])

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

  // VERY FAST Virtualization Filter: Only render edges that intersect the scroll viewport
  const VIEWPORT_MARGIN = 400 // Load edges slightly before they enter screen
  const visibleEdges = computedEdges.filter(edge => {
    // If edge bottom is above viewport OR edge top is below viewport -> Cull
    if (edge.maxY < viewport.scrollTop - VIEWPORT_MARGIN) return false
    if (edge.minY > viewport.scrollTop + viewport.clientHeight + VIEWPORT_MARGIN) return false
    return true
  })

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none z-20">
      <svg className="w-full h-full overflow-visible">
        <defs>
          <style>
            {`
              @keyframes dashFlow {
                from { stroke-dashoffset: 400; }
                to { stroke-dashoffset: 0; }
              }
              .flow-particles {
                animation: dashFlow 20s linear infinite;
              }
              .flow-particles-ghost {
                animation: dashFlow 40s linear infinite; /* flows slower for ghosts */
              }
            `}
          </style>
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
        {visibleEdges.map(edge => {
          const isHovered = hoveredEdgeId === edge.id
          const isSourceHovered = hoveredEdgeId === edge.source
          const isTargetHovered = hoveredEdgeId === edge.target
          const isHighlighted = isHovered || isSourceHovered || isTargetHovered
          const { pathD, color, dynamicStrokeWidth, edgeOpacity, isGhost, isBundled, sx, sy, tx, ty } = edge

          return (
            <g key={edge.id} className="transition-opacity duration-300">
              {/* INVISIBLE WIDE HIT AREA FOR HOVER */}
              <path
                d={pathD}
                fill="none"
                stroke="transparent"
                strokeWidth={20}
                className="pointer-events-auto cursor-pointer"
                onMouseEnter={() => setHoveredEdgeId(edge.id)}
                onMouseLeave={() => setHoveredEdgeId(null)}
                onClick={(e) => {
                  e.stopPropagation()
                  selectEdge(edge.id)
                  if (!isEdgePanelOpen) toggleEdgePanel()
                }}
              />

              {/* BASE GLOW / DROP SHADOW - Thick and highly transparent */}
              <path
                d={pathD}
                style={{
                  stroke: color,
                  strokeWidth: dynamicStrokeWidth + (isHighlighted ? 4 : 2),
                  fill: 'none',
                  strokeOpacity: isHighlighted ? edgeOpacity * 0.4 : edgeOpacity * 0.15,
                  strokeLinecap: 'round',
                  transition: 'all 0.3s ease',
                }}
                className="pointer-events-none"
              />

              {/* CORE LINE - Solid but slightly translucent */}
              <path
                d={pathD}
                style={{
                  stroke: color,
                  strokeWidth: dynamicStrokeWidth,
                  fill: 'none',
                  strokeOpacity: isHighlighted ? Math.max(0.6, edgeOpacity * 1.5) : edgeOpacity,
                  strokeDasharray: isGhost ? '6 6' : 'none',
                  strokeLinecap: 'round',
                  transition: 'all 0.3s ease',
                }}
                className="pointer-events-none"
              />

              {/* ANIMATED PARTICLES / FLOW overlay */}
              {!isGhost && (
                <path
                  d={pathD}
                  style={{
                    stroke: color, // Use the vivid path color instead of white
                    strokeWidth: Math.max(1, dynamicStrokeWidth * 0.5),
                    fill: 'none',
                    strokeOpacity: isHighlighted ? 1 : 0.8,
                    strokeLinecap: 'round',
                    // CSS dasharray: small dash, huge gap -> acts like moving dots!
                    strokeDasharray: '4 16',
                    // Add a drop shadow strictly to the particles for a neon pop
                    filter: `drop-shadow(0 0 3px ${color})`
                  }}
                  className="pointer-events-none flow-particles"
                />
              )}
              {isGhost && (
                <path
                  d={pathD}
                  style={{
                    stroke: color,
                    strokeWidth: Math.max(1, dynamicStrokeWidth * 0.4),
                    fill: 'none',
                    strokeOpacity: isHighlighted ? 0.8 : 0.4,
                    strokeLinecap: 'round',
                    // Slow dash moving
                    strokeDasharray: '6 12',
                  }}
                  className="pointer-events-none flow-particles-ghost"
                />
              )}

              {/* Bundle Badge Label rendered on the path */}
              {isBundled && !isGhost && (
                <g transform={`translate(${(sx + tx) / 2}, ${(sy + ty) / 2})`}>
                  <rect x="-10" y="-8" width="20" height="16" rx="4" fill="currentColor" opacity="0.15" className="group-hover:opacity-30" />
                  <text x="0" y="3" fill="currentColor" fontSize="10px" fontWeight="bold" textAnchor="middle" opacity="0.9">
                    {edge.edgeCount}
                  </text>
                </g>
              )}

              {/* Terminals (Hide for ghosts to signify missing end) */}
              {!isGhost && (
                <circle cx={sx} cy={sy} r="2.5" fill="currentColor" style={{ opacity: edgeOpacity }} className="group-hover:opacity-80" />
              )}

              <title>{edge.source} → {edge.target} {isBundled ? `(${edge.edgeCount} bundled logs)` : ''}</title>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// Backward-compat named export for existing imports (CanvasRouter etc.)
export { ContextViewCanvas as ReferenceModelCanvas }
export default ContextViewCanvas
