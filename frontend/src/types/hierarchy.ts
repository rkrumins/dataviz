/**
 * Shared hierarchy types used across all canvas types.
 *
 * HierarchyNode is the canonical representation of an entity within
 * a containment hierarchy. It is produced by useContainmentHierarchy
 * and consumed by shared hooks like useEdgeProjection, useHighlightState,
 * useHoverHighlight, and useLayerAssignment.
 */

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
