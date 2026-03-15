/**
 * CanvasRouter - Switches between different canvas types based on active view
 * 
 * Renders the appropriate canvas component based on the view's layout type:
 * - 'graph' → LineageCanvas (React Flow graph)
 * - 'hierarchy' | 'tree' → HierarchyCanvas (Hierarchy-style nested view)
 * - 'list' → ListView (tabular representation)
 * - 'grid' → GridView (card grid)
 */

import { Suspense, useMemo, useEffect, useRef } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { useSchemaStore, useRootEntityTypes, useSchemaIsLoading } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { useGraphProvider } from '@/providers/GraphProviderContext'
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

  // Load root nodes the first time this canvas mounts (or when the provider changes).
  // Only fetches root-level entities — children are loaded lazily via useEntityLoader.
  // This replaces the old AppLayout fetchInitialGraph which fired on every route.
  const rawNodes = useCanvasStore((s) => s.nodes)
  const { setNodes, setEdges } = useCanvasStore()
  const provider = useGraphProvider()
  const rootEntityTypes = useRootEntityTypes()
  const isLoadingOntology = useSchemaIsLoading()
  const initializedForRef = useRef<typeof provider | null>(null)

  useEffect(() => {
    // Wait for the ontology to load so we know the true root entity types.
    if (isLoadingOntology || rootEntityTypes.length === 0) return
    if (rawNodes.length > 0 && initializedForRef.current === provider) return
    if (initializedForRef.current === provider) return
    initializedForRef.current = provider

    provider.getNodes({ entityTypes: rootEntityTypes as any[], limit: 200 })
      .then(rootNodes => {
        if (!rootNodes.length) return
        setNodes(rootNodes.map(n => ({
          id: n.urn,
          type: 'generic',
          position: { x: Math.random() * 800, y: Math.random() * 600 },
          data: {
            label: n.displayName,
            type: n.entityType as any,
            urn: n.urn,
            metadata: n.properties,
            childCount: n.childCount,
            classifications: n.tags,
            businessLabel: (n.properties?.businessLabel as string) ?? undefined,
            ...n,
          },
        })))
        setEdges([])
      })
      .catch(err => console.error('[CanvasRouter] Failed to load initial nodes:', err))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, rootEntityTypes, isLoadingOntology])

  // Memoize canvas selection based on view layout type
  const CanvasComponent = useMemo(() => {
    // Layered lineage view combines layers with lineage flow
    if (layoutType === 'layered-lineage') {
      return LayeredLineageCanvas
    }

    // Reference model view gets special horizontal layer layout
    if (layoutType === 'reference') {
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
  }, [layoutType])

  return (
    <ReactFlowProvider>
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
    </ReactFlowProvider>
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
    reference: 'Context View',
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

