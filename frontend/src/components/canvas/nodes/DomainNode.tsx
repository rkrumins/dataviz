import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { FolderTree, ChevronRight, Users } from 'lucide-react'
import { usePersonaStore } from '@/store/persona'
import { cn } from '@/lib/utils'
import type { LineageNode } from '@/store/canvas'

type DomainNodeProps = NodeProps<LineageNode>

export const DomainNode = memo(function DomainNode({ 
  data, 
  selected,
  dragging 
}: DomainNodeProps) {
  const mode = usePersonaStore((s) => s.mode)
  
  const label = mode === 'business' 
    ? (data.businessLabel || data.label) 
    : (data.technicalLabel || data.label)

  return (
    <>
      {/* Input Handle */}
      <Handle
        type="target"
        position={Position.Left}
        className={cn(
          "!w-3 !h-3 !rounded-full !border-2 !border-purple-500",
          "!bg-canvas-elevated",
          "hover:!bg-purple-500 transition-colors"
        )}
      />

      {/* Node Content */}
      <div
        className={cn(
          "nx-node nx-node-domain min-w-[200px] max-w-[280px]",
          "px-4 py-3",
          selected && "selected",
          dragging && "opacity-80 cursor-grabbing"
        )}
      >
        {/* Header */}
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div className={cn(
            "w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0",
            "bg-purple-500/10"
          )}>
            <FolderTree className="w-5 h-5 text-purple-500" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <span className="text-2xs font-medium text-purple-500 uppercase tracking-wider">
                Domain
              </span>
            </div>
            <h3 className="font-display font-semibold text-sm text-ink leading-tight mt-0.5 truncate">
              {label}
            </h3>
          </div>

          {/* Expand Indicator */}
          <button className={cn(
            "w-6 h-6 rounded-md flex items-center justify-center",
            "hover:bg-purple-500/10 transition-colors",
            "text-ink-muted hover:text-purple-500"
          )}>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Metadata (Business Mode) */}
        {mode === 'business' && data.metadata && (
          <div className="mt-3 pt-3 border-t border-glass-border">
            <div className="flex items-center gap-4 text-xs text-ink-secondary">
              <div className="flex items-center gap-1">
                <Users className="w-3 h-3" />
                <span>{(data.metadata.owners as string[])?.length || 0} Owners</span>
              </div>
              <div className="flex items-center gap-1">
                <FolderTree className="w-3 h-3" />
                <span>{(data.metadata.childCount as number) || 0} Apps</span>
              </div>
            </div>
          </div>
        )}

        {/* Technical URN (Technical Mode) */}
        {mode === 'technical' && data.urn && (
          <div className="mt-2">
            <code className="text-2xs font-mono text-ink-muted bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded">
              {data.urn}
            </code>
          </div>
        )}

        {/* Classifications */}
        {data.classifications && data.classifications.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {data.classifications.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className={cn(
                  "px-1.5 py-0.5 rounded text-2xs font-medium",
                  "bg-purple-500/10 text-purple-600 dark:text-purple-400"
                )}
              >
                {tag}
              </span>
            ))}
            {data.classifications.length > 3 && (
              <span className="text-2xs text-ink-muted">
                +{data.classifications.length - 3}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Output Handle */}
      <Handle
        type="source"
        position={Position.Right}
        className={cn(
          "!w-3 !h-3 !rounded-full !border-2 !border-purple-500",
          "!bg-canvas-elevated",
          "hover:!bg-purple-500 transition-colors"
        )}
      />
    </>
  )
})

