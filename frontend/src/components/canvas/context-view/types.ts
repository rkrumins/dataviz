import type { EntityType } from '@/providers/GraphDataProvider'
import type { LogicalNodeConfig } from '@/types/schema'

export interface HierarchyNode {
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

export interface FlatTreeNode {
  node: HierarchyNode
  depth: number
  isLast: boolean
  parentIsLast: boolean[]  // Track which parents are "last" for proper tree lines
  isLoadMore?: boolean
  loadMoreCount?: number
  isSearchBox?: boolean
  isSkeleton?: boolean
  skeletonIndex?: number
}

export type ComputedEdge = {
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
