import { memo } from 'react'
import { Handle, Position, type NodeProps, NodeToolbar } from '@xyflow/react'
import {
  Table2,
  Columns3,
  FileCode,
  Workflow,
  ArrowUpRight,
  ArrowDownLeft,
  Pin,
  MoreHorizontal
} from 'lucide-react'
import { usePersonaStore } from '@/store/persona'
import { cn } from '@/lib/utils'
import type { LineageNode } from '@/store/canvas'

type AssetNodeProps = NodeProps<LineageNode>

export const AssetNode = memo(function AssetNode({
  data,
  selected,
  dragging
}: AssetNodeProps) {
  const mode = usePersonaStore((s) => s.mode)

  const label = mode === 'business'
    ? (data.businessLabel || data.label)
    : (data.technicalLabel || data.label)

  // Determine icon based on asset type
  const getIcon = () => {
    const assetType = data.metadata?.assetType as string
    switch (assetType) {
      case 'table':
        return Table2
      case 'column':
        return Columns3
      case 'pipeline':
        return Workflow
      default:
        return FileCode
    }
  }
  const Icon = getIcon()

  return (
    <>
      {/* Toolbar (appears on selection) */}
      <NodeToolbar
        isVisible={selected}
        position={Position.Top}
        className="flex items-center gap-1 glass-panel-subtle rounded-lg p-1"
      >
        <ToolbarButton icon={ArrowUpRight} label="Trace Upstream" />
        <ToolbarButton icon={ArrowDownLeft} label="Trace Downstream" />
        <div className="w-px h-4 bg-glass-border mx-0.5" />
        <ToolbarButton icon={Pin} label="Pin" />
        <ToolbarButton icon={MoreHorizontal} label="More" />
      </NodeToolbar>

      {/* Input Handle */}
      <Handle
        type="target"
        position={Position.Left}
        className={cn(
          "!w-2 !h-2 !rounded-full !border-2 !border-green-500",
          "!bg-canvas-elevated",
          "hover:!bg-green-500 transition-colors"
        )}
      />

      {/* Node Content */}
      <div
        className={cn(
          "nx-node nx-node-asset min-w-[160px] max-w-[220px]",
          "px-3 py-2",
          selected && "selected",
          dragging && "opacity-80 cursor-grabbing"
        )}
      >
        <div className="flex items-center gap-2">
          {/* Icon */}
          <div className={cn(
            "w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0",
            "bg-green-500/10"
          )}>
            <Icon className="w-3.5 h-3.5 text-green-500" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <span className="text-2xs font-medium text-green-600 dark:text-green-400 uppercase tracking-wider">
              {(data.metadata?.assetType as string) || 'Asset'}
            </span>
            <h3 className="font-medium text-sm text-ink leading-tight truncate">
              {label}
            </h3>
          </div>
        </div>

        {/* Technical Details (Technical Mode) */}
        {mode === 'technical' && (
          <div className="mt-2 space-y-1">
            {data.urn && (
              <code className="text-2xs font-mono text-ink-muted bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded block truncate">
                {data.urn}
              </code>
            )}
            {data.metadata?.schema && (
              <div className="text-2xs text-ink-muted">
                Schema: <span className="text-ink-secondary">{data.metadata.schema as string}</span>
              </div>
            )}
          </div>
        )}

        {/* Classifications */}
        {data.classifications && data.classifications.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {data.classifications.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className={cn(
                  "px-1.5 py-0.5 rounded text-2xs font-medium",
                  "bg-green-500/10 text-green-600 dark:text-green-400"
                )}
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Output Handle */}
      <Handle
        type="source"
        position={Position.Right}
        className={cn(
          "!w-2 !h-2 !rounded-full !border-2 !border-green-500",
          "!bg-canvas-elevated",
          "hover:!bg-green-500 transition-colors"
        )}
      />
    </>
  )
})

interface ToolbarButtonProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  onClick?: () => void
}

function ToolbarButton({ icon: Icon, label, onClick }: ToolbarButtonProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        "w-7 h-7 rounded-md flex items-center justify-center",
        "text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/10",
        "transition-colors"
      )}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  )
}

