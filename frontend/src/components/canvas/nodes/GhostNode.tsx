import { memo, useCallback, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { ChevronDown, Loader2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LineageNode } from '@/store/canvas'
import { useLineageExplorationStore } from '@/hooks/useLineageExploration'

type GhostNodeProps = NodeProps<LineageNode>

/**
 * GhostNode - "Load More" placeholder for paginated children
 * 
 * Displays count of hidden nodes and handles click to expand.
 * Properly positioned by ELK layout engine.
 */
export const GhostNode = memo(function GhostNode({
  data,
  selected,
}: GhostNodeProps) {
  const [isLoading, setIsLoading] = useState(false)

  // Extract data from node - cast through unknown to access ghost-specific properties
  const nodeData = data as unknown as Record<string, unknown>
  const nodeCount = (nodeData.hiddenCount as number) || (nodeData.nodeCount as number) || 0
  const parentId = nodeData.parentId as string | undefined
  const entityType = nodeData.entityType as string | undefined

  // Get loadMoreNodes action from exploration store
  const loadMoreNodes = useLineageExplorationStore((s) => s.loadMoreNodes)

  const handleClick = useCallback(() => {
    if (!parentId || isLoading) return

    setIsLoading(true)

    // Load more nodes for this parent
    // The default increment is 5, but could be configurable
    loadMoreNodes(parentId, 5)

    // Reset loading after a brief delay (layout will re-render anyway)
    setTimeout(() => setIsLoading(false), 300)
  }, [parentId, isLoading, loadMoreNodes])

  // Determine label based on entity type
  const typeLabel = entityType ? getTypePluralLabel(entityType) : 'items'

  return (
    <>
      {/* Input Handle */}
      <Handle
        type="target"
        position={Position.Left}
        className={cn(
          "!w-2 !h-2 !rounded-full",
          "!border-2 !border-dashed !border-slate-400/60",
          "!bg-slate-50 dark:!bg-slate-800"
        )}
      />

      {/* Node Content */}
      <div
        onClick={handleClick}
        className={cn(
          "px-3 py-2 rounded-lg cursor-pointer transition-all",
          "bg-gradient-to-r from-slate-100 to-slate-50",
          "dark:from-slate-800 dark:to-slate-700",
          "border border-dashed border-slate-300 dark:border-slate-600",
          "hover:border-slate-400 hover:from-slate-200 hover:to-slate-100",
          "dark:hover:border-slate-500 dark:hover:from-slate-700 dark:hover:to-slate-600",
          "min-w-[140px]",
          selected && "!border-accent-lineage !border-solid ring-2 ring-accent-lineage/20",
          isLoading && "opacity-80 pointer-events-none"
        )}
      >
        <div className="flex items-center justify-center gap-2">
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 text-accent-lineage animate-spin" />
              <span className="text-sm text-slate-500 dark:text-slate-400">
                Loading...
              </span>
            </>
          ) : (
            <>
              <div className="flex items-center justify-center w-6 h-6 rounded-full bg-accent-lineage/10">
                <Plus className="w-3.5 h-3.5 text-accent-lineage" />
              </div>
              <div className="flex flex-col items-start">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  +{nodeCount} more
                </span>
                <span className="text-2xs text-slate-400 dark:text-slate-500">
                  {typeLabel}
                </span>
              </div>
              <ChevronDown className="w-4 h-4 text-slate-400 ml-auto" />
            </>
          )}
        </div>
      </div>

      {/* Output Handle */}
      <Handle
        type="source"
        position={Position.Right}
        className={cn(
          "!w-2 !h-2 !rounded-full",
          "!border-2 !border-dashed !border-slate-400/60",
          "!bg-slate-50 dark:!bg-slate-800"
        )}
      />
    </>
  )
})

/**
 * Get plural label for entity type
 */
function getTypePluralLabel(entityType: string): string {
  const plurals: Record<string, string> = {
    domain: 'domains',
    system: 'systems',
    schema: 'schemas',
    table: 'tables',
    column: 'columns',
    app: 'applications',
    asset: 'assets',
    dataset: 'datasets',
    dashboard: 'dashboards',
    pipeline: 'pipelines',
  }
  return plurals[entityType.toLowerCase()] || `${entityType}s`
}
