/**
 * NodePreview — live preview of a type's ACTUAL canvas artifact.
 *
 * Renders one real GenericNode inside a static, non-interactive React Flow
 * instance, fed the editor's live (unsaved) form state through
 * StaticViewSchemaProvider — so what you see while picking icon/color/shape
 * is exactly what the canvas will render, not an approximation.
 */
import { useMemo } from 'react'
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react'
import { GenericNode } from '@/components/canvas/nodes/GenericNode'
import { StaticViewSchemaProvider, type ResolvedViewSchema } from '@/providers/ViewExecutionContext'
import type { EntityTypeSchema } from '@/types/schema'

const nodeTypes = { generic: GenericNode }

interface NodePreviewProps {
  /** The live (unsaved) form state of the type being edited. */
  entityType: EntityTypeSchema
}

export function NodePreview({ entityType }: NodePreviewProps) {
  const schema = useMemo((): ResolvedViewSchema => ({
    entityTypes: [entityType],
    relationshipTypes: [],
    containmentEdgeTypes: [],
    lineageEdgeTypes: [],
    rootEntityTypes: [],
  }), [entityType])

  const nodes = useMemo((): Node[] => [{
    id: '__preview__',
    type: 'generic',
    position: { x: 0, y: 0 },
    draggable: false,
    selectable: false,
    data: {
      id: '__preview__',
      typeId: entityType.id,
      name: entityType.name || 'Example',
      data: { name: entityType.name ? `Example ${entityType.name}` : 'Example Entity' },
    },
  }], [entityType.id, entityType.name])

  return (
    <StaticViewSchemaProvider schema={schema}>
      <div className="h-32 rounded-xl overflow-hidden pointer-events-none" aria-hidden>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={[]}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            panOnDrag={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
            style={{ background: 'transparent' }}
          />
        </ReactFlowProvider>
      </div>
    </StaticViewSchemaProvider>
  )
}
