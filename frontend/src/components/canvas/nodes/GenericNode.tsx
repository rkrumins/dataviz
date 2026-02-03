import { memo, useMemo } from 'react'
import { Handle, Position, type NodeProps, NodeToolbar } from '@xyflow/react'
import * as LucideIcons from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSchemaStore } from '@/store/schema'
import { useLineageExplorationStore } from '@/hooks/useLineageExploration'
// import { usePersonaStore } from '@/store/persona'
import { cn } from '@/lib/utils'
import type { EntityInstance } from '@/types/schema'

// Dynamic icon component
function DynamicIcon({ name, className, style }: { name: string; className?: string; style?: React.CSSProperties }) {
  const IconComponent = (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>>)[name]
  if (!IconComponent) {
    return <LucideIcons.Box className={className} style={style} />
  }
  return <IconComponent className={className} style={style} />
}

interface GenericNodeData extends EntityInstance {
  isExpanded?: boolean
  isLoading?: boolean
  childCount?: number
  // Trace flags
  isTraced?: boolean
  isDimmed?: boolean
  isUpstream?: boolean
  isDownstream?: boolean
  // Layout triggers
  onLoadMore?: () => void
}

import type { Node } from '@xyflow/react'
type GenericNodeProps = NodeProps<Node<Record<string, unknown>>>

/**
 * GenericNode - Renders any entity type based on schema configuration
 * 
 * This is the single node component that replaces all hardcoded node types.
 * It reads the entity type schema and renders accordingly.
 */
export const GenericNode = memo(function GenericNode({
  id,
  data,
  selected,
  dragging,
  isConnectable,
}: GenericNodeProps) {
  // Handle both nested (data.data) and flat (data) structures
  const rawData = (data as Record<string, unknown>)
  const entityData: GenericNodeData = rawData.data
    ? (rawData.data as GenericNodeData)
    : (rawData as unknown as GenericNodeData)

  const { isTraced, isDimmed, isUpstream, isDownstream } = entityData


  const loadMoreNodes = useLineageExplorationStore((s) => s.loadMoreNodes)
  const toggleExpanded = useLineageExplorationStore((s) => s.toggleExpanded)

  const hiddenCount = (entityData as any)._hiddenCount || 0
  const paginationId = (entityData as any)._paginationId


  // Support both typeId and type fields
  const typeId = entityData.typeId || (entityData as unknown as Record<string, unknown>).type as string || 'unknown'

  const getEntityType = useSchemaStore((s) => s.getEntityType)
  const getEntityVisual = useSchemaStore((s) => s.getEntityVisual)
  // const mode = usePersonaStore((s) => s.mode)

  const entityType = getEntityType(typeId)
  const visual = getEntityVisual(typeId)

  if (!entityType || !visual) {
    return <FallbackNode data={entityData} selected={!!selected} />
  }

  // Get fields to display in the node
  const visibleFields = useMemo(() => {
    return entityType.fields
      .filter((f) => f.showInNode)
      .sort((a, b) => a.displayOrder - b.displayOrder)
  }, [entityType.fields])

  // Get the primary label - handle both nested and flat structures
  const entityFields = (entityData.data || entityData) as Record<string, unknown>
  const primaryLabel = entityFields['name'] as string ||
    entityFields['label'] as string ||
    entityFields['businessLabel'] as string ||
    entityData.id || 'Unknown'
  // const secondaryLabel = mode === 'technical'
  //   ? (entityFields['urn'] as string)
  //   : (entityFields['description'] as string)

  // Size classes
  const sizeClasses = {
    xs: 'min-w-[100px] max-w-[140px] px-2 py-1.5',
    sm: 'min-w-[140px] max-w-[180px] px-2.5 py-2',
    md: 'min-w-[180px] max-w-[240px] px-3 py-2.5',
    lg: 'min-w-[220px] max-w-[300px] px-4 py-3',
    xl: 'min-w-[280px] max-w-[380px] px-5 py-4',
  }

  // Shape classes
  const shapeClasses = {
    rectangle: 'rounded-md',
    rounded: 'rounded-xl',
    pill: 'rounded-full',
    diamond: 'rounded-lg rotate-0', // Would need special handling
    hexagon: 'rounded-lg', // Would need clip-path
    circle: 'rounded-full aspect-square',
  }

  // Border style classes
  const borderClasses = {
    solid: 'border-2',
    dashed: 'border-2 border-dashed',
    dotted: 'border-2 border-dotted',
    none: 'border-0',
  }

  const isGhost = entityType.id === 'ghost'
  const isExpandable = entityType.behavior.expandable && ((entityData.childCount ?? 0) > 0)

  return (
    <>
      {/* Node Toolbar (appears on selection) */}
      {entityType.behavior.traceable && (
        <NodeToolbar
          isVisible={!!selected}
          position={Position.Top}
          className="flex items-center gap-1 glass-panel-subtle rounded-lg p-1"
        >
          <ToolbarButton icon="ArrowUpRight" label="Trace Upstream" />
          <ToolbarButton icon="ArrowDownLeft" label="Trace Downstream" />
          <div className="w-px h-4 bg-glass-border mx-0.5" />
          <ToolbarButton icon="Pin" label="Pin" />
          <ToolbarButton icon="MoreHorizontal" label="More" />
        </NodeToolbar>
      )}

      {/* Input Handle */}
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={isConnectable}
        className={cn(
          "!w-2.5 !h-2.5 !rounded-full !border-2",
          "!bg-canvas-elevated transition-colors",
          isGhost ? "!border-dashed" : ""
        )}
        style={{ borderColor: visual.color }}
      />

      {/* Node Content */}
      <div
        className={cn(
          "relative transition-all duration-200",
          sizeClasses[visual.size],
          shapeClasses[visual.shape],
          borderClasses[visual.borderStyle],
          "bg-canvas-elevated",
          !!selected && "ring-2 ring-offset-2",
          !!dragging && "opacity-80 cursor-grabbing",
          isGhost && "opacity-60",
          // Trace Styling
          isDimmed && "opacity-40 grayscale-[0.5] blur-[0.5px]",
          isTraced && "shadow-[0_0_20px_rgba(59,130,246,0.5)] ring-2 ring-blue-500 border-blue-500 scale-[1.02] z-50",
          !isTraced && selected && "ring-2 ring-offset-2"
        )}
        style={{
          borderColor: isTraced ? '#3b82f6' : visual.color,
          borderLeftWidth: visual.borderStyle !== 'none' ? '4px' : undefined,
          boxShadow: isTraced
            ? `0 0 20px rgba(59,130,246,0.4)`
            : selected
              ? `0 0 20px ${visual.color}40`
              : '0 4px 12px rgba(0,0,0,0.1)',
          ['--ring-color' as string]: isTraced ? '#3b82f6' : visual.color,
        }}
        // Add data attributes for testing/debugging
        data-traced={isTraced}
        data-dimmed={isDimmed}
        data-upstream={isUpstream}
        data-downstream={isDownstream}
      >
        {/* Header */}
        <div className="flex items-start gap-2">
          {/* Icon */}
          <div
            className={cn(
              "flex-shrink-0 rounded-lg flex items-center justify-center",
              visual.size === 'xs' ? 'w-5 h-5' :
                visual.size === 'sm' ? 'w-6 h-6' :
                  visual.size === 'md' ? 'w-8 h-8' :
                    visual.size === 'lg' ? 'w-10 h-10' : 'w-12 h-12'
            )}
            style={{ backgroundColor: `${visual.color}15` }}
          >
            <DynamicIcon
              name={visual.icon}
              className={cn(
                visual.size === 'xs' ? 'w-3 h-3' :
                  visual.size === 'sm' ? 'w-3.5 h-3.5' :
                    visual.size === 'md' ? 'w-4 h-4' :
                      visual.size === 'lg' ? 'w-5 h-5' : 'w-6 h-6'
              )}
              style={{ color: visual.color }}
            />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Type Badge */}
            <span
              className="text-2xs font-medium uppercase tracking-wider"
              style={{ color: visual.color }}
            >
              {entityType.name}
            </span>

            {/* Primary Label */}
            <h3 className={cn(
              "font-medium text-ink leading-tight truncate",
              visual.size === 'xs' ? 'text-xs' :
                visual.size === 'sm' ? 'text-sm' : 'text-sm'
            )}>
              {primaryLabel}
            </h3>
          </div>

          {/* Expand Button */}
          {isExpandable && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleExpanded(id)
              }}
              className={cn(
                "w-5 h-5 rounded flex items-center justify-center",
                "hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              )}
            >
              <DynamicIcon
                name={entityData.isExpanded ? "ChevronDown" : "ChevronRight"}
                className="w-3 h-3 text-ink-muted"
              />
            </button>
          )}
        </div>

        {/* Dynamic Fields */}
        {visibleFields.length > 1 && visual.size !== 'xs' && (
          <div className="mt-2 space-y-1">
            {visibleFields.slice(1).map((field) => (
              <FieldRenderer
                key={field.id}
                field={field}
                value={entityFields[field.id]}
                color={visual.color}
                size={visual.size}
              />
            ))}
          </div>
        )}

        {/* Roll-up Summary */}
        {entityType.hierarchy.rollUpFields.length > 0 && entityData._computed?.rollUps && (
          <div className="mt-2 pt-2 border-t border-glass-border">
            <div className="flex items-center gap-3 text-2xs text-ink-muted">
              {entityType.hierarchy.rollUpFields.map((rollUp) => (
                <span key={rollUp.targetField}>
                  {String(entityData._computed?.rollUps[rollUp.targetField])} {rollUp.label}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Child Count for collapsed nodes */}
        {entityData.childCount && !entityData.isExpanded && (
          <div className="mt-2 text-2xs text-ink-muted">
            {entityData.childCount} {entityData.childCount === 1 ? 'child' : 'children'}
          </div>
        )}

        {/* Loading State */}
        <AnimatePresence>
          {entityData.isLoading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex items-center justify-center bg-canvas-elevated/80 rounded-xl"
            >
              <LucideIcons.Loader2 className="w-5 h-5 animate-spin" style={{ color: visual.color }} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Load More Button */}
        {hiddenCount > 0 && (
          <button
            title={`Load ${hiddenCount} more items`}
            className={cn(
              "absolute -bottom-2 -right-2 w-6 h-6 rounded-full flex items-center justify-center",
              "bg-canvas-elevated shadow-md border-2",
              "hover:scale-110 transition-transform cursor-pointer"
            )}
            style={{ borderColor: visual.color }}
            onClick={(e) => {
              e.stopPropagation()
              if (paginationId) {
                // Trigger layout stabilization anchor
                entityData.onLoadMore?.()
                loadMoreNodes(paginationId, 5)
              }
            }}
          >
            <LucideIcons.Plus className="w-3.5 h-3.5" style={{ color: visual.color }} />
          </button>
        )}
      </div>

      {/* Output Handle */}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={isConnectable}
        className={cn(
          "!w-2.5 !h-2.5 !rounded-full !border-2",
          "!bg-canvas-elevated transition-colors",
          isGhost ? "!border-dashed" : ""
        )}
        style={{ borderColor: visual.color }}
      />
    </>
  )
})

// Field Renderer Component
interface FieldRendererProps {
  field: { id: string; name: string; type: string; format?: unknown }
  value: unknown
  color: string
  size: string
}

function FieldRenderer({ field, value, color, size }: FieldRendererProps) {
  if (value === undefined || value === null) return null

  switch (field.type) {
    case 'tags':
      const tags = value as string[]
      return (
        <div className="flex flex-wrap gap-1">
          {tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 rounded text-2xs font-medium"
              style={{ backgroundColor: `${color}15`, color }}
            >
              {tag}
            </span>
          ))}
          {tags.length > 3 && (
            <span className="text-2xs text-ink-muted">+{tags.length - 3}</span>
          )}
        </div>
      )

    case 'badge':
      return (
        <span
          className="inline-block px-1.5 py-0.5 rounded text-2xs font-medium"
          style={{ backgroundColor: `${color}15`, color }}
        >
          {String(value)}
        </span>
      )

    case 'progress':
      const progress = Number(value)
      return (
        <div className="space-y-0.5">
          <div className="flex items-center justify-between text-2xs">
            <span className="text-ink-muted">{field.name}</span>
            <span className={cn(
              "font-medium",
              progress >= 80 ? "text-green-500" :
                progress >= 50 ? "text-amber-500" : "text-red-500"
            )}>
              {Math.round(progress)}%
            </span>
          </div>
          {size !== 'xs' && size !== 'sm' && (
            <div className="h-1 bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  progress >= 80 ? "bg-green-500" :
                    progress >= 50 ? "bg-amber-500" : "bg-red-500"
                )}
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      )

    case 'status':
      const format = field.format as { statusColors?: Record<string, string> }
      const statusColor = format?.statusColors?.[String(value)] || color
      return (
        <div className="flex items-center gap-1.5">
          <div
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: statusColor }}
          />
          <span className="text-2xs font-medium capitalize">{String(value)}</span>
        </div>
      )

    case 'urn':
      return (
        <code className="block text-2xs font-mono text-ink-muted bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded truncate">
          {String(value)}
        </code>
      )

    case 'number':
      const numFormat = (field.format as { numberFormat?: string })?.numberFormat
      let displayNum = String(value)
      if (numFormat === 'compact') {
        displayNum = Intl.NumberFormat('en', { notation: 'compact' }).format(Number(value))
      } else if (numFormat === 'percentage') {
        displayNum = `${value}%`
      }
      return (
        <span className="text-2xs text-ink-secondary">{displayNum}</span>
      )

    default:
      return (
        <span className="text-2xs text-ink-secondary truncate">
          {String(value)}
        </span>
      )
  }
}

// Toolbar Button Component
function ToolbarButton({ icon, label }: { icon: string; label: string }) {
  return (
    <button
      title={label}
      className={cn(
        "w-7 h-7 rounded-md flex items-center justify-center",
        "text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/10",
        "transition-colors"
      )}
    >
      <DynamicIcon name={icon} className="w-3.5 h-3.5" />
    </button>
  )
}

// Fallback Node for unknown types
function FallbackNode({ data, selected }: { data: GenericNodeData; selected: boolean }) {
  return (
    <>
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-gray-400" />
      <div className={cn(
        "px-3 py-2 rounded-lg border-2 border-dashed border-gray-400",
        "bg-canvas-elevated",
        selected && "ring-2 ring-offset-2 ring-gray-400"
      )}>
        <div className="flex items-center gap-2">
          <LucideIcons.HelpCircle className="w-4 h-4 text-gray-400" />
          <span className="text-sm text-gray-500">Unknown: {data.typeId || (data as any).type}</span>
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-gray-400" />
    </>
  )
}

