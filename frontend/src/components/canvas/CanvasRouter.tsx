/**
 * CanvasRouter - Switches between different canvas types based on active view
 * 
 * Renders the appropriate canvas component based on the view's layout type:
 * - 'graph' → LineageCanvas (React Flow graph)
 * - 'hierarchy' | 'tree' → HierarchyCanvas (Hierarchy-style nested view)
 * - 'list' → ListView (tabular representation)
 * - 'grid' → GridView (card grid)
 */

import { Suspense, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { useSchemaStore } from '@/store/schema'
import { LineageCanvas } from './LineageCanvas'
import { HierarchyCanvas } from './HierarchyCanvas'
import { ReferenceModelCanvas } from './ReferenceModelCanvas'
import { LayeredLineageCanvas } from './LayeredLineageCanvas'
import { cn } from '@/lib/utils'

interface CanvasRouterProps {
  className?: string
}

export function CanvasRouter({ className }: CanvasRouterProps) {
  const activeView = useSchemaStore((s) => s.getActiveView())
  const layoutType = activeView?.layout.type ?? 'graph'

  // Memoize canvas selection based on view layout type
  const CanvasComponent = useMemo(() => {
    // Also check view ID for specific handling
    const viewId = activeView?.id ?? ''

    // Layered lineage view combines layers with lineage flow
    if (viewId === 'layered-lineage' || layoutType === 'layered-lineage') {
      return LayeredLineageCanvas
    }

    // Reference model view gets special horizontal layer layout
    if (viewId === 'reference-model' || layoutType === 'reference') {
      return ReferenceModelCanvas
    }

    switch (layoutType) {
      case 'hierarchy':
      case 'tree':
        return HierarchyCanvas
      case 'graph':
      default:
        return LineageCanvas
    }
  }, [layoutType, activeView?.id])

  return (
    <div className={cn("relative w-full h-full", className)}>
      {/* View Type Indicator */}
      <AnimatePresence>
        <motion.div
          key={layoutType}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="absolute inset-0"
        >
          <Suspense fallback={<CanvasLoader />}>
            <CanvasComponent />
          </Suspense>
        </motion.div>
      </AnimatePresence>

      {/* Active View Badge - Only for non-graph views (LineageCanvas has its own toolbar) */}
      {activeView && layoutType !== 'graph' && (
        <div className="absolute top-4 left-4 z-10 pointer-events-none">
          <ViewBadge
            name={activeView.name}
            layoutType={layoutType}
            entityCount={activeView.content.visibleEntityTypes.length}
          />
        </div>
      )}
    </div>
  )
}

function CanvasLoader() {
  return (
    <div className="w-full h-full flex items-center justify-center bg-canvas">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-accent-lineage" />
        <span className="text-sm text-ink-muted">Loading view...</span>
      </div>
    </div>
  )
}

interface ViewBadgeProps {
  name: string
  layoutType: string
  entityCount: number
}

function ViewBadge({ name, layoutType, entityCount }: ViewBadgeProps) {
  const layoutLabels: Record<string, string> = {
    graph: 'Graph',
    hierarchy: 'Hierarchy',
    tree: 'Tree',
    list: 'List',
    grid: 'Grid',
    timeline: 'Timeline',
    'layered-lineage': 'Layered Lineage',
    reference: 'Reference Model',
  }

  return (
    <div className="flex items-center gap-2">
      <div className="glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2">
        <span className="text-sm font-medium text-ink">{name}</span>
        <span className="px-1.5 py-0.5 rounded text-2xs font-medium bg-accent-lineage/10 text-accent-lineage">
          {layoutLabels[layoutType] ?? layoutType}
        </span>
        <span className="text-2xs text-ink-muted">
          {entityCount} types
        </span>
      </div>
    </div>
  )
}

export default CanvasRouter

