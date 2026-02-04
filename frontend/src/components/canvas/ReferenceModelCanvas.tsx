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
import { computeTrace } from '@/hooks/useLineageExploration'
import { EdgeDetailPanel } from '../panels/EdgeDetailPanel'
import { EditNodePanel } from '../panels/EditNodePanel'
import { useEdgeDetailPanel, useEdgeTypeFilters } from '@/hooks/useEdgeFilters'
import { useOntologyMetadata, isContainmentEdgeType, normalizeEdgeType } from '@/services/ontologyService'

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

  // Instance-level assignments from store (user drag-and-drop)
  const instanceAssignments = useInstanceAssignments()
  const effectiveAssignments = useReferenceModelStore(s => s.effectiveAssignments)
  const computeAssignments = useReferenceModelStore(s => s.computeAssignments)
  const assignmentStatus = useReferenceModelStore(s => s.assignmentStatus)

  // Trigger computation when layers or nodes change (debounce?)
  // Ideally this should be triggered by specific events, not just render.
  // For migration, we trigger on mount or significant change.
  useEffect(() => {
    // Only compute if idle or stale? 
    // For now, simple trigger if we have nodes and no assignments (or force refresh)
    if (nodes.length > 0 && provider) {
      // Debounce or check status to avoid loops
      if (assignmentStatus === 'idle') {
        computeAssignments(provider)
      }
    }
  }, [nodes.length, provider, computeAssignments, assignmentStatus])

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, nodeId: string } | null>(null)

  // Handle right click
  const handleContextMenu = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.preventDefault()
    e.stopPropagation() // Prevent bubbling
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId })
  }, [])

  // Close menu on click elsewhere
  useEffect(() => {
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])



  // Edge details
  const { isOpen: isEdgePanelOpen, toggle: toggleEdgePanel, close: closeEdgePanel } = useEdgeDetailPanel()
  const { filters: edgeFilters, toggle: toggleEdgeFilter } = useEdgeTypeFilters()
  const selectEdge = useCanvasStore((s) => s.selectEdge)

  // Trace / Focus State
  const [traceFocusId, setTraceFocusId] = useState<string | null>(null)
  const [traceNodes, setTraceNodes] = useState<Set<string>>(new Set())

  // Trace Calculation for Double Click
  // We import computeTrace dynamically or assume it's available via utility
  // Since we can't easily import from hook file if it's not exported, we'll implement a lightweight version 
  // OR rely on the hook if possible. 
  // Actually, we can assume the user meant "computeTrace" is importable.
  // Checking previous file view: "export function computeTrace" exists in hooks/useLineageExploration.ts

  const handleDoubleClick = useCallback(async (nodeId: string) => {
    // Toggle trace off if clicking the same node
    if (traceFocusId === nodeId) {
      setTraceFocusId(null)
      setTraceNodes(new Set())
      return
    }

    // Resolve URN from the clicked node
    // We assume nodes in store have data.urn. Fallback to ID if not found.
    const targetNode = nodes.find(n => n.id === nodeId)
    const targetUrn = (targetNode?.data?.urn as string) || nodeId

    // Optimistically highlight the clicked node (using ID)
    setTraceFocusId(nodeId)
    setTraceNodes(new Set([nodeId]))

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
      result.upstreamUrns.forEach(u => {
        const id = resolveId(u)
        if (id) visibleIds.add(id)
      })
      result.downstreamUrns.forEach(u => {
        const id = resolveId(u)
        if (id) visibleIds.add(id)
      })

      setTraceNodes(visibleIds)

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

    // 1. Determine "Explicit Assignment" for every node
    // This ignores inheritance for a moment, just checking rules/manual overrides
    const explicitAssignments = new Map<string, string>() // nodeId -> layerId

    // Config assignments
    sortedLayers.forEach(l => {
      l.entityAssignments?.forEach(a => {
        explicitAssignments.set(a.entityId, l.id)
      })
    })

    // Rule assignments
    nodes.forEach(node => {
      // If manually assigned via instanceAssignments (store), that wins
      const instanceAssignment = instanceAssignments.get(node.id)
      if (instanceAssignment) {
        explicitAssignments.set(node.id, instanceAssignment.layerId)
        return
      }

      // If already found in config, skip rules (config > rules)
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
        explicitAssignments.set(node.id, ruleLayerId)
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

      // Use backend-computed effective assignment if available
      let myLayerId = effectiveAssignments.get(nodeId)?.layerId

      // Fallback to explicit instance assignment
      if (!myLayerId) {
        myLayerId = explicitAssignments.get(nodeId)
      }

      // Fallback to INHERITANCE
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

  // Action: Move entity to layer
  const moveToLayer = useCallback((layerId: string) => {
    if (!contextMenu || !activeView || !activeView.id) return

    const entity = displayMap.get(contextMenu.nodeId)
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

    setContextMenu(null)
  }, [contextMenu, activeView, displayMap, updateView])

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
    const set = new Set(traceNodes)
    if (traceFocusId) set.add(traceFocusId)

    // Add ancestors
    traceNodes.forEach(id => {
      let curr = parentMap.get(id)
      while (curr) {
        set.add(curr)
        curr = parentMap.get(curr)
      }
    })

    if (traceFocusId) {
      let curr = parentMap.get(traceFocusId)
      while (curr) {
        set.add(curr)
        curr = parentMap.get(curr)
      }
    }

    return set
  }, [traceNodes, traceFocusId, parentMap])
  const lineageEdges = useMemo(() => {
    if (!showLineageFlow) return []
    // Filter out containment edges
    return edges.filter(edge => {
      const params = edge.data || {}
      const rel = params.relationship || params.edgeType
      return !isContainmentEdge(normalizeEdgeType(edge))
    })
  }, [edges, showLineageFlow])

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

    // 2. Project Edges
    const projected: any[] = []
    const seen = new Set<string>()

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

        const key = `${sourceId}->${targetId}`

        if (!seen.has(key)) {
          projected.push({
            ...edge,
            id: `proj-${key}-${edge.id}`,
            source: sourceId,
            target: targetId,
            animated: true // Visual cue for rolled up edges?
          })
          seen.add(key)
        }
      }
    })

    return projected
  }, [lineageEdges, nodesByLayer, expandedNodes, displayMap, showLineageFlow])

  return (
    <div className={cn("h-full w-full flex flex-col overflow-hidden bg-canvas", className)}>
      {/* Header */}
      <div className="flex-shrink-0 bg-canvas-elevated/95 backdrop-blur border-b border-glass-border px-6 py-3">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-display font-semibold text-ink">Reference Model</h2>
          <span className="px-2 py-1 rounded-md bg-accent-lineage/10 text-accent-lineage text-xs font-medium">
            Data Flow View
          </span>
          <div className="flex-1" />

          {/* Search */}
          <div className="relative">
            <LucideIcons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search... (⌘F)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="input pl-9 pr-8 py-1.5 w-56 text-sm"
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
            onClick={() => setShowLineageFlow(!showLineageFlow)}
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

          <div className="flex items-center gap-1">
            <button onClick={expandAll} className="btn btn-ghost btn-sm" title="Expand All">
              <LucideIcons.ChevronsDownUp className="w-4 h-4 rotate-180" />
            </button>
            <button onClick={collapseAll} className="btn btn-ghost btn-sm" title="Collapse All">
              <LucideIcons.ChevronsDownUp className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-2 text-sm text-ink-muted">
            <LucideIcons.ArrowRight className="w-4 h-4" />
            <span>Data Flow</span>
          </div>
        </div>

        {/* Search Results */}
        {searchResults.length > 0 && (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span className="text-xs text-ink-muted">{searchResults.length} results:</span>
            {searchResults.slice(0, 5).map((node) => (
              <button
                key={node.id}
                onClick={() => {
                  selectNode(node.id)
                  setExpandedNodes((prev) => new Set([...prev, node.id]))
                }}
                className="px-2 py-1 rounded-md bg-accent-lineage/10 text-accent-lineage text-xs hover:bg-accent-lineage/20"
              >
                {node.name}
              </button>
            ))}
            {searchResults.length > 5 && (
              <span className="text-xs text-ink-muted">+{searchResults.length - 5} more</span>
            )}
          </div>
        )}

        {/* Trace Toolbar */}
        <AnimatePresence>
          {traceFocusId && (
            <motion.div
              initial={{ y: -20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -20, opacity: 0 }}
              className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2 rounded-full glass-panel border border-accent-lineage/30 shadow-lg shadow-accent-lineage/10"
            >
              <div className="flex items-center gap-2 text-sm font-medium text-ink">
                <span className="w-2 h-2 rounded-full bg-accent-lineage animate-pulse" />
                <span>Tracing:</span>
                <span className="font-bold text-accent-lineage">
                  {displayMap.get(traceFocusId)?.name || 'Unknown Node'}
                </span>
              </div>
              <div className="h-4 w-[1px] bg-glass-border" />
              <button
                onClick={() => {
                  setTraceFocusId(null)
                  setTraceNodes(new Set())
                  setExpandedNodes(new Set()) // Optional: Collapse all on exit? Maybe keep context.
                }}
                className="text-xs font-semibold text-ink-muted hover:text-ink flex items-center gap-1 transition-colors"
              >
                <LucideIcons.X className="w-3.5 h-3.5" />
                Exit Trace
              </button>
            </motion.div>
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
              edgeFilters={edgeFilters}
              onToggleFilter={toggleEdgeFilter}
            />
          )}

          {/* Node Details Panel */}
          {selectedNodeId && (
            <EditNodePanel
              key={selectedNodeId}
              isOpen={!!selectedNodeId}
              onClose={() => selectNode(null)}
              nodeId={selectedNodeId}
              isReadOnly={true} // Reference model view usually readonly for details? Or allow edits.
            />
          )}
        </AnimatePresence>

        {/* Layer Columns */}
        <div className="flex-1 overflow-auto relative">
          <div className="flex h-full min-h-0">
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

                traceFocusId={traceFocusId}
                traceNodes={traceNodes}
                traceContextSet={traceContextSet}
              />
            ))}
          </div>

          {/* Context Menu */}
          {contextMenu && (
            <div
              className="fixed z-50 min-w-[160px] glass-panel rounded-lg shadow-xl overflow-hidden py-1 border border-glass-border"
              style={{ top: contextMenu.y, left: contextMenu.x }}
            >
              <div className="px-3 py-1.5 border-b border-glass-border text-xs font-semibold text-ink-muted bg-black/5 dark:bg-white/5">
                Move to Layer...
              </div>
              {sortedLayers.map(layer => (
                <button
                  key={layer.id}
                  onClick={() => moveToLayer(layer.id)}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent-lineage/10 hover:text-accent-lineage flex items-center gap-2"
                >
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: layer.color }} />
                  {layer.name}
                </button>
              ))}
            </div>
          )}

          {/* Lineage Flow Overlay */}
          {showLineageFlow && (
            <LineageFlowOverlay
              nodes={displayFlat} // Pass rendered nodes for checking existence? Actually Overlay searches DOM.
              edges={visibleLineageEdges}
              expandedNodes={expandedNodes}
              selectEdge={selectEdge}
              isEdgePanelOpen={isEdgePanelOpen}
              toggleEdgePanel={toggleEdgePanel}
            />
          )}

        </div>
      </div>
    </div>
  )
}

// Helper for Lineage Roll-up
// This must be inside component to access state, or mapped outside.
// Use memo inside component.

// ... (Rest of file)

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
  onDoubleClick: (id: string) => void
  traceFocusId: string | null
  traceNodes: Set<string>
  traceContextSet: Set<string>
  isDimmed?: boolean // Computed internally or passed? Computed is better.
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
  traceFocusId,
  traceNodes,
  traceContextSet
}: LayerColumnProps) { // No longer LayerColumnProps? Yes it is.
  return (
    <div className="flex-1 min-w-[280px] max-w-[400px] border-r border-glass-border last:border-r-0 flex flex-col">
      {/* Layer Header */}
      <div
        className="flex-shrink-0 px-4 py-3 border-b border-glass-border"
        style={{ backgroundColor: `${layer.color}10` }}
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
        </div>
      </div>

      {/* Layer Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
        {nodes.length === 0 ? (
          <div className="text-center py-8 text-ink-muted text-sm">
            No entities in this layer
          </div>
        ) : (
          nodes.map((node) => (
            <LayerNodeCard
              key={node.id}
              node={node}
              layer={layer}
              schema={schema}
              selectedNodeId={selectedNodeId}
              expandedNodes={expandedNodes}
              searchResults={searchResults}
              onSelect={onSelect}
              onToggle={onToggle}
              onContextMenu={onContextMenu}
              onDoubleClick={onDoubleClick}
              traceFocusId={traceFocusId}
              traceNodes={traceNodes}
              traceContextSet={traceContextSet}
            />
          ))
        )}
      </div>
    </div>
  )
}

interface LayerNodeCardProps {
  node: HierarchyNode
  layer: ViewLayerConfig
  schema: ReturnType<typeof useSchemaStore.getState>['schema']
  selectedNodeId: string | null
  expandedNodes: Set<string>
  searchResults: string[]
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void
  onDoubleClick: (id: string) => void
  traceFocusId: string | null
  traceNodes: Set<string>
  traceContextSet: Set<string>
}

function LayerNodeCard({
  node,
  layer,
  schema,
  selectedNodeId,
  expandedNodes,
  searchResults,
  onSelect,
  onToggle,
  onContextMenu,
  onDoubleClick,
  traceFocusId,
  traceNodes,
  traceContextSet
}: LayerNodeCardProps) {
  const entityType = schema?.entityTypes.find((et) => et.id === node.typeId)
  const visual = entityType?.visual

  // Style Dimming:
  // If trace is active:
  // - Node is highlighted if it is in traceContextSet (traced node OR ancestor)
  // - Otherwise dimmed
  const isTraceActive = traceFocusId !== null
  const isHighlighted = isTraceActive && traceContextSet.has(node.id)

  // Dim if trace is active AND NOT highlighted
  const isDimmed = isTraceActive && !isHighlighted

  // Logic for expandable state
  const childCount = (node.data.childCount as number) || (node.data._collapsedChildCount as number) || 0
  const hasChildren = node.children.length > 0 || childCount > 0

  const isExpanded = expandedNodes.has(node.id)
  const isSelected = selectedNodeId === node.id
  const isSearchResult = searchResults.includes(node.id)

  // Count nested children - prefer metadata if available and we are collapsed
  const countDescendants = (n: HierarchyNode): number => {
    // If we have explicit metadata, use it
    if (n.data.childCount) return n.data.childCount as number
    return n.children.reduce((acc, child) => acc + 1 + countDescendants(child), 0)
  }
  const descendantCount = hasChildren && !isExpanded ? (childCount || countDescendants(node)) : 0

  // Auto-scroll when trace is focused
  useEffect(() => {
    if (traceFocusId === node.id) {
      // Wait slightly for any expansions/layout shifts
      setTimeout(() => {
        const el = document.getElementById(`layer-node-${node.id}`)
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
        }
      }, 100)
    }
  }, [traceFocusId, node.id])

  return (
    <motion.div
      layout
      id={`layer-node-${node.id}`}
      className={cn(
        "rounded-lg border transition-all duration-300",
        "bg-canvas-elevated hover:shadow-md cursor-pointer",
        isSelected && "ring-2 ring-offset-1",
        isSearchResult && !isSelected && "ring-2 ring-amber-400/50",
        node.isLogical && "border-dashed bg-black/5 dark:bg-white/5",

        // Highlight logic
        isHighlighted && "shadow-[0_0_15px_-3px_rgba(var(--accent-lineage-rgb),0.3)] ring-1 ring-accent-lineage border-accent-lineage z-10 scale-[1.02]",

        // Dimming logic
        isDimmed && "opacity-40 grayscale-[0.8] blur-[0.5px] scale-[0.98]" // Less aggressive opacity (0.4), subtle blur
      )}
      style={{
        borderColor: isHighlighted ? 'var(--accent-lineage)' : (visual?.color ?? layer.color ?? '#6b7280'),
        borderLeftWidth: '3px',
        ['--tw-ring-color' as string]: visual?.color ?? layer.color ?? '#6b7280',
        ['--accent-lineage-rgb' as string]: '59, 130, 246', // Fallback if var not set, ideally from theme
      }}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(node.id)
      }}

      onDoubleClick={(e) => {
        e.stopPropagation()
        onDoubleClick(node.id)
      }}
      onContextMenu={(e) => onContextMenu(e, node.id)}
    >
      {/* Node Header */}
      < div className="flex items-center gap-2 px-3 py-2" >
        {hasChildren && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggle(node.id)
            }}
            className="w-5 h-5 rounded flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/10"
          >
            <motion.div animate={{ rotate: isExpanded ? 90 : 0 }}>
              <LucideIcons.ChevronRight className="w-3 h-3 text-ink-muted" />
            </motion.div>
          </button>
        )}

        {!hasChildren && <div className="w-5" />}

        <div
          className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${visual?.color ?? layer.color}15` }}
        >
          <DynamicIcon
            name={visual?.icon ?? 'Box'}
            className="w-3.5 h-3.5"
            style={{ color: visual?.color ?? layer.color }}
          />
        </div>

        <div className="flex-1 min-w-0">
          <span className="text-2xs font-medium uppercase tracking-wider text-ink-muted">
            {node.isLogical ? 'Group' : (entityType?.name ?? node.typeId)}
          </span>
          <h4 className={cn("text-sm font-medium truncate", node.isLogical ? "text-ink font-semibold" : "text-ink")}>
            {node.name}
          </h4>
          {node.isLogical && !!node.data?.description && (
            <p className="text-2xs text-ink-muted truncate">{String(node.data.description || '')}</p>
          )}
        </div>

        {
          hasChildren && !isExpanded && (
            <span className="text-2xs text-ink-muted px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10">
              +{descendantCount}
            </span>
          )
        }
      </div >

      {/* Expanded Children */}
      <AnimatePresence>
        {
          hasChildren && isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="px-3 pb-2 pl-8 space-y-1.5">
                {node.children.map((child) => (
                  <LayerNodeCard
                    key={child.id}
                    node={child}
                    layer={layer}
                    schema={schema}
                    selectedNodeId={selectedNodeId}
                    expandedNodes={expandedNodes}
                    searchResults={searchResults}
                    onSelect={onSelect}
                    onToggle={onToggle}
                    onContextMenu={onContextMenu}

                    onDoubleClick={onDoubleClick}
                    traceFocusId={traceFocusId}
                    traceNodes={traceNodes}
                    traceContextSet={traceContextSet}
                  />
                ))}
              </div>
            </motion.div>
          )
        }
      </AnimatePresence >
    </motion.div >
  )
}
// ----------------------------------------------------
// SVG Overlay Component
// ----------------------------------------------------

function LineageFlowOverlay({
  nodes,
  edges,
  expandedNodes,
  selectEdge,
  isEdgePanelOpen,
  toggleEdgePanel
}: {
  nodes: any[],
  edges: any[],
  expandedNodes: Set<string>,
  selectEdge: (id: string) => void,
  isEdgePanelOpen: boolean,
  toggleEdgePanel: () => void
}) {
  const [paths, setPaths] = useState<React.ReactNode[]>([])
  const containerRef = useRef<HTMLDivElement>(null)

  // Update paths function
  const updateFlow = useCallback(() => {
    if (!containerRef.current) return

    const containerRect = containerRef.current.getBoundingClientRect()
    const newPaths: React.ReactNode[] = []

    edges.forEach(edge => {
      const sourceId = `layer-node-${edge.source}`
      const targetId = `layer-node-${edge.target}`

      const sourceEl = document.getElementById(sourceId)
      const targetEl = document.getElementById(targetId)

      if (sourceEl && targetEl) {
        const sRect = sourceEl.getBoundingClientRect()
        const tRect = targetEl.getBoundingClientRect()

        // Relative coordinates
        const sx = sRect.right - containerRect.left
        const sy = sRect.top + sRect.height / 2 - containerRect.top
        const tx = tRect.left - containerRect.left
        const ty = tRect.top + tRect.height / 2 - containerRect.top

        // Bezier curve
        const curvature = 0.5

        // If same column or backwards, adjust curvature?
        // Assuming left-to-right flow mostly

        const d = `M ${sx} ${sy} C ${sx + (tx - sx) * curvature} ${sy}, ${tx - (tx - sx) * curvature} ${ty}, ${tx} ${ty}`

        newPaths.push(
          <g
            key={edge.id}
            className="pointer-events-auto cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              selectEdge(edge.id)
              if (!isEdgePanelOpen) toggleEdgePanel()
            }}
          >
            <path
              d={d}
              fill="none"
              stroke="#6366f1"
              strokeWidth="2"
              strokeOpacity="0.6"
              className="hover:stroke-[3px] transition-all"
            />
            <circle cx={sx} cy={sy} r="2" fill="#6366f1" />
            <circle cx={tx} cy={ty} r="2" fill="#6366f1" />
            <title>{edge.source} → {edge.target}</title>
          </g>
        )
      }
    })
    setPaths(newPaths)
  }, [edges])

  // Listeners
  useEffect(() => {
    // Initial draw
    // Delay slightly to allow layout to settle
    const timer = setTimeout(updateFlow, 100)

    // Resize
    window.addEventListener('resize', updateFlow)

    // Scroll - Capture phase to detect scroll in columns?
    // Or just poll? Scroll interaction is tricky. 
    // Let's add specific listeners to the columns if possible, but we don't have refs here easily.
    // We can capture global scroll
    window.addEventListener('scroll', updateFlow, true)

    return () => {
      window.removeEventListener('resize', updateFlow)
      window.removeEventListener('scroll', updateFlow, true)
      clearTimeout(timer)
    }
  }, [updateFlow, nodes, expandedNodes]) // Re-run when nodes change

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none z-0 overflow-hidden"
    >
      <svg className="w-full h-full">
        {paths}
      </svg>
    </div>
  )
}

export default ReferenceModelCanvas

