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
import { useSchemaStore, useRootEntityTypes, useSchemaIsLoading, useEntityTypes } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { LineageCanvas } from './LineageCanvas'
import { HierarchyCanvas } from './HierarchyCanvas'
import { ReferenceModelCanvas } from './ReferenceModelCanvas'
import { LayeredLineageCanvas } from './LayeredLineageCanvas'
import { cn } from '@/lib/utils'
import type { GraphNode, EntityTypeDefinition } from '@/providers/GraphDataProvider'

/** Max entities per type per fetch. Keeps initial loads manageable. */
const PER_TYPE_LIMIT = 200

function toCanvasNode(n: GraphNode, opts?: { randomPosition?: boolean }) {
  return {
    id: n.urn,
    type: 'generic' as const,
    position: opts?.randomPosition
      ? { x: Math.random() * 800, y: Math.random() * 600 }
      : { x: 0, y: 0 },
    data: {
      label: n.displayName,
      type: n.entityType,
      urn: n.urn,
      metadata: n.properties,
      childCount: n.childCount,
      classifications: n.tags,
      businessLabel: (n.properties?.businessLabel as string) ?? undefined,
      ...n,
    },
  }
}

/**
 * Compute the "view-scoped root types" for a reference/context view.
 *
 * A type is a VIEW ROOT if none of its canBeContainedBy parents appear in
 * the view's visibleEntityTypes set. This correctly handles multiple
 * independent hierarchies coexisting in one graph:
 *
 *   Physical tree:    DataDomain → DataPlatform → System → Table → Column
 *   Reference tree:   Country → Region → City
 *   Governance tree:  SharingPolicy
 *
 * For visibleEntityTypes = ["DataDomain","DataPlatform","Country","SharingPolicy"]:
 *   → roots = ["DataDomain", "Country", "SharingPolicy"]   (each tree's entry point)
 *
 * For visibleEntityTypes = ["DataPlatform","System","Table"]:
 *   → roots = ["DataPlatform"]   (DataDomain is not visible, so DataPlatform is the root here)
 */
function computeViewScopedRoots(
  visibleTypes: string[],
  schemaEntityTypes: EntityTypeDefinition[],
  globalRoots: string[],
): string[] {
  if (visibleTypes.length === 0) return globalRoots

  const visibleSet = new Set(visibleTypes)

  const roots = visibleTypes.filter(typeId => {
    const et = schemaEntityTypes.find(e => e.id === typeId)
    // A type with no definition → treat as root (safest assumption)
    if (!et) return true
    const parents = et.hierarchy?.canBeContainedBy ?? []
    // Root in this view = no parent type is in the visible set
    return parents.every(parentType => !visibleSet.has(parentType))
  })

  if (roots.length > 0) return roots

  // Last resort: use global ontology roots that overlap with visible types,
  // or simply the first visible type so the view is never empty.
  const globalOverlap = globalRoots.filter(r => visibleSet.has(r))
  return globalOverlap.length > 0 ? globalOverlap : [visibleTypes[0]]
}

interface CanvasRouterProps {
  className?: string
}

export function CanvasRouter({ className }: CanvasRouterProps) {
  const activeView = useSchemaStore((s) => s.getActiveView())
  const layoutType = activeView?.layout.type ?? 'graph'

  const { setNodes, addNodes, setEdges, addEdges } = useCanvasStore()
  const provider = useGraphProvider()
  const rootEntityTypes = useRootEntityTypes()
  const allSchemaEntityTypes = useEntityTypes()
  const isLoadingOntology = useSchemaIsLoading()

  // Track (provider, viewId) so reference views reload when the active view changes.
  const initializedKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (isLoadingOntology) return

    const isReferenceView = layoutType === 'reference' || layoutType === 'layered-lineage'

    // Reference views key on view ID too — different views show different entity scopes.
    const initKey = isReferenceView
      ? `${String(provider)}:${activeView?.id ?? 'none'}`
      : String(provider)

    if (initializedKeyRef.current === initKey) return
    initializedKeyRef.current = initKey

    setNodes([])
    setEdges([])

    if (isReferenceView) {
      // Reference / Context View loading strategy
      // ──────────────────────────────────────────
      // A reference view can span multiple independent hierarchies simultaneously:
      //   Physical:    DataDomain → DataPlatform → System → Table → Column
      //   Reference:   Country → Region → City
      //   Governance:  SharingPolicy
      //
      // We load in two passes so the view feels responsive:
      //
      //   Pass 1 — View-scoped root types (immediately visible)
      //     Types whose parent types are NOT in the view's visibleEntityTypes.
      //     For a "DataDomain + Country" view both are roots; we load both.
      //     Limit: PER_TYPE_LIMIT entities per root type.
      //
      //   Pass 2 — Direct children of those roots (one level deep, background)
      //     Types in visibleEntityTypes whose parents ARE the root types just loaded.
      //     Loaded in the background after Pass 1 completes.
      //     This populates child layers without waiting for user interaction.
      //     Deeper levels remain on-demand (user expands nodes).

      const viewTypes = activeView?.content?.visibleEntityTypes ?? []
      const rootTypes = computeViewScopedRoots(viewTypes, allSchemaEntityTypes, rootEntityTypes)

      if (rootTypes.length === 0) return

      // Pass 1: load root entities
      Promise.all(
        rootTypes.map(et =>
          provider.getNodes({ entityTypes: [et], limit: PER_TYPE_LIMIT })
            .catch(() => [] as GraphNode[])
        )
      ).then(results => {
        const rootNodes = results.flat()
        if (!rootNodes.length) return

        setNodes(rootNodes.map(n => toCanvasNode(n)))
        setEdges([])

        // Pass 2: load ALL remaining visible entity types (not just direct children).
        // This ensures deep hierarchies (4+ levels) are fully populated.
        // Each type bounded by PER_TYPE_LIMIT, so total is manageable.
        const loadedRootTypes = new Set(rootNodes.map(n => n.entityType))

        const remainingTypes = viewTypes.filter(t => !loadedRootTypes.has(t))
        const childTypes = remainingTypes

        if (childTypes.length === 0) return

        Promise.all(
          childTypes.map(et =>
            provider.getNodes({ entityTypes: [et], limit: PER_TYPE_LIMIT })
              .catch(() => [] as GraphNode[])
          )
        ).then(childResults => {
          const childNodes = childResults.flat()
          if (childNodes.length === 0) return
          addNodes(childNodes.map(n => toCanvasNode(n)))
        })
      }).catch(err => console.error('[CanvasRouter] Failed to load reference view nodes:', err))

    } else {
      // HierarchyCanvas / LineageCanvas: root entities only.
      // Children are expanded lazily via useEntityLoader.loadChildren().
      // If the resolved ontology has no root types yet (graph with no containment edges),
      // fall back to all schema types so the view is never empty.
      const typesToLoad = rootEntityTypes.length > 0
        ? rootEntityTypes
        : allSchemaEntityTypes.map(et => et.id)

      if (typesToLoad.length === 0) return

      provider.getNodes({ entityTypes: typesToLoad as any[], limit: PER_TYPE_LIMIT })
        .then(rootNodes => {
          if (!rootNodes.length) return
          setNodes(rootNodes.map(n => toCanvasNode(n, { randomPosition: true })))
          setEdges([])
        })
        .catch(err => console.error('[CanvasRouter] Failed to load initial nodes:', err))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, layoutType, activeView?.id, rootEntityTypes, allSchemaEntityTypes, isLoadingOntology])

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

