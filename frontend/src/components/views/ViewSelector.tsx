import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { useSchemaStore } from '@/store/schema'
import type { ViewConfiguration } from '@/types/schema'
import { cn } from '@/lib/utils'

// Dynamic icon component
function DynamicIcon({ name, className }: { name: string; className?: string }) {
  const IconComponent = (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[name]
  if (!IconComponent) {
    return <LucideIcons.Layout className={className} />
  }
  return <IconComponent className={className} />
}

interface ViewSelectorProps {
  onCreateView?: () => void
  onEditView?: (viewId: string) => void
}

export function ViewSelector({ onCreateView, onEditView }: ViewSelectorProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const visibleViews = useSchemaStore((s) => s.visibleViews)
  const activeViewId = useSchemaStore((s) => s.activeViewId)
  const setActiveView = useSchemaStore((s) => s.setActiveView)

  const views = visibleViews()
  const activeView = views.find((v) => v.id === activeViewId)
    ?? views[0]  // Fall back to first visible view if active view is out-of-scope

  return (
    <div className="relative">
      {/* Current View Button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg",
          "bg-accent-lineage/10 text-accent-lineage",
          "hover:bg-accent-lineage/15 transition-colors"
        )}
      >
        {activeView && (
          <>
            <DynamicIcon name={activeView.icon || 'Layout'} className="w-5 h-5" />
            <div className="flex-1 text-left">
              <span className="text-sm font-medium block">{activeView.name}</span>
              <span className="text-2xs text-accent-lineage/70">
                {activeView.content.visibleEntityTypes.length} entity types
              </span>
            </div>
          </>
        )}
        <LucideIcons.ChevronDown
          className={cn(
            "w-4 h-4 transition-transform",
            isExpanded && "rotate-180"
          )}
        />
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className={cn(
              "absolute top-full left-0 mt-2 z-[100]",
              "w-72 bg-canvas-elevated border border-glass-border rounded-xl shadow-lg overflow-hidden"
            )}
            style={{ backdropFilter: 'blur(16px)' }}
          >
            {/* View List */}
            <div className="p-2 max-h-[300px] overflow-y-auto custom-scrollbar">
              <div className="text-2xs font-medium text-ink-muted uppercase tracking-wider px-2 py-1">
                Available Views
              </div>

              {views.map((view) => (
                <ViewItem
                  key={view.id}
                  view={view}
                  isActive={view.id === activeViewId}
                  onClick={() => {
                    setActiveView(view.id)
                    setIsExpanded(false)
                  }}
                  onEdit={() => onEditView?.(view.id)}
                />
              ))}
            </div>

            {/* Actions */}
            <div className="p-2 border-t border-glass-border">
              <button
                onClick={() => {
                  onCreateView?.()
                  setIsExpanded(false)
                }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 rounded-lg",
                  "text-sm text-ink-secondary",
                  "hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                )}
              >
                <LucideIcons.Plus className="w-4 h-4" />
                Create New View
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Backdrop */}
      {isExpanded && (
        <div
          className="fixed inset-0 z-[99]"
          onClick={() => setIsExpanded(false)}
        />
      )}
    </div>
  )
}

interface ViewItemProps {
  view: ViewConfiguration
  isActive: boolean
  onClick: () => void
  onEdit?: () => void
}

function ViewItem({ view, isActive, onClick, onEdit }: ViewItemProps) {
  return (
    <div
      className={cn(
        "group flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer",
        "transition-colors",
        isActive
          ? "bg-accent-lineage/10 text-accent-lineage"
          : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink"
      )}
      onClick={onClick}
    >
      <DynamicIcon
        name={view.icon || 'Layout'}
        className={cn(
          "w-4 h-4",
          isActive ? "text-accent-lineage" : "text-ink-muted"
        )}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{view.name}</span>
          {view.isDefault && (
            <span className="px-1.5 py-0.5 text-2xs bg-accent-lineage/10 text-accent-lineage rounded">
              Default
            </span>
          )}
        </div>
        {view.description && (
          <p className="text-2xs text-ink-muted truncate">{view.description}</p>
        )}
      </div>

      {/* Edit Button */}
      {onEdit && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onEdit()
          }}
          className={cn(
            "opacity-0 group-hover:opacity-100",
            "w-6 h-6 rounded flex items-center justify-center",
            "text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10",
            "transition-all"
          )}
        >
          <LucideIcons.Settings className="w-3 h-3" />
        </button>
      )}

      {/* Active Indicator */}
      {isActive && (
        <LucideIcons.Check className="w-4 h-4 text-accent-lineage" />
      )}
    </div>
  )
}

/**
 * Compact View Selector for constrained spaces
 */
export function ViewSelectorCompact() {
  const visibleViews = useSchemaStore((s) => s.visibleViews)
  const activeViewId = useSchemaStore((s) => s.activeViewId)
  const setActiveView = useSchemaStore((s) => s.setActiveView)

  const views = visibleViews()

  return (
    <div className="flex items-center gap-1 p-1 rounded-lg bg-black/5 dark:bg-white/5">
      {views.map((view) => (
        <button
          key={view.id}
          onClick={() => setActiveView(view.id)}
          title={view.name}
          className={cn(
            "px-3 py-1.5 rounded-md text-sm font-medium transition-all",
            view.id === activeViewId
              ? "bg-accent-lineage text-white"
              : "text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
          )}
        >
          {view.name}
        </button>
      ))}
    </div>
  )
}

