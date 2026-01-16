import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { MoreHorizontal, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LineageNode } from '@/store/canvas'

type GhostNodeProps = NodeProps<LineageNode>

/**
 * GhostNode - Placeholder for nodes that exist outside the current viewport
 * or at a deeper LOD level. Clicking loads more data.
 */
export const GhostNode = memo(function GhostNode({ 
  data,
  selected,
}: GhostNodeProps) {
  const isLoading = data.metadata?.isLoading as boolean
  const nodeCount = data.metadata?.nodeCount as number || 0
  const direction = data.metadata?.direction as 'upstream' | 'downstream' | undefined

  return (
    <>
      {/* Input Handle */}
      <Handle
        type="target"
        position={Position.Left}
        className={cn(
          "!w-2 !h-2 !rounded-full !border-2 !border-dashed !border-slate-400",
          "!bg-transparent"
        )}
      />

      {/* Node Content */}
      <div
        className={cn(
          "nx-node nx-node-ghost",
          "min-w-[120px] px-3 py-2.5",
          "cursor-pointer",
          selected && "!border-accent-lineage !border-solid"
        )}
      >
        <div className="flex items-center justify-center gap-2">
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 text-slate-400 animate-spin" />
              <span className="text-sm text-slate-400">Loading...</span>
            </>
          ) : (
            <>
              <MoreHorizontal className="w-4 h-4 text-slate-400" />
              <div className="text-center">
                <span className="text-sm font-medium text-slate-500 block">
                  {nodeCount > 0 ? `${nodeCount} more` : 'Load more'}
                </span>
                {direction && (
                  <span className="text-2xs text-slate-400">
                    {direction === 'upstream' ? '← Sources' : 'Targets →'}
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {/* Hint text */}
        {!isLoading && (
          <div className="mt-1 text-center">
            <span className="text-2xs text-slate-400">Click to expand</span>
          </div>
        )}
      </div>

      {/* Output Handle */}
      <Handle
        type="source"
        position={Position.Right}
        className={cn(
          "!w-2 !h-2 !rounded-full !border-2 !border-dashed !border-slate-400",
          "!bg-transparent"
        )}
      />
    </>
  )
})

