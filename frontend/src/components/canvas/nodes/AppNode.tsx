import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Box, Database, GitBranch, Activity } from 'lucide-react'
import { usePersonaStore } from '@/store/persona'
import { cn } from '@/lib/utils'
import type { LineageNode } from '@/store/canvas'

type AppNodeProps = NodeProps<LineageNode>

export const AppNode = memo(function AppNode({
  data,
  selected,
  dragging
}: AppNodeProps) {
  const mode = usePersonaStore((s) => s.mode)

  const label = mode === 'business'
    ? (data.businessLabel || data.label)
    : (data.technicalLabel || data.label)

  // Determine icon based on metadata
  const getIcon = () => {
    const appType = data.metadata?.appType as string
    switch (appType) {
      case 'database':
        return Database
      case 'pipeline':
        return GitBranch
      case 'service':
        return Activity
      default:
        return Box
    }
  }
  const Icon = getIcon()

  return (
    <>
      {/* Input Handle */}
      <Handle
        type="target"
        position={Position.Left}
        className={cn(
          "!w-2.5 !h-2.5 !rounded-full !border-2 !border-cyan-500",
          "!bg-canvas-elevated",
          "hover:!bg-cyan-500 transition-colors"
        )}
      />

      {/* Node Content */}
      <div
        className={cn(
          "nx-node nx-node-app min-w-[180px] max-w-[240px]",
          "px-3 py-2.5",
          selected && "selected",
          dragging && "opacity-80 cursor-grabbing"
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5">
          {/* Icon */}
          <div className={cn(
            "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0",
            "bg-cyan-500/10"
          )}>
            <Icon className="w-4 h-4 text-cyan-500" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <span className="text-2xs font-medium text-cyan-500 uppercase tracking-wider">
              Application
            </span>
            <h3 className="font-medium text-sm text-ink leading-tight truncate">
              {label}
            </h3>
          </div>
        </div>

        {/* Confidence Indicator */}
        {data.confidence !== undefined && (
          <div className="mt-2">
            <div className="flex items-center justify-between text-2xs mb-1">
              <span className="text-ink-muted">Confidence</span>
              <span className={cn(
                "font-medium",
                data.confidence >= 0.8 ? "text-green-500" :
                  data.confidence >= 0.5 ? "text-amber-500" : "text-red-500"
              )}>
                {Math.round(data.confidence * 100)}%
              </span>
            </div>
            <div className="h-1 bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  data.confidence >= 0.8 ? "bg-green-500" :
                    data.confidence >= 0.5 ? "bg-amber-500" : "bg-red-500"
                )}
                style={{ width: `${data.confidence * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Technical URN */}
        {mode === 'technical' && data.urn && (
          <div className="mt-2">
            <code className="text-2xs font-mono text-ink-muted bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded block truncate">
              {data.urn}
            </code>
          </div>
        )}

        {/* Quick Stats */}
        {data.metadata && (
          <div className="mt-2 flex items-center gap-3 text-2xs text-ink-muted">
            {data.metadata.assetCount !== undefined && (
              <span>{data.metadata.assetCount} assets</span>
            )}
            {data.metadata.lastUpdated && (
              <span>{data.metadata.lastUpdated as string}</span>
            )}
          </div>
        )}
      </div>

      {/* Output Handle */}
      <Handle
        type="source"
        position={Position.Right}
        className={cn(
          "!w-2.5 !h-2.5 !rounded-full !border-2 !border-cyan-500",
          "!bg-canvas-elevated",
          "hover:!bg-cyan-500 transition-colors"
        )}
      />
    </>
  )
})

