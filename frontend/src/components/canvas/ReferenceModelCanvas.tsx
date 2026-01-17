/**
 * ReferenceModelCanvas - Hierarchy-style Reference Model with User-Defined Layers
 * 
 * Displays entities in a horizontal left-to-right flow with:
 * - User-defined layer columns (Source → Staging → Refinery → Report)
 * - Collapsible containers within each layer
 * - Entities flow from left (sources) to right (consumers)
 * - Configurable layer definitions via schema
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import type { EntityTypeSchema } from '@/types/schema'

// Dynamic icon component
function DynamicIcon({ name, className, style }: { name: string; className?: string; style?: React.CSSProperties }) {
  const IconComponent = (LucideIcons as Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>>)[name]
  if (!IconComponent) {
    return <LucideIcons.Box className={className} style={style} />
  }
  return <IconComponent className={className} style={style} />
}

// Layer definition for reference model
export interface ReferenceModelLayer {
  id: string
  name: string
  description?: string
  icon?: string
  color?: string
  entityTypes: string[] // Which entity types belong to this layer
  order: number // Left-to-right position (0 = leftmost)
}

// Default layers matching typical data flow
export const defaultReferenceModelLayers: ReferenceModelLayer[] = [
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
}

interface ReferenceModelCanvasProps {
  className?: string
  layers?: ReferenceModelLayer[]
}

export function ReferenceModelCanvas({ 
  className, 
  layers = defaultReferenceModelLayers 
}: ReferenceModelCanvasProps) {
  const nodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)
  const selectNode = useCanvasStore((s) => s.selectNode)
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  const selectedNodeId = selectedNodeIds[0] ?? null
  const schema = useSchemaStore((s) => s.schema)
  
  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const searchInputRef = useRef<HTMLInputElement>(null)
  
  // Sort layers by order
  const sortedLayers = useMemo(() => 
    [...layers].sort((a, b) => a.order - b.order),
    [layers]
  )
  
  // Build hierarchy tree from nodes and containment edges
  const hierarchyTree = useMemo(() => {
    if (!nodes.length) return []
    
    const containmentEdges = edges.filter((e) => 
      e.data?.relationship === 'contains' || e.data?.edgeType === 'contains'
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
      }
    }
    
    return rootNodes
      .map((n) => buildTree(n.id, 0))
      .filter((n): n is HierarchyNode => n !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [nodes, edges])
  
  // Group nodes by layer
  const nodesByLayer = useMemo(() => {
    const grouped = new Map<string, HierarchyNode[]>()
    
    // Initialize all layers
    sortedLayers.forEach((layer) => {
      grouped.set(layer.id, [])
    })
    
    // Flatten hierarchy and assign to layers
    const assignToLayer = (node: HierarchyNode) => {
      const layer = sortedLayers.find((l) => l.entityTypes.includes(node.typeId))
      if (layer) {
        const layerNodes = grouped.get(layer.id) ?? []
        layerNodes.push(node)
        grouped.set(layer.id, layerNodes)
      }
      // Assign children to their respective layers
      node.children.forEach(assignToLayer)
    }
    
    hierarchyTree.forEach(assignToLayer)
    
    return grouped
  }, [hierarchyTree, sortedLayers])
  
  // Flatten nodes for search
  const flatNodes = useMemo(() => {
    const flat: HierarchyNode[] = []
    const traverse = (node: HierarchyNode) => {
      flat.push(node)
      node.children.forEach(traverse)
    }
    hierarchyTree.forEach(traverse)
    return flat
  }, [hierarchyTree])
  
  // Search results
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return []
    const query = searchQuery.toLowerCase()
    return flatNodes.filter((node) => 
      node.name.toLowerCase().includes(query) ||
      node.typeId.toLowerCase().includes(query)
    )
  }, [searchQuery, flatNodes])
  
  // Toggle node expansion
  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }, [])
  
  // Expand all / collapse all
  const expandAll = useCallback(() => {
    const allIds = flatNodes.map((n) => n.id)
    setExpandedNodes(new Set(allIds))
  }, [flatNodes])
  
  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set())
  }, [])

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
      <div className="flex-1 overflow-auto">
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
            />
          ))}
        </div>
      </div>
    </div>
  )
}

interface LayerColumnProps {
  layer: ReferenceModelLayer
  nodes: HierarchyNode[]
  schema: ReturnType<typeof useSchemaStore.getState>['schema']
  selectedNodeId: string | null
  expandedNodes: Set<string>
  searchResults: string[]
  onSelect: (id: string) => void
  onToggle: (id: string) => void
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
            />
          ))
        )}
      </div>
    </div>
  )
}

interface LayerNodeCardProps {
  node: HierarchyNode
  layer: ReferenceModelLayer
  schema: ReturnType<typeof useSchemaStore.getState>['schema']
  selectedNodeId: string | null
  expandedNodes: Set<string>
  searchResults: string[]
  onSelect: (id: string) => void
  onToggle: (id: string) => void
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
      )}
      style={{
        borderColor: visual?.color ?? layer.color ?? '#6b7280',
        borderLeftWidth: '3px',
        ['--tw-ring-color' as string]: visual?.color ?? layer.color ?? '#6b7280',
      }}
      onClick={() => onSelect(node.id)}
    >
      {/* Node Header */}
      <div className="flex items-center gap-2 px-3 py-2">
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
            {entityType?.name ?? node.typeId}
          </span>
          <h4 className="text-sm font-medium text-ink truncate">{node.name}</h4>
        </div>
        
        {hasChildren && !isExpanded && (
          <span className="text-2xs text-ink-muted px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10">
            +{descendantCount}
          </span>
        )}
      </div>
      
      {/* Expanded Children */}
      <AnimatePresence>
        {hasChildren && isExpanded && (
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
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export default ReferenceModelCanvas

