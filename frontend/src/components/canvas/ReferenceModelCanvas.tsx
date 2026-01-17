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
import {
  type GraphNode,
  resolveLayerAssignment,
  matchesRule,
  type LayerAssignmentRule,
  type EntityType,
} from '@/providers/GraphDataProvider'
import { useGraphProvider } from '@/providers'

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
  const selectNode = useCanvasStore((s) => s.selectNode)
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  const selectedNodeId = selectedNodeIds[0] ?? null
  const schema = useSchemaStore((s) => s.schema)
  const activeView = useSchemaStore((s) => s.getActiveView())
  const updateView = useSchemaStore((s) => s.updateView)

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

  // Helper to map canvas type to EntityType
  const mapNodeType = useCallback((type: string): EntityType => {
    const mapping: Record<string, EntityType> = {
      domain: 'container',
      app: 'dataPlatform',
      asset: 'dataset',
      column: 'schemaField',
      ghost: 'dataset',
      system: 'dataPlatform',
      schema: 'container',
      table: 'dataset',
      view: 'dataset',
      pipeline: 'dataJob',
      dashboard: 'dashboard',
      report: 'chart'
    }
    return mapping[type] ?? 'dataset'
  }, [])

  // Build hierarchy tree from nodes and containment edges
  const hierarchyTree = useMemo(() => {
    if (!nodes.length) return []

    // Containment logic: Edge typ 'contains' OR type 'CONTAINS'
    const containmentEdges = edges.filter((e) =>
      e.data?.relationship === 'contains' || e.data?.edgeType === 'contains' || e.data?.edgeType === 'CONTAINS'
    )

    const nodeMap = new Map(nodes.map((n) => [n.id, n]))
    const childMap = new Map<string, string[]>()
    const hasParent = new Set<string>()

    containmentEdges.forEach((edge) => {
      const children = childMap.get(edge.source) ?? []
      children.push(edge.target)
      childMap.set(edge.source, children)
      hasParent.add(edge.target)
    })

    // Root nodes are those without parents OR nodes that are explicity roots in a layer context
    // Ideally only true roots (no incoming containment)
    // Note: If containment cycles exist, this might miss nodes. Assuming DAG.
    const rootNodes = nodes.filter((n) =>
      !hasParent.has(n.id) && n.data.type !== 'ghost'
    )

    const buildTree = (nodeId: string, depth: number): HierarchyNode | null => {
      const node = nodeMap.get(nodeId)
      if (!node) return null

      const children = (childMap.get(nodeId) ?? [])
        .map((childId) => buildTree(childId, depth + 1))
        .filter((n): n is HierarchyNode => n !== null)
        .sort((a, b) => a.name.localeCompare(b.name))

      return {
        id: node.id,
        typeId: node.data.type,
        name: node.data.label ?? node.data.businessLabel ?? node.id,
        data: node.data as Record<string, unknown>,
        children,
        depth,
        // Enriched props for layer logic
        urn: node.data.urn || node.id,
        entityTypeOption: mapNodeType(node.data.type),
        tags: node.data.classifications || []
      }
    }

    return rootNodes
      .map((n) => buildTree(n.id, 0))
      .filter((n): n is HierarchyNode => n !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [nodes, edges, mapNodeType])

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

      // 2. Default entity type rules (lower priority if rules exist, or base mechanism)
      // Always add these to support type-based matching alongside complex rules
      layer.entityTypes.forEach((entityType, idx) => {
        generatedRules.push({
          id: `${layer.id}-${entityType}`,
          layerId: layer.id,
          entityTypes: [entityType as any], // Cast for simple string matching if needed
          priority: layer.order * 10 + idx,
        })
      })
    })

    return generatedRules
  }, [sortedLayers])

  // Group nodes by layer
  const nodesByLayer = useMemo(() => {
    const grouped = new Map<string, HierarchyNode[]>()

    // Initialize all layers
    sortedLayers.forEach((layer) => {
      grouped.set(layer.id, [])
    })

    const assignedNodeIds = new Set<string>()

    // Helper: Map physical nodes to a logical node context
    const getMappedPhysicalNodes = (logicalConfig: LogicalNodeConfig): HierarchyNode[] => {
      const mapped: HierarchyNode[] = []

      // Iterate TOP LEVEL physical nodes
      // We prioritize assigning roots. If a root is assigned, its children come with it.
      hierarchyTree.forEach(pNode => {
        if (assignedNodeIds.has(pNode.id)) return

        const graphNode: GraphNode = {
          urn: pNode.urn,
          entityType: pNode.entityTypeOption,
          displayName: pNode.name,
          properties: pNode.data,
          tags: pNode.tags
        }

        // Check rules
        // Note: layerRules are flattened. logicalConfig.rules are specific.
        // We use logicalConfig.rules here.
        let isMatch = false
        if (logicalConfig.rules) {
          for (const rule of logicalConfig.rules) {
            if (matchesRule(graphNode, rule)) {
              isMatch = true
              break
            }
          }
        }

        if (isMatch) {
          mapped.push(pNode)
          assignedNodeIds.add(pNode.id)
        }
      })

      return mapped
    }

    // Helper: Build Logical Tree Recursively
    const buildLogicalTree = (config: LogicalNodeConfig, depth: number): HierarchyNode => {
      // 1. Build Logical Children
      const logicalChildren = (config.children || []).map(c => buildLogicalTree(c, depth + 1))

      // 2. Find Mapped Physical Children
      const physicalChildren = getMappedPhysicalNodes(config)

      return {
        id: `logical-${config.id}`,
        typeId: config.type,
        name: config.name,
        data: { description: config.description },
        children: [...logicalChildren, ...physicalChildren],
        parentId: undefined,
        depth,
        urn: `urn:logical:${config.id}`,
        entityTypeOption: 'container',
        tags: [],
        isLogical: true,
        logicalConfig: config
      }
    }

    // Process Layers
    sortedLayers.forEach(layer => {
      // STRATEGY A: Logical Hierarchy Defined
      if (layer.logicalNodes && layer.logicalNodes.length > 0) {
        const layerRootNodes: HierarchyNode[] = []

        layer.logicalNodes.forEach(config => {
          layerRootNodes.push(buildLogicalTree(config, 0))
        })

        // Unassigned Handling: Find roots matching the layer type fallback
        if (layer.showUnassigned !== false) { // Default true? or false?
          hierarchyTree.forEach(pNode => {
            if (assignedNodeIds.has(pNode.id)) return
            // Fallback to type match
            if (layer.entityTypes.includes(pNode.typeId)) {
              layerRootNodes.push(pNode)
              assignedNodeIds.add(pNode.id)
            }
          })
        }
        grouped.set(layer.id, layerRootNodes)
      }
      // STRATEGY B: Legacy / Pure Type-Based (if no logical nodes defined)
      else {
        // Existing logic with a twist: Only assign if not already assigned to a logical node?
        // We iterate hierarchyTree again
        const layerNodes: HierarchyNode[] = []

        hierarchyTree.forEach(pNode => {
          if (assignedNodeIds.has(pNode.id)) return // Already grabbed by a logical node

          // Simple type check OR advanced rule check from layerRules
          let assignedToThisLayer = false

          // 1. Check type
          if (layer.entityTypes.includes(pNode.typeId)) {
            assignedToThisLayer = true
          }

          // 2. Check global rules (resolveLayerAssignment)
          // We need to re-verify if this node maps to THIS layer
          // resolveLayerAssignment returns winner.
          if (!assignedToThisLayer) {
            const graphNode: GraphNode = {
              urn: pNode.urn,
              entityType: pNode.entityTypeOption,
              displayName: pNode.name,
              properties: pNode.data,
              tags: pNode.tags
            }
            if (resolveLayerAssignment(graphNode, layerRules) === layer.id) {
              assignedToThisLayer = true
            }
          }

          if (assignedToThisLayer) {
            layerNodes.push(pNode)
            assignedNodeIds.add(pNode.id)
          }
        })

        grouped.set(layer.id, layerNodes)
      }
    })

    return grouped
  }, [hierarchyTree, sortedLayers, layerRules])

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

    const node = displayMap.get(contextMenu.nodeId)
    if (!node) return

    // Prevent moving Logical Nodes? Or allow?
    if (node.isLogical) {
      // Maybe allow moving logical containers? Not for now.
      return
    }

    const layers = activeView.layout.referenceLayout?.layers || defaultReferenceModelLayers

    // Clone layers to update
    const updatedLayers = layers.map(l => {
      if (l.id === layerId) {
        return {
          ...l,
          rules: [
            ...(l.rules || []),
            {
              id: `rule-${Date.now()}`,
              priority: 100, // High priority for manual moves
              urnPattern: node.urn // Strict instance match
            }
          ]
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
  const provider = useGraphProvider()
  const addNodes = useCanvasStore((s) => s.addNodes)
  const addEdges = useCanvasStore((s) => s.addEdges)

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

    // If node has childCount metadata but no actual children in the tree, try fetching
    const childCount = (node?.data?._collapsedChildCount as number) || (node?.data?.childCount as number) || 0
    const hasNoChildren = (node?.children?.length ?? 0) === 0

    if (node && hasNoChildren && childCount > 0) {
      try {
        // Fetch children
        const children = await provider.getChildren(node.urn)

        // Convert to Canvas Nodes
        const newNodes = children.map(child => ({
          id: child.urn, // Use URN as ID
          position: { x: 0, y: 0 }, // Layout will handle this
          data: {
            urn: child.urn,
            label: child.displayName,
            type: child.entityType, // Map back if needed
            ...child.properties,
            childCount: child.childCount
          },
          type: 'custom' // Default type
        }))

        // Create containment edges
        const newEdges = children.map(child => ({
          id: `contains-${node.id}-${child.urn}`,
          source: node.id,
          target: child.urn,
          type: 'contains',
          data: {
            relationship: 'contains'
          }
        }))

        addNodes(newNodes as any)
        addEdges(newEdges as any)

      } catch (err) {
        console.error('Failed to lazy load children', err)
      }
    }

    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }, [displayMap, provider, addNodes, addEdges])

  // Expand all / collapse all
  const expandAll = useCallback(() => {
    const allIds = displayFlat.map((n) => n.id)
    setExpandedNodes(new Set(allIds))
  }, [displayFlat])

  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set())
  }, [])

  // Lineage Edges for Overlay
  const lineageEdges = useMemo(() => {
    if (!showLineageFlow) return []
    // Filter out containment edges
    return edges.filter(edge => {
      const params = edge.data || {}
      const rel = params.relationship || params.edgeType
      return rel !== 'contains' && rel !== 'CONTAINS'
    })
  }, [edges, showLineageFlow])

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
      </div>

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
            nodes={nodes}
            edges={lineageEdges}
            expandedNodes={expandedNodes}
          />
        )}

      </div>
    </div>
  )
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
  onContextMenu
}: LayerColumnProps) {
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
  onContextMenu
}: LayerNodeCardProps) {
  const entityType = schema?.entityTypes.find((et) => et.id === node.typeId)
  const visual = entityType?.visual
  const hasChildren = node.children.length > 0
  const isExpanded = expandedNodes.has(node.id)
  const isSelected = selectedNodeId === node.id
  const isSearchResult = searchResults.includes(node.id)

  // Count nested children
  const countDescendants = (n: HierarchyNode): number => {
    return n.children.reduce((acc, child) => acc + 1 + countDescendants(child), 0)
  }
  const descendantCount = hasChildren && !isExpanded ? countDescendants(node) : 0

  return (
    <motion.div
      layout
      id={`layer-node-${node.id}`}
      className={cn(
        "rounded-lg border transition-all duration-200",
        "bg-canvas-elevated hover:shadow-md cursor-pointer",
        isSelected && "ring-2 ring-offset-1",
        isSearchResult && !isSelected && "ring-2 ring-amber-400/50",
        node.isLogical && "border-dashed bg-black/5 dark:bg-white/5" // Distinct style for logical nodes
      )}
      style={{
        borderColor: visual?.color ?? layer.color ?? '#6b7280',
        borderLeftWidth: '3px',
        ['--tw-ring-color' as string]: visual?.color ?? layer.color ?? '#6b7280',
      }}
      onClick={() => onSelect(node.id)}
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
          {node.isLogical && node.data?.description && (
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
  expandedNodes
}: {
  nodes: any[],
  edges: any[],
  expandedNodes: Set<string>
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
          <g key={edge.id}>
            <path
              d={d}
              fill="none"
              stroke="#6366f1"
              strokeWidth="2"
              strokeOpacity="0.4"
            />
            <circle cx={sx} cy={sy} r="2" fill="#6366f1" />
            <circle cx={tx} cy={ty} r="2" fill="#6366f1" />
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

