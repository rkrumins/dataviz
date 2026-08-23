/**
 * ContextViewCanvas - Enterprise-grade Context View with User-Defined Layers
 *
 * Displays entities in a horizontal left-to-right flow with:
 * - User-defined layer columns (Source → Staging → Refinery → Report)
 * - Collapsible containers within each layer
 * - Entities flow from left (sources) to right (consumers)
 * - Configurable layer definitions via schema
 * - Lineage flow overlay support
 * - Backend-persisted blueprints (Save / Load / Quick Start Templates)
 *
 * Orchestrator component — delegates layer assignment, edge projection,
 * highlight state, and rendering to extracted hooks and components.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import {
  useSchemaStore,
  normalizeEdgeType,
  useEdgeTypeMetadataMap,
} from '@/store/schema'
import {
  useViewContainmentEdgeTypes,
  useViewLineageEdgeTypes,
  useViewIsContainmentEdge,
  useViewRelationshipTypes,
  useViewEntityTypes,
} from '@/hooks/useViewSchema'
import { useCanvasStore, useCanvasVersion, type LineageEdge, type LineageNode } from '@/store/canvas'
import { useInstanceAssignments, useReferenceModelStore } from '@/store/referenceModelStore'
import { useWorkspacesStore } from '@/store/workspaces'
import { usePreferencesStore } from '@/store/preferences'
import { useFeature } from '@/store/features'
import { useQueryClient } from '@tanstack/react-query'
import { useBranchStore, useEffectiveBranchId, useGraphId } from '@/store/branchStore'
import { usePermission, useAuthStore } from '@/store/auth'
import { canvasScopeWorkspaceId } from '@/lib/canvasScope'
import { saveStagedChangesToDraft } from '@/features/versioning/model/saveStagedChangesToDraft'
import { VERSIONING_KEYS, useResolveGraph, useProjectionWatermark } from '@/features/versioning/hooks/useVersioning'
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'
import { deriveViewCapabilities } from '@/lib/viewAccess'
import { useGraphProvider } from '@/providers'
import type { TraceV2Result } from '@/providers/GraphDataProvider'
import { useGraphHydration } from '@/hooks/useGraphHydration'
import { Crosshair, X } from 'lucide-react'
import { LayerStrip } from './LayerStrip'
import { useRevealNode, type RevealOptions } from '@/hooks/useRevealNode'
import { useLocateManyOnCanvas } from '@/hooks/useLocateManyOnCanvas'
import { useExternalDegrees } from '@/hooks/useExternalDegrees'
import { useRevealSearchHit } from '@/hooks/useRevealSearchHit'
import { useMatchUrnSet, useSearchStore } from '@/store/searchStore'
import { useAggregatedLineage, useAggregatedEdgesCacheVersion } from '@/hooks/useAggregatedLineage'
import { EdgeDetailPanel, generateEdgeTypeFilters } from '../../panels/EdgeDetailPanel'
import { EntityDrawer } from '../../panels/EntityDrawer'
import { HierarchyBuilderPanel } from '../create/HierarchyBuilderPanel'
import { useHierarchyBuilderStore } from '../create/hierarchyBuilderStore'
import { BuildPanel } from '../create/buildmode/BuildPanel'
import { buildTypeLayerMap, resolveRowLayer } from '../create/buildmode/resolveRowLayer'
import { EdgeLegend } from '../EdgeLegend'

import { useUnifiedTrace, type UseUnifiedTraceResult, type TraceResult } from '@/hooks/useUnifiedTrace'
import { useEdgeDetailPanel, useEdgeTypeFilters } from '@/hooks/useEdgeFilters'
import { getEdgeTypeDefinition } from '@/utils/edgeTypeUtils'

// UX-first interaction components
import { CanvasContextMenu, type ContextMenuAction } from '../CanvasContextMenu'
import { InlineNodeEditor } from '../InlineNodeEditor'
import { CommandPalette } from '../CommandPalette'
import { useEdgeConnect } from '../edge-create/useEdgeConnect'
import { ConnectionDragLayer } from '../edge-create/ConnectionDragLayer'
import { EdgeTypePickerPopover } from '../edge-create/EdgeTypePickerPopover'
import { CreateLinkPopover } from '../edge-create/CreateLinkPopover'
import { useCreateLinkStore } from '../edge-create/createLinkStore'
import { ensureDraftOpen } from '@/features/versioning/model/ensureDraftOpen'
import { BlankCanvasEmptyState } from './BlankCanvasEmptyState'
import { FirstStepsChecklist } from './FirstStepsChecklist'
import { useCanvasInteractions } from '@/hooks/useCanvasInteractions'
import { useCanvasKeyboard } from '@/hooks/useCanvasKeyboard'
import { useDuplicateSubtree } from '@/hooks/useDuplicateSubtree'

import type { ViewLayerConfig, DisplayRuleConfig, LayerNodeSortAlgo, LayerNodeSortMode } from '@/types/schema'

// Extracted types, constants, hooks, and components
import { defaultReferenceModelLayers } from './constants'
import { useLayerAssignment } from '@/hooks/useLayerAssignment'
import { useDeletionGhosts } from '@/features/versioning/canvas/useDeletionGhosts'
import { useContainmentHierarchy } from '@/hooks/useContainmentHierarchy'
import { useEdgeProjection } from '@/hooks/useEdgeProjection'
import { useHighlightState, useHoverHighlight, useHoveredNodeId } from '@/hooks/useHighlightState'
import { useTraceFilteredHierarchy } from '@/hooks/useTraceFilteredHierarchy'
import { computeTraceMergeSpine } from '@/hooks/lib/traceMergeSpine'
import { LayerColumn } from './LayerColumn'
import { SORT_MODE_LABELS } from './LayerSortMenu'
import { CanvasStatusChips } from './CanvasStatusChips'
import { computeFitZoom } from './fitZoom'
import { shiftToClear } from './drawerClearance'
import { LineageLens, type LensWalkSeed } from './LineageLens'
import {
  EMPTY_LENS_HISTORY,
  lensFocalOf,
  lensPush,
  lensBackward,
  lensForwardStep,
  lensJump,
  type LensHistory,
} from './lens/lensHistory'
import { decodeLensShare } from './lens/shareCodec'
import { useLensWalk } from '@/hooks/useLensWalk'
import { useCanvasTraceWalk } from '@/hooks/useCanvasTraceWalk'
import { useTraceOverlay, type TraceOverlay } from '@/hooks/useTraceOverlay'
import { lanesToRenderTrees } from '@/hooks/lib/traceViewModel'
import { useBranchCreatedDelta } from '@/hooks/useBranchCreatedDelta'
import {
  emptyTraceHistory,
  pushTraceFocal,
  updateCurrentTraceView,
  traceHistoryBack,
  traceHistoryForward,
  traceHistoryJump,
  currentTraceEntry,
  serializeTraceHistory,
  hydrateTraceHistory,
  type TraceHistoryStack,
  type TraceHistoryEntryRecord,
} from '@/hooks/lib/traceHistoryStack'
import { FULL_WALK_INITIAL_DEPTH } from '@/hooks/useLensWalk'
import { useResolvedNames } from '@/hooks/useResolvedNames'
import { decodeTraceShare, encodeTraceShare } from '@/hooks/lib/traceShareCodec'
import type { TraceShareSummary } from '@/components/canvas/trace/TraceSharePopover'

/** The native canvas trace has no per-edge drilldowns — the closure walk
 *  model is complete at leaf grain. One shared empty map keeps the trace
 *  filter's memo quiet. */
const EMPTY_DRILLDOWNS: Map<string, TraceV2Result> = new Map()
/** The native trace draws through the overlay, never through the browse
 *  hierarchy filter — so the filter is fed nothing and stays pass-through. */
const EMPTY_TRACE_NODES: ReadonlySet<string> = new Set<string>()
/** Fed to the edge projection while the OVERLAY is drawing: the trace's wires
 *  come from its own ledger, so the browse lineage has nothing to say and
 *  projecting it only produces noise (see the call site). */
const EMPTY_EDGES: unknown[] = []
const EMPTY_AGG_EDGES: Map<string, unknown> = new Map()
/** Trailing edge for recording the reader's expansion into the history
 *  entry. One reveal opens a whole chain and one drill peels a level per
 *  click; without this each of those rewrites the entry (and its
 *  localStorage line) several times over for a single gesture. */
const TRACE_EXPANSION_RECORD_MS = 250
import { useLensChildren } from '@/hooks/useLensChildren'
import { aggregateFlowRibbons } from './flowRibbons'
import type { AnchorProxyGroup, ColumnGeometryApi } from './types'
import type { HierarchyNode } from '@/types/hierarchy'
import { StartEditingDialog } from './StartEditingDialog'
import { AddLayerColumn } from './AddLayerColumn'
import * as layerOps from './layerMutations'
import * as assignmentOps from './assignmentMutations'
import { generateKeyBetween } from '@/utils/orderKeys'
import { normalizeReferenceLayout, deriveEntityScope, scopeForPersist, type NormalizedReferenceLayout } from '@/utils/referenceLayout'
import { LineageFlowOverlay, EXTREMITY_EDGE_GUTTER_PX } from './LineageFlowOverlay'
import { GhostLineageOverlay } from './GhostLineageOverlay'
import { ContextViewHeader } from './ContextViewHeader'
import { EditViewDetailsDialog } from './EditViewDetailsDialog'
import { ShareViewDialog } from '@/components/views/ShareViewDialog'
import { resetAllCircuitBreakers } from '@/services/circuitBreaker'
import { getView, updateView, updateViewLayout } from '@/services/viewApiService'
import { useSourceChangedRefresh } from '@/hooks/useSourceChangedRefresh'
import { SearchMapPanel } from '../search/SearchMapPanel'
import { PropertyManagerDrawer } from '../property-manager/PropertyManagerDrawer'
import { useDisplayRuleEngine } from '@/hooks/useDisplayRuleEngine'
import { useLoadingToast, useToast, useToastStore } from '@/components/ui/toast'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { StagedChangesPanel } from './StagedChangesPanel'
import { ImportDialog } from '@/features/import-export/ImportDialog'
import { ExportDialog } from '@/features/import-export/ExportDialog'
import { invalidateAggregatedEdges } from '@/hooks/useAggregatedLineage'
import { useVersioningPanelStore } from '@/store/versioningPanelStore'
import { TraceBottomDock } from '../trace/TraceBottomDock'
import { TraceWalkIndicator } from './TraceWalkIndicator'

// Re-export for backward compatibility
export { defaultReferenceModelLayers } from './constants'

export interface ContextViewCanvasProps {
  className?: string
  layers?: ViewLayerConfig[]
  showLineageFlow?: boolean
}

/**
 * Containment descendants of `rootId` (via `parentMap`) that carry their OWN explicit assignment entry.
 * Assigning a parent clears these so they inherit the parent's new layer (the hard-inherit rule).
 */
function explicitDescendants(
  rootId: string,
  parentMap: Map<string, string>,
  assignments: NormalizedReferenceLayout['assignments'],
): string[] {
  const childMap = new Map<string, string[]>()
  parentMap.forEach((parent, child) => {
    const list = childMap.get(parent) ?? []
    list.push(child)
    childMap.set(parent, list)
  })
  const out: string[] = []
  const queue = [...(childMap.get(rootId) ?? [])]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    if (assignments[id]) out.push(id)
    queue.push(...(childMap.get(id) ?? []))
  }
  return out
}

/** The rendered-tree context used to resolve custom-order reordering. */
interface ReorderTreeContext {
  displayMap: Map<string, HierarchyNode>
  parentMap: Map<string, string>
  nodesByLayer: Map<string, HierarchyNode[]>
  nodeLayerMap: Map<string, string>
}

/**
 * The sibling set a node belongs to for custom-order reordering, in current
 * visual order, plus the layer that set lives in. A node with a containment
 * parent in the SAME layer is a child — its siblings are that parent's
 * rendered children; otherwise it is a visual root — its siblings are the
 * layer's roots. Logical wrappers are excluded (not orderable). Returns null
 * when the node resolves to no layer.
 */
function siblingContext(
  nodeId: string,
  ctx: ReorderTreeContext,
): { siblings: string[]; layerId: string } | null {
  const layerId = ctx.nodeLayerMap.get(nodeId)
  if (!layerId) return null
  const parentId = ctx.parentMap.get(nodeId)
  if (parentId && ctx.nodeLayerMap.get(parentId) === layerId) {
    const parent = ctx.displayMap.get(parentId)
    if (parent) {
      return { siblings: parent.children.filter(c => !c.isLogical).map(c => c.id), layerId }
    }
  }
  return {
    siblings: (ctx.nodesByLayer.get(layerId) ?? []).filter(n => !n.isLogical).map(n => n.id),
    layerId,
  }
}

export function ContextViewCanvas({
  className,
  layers = defaultReferenceModelLayers,
  showLineageFlow: initialShowLineageFlow = true
}: ContextViewCanvasProps) {
  const nodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)
  const addNodes = useCanvasStore((s) => s.addNodes)
  const addEdges = useCanvasStore((s) => s.addEdges)
  const setVisibleEdges = useCanvasStore((s) => s.setVisibleEdges)
  const removeStoreEdges = useCanvasStore((s) => s.removeEdges)
  const removeStoreNodes = useCanvasStore((s) => s.removeNodes)
  const selectNode = useCanvasStore((s) => s.selectNode)
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  const selectedNodeId = selectedNodeIds[0] ?? null
  const drawerNodeId = useCanvasStore((s) => s.drawerNodeId)
  const closeNodeDrawer = useCanvasStore((s) => s.closeNodeDrawer)
  const edgeFetchFailures = useCanvasStore((s) => s.edgeFetchFailures)
  const clearEdgeFetchFailures = useCanvasStore((s) => s.clearEdgeFetchFailures)
  const edgesTruncated = useCanvasStore((s) => s.edgesTruncated)
  const schema = useSchemaStore((s) => s.schema)
  const activeView = useSchemaStore((s) => s.getActiveView())
  const provider = useGraphProvider()
  const containmentEdgeTypes = useViewContainmentEdgeTypes()
  const lineageEdgeTypes = useViewLineageEdgeTypes()
  const isContainmentEdge = useViewIsContainmentEdge()
  const edgeTypeMetadata = useEdgeTypeMetadataMap()

  // Lineage rendering preferences — drive the Stubs/Auto/Raw mode, the
  // auto-mode size cutover, and the bundle fan-in threshold. Read with
  // separate selectors so unrelated preference changes don't re-render.
  const lineageRenderMode = usePreferencesStore((s) => s.lineageRenderMode)
  const setLineageRenderMode = usePreferencesStore((s) => s.setLineageRenderMode)
  const autoStubThreshold = usePreferencesStore((s) => s.autoStubThreshold)
  const lineageBundleFanIn = usePreferencesStore((s) => s.lineageBundleFanIn)

  // Canvas display settings — driven by the header's DisplaySettingsPopover.
  // `?? default` guards users whose persisted preferences predate these
  // fields: zustand's shallow-merge hydration can surface them as
  // undefined for that cohort until the next setter fires.
  const canvasZoom = usePreferencesStore((s) => s.canvasZoom) ?? 1
  const setCanvasZoom = usePreferencesStore((s) => s.setCanvasZoom)
  // Missing-link alerts are optional: Views are subsets of a Data Source,
  // so links to out-of-view entities can be expected rather than a problem.
  const showMissingConnectionIndicators = usePreferencesStore((s) => s.showMissingConnectionIndicators) ?? true
  const showFlowRibbons = usePreferencesStore((s) => s.showFlowRibbons) ?? true
  const canvasDensity = usePreferencesStore((s) => s.canvasDensity) ?? 'spacious'
  const setCanvasDensity = usePreferencesStore((s) => s.setCanvasDensity)
  const showCanvasTypeBadge = usePreferencesStore((s) => s.showCanvasTypeBadge) ?? true
  const toggleCanvasTypeBadge = usePreferencesStore((s) => s.toggleCanvasTypeBadge)
  const subtleCanvasTreeLines = usePreferencesStore((s) => s.subtleCanvasTreeLines) ?? false
  const toggleSubtleCanvasTreeLines = usePreferencesStore((s) => s.toggleSubtleCanvasTreeLines)
  const resetCanvasDisplaySettings = usePreferencesStore((s) => s.resetCanvasDisplaySettings)

  // URN resolver for trace
  const urnResolver = useCallback((nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId)
    return (node?.data?.urn as string) || nodeId
  }, [nodes])

  // Unified Trace System - replaces local trace state
  const trace = useUnifiedTrace({
    provider,
    urnResolver,
    onTraceComplete: async (result) => {
      console.log('[ReferenceModelCanvas] Trace complete:', result.traceNodes.size, 'nodes')

      // Auto-enable lineage flow so edges are visible
      setShowLineageFlow(true)

      // Merge trace result into the canvas store using a spine-based strategy
      // (see frontend/src/hooks/lib/traceMergeSpine.ts).
      //
      // Why not "all" or "nothing":
      //   - Blanket-merging every node the backend returned re-parents existing
      //     canvas nodes under alien ancestors (e.g. Snowflake stealing
      //     REPORTING) via useLayerAssignment's "children inherit parent's
      //     layer" HARD RULE — destroys legitimate placements.
      //   - Blanket-dropping every ancestor (the previous approach) leaves new
      //     lineage participants floating with no path to a layer root, so
      //     useLayerAssignment marks them unassigned and useEdgeProjection
      //     silently drops their edges (the "trace returns nodes but UI shows
      //     no lineage" bug).
      //
      // The spine helper returns the minimum ancestor chain needed to route
      // each new participant up to a node the canvas already places. We merge
      // participants + spine and let useLayerAssignment's natural priority
      // chain (explicit → instance → view config → rules → inheritance)
      // decide where each node lands. Participants whose chain never reaches
      // a known anchor AND whose entity type/rules don't claim them in this
      // view fall out of `nodesByLayer` and don't render — the same outcome
      // as browse mode. We intentionally drop the previous "stamp the focus
      // layer as a fallback" behaviour: it pulled in entities (e.g. a
      // `Web Analytics` layer node that has no view assignment) and parked
      // them in the focus's column, falsely implying they belonged to that
      // layer. Losing the lineage involving truly unassigned nodes is the
      // correct trade-off — the user can place those nodes in a layer to
      // surface them.
      if (result.lineageResult) {
        const lr = result.lineageResult

        const participantUrns = new Set<string>()
        result.traceNodes.forEach(u => participantUrns.add(u))
        lr.upstreamUrns.forEach(u => participantUrns.add(u))
        lr.downstreamUrns.forEach(u => participantUrns.add(u))

        const knownAssignedUrns = new Set<string>(displayMap.keys())
        const { spineUrns } = computeTraceMergeSpine({
          participantUrns,
          containmentEdges: result.containmentEdges ?? [],
          knownAssignedUrns,
        })

        const shouldMergeNode = (urn: string): boolean =>
          (participantUrns.has(urn) || spineUrns.has(urn)) && !knownAssignedUrns.has(urn)

        // Only trace nodes that arrived with real, renderable data may
        // become canvas nodes. A spine ancestor (e.g. a Container whose
        // child Table was the only thing assigned) that the backend
        // returned without node data must NOT get a containment edge —
        // a dangling edge to it renders as a blank/phantom box.
        const hydratedTraceUrns = new Set<string>(
          lr.nodes
            .filter(gn => gn.urn && (gn.displayName ?? '').trim().length > 0)
            .map(gn => gn.urn)
        )

        const newCanvasNodes = lr.nodes
          .filter(gn => shouldMergeNode(gn.urn) && hydratedTraceUrns.has(gn.urn))
          .map(gn => {
            const metadata: Record<string, unknown> = {
              ...gn.properties,
              childCount: gn.childCount,
              sourceSystem: gn.sourceSystem,
            }
            return {
              id: gn.urn,
              type: 'default' as const,
              position: { x: 0, y: 0 },
              data: {
                label: gn.displayName,
                urn: gn.urn,
                type: gn.entityType,
                classifications: gn.tags ?? [],
                metadata,
              },
            }
          })
        if (newCanvasNodes.length > 0) {
          addNodes(newCanvasNodes as any[])
        }

        // Lineage edges: both endpoints must be either newly-merged or
        // already on the canvas. Drops only the rare edge whose endpoint
        // is an ancestor the spine excluded — those dangle.
        const isResolvableEndpoint = (urn: string): boolean =>
          (shouldMergeNode(urn) && hydratedTraceUrns.has(urn)) || knownAssignedUrns.has(urn)
        const newCanvasEdges = lr.edges
          .filter(ge => isResolvableEndpoint(ge.sourceUrn) && isResolvableEndpoint(ge.targetUrn))
          .map(ge => ({
            id: ge.id,
            source: ge.sourceUrn,
            target: ge.targetUrn,
            data: {
              edgeType: ge.edgeType,
              relationship: ge.edgeType,
              confidence: ge.confidence,
            },
          }))
        if (newCanvasEdges.length > 0) {
          addEdges(newCanvasEdges as any[])
          trace.recordAddedEdgeIds(newCanvasEdges.map(e => e.id))
        }

        // Containment edges: only when the TARGET (child) is a newly-merged
        // node. Never add an edge whose target is already on the canvas —
        // that would re-parent an existing node under an alien ancestor and
        // collapse its layer assignment via the HARD RULE.
        const newContainmentEdges = (result.containmentEdges ?? [])
          .filter(ge => shouldMergeNode(ge.targetUrn) && isResolvableEndpoint(ge.sourceUrn))
          .map(ge => ({
            id: ge.id,
            source: ge.sourceUrn,
            target: ge.targetUrn,
            data: {
              edgeType: ge.edgeType,
              relationship: ge.edgeType,
              confidence: ge.confidence,
            },
          }))
        if (newContainmentEdges.length > 0) {
          addEdges(newContainmentEdges as any[])
          trace.recordAddedEdgeIds(newContainmentEdges.map(e => e.id))
        }

        // Auto-expand only the focus's containment chain. Expanding every
        // participant's container would unfold the entire layered canvas for
        // a hub focus (a Campaigns object with 216 downstream participants
        // would expand 17 entity types × 4 layers worth of containers,
        // rendering tens of thousands of edges on initial trace). Leaving
        // other participants rolled up means the user sees AGGREGATED
        // edges between containers; expanding a container drills via
        // autoDrillOnExpand to reveal its lineage participants on demand.
        const nodesToExpand = new Set(expandedNodes)
        const allCurrentEdges = [...edges, ...newCanvasEdges, ...newContainmentEdges]
        const traceParentMap = new Map<string, string>()
        allCurrentEdges.forEach(e => {
          if (isContainmentEdge(normalizeEdgeType(e))) {
            traceParentMap.set(e.target ?? (e as any).targetUrn, e.source ?? (e as any).sourceUrn)
          }
        })

        if (result.focusId) {
          let curr = traceParentMap.get(result.focusId)
          while (curr) {
            if (nodesToExpand.has(curr)) break  // already on the walk
            nodesToExpand.add(curr)
            curr = traceParentMap.get(curr)
          }
        }

        setExpandedNodes(nodesToExpand)
      }
    }
  })

  // Forward-declared ref to the smart-level trace handler — defined further
  // down where granularityOptions is in scope. Used by hooks that fire
  // before that declaration (useCanvasInteractions options) so the
  // closure dereferences lazily.
  const startTraceRef = useRef<(nodeId: string) => void>(() => {})
  const toggleTraceRef = useRef<(nodeId: string) => void>(() => {})

  // Exit-trace cleanup. Purges the edges the trace merged into the canvas
  // store so the ambient edge mesh doesn't permanently inherit them.
  const exitTrace = useCallback(() => {
    if (!trace.isTracing) return false
    const idsToRemove = Array.from(trace.addedEdgeIds)
    trace.clearTrace()
    if (idsToRemove.length > 0) removeStoreEdges(idsToRemove)
    trace.resetAddedEdgeIds()
    setExpandedNodes(new Set())
    // Clear breakers on exit-trace so a trace 504 that opened the 'trace'
    // breaker can't linger and block a re-trace. Browse breakers are now
    // isolated per endpoint class, so this is belt-and-suspenders; it also
    // resets any half-open flap. (Scope-less: the per-scope vars are
    // declared later in render order — a deliberate rare user action can
    // safely reset all scopes' breakers, which re-open on the next failure.)
    resetAllCircuitBreakers()
    return true
  }, [trace, removeStoreEdges])

  // UX-first Canvas Interactions (context menu, inline edit, quick create, command palette)
  // Forward ref so the keyboard 'C' handler (wired into useCanvasInteractions
  // before useEdgeConnect exists) can arm connect-mode on the selected node.
  const edgeConnectRef = useRef<{ armConnect: (id: string) => void } | null>(null)

  // Forward ref to the TRACE OVERLAY (declared far below, after the layer
  // assignment it reads). Every interaction that would write the canvas —
  // expand, reveal, edit, reorder, connect — consults it: while a trace is
  // on, the canvas is a read-only projection of the walk model.
  const overlayRef = useRef<TraceOverlay | null>(null)
  /** A trace SESSION is open — true from the instant Trace is pressed, which
   *  is earlier than `overlay.active` (that waits for a model holding the
   *  focus, so the canvas can keep showing browse while the walk runs). */
  const traceSessionRef = useRef(false)

  /**
   * THE WRITE LOCK. A trace refuses canvas writes for its WHOLE life, not
   * just while the overlay is drawing. The walk in between is precisely when
   * a stray expand, reveal, search or edit would land in the store — the
   * reader is still looking at browse, so the affordances still look live —
   * and exiting the trace would then restore a canvas that never existed.
   *
   * Deliberately WIDER than `overlay.active`: that one answers "is a trace
   * on screen right now" and drives RENDERING; this one answers "may the
   * canvas be written" and drives every guard.
   */
  const traceWriteLocked = useCallback(
    () => traceSessionRef.current || overlayRef.current?.active === true,
    [],
  )
  /** Same predicate, reachable from the handlers wired ABOVE it (the keyboard
   *  config among them). Set once and never reassigned — `traceWriteLocked`
   *  has empty deps, so it is stable for the component's life. */
  const traceWriteLockedRef = useRef(traceWriteLocked)

  // Forward refs to values declared far below in render order: the hydration
  // cancellers (so `beginTrace` can drop in-flight child pages) and the live
  // on-screen node map (so the edge drill resolves against what is drawn).
  const childLoadRef = useRef<{ cancel: (id: string) => void; loadingNodes: ReadonlySet<string> } | null>(null)
  const renderMapRef = useRef<Map<string, HierarchyNode>>(new Map())

  // Forward-ref for the duplicate-subtree layer wiring. onNodeCopied /
  // onNodeDuplicated fire from useDuplicateSubtree / useCanvasInteractions,
  // both wired BEFORE nodeLayerMap / sortedLayers / assignEntityToLayer /
  // parentMap exist in render order (mirrors startTraceRef). Keep a ref whose
  // .current is refreshed once those are computed (below) and read it lazily
  // inside the callbacks so they always see live layer state.
  const duplicateWiringRef = useRef<{
    nodeLayerMap: Map<string, string>
    sortedLayers: ViewLayerConfig[]
    assignEntityToLayer: (entityId: string, layerId: string) => { success: boolean }
    parentMap: Map<string, string>
    setExpandedNodes: React.Dispatch<React.SetStateAction<Set<string>>>
    currentLayout: () => NormalizedReferenceLayout
    persistReferenceLayout: (next: NormalizedReferenceLayout) => void
  } | null>(null)

  // Duplicate a node's whole subtree as freshly-staged copies. onNodeCopied
  // assigns EACH copy (root + every descendant) to its ORIGINAL's layer —
  // ContextView only renders nodes that resolve to a layer, so without
  // per-node assignment the descendant copies would vanish (don't rely on
  // containment inheritance; assign explicitly). Reuses the same layer
  // resolution the create flow's onEntityStaged uses. Writes BOTH the
  // canonical view-config entry (keyed by the copy's temp urn, remapped to
  // its real urn on save — same as a create) and the optimistic session
  // assignment (immediate render feedback before the canonical write's
  // debounce/re-render lands).
  const { duplicateSubtree } = useDuplicateSubtree({
    onNodeCopied: (originalId, _originalUrn, copyUrn) => {
      const wiring = duplicateWiringRef.current
      if (!wiring) return
      const layer = wiring.nodeLayerMap.get(originalId) ?? wiring.sortedLayers[0]?.id
      if (layer) {
        wiring.assignEntityToLayer(copyUrn, layer)
        wiring.persistReferenceLayout(assignmentOps.assignEntities(wiring.currentLayout(), [copyUrn], layer))
      }
    },
  })

  const interactions = useCanvasInteractions({
    onTraceNode: (nodeId) => startTraceRef.current(nodeId),
    onNodeCreated: (nodeId) => selectNode(nodeId),
    duplicateSubtree,
    onNodeDuplicated: (originalId, rootCopyUrn) => {
      // Reveal the copy: expand the original's parent (shows the new sibling)
      // and the root copy itself (shows its just-staged children). Mirrors
      // GraphCanvas's onNodeDuplicated, using this file's parentMap /
      // setExpandedNodes (via the forward-ref).
      const wiring = duplicateWiringRef.current
      if (!wiring) return
      const parentId = wiring.parentMap.get(originalId)
      wiring.setExpandedNodes((prev) => {
        const next = new Set(prev)
        if (parentId) next.add(parentId)
        next.add(rootCopyUrn)
        return next
      })
    },
    onConnectMode: (nodeId) => {
      // Draft-gated on the SCOPED isDraft: on Published (or a draft open on a different data
      // source) the connect shortcut is inert — managers enter edit via the header's Edit button.
      if (!isDraft) return
      // …and trace-gated, because arming leads to the picker, which stages a
      // create_edge straight into the canvas store. The 'C' key reaches this
      // with no affordance to withdraw, so the refusal has to live here.
      if (traceWriteLockedRef.current()) return
      edgeConnectRef.current?.armConnect(nodeId)
    },
    layers: layers,
    onMoveToLayer: (_nodeId, _layerId) => {
      // Implementation handled by the existing moveToLayer function
    },
    onCloseEdgePanel: () => {
      if (isEdgePanelOpen) { closeEdgePanel(); return true }
      return false
    },
    onCloseEntityDrawer: () => {
      if (isStagedPanelOpen) { closeStagedChangesPanel(); return true }
      if (drawerNodeId) { closeNodeDrawer(); clearSelection(); return true }
      return false
    },
    // ESC exits an active trace before any other panel close — gives the
    // user a single, predictable escape from a busy trace view.
    onExitTrace: exitTrace,
  })

  // Edge authoring: drag-handle + connect-mode → ontology-filtered picker →
  // stage a RAW create_edge. Only offered in draft (authoring) mode.
  const edgeConnect = useEdgeConnect({
    onConnect: (sourceUrn, targetUrn, edgeType) =>
      interactions.stageEdgeCreate(sourceUrn, targetUrn, edgeType),
  })
  edgeConnectRef.current = edgeConnect

  // Aggregated lineage for progressive edge disclosure
  const {
    aggregatedEdges,
    fetchAggregated,
    clearCache: clearAggregationCache,
    isLoading: isLoadingAggregatedEdges,
    granularity: lineageGranularity,
    setGranularity: setLineageGranularity,
    truncated: aggregationTruncated,
    staleReason: aggregationStaleReason,
    error: aggregationError,
    loadMoreDetail: loadMoreAggregatedDetail,
    purgeEdgesIncidentToUrns: purgeAggregatedEdgesIncidentToUrns,
  } = useAggregatedLineage({ granularity: null })
  // Cache-epoch: part of the fetch-dedupe key so invalidations refetch even
  // when the visible container set (and so the URN key) hasn't changed.
  const aggregatedCacheVersion = useAggregatedEdgesCacheVersion()

  // Instance-level assignments from store (user drag-and-drop)
  const instanceAssignments = useInstanceAssignments()
  const effectiveAssignments = useReferenceModelStore(s => s.effectiveAssignments)
  const computeAssignments = useReferenceModelStore(s => s.computeAssignments)
  const assignmentStatus = useReferenceModelStore(s => s.assignmentStatus)
  const resetAssignmentStatus = useReferenceModelStore(s => s.resetAssignmentStatus)
  const setLayers = useReferenceModelStore(s => s.setLayers)
  const storeLayers = useReferenceModelStore(s => s.layers)
  // Display rules are session state on the store, edited via the Property Manager. The canvas
  // owns their persistence: seed from the view on open (hydrate effect) + write them into the
  // debounced updateViewLayout payload on change (persist effect) — see below.
  const displayRules = useReferenceModelStore(s => s.displayRules)
  const assignEntityToLayer = useReferenceModelStore(s => s.assignEntityToLayer)
  const remapEntityId = useReferenceModelStore(s => s.remapEntityId)
  const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)

  // View/Edit mode gates — Published is strictly read-only for everyone;
  // "edit mode" IS having a draft open (no separate flag). `isDraft` is
  // scoped to the active view's data source (unlike the unscoped store
  // `isDraftMode()`) so the header never claims Edit for a draft that
  // belongs to a different data source.
  const dataSourceId = activeView?.dataSourceId ?? null
  // The canvas-versioning scope is the VIEW's own workspace — the same source
  // CanvasVersioningBar / branchStore.setResolved use. The global workspaces-store
  // selection can lag or diverge (deep links, workspace switching), and when it does
  // the strict scope guard in useEffectiveBranchId returned null → isDraft false →
  // the whole Edit cluster went invisible. See canvasScopeWorkspaceId.
  const scopeWsId = canvasScopeWorkspaceId(activeView?.workspaceId, activeWorkspaceId)
  // Branch-per-view: also scope by the active view's id, so `isDraft` never reflects a
  // draft belonging to a DIFFERENT view on the same data source (branchStore is a single
  // global store — without this, a view switch could keep reading the prior view's gate).
  const effectiveBranchId = useEffectiveBranchId(scopeWsId ?? '', dataSourceId, activeView?.id ?? null)
  const isDraft = !!effectiveBranchId
  // editModeEnabled IS that separate flag: an independent admin switch that also 403s every
  // graph mutation route server-side (nodes/create, edges, /changes — graph.py's require_edit_mode),
  // so node/edge mutation affordances need isDraft AND this, even though layer/view-config actions
  // (which never touch those routes) still only need isDraft.
  const editModeEnabled = useFeature('editModeEnabled')
  const canEditGraph = isDraft && editModeEnabled
  // Reconstruct committed-draft deletions as read-only rose "ghost" nodes (from the draft-vs-main
  // diff) so a deletion stays visible in red until merged — surviving refresh. Draft-only.
  useDeletionGhosts(isDraft)
  const canManage = usePermission('workspace:datasource:manage', scopeWsId ?? undefined)
  const graphId = useGraphId()
  // Capability context: readOnly means the data plane rejects every write
  // for this caller (shared/enterprise view opened without membership).
  const viewExecCtx = useViewExecutionContext()
  const readOnly = viewExecCtx?.readOnly ?? false
  const canEnterEdit = !!graphId && !readOnly
  // Blank (hand-built) models drive the guided empty state + first-steps
  // companion; react-query dedupes this against CanvasVersioningBar's resolve.
  // Threading the view id keeps every resolve consumer on ONE cache entry per
  // scope AND carries the capability context for non-members.
  const resolveQ = useResolveGraph(scopeWsId ?? undefined, dataSourceId, activeView?.id ?? null)
  const isBlankModel = resolveQ.data?.kind === 'blank'
  const mainHeadSeq = resolveQ.data?.mainHeadCommitSeq ?? 0

  // View-level rights for the title menu — deliberately independent of the
  // canvas Edit cluster (view metadata is not graph data). The server's
  // access envelope is authoritative when present (it is computed by the
  // same evaluator that enforces every request); the claim-derived legacy
  // inputs below only cover responses that predate it.
  const currentUserId = useAuthStore(s => s.user?.id) ?? null
  const isViewCreator = !!activeView?.createdBy && activeView.createdBy === currentUserId
  const canEditPerm = usePermission('workspace:view:edit', scopeWsId ?? undefined)
  const canAdminPerm = usePermission('workspace:admin', scopeWsId ?? undefined)
  const canPublishPerm = usePermission('workspace:view:publish', scopeWsId ?? undefined)
  const viewCaps = deriveViewCapabilities(viewExecCtx?.access ?? null, {
    isCreator: isViewCreator,
    canEditPerm,
    canAdminPerm,
    canPublishPerm,
  })
  const canEditView = viewCaps.canEdit
  const canShareView = viewCaps.canManageGrants

  // Keyboard shortcuts. Published is read-only, so its mutating shortcuts — Delete, ⌘D (duplicate),
  // and N (create) — are neutralised there with no-ops. A bare `undefined` on onDelete would fall
  // through to useCanvasKeyboard's built-in node-removal, so it must be an explicit no-op.
  // (The context-menu mutation entry points are draft-gated separately.)
  // Fit-to-width / lens handlers are defined further down (they need
  // sortedLayers / lens state); ref indirection avoids the TDZ.
  const fitToWidthRef = useRef<(() => void) | null>(null)
  const focusLensRef = useRef<(() => void) | null>(null)
  const zoomShortcutHandlers = useMemo(() => ({
    onFitView: () => fitToWidthRef.current?.(),
    onZoomPreset: (level: 1 | 2 | 3) => setCanvasZoom([0.5, 0.75, 1][level - 1]),
    onFocusLens: () => focusLensRef.current?.(),
  }), [setCanvasZoom])
  useCanvasKeyboard({
    enabled: true,
    handlers: isDraft
      ? { ...interactions.keyboardHandlers, ...zoomShortcutHandlers }
      : { ...interactions.keyboardHandlers, ...zoomShortcutHandlers, onDelete: () => {}, onDuplicate: () => {}, onCreate: () => {} },
  })

  // ─── Canonical reference-layout persistence ─────────────────────────────────────────────────────
  // Every layer/assignment gesture writes ONE store: the active view's `referenceLayout`.
  // persistReferenceLayout updates the schema-store view SYNCHRONOUSLY (immediate canvas re-render —
  // useLayerAssignment reads the canonical `assignments`) and arms a debounced durable
  // PUT /views/{id}/layout. Reads go through the LIVE view (getActiveView) + normalizeReferenceLayout so
  // rapid successive writes (e.g. a build batch's per-row assigns) accumulate instead of clobbering, and
  // every saved config is canonical-clean (entityAssignments stripped, exact-urn rules converted).
  // This REPLACES the prior syncStatus→saveToBackend blueprint-autosync effect (the reference-model
  // store no longer persists layers/assignments — Task 5 demotes it to a render cache).
  const layoutSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingLayoutSave = useRef<
    {
      viewId: string
      referenceLayout: NormalizedReferenceLayout
      entityScope: 'all' | 'curated'
      // The draft branch the edit was made on (null on Published/main). Routes the
      // durable PUT to the branch's layout overlay so a draft edit never mutates the
      // published base — see updateViewLayout / the backend ?branchId routing.
      branchId: string | null
    } | null
  >(null)
  // Sync indicator DERIVED from the canvas debounce (replaces the deleted store syncStatus): 'saving'
  // from the moment a save is armed until the durable PUT settles, else 'idle'. The header subline
  // shows a small spinner while 'saving'.
  const [layoutSyncStatus, setLayoutSyncStatus] = useState<'idle' | 'saving'>('idle')

  const doLayoutSave = useCallback(async () => {
    if (layoutSaveTimer.current) { clearTimeout(layoutSaveTimer.current); layoutSaveTimer.current = null }
    const pending = pendingLayoutSave.current
    if (!pending) { setLayoutSyncStatus('idle'); return }
    pendingLayoutSave.current = null
    try {
      await updateViewLayout(pending.viewId, {
        referenceLayout: pending.referenceLayout,
        entityScope: pending.entityScope,
        // Always send the live display rules so a layer-only save never wipes them (the endpoint
        // replaces referenceLayout wholesale, then re-nests displayRules only when supplied).
        displayRules: useReferenceModelStore.getState().displayRules,
      }, pending.branchId ?? undefined)
    } catch (err) {
      // Swallow to avoid unhandled-rejection noise; the next edit re-arms the save.
      console.error('[ContextViewCanvas] layout save failed', err)
    } finally {
      setLayoutSyncStatus('idle')
    }
  }, [])

  /** Arm (or re-arm) the debounced durable save and show the 'saving' indicator.
   *  Gated on canEdit — the VIEW-config capability, not the graph-data one:
   *  layout persistence is PUT /views/{id}/layout (can_edit_view), which an
   *  editor-grantee passes even while their graph data stays read-only
   *  (canEdit: true, dataAccess: 'readonly'). One choke point instead of
   *  guarding every gesture that feeds it. */
  const armLayoutSave = useCallback(() => {
    if (!viewCaps.canEdit) return
    setLayoutSyncStatus('saving')
    if (layoutSaveTimer.current) clearTimeout(layoutSaveTimer.current)
    layoutSaveTimer.current = setTimeout(() => { void doLayoutSave() }, 1500)
  }, [doLayoutSave, viewCaps.canEdit])

  /** Flush any pending debounced layout save NOW (no-op if none pending). Used by the Save button. */
  const flushLayoutSave = useCallback(async () => { await doLayoutSave() }, [doLayoutSave])

  // On unmount, clear the debounce timer AND flush any armed save so a layout edit
  // made just before navigating away (still inside the 1500ms window) is persisted
  // to its branch's overlay — the single-slot pending payload carries its branchId,
  // so a best-effort flush here can't leak to the wrong branch (doLayoutSave clears
  // the timer + captures the pending synchronously before its first await).
  useEffect(() => () => {
    if (layoutSaveTimer.current) { clearTimeout(layoutSaveTimer.current); layoutSaveTimer.current = null }
    if (pendingLayoutSave.current) void doLayoutSave()
  }, [doLayoutSave])

  // ─── Branch-aware re-read (BSL Phase 4) ─────────────────────────────────────────────────────────
  // When the active view or its effective branch changes, re-fetch the BRANCH-EFFECTIVE view
  // (base ⊕ the branch's layout overlay for a draft; base for Published / other branches — the backend
  // ?branchId routing) and apply its layout + entityScope so the canvas repopulates for the new branch.
  // This is the READ side that pairs with the Phase-3 WRITE routing: a draft now SEES its own overlay,
  // while switching Published↔draft↔draft reloads the correct layout instead of showing the last branch's.
  useEffect(() => {
    const viewId = activeView?.id
    if (!viewId) return
    let cancelled = false
    void (async () => {
      // FLUSH-ON-SWITCH: the single-slot pendingLayoutSave still holds the PREVIOUS branch's edit (its
      // payload carries that branch's id). Persist it BEFORE the re-fetch so switching branches within
      // the debounce window never drops it (the slot would otherwise be overwritten by the next edit).
      if (pendingLayoutSave.current) await flushLayoutSave()
      if (cancelled) return
      let full
      try {
        full = await getView(viewId, effectiveBranchId ?? undefined)
      } catch (err) {
        console.error('[ContextViewCanvas] branch-effective view re-fetch failed', err)
        return
      }
      if (cancelled) return
      // A local edit landed after we started (a new save is armed) → don't clobber the optimistic layout.
      if (pendingLayoutSave.current) return
      const view = useSchemaStore.getState().getActiveView()
      if (!view || view.id !== viewId) return   // the active view switched under us
      const nextRef = full.config?.layout?.referenceLayout
      // Skip if the branch-effective layout equals what the store already has (no render thrash).
      const currentNorm = normalizeReferenceLayout(view.layout?.referenceLayout)
      const nextNorm = normalizeReferenceLayout(nextRef)
      if (JSON.stringify(currentNorm) === JSON.stringify(nextNorm)) return
      const nextScope = full.config?.content?.entityScope
      useSchemaStore.getState().updateView(viewId, {
        layout: { ...(view.layout ?? {}), referenceLayout: nextRef },
        content: { ...view.content, entityScope: nextScope ?? view.content?.entityScope },
      })
    })()
    return () => { cancelled = true }
  }, [activeView?.id, effectiveBranchId, flushLayoutSave])

  /** The active view's CURRENT canonical layout, read LIVE so successive writes accumulate. Falls back
   *  to the default columns when the view has none, matching the prior `currentLayers()` behaviour. */
  const currentLayout = useCallback((): NormalizedReferenceLayout => {
    const view = useSchemaStore.getState().getActiveView()
    const norm = normalizeReferenceLayout(view?.layout?.referenceLayout)
    return {
      layers: norm.layers.length > 0 ? norm.layers : defaultReferenceModelLayers,
      assignments: norm.assignments,
      ...(norm.defaultNodeSortMode ? { defaultNodeSortMode: norm.defaultNodeSortMode } : {}),
    }
  }, [])

  const persistReferenceLayout = useCallback((next: NormalizedReferenceLayout) => {
    const view = useSchemaStore.getState().getActiveView()
    if (!view?.id) return
    // Pin the scope from the PRE-gesture state so a canvas gesture NEVER flips a view's scope
    // implicitly: an open view stays 'all' (assigns render via the canonical map, not the scope),
    // a curated view stays 'curated'. `view` here is pre-write, so its layout is the pre-gesture one.
    const entityScope = scopeForPersist(view.content, view.layout?.referenceLayout)
    // Canonical-clean: layers + assignments (+ the defaultNodeSortMode side-field, which must ride the
    // wholesale write or it would be wiped by every gesture). Mirror the pinned scope into
    // content.entityScope locally so it's explicit for the NEXT gesture (the durable updateViewLayout
    // writes it too).
    const referenceLayout = {
      layers: next.layers,
      assignments: next.assignments,
      ...(next.defaultNodeSortMode ? { defaultNodeSortMode: next.defaultNodeSortMode } : {}),
    }
    useSchemaStore.getState().updateView(view.id, {
      layout: { ...(view.layout ?? {}), referenceLayout },
      content: { ...view.content, entityScope },
    })
    // Arm the debounced durable save — managers only (viewers' edits stay session-local, matching the
    // prior blueprint-autosync gate).
    if (!canManage) return
    pendingLayoutSave.current = { viewId: view.id, referenceLayout, entityScope, branchId: effectiveBranchId }
    armLayoutSave()
  }, [canManage, armLayoutSave, effectiveBranchId])

  // Step 1: Sync view layers to store when activeView changes
  useEffect(() => {
    if (!activeView) return

    const viewLayers = activeView.layout?.referenceLayout?.layers
    if (!viewLayers || viewLayers.length === 0) return

    // Only sync if layers have changed (avoid unnecessary updates)
    const layersChanged =
      storeLayers.length !== viewLayers.length ||
      storeLayers.some((layer, idx) => {
        const viewLayer = viewLayers[idx]
        return !viewLayer ||
          layer.id !== viewLayer.id ||
          JSON.stringify(layer.entityAssignments) !== JSON.stringify(viewLayer.entityAssignments)
      })

    if (layersChanged) {
      setLayers(viewLayers)
    }
  }, [activeView?.id, activeView?.layout?.referenceLayout?.layers, setLayers, storeLayers])

  // Step 1b — HYDRATE display rules from the view on open. Display rules are view-scoped session
  // state on the store, edited via the Property Manager; seeding them here (they no longer arrive via
  // a context-model load) is what makes a view's saved tags appear, and re-seeding on every view
  // switch prevents one view's rules leaking into another. Defined BEFORE the persist effect so on a
  // switch the store is updated first and the persist effect's stale-guard catches the transition.
  useEffect(() => {
    const view = useSchemaStore.getState().getActiveView()
    const raw = view?.layout?.referenceLayout?.displayRules
    useReferenceModelStore.getState().setDisplayRules(Array.isArray(raw) ? (raw as DisplayRuleConfig[]) : [])
  }, [activeView?.id])

  // Step 1c — PERSIST display-rule edits. When the store's rules diverge from the active view's saved
  // rules, fold them into the LOCAL view (so an in-session view switch re-hydrates them) and arm the
  // debounced durable save — which always sends the live displayRules (see doLayoutSave), so a
  // layer-only save never wipes them. Guards: ignore a stale render whose captured rules the store
  // has already moved past (e.g. a switch just re-hydrated), and skip when the view already carries
  // these rules (the hydration seed / no net change). Managers only.
  useEffect(() => {
    if (useReferenceModelStore.getState().displayRules !== displayRules) return
    if (!canManage) return
    const view = useSchemaStore.getState().getActiveView()
    if (!view?.id) return
    const savedRaw = view.layout?.referenceLayout?.displayRules
    const saved = Array.isArray(savedRaw) ? savedRaw : []
    if (JSON.stringify(saved) === JSON.stringify(displayRules)) return
    const norm = normalizeReferenceLayout(view.layout?.referenceLayout)
    const entityScope = scopeForPersist(view.content, view.layout?.referenceLayout)
    useSchemaStore.getState().updateView(view.id, {
      layout: {
        ...(view.layout ?? {}),
        referenceLayout: { layers: norm.layers, assignments: norm.assignments, displayRules },
      },
    })
    pendingLayoutSave.current = { viewId: view.id, referenceLayout: norm, entityScope, branchId: effectiveBranchId }
    armLayoutSave()
  }, [displayRules, canManage, armLayoutSave, effectiveBranchId])

  // Step 2: Load assignments from backend when layers are synced and nodes are available
  // Uses a ref to track what we've computed for, preventing cascading re-fetches.
  const assignmentComputedRef = useRef<string | null>(null)

  // Reset the assignment guard when the active view changes so recomputation
  // always happens for the new view (even if layer IDs happen to match).
  const assignmentRetriesRef = useRef(0)
  useEffect(() => {
    assignmentComputedRef.current = null
    assignmentRetriesRef.current = 0
  }, [activeView?.id])

  useEffect(() => {
    if (nodes.length === 0 || !provider || storeLayers.length === 0) return
    if (assignmentStatus !== 'idle') return

    // Include activeView ID so switching between views with identical layer IDs
    // still triggers recomputation.
    const layerFingerprint = `${activeView?.id ?? ''}:${storeLayers.map(l => l.id).join(',')}`

    // Only compute once per unique view+layer configuration
    if (assignmentComputedRef.current === layerFingerprint) return
    assignmentComputedRef.current = layerFingerprint

    // Thread the active view's canonical placements + scope into the compute request (read LIVE,
    // same as persistReferenceLayout). The store no longer owns these; the adapter in
    // buildAssignmentRequest fills the backend EntityAssignmentConfig fields.
    const view = useSchemaStore.getState().getActiveView()
    const norm = normalizeReferenceLayout(view?.layout?.referenceLayout)
    // Scope the assignment compute to the loaded view (top-level nodes now,
    // plus whatever the user has lazily expanded). The backend reads exactly
    // this set — never the whole graph — so million-node graphs stay fast and
    // no rendered entity is dropped by a truncating cap.
    const loadedUrns = nodes
      .map(n => (n.data?.urn as string) || n.id)
      .filter(Boolean)
    computeAssignments(provider, {
      assignments: norm.assignments,
      entityScope: deriveEntityScope(view?.content, norm),
      entityIds: loadedUrns,
    })
  }, [nodes.length, provider, computeAssignments, assignmentStatus, storeLayers, activeView?.id])

  // Bounded recovery: the 'error' state is otherwise terminal (the compute
  // effect above only fires from 'idle', and the fingerprint ref stays
  // latched), so a transient failure — a backend blip, a request that timed
  // out and then recovered — left the canvas unable to place entities until
  // a full view switch. Retry with backoff a few times, then stop: a
  // genuinely-down backend must not be hammered forever. On success the
  // counter resets so a later, unrelated failure gets its own budget.
  useEffect(() => {
    if (assignmentStatus === 'success') { assignmentRetriesRef.current = 0; return }
    if (assignmentStatus !== 'error') return
    if (assignmentRetriesRef.current >= 3) return
    const attempt = assignmentRetriesRef.current + 1
    const delay = Math.min(1000 * 2 ** attempt, 8000) // 2s, 4s, 8s
    const t = setTimeout(() => {
      assignmentRetriesRef.current = attempt
      assignmentComputedRef.current = null   // clear the fingerprint latch
      resetAssignmentStatus()                // 'error' -> 'idle' re-arms the compute effect
    }, delay)
    return () => clearTimeout(t)
  }, [assignmentStatus, resetAssignmentStatus])

  // Search state
  const [searchQuery, setSearchQuery] = useState('')

  // Entity creation. Every entry point (layer "add" buttons, per-row
  // add-child, right-click create, palette, 'N' key) opens the shared
  // Hierarchy Builder; its store centralizes scope + the ensureDraftOpen
  // guard. Subscribed via selectors so unrelated store writes don't re-render.
  // `surface` distinguishes the 400px rail from the wider Build Mode panel —
  // only one of the two (never both) mounts at a time.
  const builderOpen = useHierarchyBuilderStore(s => s.isOpen && s.surface === 'rail')
  const buildOpen = useHierarchyBuilderStore(s => s.isOpen && s.surface === 'build')
  const builderLayerId = useHierarchyBuilderStore(s => s.layerId)
  const builderParentUrn = useHierarchyBuilderStore(s => s.parentUrn)

  // Assignment warning state (shown when user tries to assign child to different layer)
  const [assignmentWarning, setAssignmentWarning] = useState<string | null>(null)
  const assignmentWarningTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleAssignToLayer = useCallback((entityId: string, layerId: string) => {
    // Drop-to-assign is a layout WRITE; a trace is read-only. (The columns
    // also render the overlay's lanes, so the drop target isn't the browse
    // tree the assignment would be recorded against.)
    if (traceWriteLocked()) return
    const before = currentLayout()
    // Live containment map (from useContainmentHierarchy, exposed via the forward-ref set during render).
    const parentMap = duplicateWiringRef.current?.parentMap ?? new Map<string, string>()

    // Containment hard rule: a child cannot be placed in a different layer than its parent subtree.
    const conflict = assignmentOps.checkAssignmentConflict(parentMap, before.assignments, entityId, layerId)
    if (conflict?.type === 'containment_locked') {
      setAssignmentWarning(conflict.message)
      if (assignmentWarningTimer.current) clearTimeout(assignmentWarningTimer.current)
      assignmentWarningTimer.current = setTimeout(() => setAssignmentWarning(null), 5000)
      return
    }

    const entity = nodesRef.current.find(n => n.id === entityId || (n.data?.urn as string) === entityId)
    const entityName = (entity?.data?.label as string) ?? entityId
    const prevLayerId = before.assignments[entityId]?.layerId
    const prevLayer = before.layers.find(l => l.id === prevLayerId)
    const targetLayer = before.layers.find(l => l.id === layerId)

    // Descendants with their own explicit entries are cleared so they inherit the parent's new layer.
    const clearDescendants = explicitDescendants(entityId, parentMap, before.assignments)
    // A drop into a custom-sorted layer lands at the true BOTTOM of the manual
    // arrangement: first seed any UNKEYED explicit roots of the target layer
    // from its current visual order (else they'd render below the appended
    // entry in the alpha tail), then mint a key after the layer's largest.
    let base = before
    let orderKey: string | undefined
    if (before.layers.find(l => l.id === layerId)?.nodeSortMode === 'custom') {
      const targetRoots = (nodesByLayerRef.current.get(layerId) ?? [])
        .map(n => n.id)
        .filter(id => !id.startsWith('logical:'))
      base = layerOps.setLayerNodeSortMode(before, layerId, 'custom', targetRoots)
      try {
        orderKey = generateKeyBetween(assignmentOps.lastOrderKeyInLayer(base, layerId), null)
      } catch { /* malformed keys — fall back to the unkeyed alpha tail */ }
    }
    const after = assignmentOps.assignEntities(base, [entityId], layerId, { clearDescendants, orderKey })
    persistReferenceLayout(after)
    // A session-created/duplicated ROOT carries a stale reference-model-store instanceAssignment (from
    // the create/duplicate path) that wins at top priority in useLayerAssignment and would shadow this
    // canonical move until reload. Clear it so the canonical value renders immediately (on discard the
    // move's staged `discard` hook restores the pre-move canonical layout via persistReferenceLayout —
    // there is no node-property fallback anymore, that was removed in Phase 3b).
    useReferenceModelStore.getState().removeEntityAssignment(entityId)

    // Surface it in Review & Save as a VIEW-LAYOUT change: no graph op, undoable via discard/reapply.
    useStagedChangesStore.getState().stageOrReplace(
      (c) => c.type === 'assign_layer' && c.targetId === entityId,
      {
        type: 'assign_layer',
        targetId: entityId,
        targetUrn: (entity?.data?.urn as string) ?? entityId,
        before: { layerId: prevLayerId, layerName: prevLayer?.name },
        after: { layerId, layerName: targetLayer?.name },
        summary: `Move '${entityName}' → ${targetLayer?.name ?? 'layer'}`,
        discard: () => persistReferenceLayout(before),
        reapply: () => persistReferenceLayout(after),
      },
    )
  }, [currentLayout, persistReferenceLayout, traceWriteLocked])

  // Expanded nodes state (for hierarchy expansion, not trace)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())

  // Per-view expanded state: save/restore on view switch to prevent stale data
  const expandedByViewRef = useRef<Map<string, Set<string>>>(new Map())
  const prevViewIdRef = useRef<string | null>(null)

  useEffect(() => {
    const currentViewId = activeView?.id ?? null
    // Save current expanded state for the previous view
    if (prevViewIdRef.current && prevViewIdRef.current !== currentViewId) {
      expandedByViewRef.current.set(prevViewIdRef.current, new Set(expandedNodes))
    }
    // Restore or reset for the new view
    if (currentViewId !== prevViewIdRef.current) {
      const restored = expandedByViewRef.current.get(currentViewId ?? '') ?? new Set<string>()
      setExpandedNodes(restored)
      // Reset aggregation cache so stale data doesn't bleed into the new view
      prevAggregationKeyRef.current = ''
      clearAggregationCache()
    }
    prevViewIdRef.current = currentViewId
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView?.id])

  const relationshipTypes = useViewRelationshipTypes()

  // Advanced Search — production panel for template-driven exploration,
  // visual predicate builder, raw JSON (Power tools), and Ask (NL2Query).
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false)

  // Property Manager — right-side drawer to browse properties + author
  // display-rule tags. The engine recomputes which nodes each enabled
  // rule matches and publishes them so FlatTreeItem can render chips.
  const [propertyManagerOpen, setPropertyManagerOpen] = useState(false)
  useDisplayRuleEngine(activeView?.id ?? null)

  // View-metadata dialogs (title menu). EditViewDetailsDialog is prop-driven
  // (open flag); Share mirrors ExplorerPage — mounted while shareSeed is set,
  // seeded from a fresh getView. viewVisibility feeds the menu's read-only
  // row and is only ever populated from that fetch (undefined until first
  // Share open — the menu hides the row while unknown).
  const [viewDetailsOpen, setViewDetailsOpen] = useState(false)
  const [shareSeed, setShareSeed] = useState<
    { id: string; name: string; visibility: 'private' | 'workspace' | 'enterprise' } | null
  >(null)
  const [viewVisibility, setViewVisibility] = useState<'private' | 'workspace' | 'enterprise' | undefined>(undefined)

  // Granularity options for the lineage aggregation selector — driven by the
  // active ontology's entity types, sorted coarsest-first (lowest level first).
  // Filtered to types that are valid lineage anchors (behavior.traceable=true)
  // — matches the trace v2 contract where only traceable entities can be the
  // level a trace runs at. Tags / glossary terms are excluded.
  const schemaEntityTypes = useViewEntityTypes()
  const granularityOptions = useMemo(
    () => schemaEntityTypes
      .filter(et => et.hierarchy?.level !== undefined)
      .filter(et => et.behavior?.traceable !== false)
      .map(et => ({ id: et.id, name: et.name, level: et.hierarchy.level })),
    [schemaEntityTypes]
  )

  // Auto-select the coarsest (lowest-level) granularity once options are
  // available. The toolbar no longer exposes a "no aggregation" option, so
  // null is not a valid resting state.
  useEffect(() => {
    if (lineageGranularity == null && granularityOptions.length > 0) {
      const coarsest = [...granularityOptions].sort((a, b) => a.level - b.level)[0]
      setLineageGranularity(coarsest.id)
    }
  }, [lineageGranularity, granularityOptions, setLineageGranularity])

  // Handle right click - now uses unified CanvasContextMenu
  const handleContextMenu = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.preventDefault()
    e.stopPropagation()
    // The menu is an authoring surface (rename/duplicate/delete/reorder) and
    // its targets are resolved against the BROWSE tree, which is not what the
    // columns are showing. No menu while a trace is on.
    if (traceWriteLocked()) return
    const node = nodes.find(n => n.id === nodeId)
    interactions.openContextMenu(e, {
      type: 'node',
      id: nodeId,
      data: node?.data as Record<string, unknown> || {},
    })
  }, [nodes, interactions, traceWriteLocked])



  // Edge details
  const { isOpen: isEdgePanelOpen, toggle: toggleEdgePanel, close: closeEdgePanel } = useEdgeDetailPanel()
  const { filters: edgeFilters, toggle: toggleEdgeFilter } = useEdgeTypeFilters()
  const ontologyMetadata = useMemo(() => ({ edgeTypeMetadata }), [edgeTypeMetadata])
  const selectEdge = useCanvasStore((s) => s.selectEdge)

  // Generate dynamic edge filters from actual edges and schema
  const dynamicEdgeFilters = useMemo(() => {
    if (edges.length === 0) return edgeFilters
    return generateEdgeTypeFilters(
      edges,
      relationshipTypes,
      containmentEdgeTypes,
      ontologyMetadata
    )
  }, [edges, relationshipTypes, containmentEdgeTypes, ontologyMetadata, edgeFilters])

  // Schema-driven edge color resolver — used by LineageFlowOverlay
  // Resolves edge type → color from backend schema, falling back to defaults
  const resolveEdgeColor = useCallback((edgeType: string) => {
    return getEdgeTypeDefinition(
      edgeType,
      relationshipTypes,
      containmentEdgeTypes,
      ontologyMetadata ? { edgeTypeMetadata: ontologyMetadata.edgeTypeMetadata } : undefined
    ).color
  }, [relationshipTypes, containmentEdgeTypes, ontologyMetadata])

  // Double-click handler: inline edit (default) or trace (shift+double-click)
  const handleDoubleClick = useCallback(async (nodeId: string, event?: React.MouseEvent) => {
    // A trace is a read-only projection: no inline edit, and no re-trace
    // gesture that would land mid-walk. ESC leaves first.
    if (traceWriteLocked()) return

    // UX-first: Double-click = inline edit (modern approach)
    // Use Shift+Double-click for trace (power user feature)
    //
    if (event && !event.shiftKey) {
      // The rename this opens stages `rename_entity` → POST /graph/changes, which the server
      // refuses when editing is off. Don't start an edit that cannot be saved: the user would
      // type a new name, press enter, and get a 403 they cannot attribute to a setting.
      //
      // Returning here rather than falling through matters. The fall-through leads to TRACE, so
      // without it a plain double-click would silently become a trace gesture the moment an admin
      // turned editing off — repurposing an input nobody asked us to repurpose.
      if (!canEditGraph) return

      // Find the node element to get its position
      const element = document.getElementById(`layer-node-${nodeId}`)
      if (element) {
        const rect = element.getBoundingClientRect()
        const targetNode = nodes.find(n => n.id === nodeId)
        interactions.startInlineEdit(
          nodeId,
          (targetNode?.data?.label as string) || nodeId,
          { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        )
        return
      }
    }

    // TRACE: open the Lineage Lens on this node with the full walk on.
    toggleTraceRef.current(nodeId)
  }, [nodes, interactions, canEditGraph, traceWriteLocked])


  // Lineage flow toggle
  const [showLineageFlow, setShowLineageFlow] = useState(initialShowLineageFlow)

  // Edge direction toggle — controls arrowheads + animated mid-edge chevron
  const [showEdgeDirection, setShowEdgeDirection] = useState(true)

  // Trace bottom dock — expanded vs compact. Lifted to the canvas so a
  // global Cmd/Ctrl+I shortcut can toggle it from anywhere.
  const [dockExpanded, setDockExpanded] = useState(false)
  // The dock's collapse/shortcut effects live further down, after the
  // native trace session (`traceActive`) they key on is declared.

  // Sync ontology-derived lineage edge types into trace config so the trace
  // backend traverses TRANSFORMS, AGGREGATED, and any other ontology-classified
  // lineage edges — not just AGGREGATED. (Issue #3)
  useEffect(() => {
    if (lineageEdgeTypes.length > 0) {
      trace.setConfig({ lineageEdgeTypes })
    }
  }, [lineageEdgeTypes, trace.setConfig])

  // Trace entry points start the NATIVE canvas trace — see `canvasTrace`
  // below, where the forward-declared refs are wired. The smart-level
  // /trace/v2 wrappers that lived here are gone with them.

  // Staged changes — review-before-save layer for all canvas edits
  const stagedChangeList = useStagedChangesStore(s => s.changes)
  const stagedRedoStack = useStagedChangesStore(s => s.redoStack)
  const isStagedPanelOpen = useStagedChangesStore(s => s.isReviewPanelOpen)
  const openStagedChangesPanel = useStagedChangesStore(s => s.openReviewPanel)
  const closeStagedChangesPanel = useStagedChangesStore(s => s.closeReviewPanel)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [showStartEditing, setShowStartEditing] = useState(false)
  // An import commits to the draft server-side; we refresh only when the user LEAVES the import
  // dialog (re-hydrating mid-dialog unmounts it and hides the preview).
  const importedRef = useRef(false)
  const applyStagedChanges = useStagedChangesStore(s => s.applyAll)
  const queryClient = useQueryClient()
  // Refresh the canvas + versioning surfaces after an import — but only on dialog exit, and only if
  // an import happened (re-hydrating while the dialog is open unmounts its preview).
  const refreshAfterImport = useCallback(() => {
    if (!importedRef.current) return
    importedRef.current = false
    queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.all })
    invalidateAggregatedEdges()
    useBranchStore.getState().bumpMainEpoch()
  }, [queryClient])
  // After a publish/merge, `main@head` moves and the FalkorDB projection (which the canvas +
  // Properties panel read) catches up ASYNCHRONOUSLY. The immediate post-merge re-hydration reads
  // the still-stale projection, so merged properties don't appear until a later refresh. Watch the
  // projection watermark: when it finishes (fresh false→true), re-hydrate so the canvas reflects the
  // freshly-projected state with no manual refresh.
  // Versioning reads are membership-gated and meaningless to a read-only
  // shared viewer (no drafts, no projection to chase) — don't fire them.
  const projFresh = useProjectionWatermark(
    readOnly ? undefined : scopeWsId ?? undefined,
    readOnly ? null : graphId,
  ).data?.fresh
  const prevProjFreshRef = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    if (prevProjFreshRef.current === false && projFresh === true) {
      useBranchStore.getState().bumpMainEpoch()
    }
    prevProjFreshRef.current = projFresh
  }, [projFresh])
  const undoStagedChange = useStagedChangesStore(s => s.undo)
  const redoStagedChange = useStagedChangesStore(s => s.redo)

  // Keyboard shortcuts for Undo/Redo — works anywhere on the canvas, but only in draft (edit)
  // mode: Published is read-only, so there are no staged changes to undo/redo.
  useEffect(() => {
    if (!isDraft) return
    const onKey = (e: KeyboardEvent) => {
      // Ignore when the user is typing in an input/textarea
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undoStagedChange()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redoStagedChange()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDraft, undoStagedChange, redoStagedChange])

  // Ref to trigger edge redraw from child components
  const triggerEdgeRedrawRef = useRef<(() => void) | null>(null)

  // Horizontal scroll container — used by the drawer-aware autoscroll effect
  // below to keep the selected column in the un-occluded region whenever a
  // side panel (EntityDrawer / EdgeDetailPanel) is open.
  const horizontalScrollRef = useRef<HTMLDivElement | null>(null)
  const lastAutoScrolledForSelectionRef = useRef<string | null>(null)

  // Zoom changes move every node card, but nothing else forces the edge
  // overlay to recompute geometry. Double-rAF so the transform commits
  // before the redraw reads fresh rects.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => triggerEdgeRedrawRef.current?.())
    })
    return () => cancelAnimationFrame(raf)
  }, [canvasZoom])

  // Side panels (EntityDrawer, EdgeDetailPanel, Advanced Search, the
  // hierarchy builder/build rails) are OVERLAYS that reserve canvas space
  // via padding — a change that does NOT resize the observed node cards,
  // so the overlay's ResizeObserver never fires. Without an explicit
  // nudge the lineage marks stay anchored to their pre-panel positions,
  // stranding ghost stubs/edges over empty canvas when a panel opens,
  // closes, or the tree is expanded/collapsed while one is open. Force a
  // redraw on every panel transition, with trailing settle passes so the
  // marks land on the post-animation geometry (panels slide ~300–400ms).
  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => triggerEdgeRedrawRef.current?.()),
    )
    const t1 = setTimeout(() => triggerEdgeRedrawRef.current?.(), 250)
    const t2 = setTimeout(() => triggerEdgeRedrawRef.current?.(), 480)
    return () => { cancelAnimationFrame(raf); clearTimeout(t1); clearTimeout(t2) }
  }, [drawerNodeId, selectedNodeId, isEdgePanelOpen, advancedSearchOpen, builderOpen, buildOpen])

  // Zoom-out mounts ~1/zoom more rows per column (the wrapper's layout
  // pre-compensation enlarges the scroll viewport in layout px), so the
  // extra coverage comes from the larger window — overscan can shrink to
  // keep total mounted rows bounded.
  const effectiveOverscan = useMemo(
    () => Math.min(15, Math.max(5, Math.round(15 * canvasZoom))),
    [canvasZoom],
  )

  // Drawer-aware horizontal autoscroll: when a side panel opens (EntityDrawer
  // for selected nodes or EdgeDetailPanel for selected edges) the right edge
  // of the canvas is reserved via padding, but a node already sitting on the
  // far right would still be visually clipped. This effect smoothly slides the
  // selected node's column into the un-occluded region. One-shot per
  // selection so the user retains scroll control afterwards (mirrors the
  // trace-focus auto-scroll guard in LayerColumn).
  useEffect(() => {
    const drawerOpen = !!selectedNodeId
    if (!drawerOpen && !isEdgePanelOpen) {
      lastAutoScrolledForSelectionRef.current = null
      return
    }
    if (!selectedNodeId) return
    if (lastAutoScrolledForSelectionRef.current === selectedNodeId) return

    const layerId = effectiveAssignments.get(selectedNodeId)?.layerId
    if (!layerId) return

    // Defer two frames: first to let React commit the padding change, second
    // to let layout settle so getBoundingClientRect reads the new geometry.
    let cancelRaf2: number | null = null
    const raf1 = requestAnimationFrame(() => {
      cancelRaf2 = requestAnimationFrame(() => {
        const container = horizontalScrollRef.current
        if (!container) return
        const column = container.querySelector(
          `[data-layer-id="${CSS.escape(layerId)}"]`,
        ) as HTMLElement | null
        if (!column) return

        // Read actual rendered panel widths (responsive clamp() values) so the
        // math doesn't over- or under-shift on different viewport sizes.
        const drawerEl = document.querySelector('[data-panel="entity-drawer"]') as HTMLElement | null
        const edgePanelEl = document.querySelector('[data-panel="edge-detail-panel"]') as HTMLElement | null
        const reservedRight = drawerEl?.offsetWidth ?? edgePanelEl?.offsetWidth ?? 0

        const cRect = container.getBoundingClientRect()
        const colRect = column.getBoundingClientRect()
        const margin = 24

        const viewportLeft = cRect.left
        const viewportRight = cRect.right - reservedRight

        let delta = 0
        if (colRect.right > viewportRight) {
          delta = colRect.right - viewportRight + margin
        } else if (colRect.left < viewportLeft) {
          delta = colRect.left - viewportLeft - margin
        }

        if (delta !== 0) {
          container.scrollTo({
            left: container.scrollLeft + delta,
            behavior: 'smooth',
          })
          // Lineage edges measure node positions from the DOM; redraw once the
          // smooth scroll has settled so trace edges follow the column.
          setTimeout(() => triggerEdgeRedrawRef.current?.(), 350)
        }
        lastAutoScrolledForSelectionRef.current = selectedNodeId
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      if (cancelRaf2 != null) cancelAnimationFrame(cancelRaf2)
    }
  }, [selectedNodeId, isEdgePanelOpen, effectiveAssignments])

  const handleLayerScroll = useCallback(() => {
    if (triggerEdgeRedrawRef.current) {
      triggerEdgeRedrawRef.current()
    }
  }, [])

  // Callback for animation completion to trigger edge redraw
  const handleAnimationComplete = useCallback(() => {
    // Small delay to ensure DOM is fully updated after animation
    requestAnimationFrame(() => {
      if (triggerEdgeRedrawRef.current) {
        triggerEdgeRedrawRef.current()
      }
    })
  }, [])

  // Sort layers by order
  const activeLayers = useMemo(() => {
    if (layers && layers !== defaultReferenceModelLayers && layers.length > 0) return layers
    if (activeView?.layout?.referenceLayout?.layers?.length) return activeView.layout.referenceLayout.layers
    return defaultReferenceModelLayers
  }, [layers, activeView])

  const sortedLayers = useMemo(() =>
    [...activeLayers].sort((a, b) => a.order - b.order),
    [activeLayers]
  )

  // Layer Strip chips — stable identity so the strip's scroll-measure
  // effect doesn't re-attach on unrelated canvas re-renders.
  const stripLayers = useMemo(
    () => sortedLayers.map(l => ({ id: l.id, name: l.name, color: l.color || '#6366f1' })),
    [sortedLayers],
  )

  // Monotonic version counter — replaces brittle fingerprint sampling.
  // Incremented automatically by canvas store middleware on every node/edge mutation.
  const canvasVersion = useCanvasVersion()
  const nodeEdgeFingerprint = `${activeView?.id ?? ''}:${canvasVersion}`

  // Build containment hierarchy using shared hook (incremental updates).
  const { nodeMap, childMap, parentMap } = useContainmentHierarchy({
    nodes, edges, isContainmentEdge, fingerprint: nodeEdgeFingerprint,
  })

  // Helper: Calculate currently visible top-level nodes (containers)
  const getVisibleContainerUrns = useCallback(() => {
    return nodes
      .filter(n => {
        const parentId = parentMap.get(n.id)
        if (!parentId) return true // Root
        return expandedNodes.has(parentId)
      })
      .map(n => (n.data?.urn as string) || n.id)
      .filter(Boolean)
  }, [nodes, parentMap, expandedNodes])

  // Track previous aggregation target fingerprint to avoid redundant fetches
  const prevAggregationKeyRef = useRef<string>('')

  // Stable node URN-to-ID map (updated via ref to avoid effect dependency on nodes)
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  // === Extracted Hooks ===

  // Canonical reference layout (assignments + scope) for THIS view — the authoritative render source
  // (replaces the reference-model store's per-layer entityAssignments). Memoized on the raw config so
  // the assignment resolver only recomputes on a real layout change.
  const activeReferenceLayout = useMemo(
    () => normalizeReferenceLayout(activeView?.layout?.referenceLayout),
    [activeView?.layout?.referenceLayout],
  )
  const activeEntityScope = useMemo(
    () => deriveEntityScope(activeView?.content, activeReferenceLayout),
    [activeView?.content, activeReferenceLayout],
  )

  // ─── Node sort modes ────────────────────────────────────────────────────────
  // Persisted state: view-wide `defaultNodeSortMode` + per-layer `nodeSortMode`
  // overrides (both in referenceLayout). Viewer state: DEVICE-LOCAL per-view
  // overrides in the preferences store, so a read-only viewer's re-sort
  // survives reload without ever writing to the shared view.
  const viewDefaultSortMode = activeReferenceLayout.defaultNodeSortMode ?? 'alpha-asc'
  const activeViewIdForSort = activeView?.id ?? ''
  const persistedSortOverrides = usePreferencesStore(
    (s) => s.viewSortOverrides[activeViewIdForSort],
  )
  const sortOverrides = useMemo<ReadonlyMap<string, LayerNodeSortAlgo>>(
    () => new Map(Object.entries(persistedSortOverrides ?? {})),
    [persistedSortOverrides],
  )
  // Node-ordering kill switch (Admin → Features): hides the sort menu and
  // disables reordering; persisted orders still RENDER (read-only safety).
  const nodeSortingEnabled = useFeature('nodeSortingEnabled')

  // Fit-to-width: intrinsic width from state (scrollWidth lies under the
  // 100/zoom% compensation). Column collapse state is LayerColumn-local,
  // so v1 assumes all columns expanded — a safe over-estimate that only
  // makes the fitted zoom slightly smaller.
  const handleFitToWidth = useCallback(() => {
    const viewport = horizontalScrollRef.current?.clientWidth ?? 0
    setCanvasZoom(computeFitZoom(sortedLayers.length, 0, viewport))
    horizontalScrollRef.current?.scrollTo({ left: 0, behavior: 'smooth' })
  }, [setCanvasZoom, sortedLayers.length])

  // Measure the outer container's CLASSIC horizontal scrollbar into
  // --canvas-hsb (0 for macOS overlay scrollbars). Percentage heights
  // ignore scrollbar gutters, so without this the columns overflow the
  // visible area by the scrollbar height and their bottom edge (and the
  // bottom periphery scrims) clips below the fold.
  useEffect(() => {
    const el = horizontalScrollRef.current
    if (!el) return
    const update = () => {
      el.style.setProperty('--canvas-hsb', `${Math.max(0, el.offsetHeight - el.clientHeight)}px`)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => { fitToWidthRef.current = handleFitToWidth }, [handleFitToWidth])

  // Layer assignment: rules, nodesByLayer, displayFlat, displayMap, urnToIdMap, nodeLayerMap
  const { nodesByLayer, displayFlat, displayMap, urnToIdMap, nodeLayerMap, unassignedNodes } = useLayerAssignment({
    nodes, sortedLayers, nodeEdgeFingerprint,
    instanceAssignments, effectiveAssignments,
    nodeMap, childMap, parentMap,
    assignments: activeReferenceLayout.assignments,
    entityScope: activeEntityScope,
    defaultNodeSortMode: activeReferenceLayout.defaultNodeSortMode,
    sortOverrides,
  })

  // Live per-layer visual roots for custom-order seeding (ref, not a dep, so the
  // sort handlers keep a stable identity and LayerColumn's memo holds).
  const nodesByLayerRef = useRef(nodesByLayer)
  nodesByLayerRef.current = nodesByLayer

  // Live context for resolving a parent's effective child-sort direction inside
  // stable callbacks (refs so loadChildrenSorted keeps ONE identity — a dep on
  // nodeLayerMap would re-mint it every canvas mutation and bust LayerColumn's memo).
  const sortDirectionCtxRef = useRef({
    nodeLayerMap, layers: sortedLayers, overrides: sortOverrides, dflt: viewDefaultSortMode,
  })
  sortDirectionCtxRef.current = {
    nodeLayerMap, layers: sortedLayers, overrides: sortOverrides, dflt: viewDefaultSortMode,
  }

  // Live rendered-tree context for custom-order reordering (refs so the
  // reorder handlers keep ONE identity — LayerColumn is React.memo'd).
  const reorderTreeRef = useRef<ReorderTreeContext>({ displayMap, parentMap, nodesByLayer, nodeLayerMap })
  reorderTreeRef.current = { displayMap, parentMap, nodesByLayer, nodeLayerMap }

  // Refresh the duplicate-subtree wiring ref now that its deps exist (see the
  // ref declaration near the interactions call). Read lazily by onNodeCopied /
  // onNodeDuplicated so each duplicate action sees live layer state.
  duplicateWiringRef.current = {
    nodeLayerMap, sortedLayers, assignEntityToLayer, parentMap, setExpandedNodes, currentLayout, persistReferenceLayout,
  }

  // ── NATIVE canvas trace — Trace = the canvas shows the whole flow ──
  // upfront (Lens = interactive investigation; the two coexist). Every
  // trace affordance starts this session; the walk engine fetches to the
  // ends and the OVERLAY (below) draws the result. Nothing is merged into
  // the canvas store, so leaving a trace restores the canvas for free.
  const canvasTrace = useCanvasTraceWalk(provider)
  const traceActive = canvasTrace.isTracing
  // RENDER-TIME twin of `traceWriteLocked()`, which reads refs and so must not
  // be called during render. `overlay.active` implies `traceActive`, so the
  // session flag alone is the whole window — including the walk, when the
  // columns still show browse and every authoring affordance on them still
  // looks (and, ungated, still is) live.
  const canvasWritable = canEditGraph && !traceActive
  const traceModel = canvasTrace.walkEntry?.model ?? null
  // A SHARED TRACE (`?trace=…`) — decoded once during the first render, so
  // the trace opens on the shared picture with no un-restored flash, and so
  // every piece of state below can simply START there rather than being set
  // into place by an effect. A malformed token decodes to null and the view
  // opens normally: a link arrives from outside and must never be able to
  // break the canvas.
  const [initialTraceShare] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get('trace')
    return raw ? decodeTraceShare(raw) : null
  })
  // Direction visibility — the dock's upstream/downstream toggles. Reset
  // on every trace start so a new trace always opens with the whole flow;
  // a shared link starts on the sides its sender was reading.
  const [traceShowUpstream, setTraceShowUpstream] = useState(initialTraceShare?.up ?? true)
  const [traceShowDownstream, setTraceShowDownstream] = useState(initialTraceShare?.down ?? true)
  // Hop-depth limits — VIEW-side (the walk fetched everything; ≥ the
  // walk's own fetch depth means unlimited). Reset on trace start.
  const [traceDepthUp, setTraceDepthUp] = useState(initialTraceShare?.depthUp ?? FULL_WALK_INITIAL_DEPTH)
  const [traceDepthDown, setTraceDepthDown] = useState(initialTraceShare?.depthDown ?? FULL_WALK_INITIAL_DEPTH)

  // THE TRACE OVERLAY. Everything a trace draws — lanes, cards, counts,
  // wires — is a pure function of (walk model, this view's placement,
  // the reader's own expansion). The placement chain is the SAME one
  // useLayerAssignment resolves the browse canvas with, so an overlay card
  // anchors exactly where the canvas behind it would place the same node.
  const branchCreatedUrns = useBranchCreatedDelta()
  const viewIsCurated = activeEntityScope === 'curated'
  const overlayPlacement = useMemo(() => ({
    backendAssignments: new Map(
      [...effectiveAssignments].map(([nodeId, a]) => [nodeId, a.layerId] as const),
    ),
    unassignedFallbackLayerId: viewIsCurated
      ? undefined
      : sortedLayers.find(l => l.showUnassigned === true)?.id,
    branchCreatedUrns,
  }), [effectiveAssignments, viewIsCurated, sortedLayers, branchCreatedUrns])
  const overlay = useTraceOverlay({
    model: traceModel,
    focusUrn: canvasTrace.tracedUrn,
    layers: sortedLayers,
    assignments: activeReferenceLayout.assignments,
    viewIsCurated,
    showUpstream: traceShowUpstream,
    showDownstream: traceShowDownstream,
    depthUp: traceDepthUp,
    depthDown: traceDepthDown,
    placement: overlayPlacement,
  })
  // Read by the interaction callbacks (toggle, reveal, the write guards),
  // which must keep ONE identity — the overlay object is re-made every
  // render, so depending on it would re-mint them and bust LayerColumn's
  // memo. Assigned in an effect, not during render: those callbacks only
  // ever fire after commit, and a render-time ref write blocks the compiler
  // from preserving the surrounding memoization.
  const canvasTraceRef = useRef(canvasTrace)
  // The live trace VIEW, for the debounced history writer: a timer closure
  // captured when the reader opened a card would otherwise record whatever
  // was true 250 ms ago.
  const traceViewParamsRef = useRef({
    showUpstream: traceShowUpstream, showDownstream: traceShowDownstream,
    depthUp: traceDepthUp, depthDown: traceDepthDown,
  })
  useEffect(() => {
    overlayRef.current = overlay
    canvasTraceRef.current = canvasTrace
    traceViewParamsRef.current = {
      showUpstream: traceShowUpstream, showDownstream: traceShowDownstream,
      depthUp: traceDepthUp, depthDown: traceDepthDown,
    }
    // Keeps the lock honest in both directions — notably it CLEARS on exit,
    // and it re-arms for a trace started anywhere other than `beginTrace`.
    traceSessionRef.current = canvasTrace.isTracing
  })

  // ── Trace history — browser-style back/forward over this user's traces
  // in THIS view, persisted to localStorage (per user, per view; capped).
  // Entries record the focal AND how it was viewed (direction + depths),
  // so back restores the trace as the user left it. Session cache makes
  // restores instant while the canvas stays mounted; across sessions a
  // restore refetches like any trace.
  const authUserId = useAuthStore((s) => s.user?.id ?? 'anon')
  const traceHistoryKey = `nx:trace-history:v1:${authUserId}:${activeView?.id ?? 'no-view'}`
  const [traceHistory, setTraceHistory] = useState<TraceHistoryStack>(() => {
    const stored = hydrateTraceHistory(typeof localStorage === 'undefined' ? null : localStorage.getItem(traceHistoryKey))
    // The shared trace joins the recipient's own history, so it survives the
    // param strip below: after a reload it is one click away in the launcher
    // rather than gone with the URL.
    return initialTraceShare
      ? pushTraceFocal(stored, {
          urn: initialTraceShare.urn,
          focusId: initialTraceShare.urn,
          view: {
            showUpstream: initialTraceShare.up,
            showDownstream: initialTraceShare.down,
            depthUp: initialTraceShare.depthUp,
            depthDown: initialTraceShare.depthDown,
            traceExpansion: initialTraceShare.open,
          },
          timestamp: Date.now(),
        })
      : stored
  })
  // Re-hydrate when the user/view (and so the key) changes.
  const traceHistoryKeyRef = useRef(traceHistoryKey)
  useEffect(() => {
    if (traceHistoryKeyRef.current === traceHistoryKey) return
    traceHistoryKeyRef.current = traceHistoryKey
    setTraceHistory(hydrateTraceHistory(localStorage.getItem(traceHistoryKey)))
  }, [traceHistoryKey])
  // Persist on every change (last-write-wins across tabs — history is a
  // convenience, never a source of truth).
  useEffect(() => {
    try {
      localStorage.setItem(traceHistoryKeyRef.current, serializeTraceHistory(traceHistory))
    } catch { /* storage full/blocked — history stays in-memory */ }
  }, [traceHistory])
  // The pending expansion record (see `recordTraceExpansionSoon` below).
  // Declared up here because every path that CHANGES THE FOCAL has to cancel
  // it first: a flush scheduled by the trace being left would otherwise land
  // on the entry being opened.
  const expansionRecordRef = useRef<{ timer: ReturnType<typeof setTimeout>; forFocus: string } | null>(null)
  const cancelExpansionRecord = useCallback(() => {
    if (expansionRecordRef.current) clearTimeout(expansionRecordRef.current.timer)
    expansionRecordRef.current = null
  }, [])

  // Every view-param change while tracing is recorded on the CURRENT
  // history entry, so back/forward restore the trace as it was left.
  // Called from the setters' own event paths (never an effect).
  // Reads the live view off refs rather than deps, which is what lets it be
  // called from a TIMER (the expansion recorder below) and keeps it out of
  // the dock adapter's dependency list.
  const recordTraceView = useCallback((partial: Partial<{ showUpstream: boolean; showDownstream: boolean; depthUp: number; depthDown: number }>) => {
    const live = traceViewParamsRef.current
    setTraceHistory(h => {
      const cur = currentTraceEntry(h)
      if (!cur || cur.urn !== canvasTraceRef.current.tracedUrn) return h
      return updateCurrentTraceView(h, {
        showUpstream: partial.showUpstream ?? live.showUpstream,
        showDownstream: partial.showDownstream ?? live.showDownstream,
        depthUp: partial.depthUp ?? live.depthUp,
        depthDown: partial.depthDown ?? live.depthDown,
        // The picture, always — `updateCurrentTraceView` REPLACES the view,
        // so omitting it would erase the reader's expansion every time they
        // touched a direction arrow.
        traceExpansion: [...(overlayRef.current?.traceExpansion ?? [])],
      })
    })
  }, [])

  // Write a pending record NOW. Every navigation calls this first: the timer
  // is 250 ms behind the click and the reader is faster than that, so a card
  // opened just before Back would otherwise be dropped on the floor. Only
  // for the focus it was scheduled for — the record describes THAT trace.
  const flushExpansionRecord = useCallback(() => {
    const pending = expansionRecordRef.current
    cancelExpansionRecord()
    if (pending && canvasTraceRef.current.tracedUrn === pending.forFocus) recordTraceView({})
  }, [cancelExpansionRecord, recordTraceView])

  // Low-level entry shared by fresh traces and history restores. A trace
  // with the flow overlay off is a contradiction — tracing IS asking to
  // see the flow — and entering one collapses the sticky drawer once, so
  // the flow opens unobstructed (clicking a node re-opens it as usual).
  const beginTrace = useCallback((urn: string) => {
    setShowLineageFlow(true)
    useCanvasStore.getState().closeNodeDrawer()
    // Lock writes NOW, not on the next commit: the reader can click a browse
    // chevron between pressing Trace and the walk's first wave.
    traceSessionRef.current = true
    // Drop every child page still in flight. It was requested for the browse
    // canvas, and letting it resolve mid-trace would addGraph into the store
    // behind the overlay — a write the trace cannot undo on exit.
    const hydration = childLoadRef.current
    if (hydration) {
      for (const id of hydration.loadingNodes) {
        hydration.cancel(id)
        // `searchChildren` queues under its OWN keyspace while recording the
        // BARE id in `loadingNodes`, so cancelling the id alone leaves an
        // in-flight child search running straight into the trace.
        hydration.cancel(`search:${id}`)
      }
    }
    canvasTrace.start(urn)
  }, [canvasTrace])

  // `direction` presets the VIEW (the dock's ↑/⇅/↓ mode — Root Cause /
  // Impact / Full Lineage); the walk itself always fetches both ways, so
  // switching mode afterwards is instant. Re-tracing the SAME node with
  // a different direction just flips the view — the walk cache stays,
  // and the history records ONE entry per focal (the flip updates it).
  const startCanvasTrace = useCallback((nodeId: string, direction: 'up' | 'down' | 'both' = 'both') => {
    const urn = displayMap.get(nodeId)?.urn ?? nodeId
    const view = {
      showUpstream: direction !== 'down',
      showDownstream: direction !== 'up',
      depthUp: FULL_WALK_INITIAL_DEPTH,
      depthDown: FULL_WALK_INITIAL_DEPTH,
      // Re-pressing Trace on the focal already on screen does NOT re-seed the
      // overlay, so recording an empty picture here would leave the entry
      // describing a trace nobody is looking at. A genuinely new focal has no
      // picture yet: empty means "as it opens", and the seed decides.
      traceExpansion: canvasTraceRef.current.tracedUrn === urn
        ? [...(overlayRef.current?.traceExpansion ?? [])]
        : [],
    }
    setTraceShowUpstream(view.showUpstream)
    setTraceShowDownstream(view.showDownstream)
    setTraceDepthUp(view.depthUp)
    setTraceDepthDown(view.depthDown)
    // Same reason as `traceHistoryGo`: the entry being left keeps its picture.
    flushExpansionRecord()
    setTraceHistory(h => pushTraceFocal(h, { urn, focusId: nodeId, view, timestamp: Date.now() }))
    beginTrace(urn)
  }, [displayMap, beginTrace, flushExpansionRecord])

  // History restore: the entry's own view params, no push (back/forward
  // move the cursor, they never rewrite the trail).
  const restoreTraceEntry = useCallback((entry: TraceHistoryEntryRecord) => {
    // Its one caller, `traceHistoryGo`, has already flushed any pending
    // record onto the entry being LEFT — which is why nothing is cancelled
    // here: a bare cancel would drop the reader's picture instead of keeping
    // it, and the flush leaves nothing armed to land on this entry.
    setTraceShowUpstream(entry.view.showUpstream)
    setTraceShowDownstream(entry.view.showDownstream)
    // ONE DEPTH RULE, even for history written under the old 100-hop control.
    setTraceDepthUp(Math.min(entry.view.depthUp, FULL_WALK_INITIAL_DEPTH))
    setTraceDepthDown(Math.min(entry.view.depthDown, FULL_WALK_INITIAL_DEPTH))
    // THE PICTURE, not just the focus. Empty means "as the trace opened", so
    // the overlay's own seed is the right answer and restoring nothing is how
    // it gets to run — see traceHistoryStack's note on the empty expansion.
    if (entry.view.traceExpansion.length > 0) {
      overlayRef.current?.restoreExpansion(entry.urn, entry.view.traceExpansion)
    }
    beginTrace(entry.urn)
  }, [beginTrace])
  // OPENING A SHARED TRACE. Everything the link carries is already in place
  // — the direction, the depths and the history entry all START there — so
  // what is left is to actually run it, once, and to restore the picture the
  // sender had open. The overlay owns expansion, so this cannot be a state
  // initializer like the rest.
  const sharedTraceStarted = useRef(false)
  useEffect(() => {
    if (!initialTraceShare || sharedTraceStarted.current) return
    sharedTraceStarted.current = true
    if (initialTraceShare.open.length > 0) {
      overlayRef.current?.restoreExpansion(initialTraceShare.urn, initialTraceShare.open)
    }
    beginTrace(initialTraceShare.urn)
  }, [initialTraceShare, beginTrace])

  const traceHistoryGo = useCallback((next: TraceHistoryStack) => {
    if (next === traceHistory) return
    // A toggle inside the debounce window belongs to the entry the reader is
    // LEAVING, so it is written while the cursor is still on it and only then
    // does the cursor move. TWO QUEUED UPDATERS, applied in order: the cursor
    // move has to ride on the recorded stack, because `next` was computed
    // from the pre-flush one and setting it as a value would discard the
    // record it never saw.
    flushExpansionRecord()
    setTraceHistory(h => traceHistoryJump(h, next.cursor))
    const entry = currentTraceEntry(next)
    if (entry) restoreTraceEntry(entry)
  }, [traceHistory, restoreTraceEntry, flushExpansionRecord])
  const traceBack = useCallback(() => traceHistoryGo(traceHistoryBack(traceHistory)), [traceHistoryGo, traceHistory])
  const traceForward = useCallback(() => traceHistoryGo(traceHistoryForward(traceHistory)), [traceHistoryGo, traceHistory])

  // WHAT THE READER HAS OPEN, on a trailing edge. The timer reads the
  // expansion at FIRE time, so it records where the reader ended up rather
  // than every level they passed through on the way.
  const recordTraceExpansionSoon = useCallback(() => {
    const forFocus = canvasTraceRef.current.tracedUrn
    if (!forFocus) return
    cancelExpansionRecord()
    expansionRecordRef.current = {
      forFocus,
      timer: setTimeout(() => {
        expansionRecordRef.current = null
        // Back pressed between the toggle and the flush: the picture on
        // screen now belongs to the entry the reader moved TO, and writing
        // it here would overwrite the one they just came back to.
        if (canvasTraceRef.current.tracedUrn === forFocus) recordTraceView({})
      }, TRACE_EXPANSION_RECORD_MS),
    }
  }, [cancelExpansionRecord, recordTraceView])
  useEffect(() => cancelExpansionRecord, [cancelExpansionRecord])
  // Stable identity (refs, not deps) so the ESC listener below attaches
  // once per trace rather than once per render.
  const exitCanvasTrace = useCallback(() => {
    overlayRef.current?.exit()
    canvasTraceRef.current.exit()
    resetAllCircuitBreakers()
  }, [])
  // Forward-declared refs, for hooks that fire earlier in render order.
  // Assigned in an effect (not render) — the interaction callbacks that
  // read them only fire after commit, and a render-time ref write blocks
  // the compiler from preserving the surrounding memoization.
  useEffect(() => {
    startTraceRef.current = startCanvasTrace
    toggleTraceRef.current = startCanvasTrace
  }, [startCanvasTrace])
  // What the canvas renders while a trace is on: the overlay's lanes, as
  // the HierarchyNode trees LayerColumn already knows how to draw. The
  // lanes hold ONLY the visible tree (a closed card emits no children), so
  // this is the whole picture — no filtering step downstream.
  //
  // Direction toggles and hop-depth limits narrow WHAT RENDERS, never what
  // was walked: they are inputs to the view model, so "2 up / 3 down"
  // answers instantly with no refetch.
  const traceRender = useMemo(
    () => (overlay.view ? lanesToRenderTrees(overlay.view.lanes) : null),
    [overlay.view],
  )

  // WHAT THE CANVAS IS DRAWING THAT THE STORE DOES NOT HOLD. The walk's
  // nodes are canvas-shaped already (`toCanvasNode`), they are simply not in
  // the store — by design, so leaving a trace costs nothing. The entity
  // drawer asks the store first and this second, which is what lets a reader
  // click any partner card and read what it is.
  const traceNodeIndex = useMemo(() => {
    if (!traceModel) return null
    const index = new Map<string, LineageNode>()
    for (const node of traceModel.nodes) index.set(node.id, node)
    return index
  }, [traceModel])
  const resolveTraceNode = useCallback(
    (id: string): LineageNode | null => traceNodeIndex?.get(id) ?? null,
    [traceNodeIndex],
  )

  // Expansion in trace mode is the OVERLAY's, never the canvas's — which
  // is why exiting restores the reader's own browse expansion for free.
  const expandedForRender = traceRender
    ? (overlay.traceExpansion as Set<string>)
    : expandedNodes

  // The flow-direction picture for LineageFlowOverlay — the SAME styling
  // contract the legacy trace drove (cyan upstream, amber downstream,
  // focus glow, non-participants dimmed), synthesized from the walk model.
  const nativeTraceResult = useMemo(() => {
    if (!overlay.active || !traceModel) return null
    const toIds = (urns: ReadonlySet<string>) => {
      const s = new Set<string>()
      for (const u of urns) s.add(urnToIdMap.get(u) ?? u)
      return s
    }
    return {
      upstreamNodes: toIds(traceModel.upstreamUrns),
      downstreamNodes: toIds(traceModel.downstreamUrns),
      focusId: canvasTrace.tracedUrn ? (urnToIdMap.get(canvasTrace.tracedUrn) ?? canvasTrace.tracedUrn) : null,
    }
  }, [overlay.active, traceModel, canvasTrace.tracedUrn, urnToIdMap])

  const traceParticipants = useMemo(() => {
    const upstream: Array<{ urn: string; label: string }> = []
    const downstream: Array<{ urn: string; label: string }> = []
    if (traceActive && traceModel) {
      for (const n of traceModel.nodes) {
        const entry = { urn: n.urn, label: n.displayName ?? n.urn }
        if (traceModel.upstreamUrns.has(n.urn)) upstream.push(entry)
        else if (traceModel.downstreamUrns.has(n.urn)) downstream.push(entry)
      }
    }
    return { upstream, downstream }
  }, [traceActive, traceModel])

  // The REAL TraceBottomDock, driven by the native walk: an adapter shaped
  // as UseUnifiedTraceResult. The dormant legacy hook supplies every field
  // the dock family may touch; the native walk overrides the live ones.
  // Notably: "Reduce depth & retrace" (the truncation notice's action)
  // maps to continuing the walk — the closure engine's equivalent.
  const tracedNodeId = canvasTrace.tracedUrn
    ? (urnToIdMap.get(canvasTrace.tracedUrn) ?? canvasTrace.tracedUrn)
    : null
  // A HISTORY OUTLIVES THE PAGE, so it cannot be labelled from what the page
  // has loaded (2026-08-22). After a reload the canvas holds its lane roots
  // and nothing else, and the launcher read URN tails —
  // `intermediate_t2_17d10688` — that turned into names later, if and when
  // the reader happened to expand the container each entity lives in. What
  // the canvas cannot name, the data source answers: one batched lookup for
  // the unnamed urns, each asked at most once.
  const unnamedHistoryUrns = useMemo(() => (
    traceHistory.entries
      .filter(e => !(displayMap.get(urnToIdMap.get(e.urn) ?? e.focusId)?.name || displayMap.get(e.focusId)?.name))
      .map(e => e.urn)
  ), [traceHistory, displayMap, urnToIdMap])
  const historyNames = useResolvedNames(unnamedHistoryUrns, provider)
  /** One name per entry: the canvas first (it is already showing that name),
   *  the data source for everything else, and the urn tail only when neither
   *  has anything. Both the launcher and the dock's Recent list read it. */
  const historyLabels = useMemo(() => new Map<string, string>(
    traceHistory.entries.map(entry => [
      entry.urn,
      displayMap.get(urnToIdMap.get(entry.urn) ?? entry.focusId)?.name
        || displayMap.get(entry.focusId)?.name
        || historyNames.get(entry.urn)
        || entry.urn.split(/[:/]/).pop()
        || entry.urn,
    ]),
  ), [traceHistory, displayMap, urnToIdMap, historyNames])
  // Launcher entries for the header's "pick up where you left off"
  // panel: resolved labels, direction mode, STACK index (newest first).
  const headerTraceHistory = useMemo(() => (
    traceHistory.entries.map((e, i) => ({
      index: i,
      label: historyLabels.get(e.urn) ?? e.urn,
      mode: (e.view.showUpstream && e.view.showDownstream ? 'both' : e.view.showUpstream ? 'up' : 'down') as 'up' | 'down' | 'both',
      timestamp: e.timestamp,
    })).reverse()
  ), [traceHistory, historyLabels])
  // PICKING AN ENTRY IS NOT BACK/FORWARD. `traceHistoryGo` is the cursor
  // walk, where "the cursor is already there" rightly means there is nothing
  // to do — but a click on a row is a request to be looking at that trace,
  // and after a reload the cursor sits on the newest entry with no trace on
  // screen at all. That row did nothing when clicked; it is the likeliest
  // row in the list.
  const resumeTraceHistory = useCallback((index: number) => {
    const entry = traceHistory.entries[index]
    if (!entry) return
    flushExpansionRecord()
    setTraceHistory(h => traceHistoryJump(h, index))
    restoreTraceEntry(entry)
  }, [traceHistory, flushExpansionRecord, restoreTraceEntry])
  // A ROW OF THE LAUNCHER IS A FINDING TOO, so it can be handed over without
  // being opened first. Built on the click that asks for one — encoding all
  // fifty tokens on every render would be work nobody asked for. The depth
  // clamp is `restoreTraceEntry`'s own ONE DEPTH RULE: an entry written under
  // the old 100-hop control would otherwise encode a depth the decoder is
  // right to refuse, and the link would quietly do nothing.
  const traceHistoryLink = useCallback((index: number): string | null => {
    const entry = traceHistory.entries[index]
    if (!entry) return null
    const token = encodeTraceShare({
      urn: entry.urn,
      label: historyLabels.get(entry.urn),
      up: entry.view.showUpstream,
      down: entry.view.showDownstream,
      depthUp: Math.min(entry.view.depthUp, FULL_WALK_INITIAL_DEPTH),
      depthDown: Math.min(entry.view.depthDown, FULL_WALK_INITIAL_DEPTH),
      open: entry.view.traceExpansion,
    })
    const url = new URL(window.location.href)
    url.searchParams.set('trace', token)
    url.searchParams.delete('lens')
    return url.toString()
  }, [traceHistory, historyLabels])
  const clearTraceHistory = useCallback(() => setTraceHistory(emptyTraceHistory()), [])

  // Legacy-shaped history entries for the dock's Recent popover.
  const dockHistoryEntries = useMemo(() => [...traceHistory.entries].reverse().map(e => ({
    focusId: e.focusId,
    focusUrn: e.urn,
    // Same name the launcher shows, resolved the same way — the dock's
    // Recent list printed the whole urn when the canvas could not name it.
    label: historyLabels.get(e.urn) ?? e.urn,
    timestamp: e.timestamp,
    config: { ...trace.config, upstreamDepth: e.view.depthUp, downstreamDepth: e.view.depthDown },
  })), [traceHistory, trace.config, historyLabels])
  // THE TRACED ENTITY'S NAME, resolved once for everything that says it.
  // The canvas can only name what it has loaded, and a trace opened from a
  // shared link is routinely on something the recipient has never expanded —
  // so the walk model answers next, then the link's own label (all anyone
  // has during the seconds the walk is out), then the urn tail.
  const tracedLabel = useMemo(() => {
    const urn = canvasTrace.tracedUrn
    if (!urn) return null
    return displayMap.get(urnToIdMap.get(urn) ?? urn)?.name
      || (traceNodeIndex?.get(urn)?.data as { label?: string } | undefined)?.label
      || (initialTraceShare?.urn === urn ? initialTraceShare.label : undefined)
      || urn.split(/[:/]/).pop()
      || urn
  }, [canvasTrace.tracedUrn, displayMap, urnToIdMap, traceNodeIndex, initialTraceShare])

  // WHAT THE SHARE CONTROL OFFERS. Built from what is on screen right now:
  // the focus and its name, the sides being read, the hop limits, and the
  // cards that are open. `buildLink` is called on click, so the link is
  // always the trace as it stands rather than as it stood when the popover
  // opened. `lens` is dropped from the URL — one link, one thing to open.
  const traceShare = useMemo<TraceShareSummary | undefined>(() => {
    const urn = canvasTrace.tracedUrn
    if (!traceActive || !urn || !tracedLabel) return undefined
    const label = tracedLabel
    const open = [...(overlay.traceExpansion ?? [])] as string[]
    return {
      label,
      direction: traceShowUpstream && traceShowDownstream ? 'both' : traceShowUpstream ? 'up' : 'down',
      depthUp: traceDepthUp,
      depthDown: traceDepthDown,
      openCards: open.length,
      buildLink: (includePicture: boolean) => {
        const token = encodeTraceShare({
          urn,
          label,
          up: traceShowUpstream,
          down: traceShowDownstream,
          depthUp: traceDepthUp,
          depthDown: traceDepthDown,
          open: includePicture ? open : [],
        })
        const url = new URL(window.location.href)
        url.searchParams.set('trace', token)
        url.searchParams.delete('lens')
        return url.toString()
      },
    }
  }, [traceActive, canvasTrace.tracedUrn, tracedLabel, overlay.traceExpansion, traceShowUpstream, traceShowDownstream, traceDepthUp, traceDepthDown])

  const dockTrace = useMemo<UseUnifiedTraceResult>(() => {
    if (!traceActive || !traceModel || !tracedNodeId) return trace
    const result: TraceResult = {
      focusId: tracedNodeId,
      // What the WALK brought back — the dock's truncation notice asks
      // "how big is this trace", not "how much is on screen".
      traceNodes: new Set(traceModel.nodes.map(n => n.urn)),
      upstreamNodes: new Set(traceModel.upstreamUrns),
      downstreamNodes: new Set(traceModel.downstreamUrns),
      traceEdges: new Set(traceModel.lineageEdges.map(e => e.id ?? `${e.sourceUrn}>${e.targetUrn}`)),
      lineageResult: null,
      isInherited: false,
      // Partiality is DERIVED from the model (what is still owed), never a
      // budget park — there is no budget. The dock's truncation notice
      // therefore only speaks for a walk that genuinely lost something
      // (a failed step) or is parked at the memory checkpoint.
      truncated: traceModel.truncated
        || canvasTrace.progress?.phase === 'checkpoint'
        || canvasTrace.progress?.phase === 'error',
      truncationReason: canvasTrace.progress?.phase === 'checkpoint'
        ? 'checkpoint'
        : (canvasTrace.progress?.phase === 'error' ? (canvasTrace.progress.error ?? 'timeout') : (traceModel.truncationReason ?? undefined)),
    }
    return {
      ...trace,
      isTracing: true,
      focusId: tracedNodeId,
      result,
      error: canvasTrace.walkEntry?.status === 'error' ? canvasTrace.walkEntry.error : null,
      isLoading: canvasTrace.walkEntry?.status === 'loading'
        || canvasTrace.progress?.phase === 'seeding' || canvasTrace.progress?.phase === 'walking',
      upstreamCount: traceParticipants.upstream.length,
      downstreamCount: traceParticipants.downstream.length,
      showUpstream: traceShowUpstream,
      showDownstream: traceShowDownstream,
      setShowUpstream: (show) => { setTraceShowUpstream(show); recordTraceView({ showUpstream: show }) },
      setShowDownstream: (show) => { setTraceShowDownstream(show); recordTraceView({ showDownstream: show }) },
      // Depth is a VIEW limit on the walked flow: it re-projects instantly,
      // it is clamped to the walk's own ceiling (one depth rule), and it
      // NEVER reaches the legacy hook — `trace.setConfig` would queue a
      // refetch of a flow this session already holds in full. Every other
      // field on TraceConfig parameterises that same request, which is why
      // the dock withdraws those controls in `nativeMode`; a stray one must
      // die here rather than quietly become a network call.
      config: { ...trace.config, upstreamDepth: traceDepthUp, downstreamDepth: traceDepthDown },
      setConfig: (cfg) => {
        const depthUp = cfg.upstreamDepth === undefined
          ? undefined : Math.min(cfg.upstreamDepth, FULL_WALK_INITIAL_DEPTH)
        const depthDown = cfg.downstreamDepth === undefined
          ? undefined : Math.min(cfg.downstreamDepth, FULL_WALK_INITIAL_DEPTH)
        if (depthUp === undefined && depthDown === undefined) return
        if (depthUp !== undefined) setTraceDepthUp(depthUp)
        if (depthDown !== undefined) setTraceDepthDown(depthDown)
        recordTraceView({ depthUp, depthDown })
      },
      // History — the dock's Recent popover + back/forward, fed from the
      // per-view stack (newest first for the list).
      traceHistory: dockHistoryEntries,
      jumpToHistoryEntry: async (entry) => {
        const idx = traceHistory.entries.findIndex(e => e.urn === entry.focusUrn && e.timestamp === entry.timestamp)
        if (idx >= 0) traceHistoryGo(traceHistoryJump(traceHistory, idx))
      },
      clearTraceHistory: () => setTraceHistory(emptyTraceHistory()),
      statistics: {
        ...trace.statistics,
        totalNodes: traceModel.nodes.length,
        totalEdges: traceModel.lineageEdges.length,
        upstreamCount: traceParticipants.upstream.length,
        downstreamCount: traceParticipants.downstream.length,
      },
      // RETRACE IS NOT A VIEW ACTION. Direction and depth are scope on a flow
      // already in hand, so the "apply" the dock fires after one of them has
      // nothing to do and must stay a no-op — re-walking on every arrow is
      // exactly the refetch storm the native engine exists to end. What
      // retrace still MEANS is "this walk did not finish": re-kick a failed
      // initial fetch, or grant the budget / clear the failures for a walk
      // that stopped short of exhaustion.
      retrace: async () => {
        if (canvasTrace.walkEntry?.status === 'error') { canvasTrace.retryWalk(); return }
        const phase = canvasTrace.progress?.phase
        if (phase === 'checkpoint') canvasTrace.continuePastCheckpoint()
        else if (phase === 'error') canvasTrace.retryWalk()
      },
    }
  }, [traceActive, traceModel, tracedNodeId, trace, canvasTrace, traceParticipants, traceShowUpstream, traceShowDownstream, traceDepthUp, traceDepthDown, dockHistoryEntries, traceHistory, traceHistoryGo, recordTraceView])

  // Auto-collapse the dock when trace exits so a stale open state doesn't
  // immediately reappear next time the user starts a trace.
  useEffect(() => {
    if (!traceActive && dockExpanded) setDockExpanded(false)
  }, [traceActive, dockExpanded])
  // Trace-mode keys: ESC leaves the trace, Cmd/Ctrl+I toggles the dock.
  useEffect(() => {
    if (!traceActive) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === 'Escape') {
        // Escape is layered. A popover open over the dock (the depth
        // settings, an edge-type menu) owns the first press — it is what the
        // reader is looking at, and taking the whole trace down instead is a
        // destructive answer to "close this". Let it consume that press; the
        // next one, with nothing open, leaves the trace.
        //
        // Deliberately NOT keyed on `e.defaultPrevented`: useCanvasKeyboard
        // preventDefaults EVERY Escape for its clear-selection handler, so
        // that flag is always true here and would retire the exit entirely.
        // The open dialog is the real signal, and it is precise — the
        // popovers unmount on close, leaving nothing behind to match.
        if (document.querySelector('[role="dialog"]')) return
        e.preventDefault()
        exitCanvasTrace()
        return
      }
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod || e.shiftKey) return
      if (e.key.toLowerCase() === 'i') {
        e.preventDefault()
        setDockExpanded(v => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [traceActive, exitCanvasTrace])

  // Trace filter — retained for the LEGACY (useUnifiedTrace) drilldown
  // path only. The native trace no longer filters the browse hierarchy: the
  // overlay's lanes ARE the picture, already scoped, so `isTracing: false`
  // keeps this a pass-through and `contextSet` stays empty.
  const {
    contextSet: traceContextSet,
  } = useTraceFilteredHierarchy({
    nodesByLayer, displayFlat, displayMap,
    isTracing: false,
    traceNodes: EMPTY_TRACE_NODES,
    drilldowns: EMPTY_DRILLDOWNS,
    parentMap,
    childMap,
    expandedNodes,
  })

  // TRACE MODE swaps the whole render source for the overlay's lanes;
  // browse renders exactly as before.
  const renderByLayer = traceRender?.byLayer ?? nodesByLayer
  const renderFlat = traceRender?.flat ?? displayFlat
  const renderMap = traceRender?.map ?? displayMap


  // Suppress parent AGGREGATED edges whose drill currently has at least one
  // finer-level edge visible. Without this the canvas renders the same
  // lineage twice — once at the parent level (e.g. Dataset↔Dataset AGG) and
  // once at the child level (Column↔Column). Keying on the URN pair lets
  // useEdgeProjection skip both Section A (`aggregatedEdges`-derived) and
  // Section B (canvas-store) AGG edges in one pass. Restoration is
  // automatic: when either endpoint collapses, no drilled edge has both
  // endpoints in renderMap, the key drops out of the set, and the AGG edge
  // re-appears next render.
  const suppressedAggEdgeKeys = useMemo(() => {
    const keys = new Set<string>()
    if (!trace.isTracing) return keys
    trace.drilldowns.forEach((result, key) => {
      const at = key.indexOf('@')
      const pair = at >= 0 ? key.slice(0, at) : key
      const arrow = pair.indexOf('->')
      if (arrow < 0) return
      const s = pair.slice(0, arrow)
      const t = pair.slice(arrow + 2)
      const anyVisible = result.edges.some(
        e => renderMap.has(e.sourceUrn) && renderMap.has(e.targetUrn),
      )
      if (anyVisible) keys.add(`${s}->${t}`)
    })
    return keys
  }, [trace.isTracing, trace.drilldowns, renderMap])


  // Search results
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return []
    const query = searchQuery.toLowerCase()
    return displayFlat.filter((node) =>
      node.name.toLowerCase().includes(query) ||
      node.typeId.toLowerCase().includes(query)
    )
  }, [searchQuery, displayFlat])

  // Advanced-search match URN set (W1 substrate). Subscribed once so a
  // re-render fires only when the set object identity changes. The
  // canvas highlights these URNs via the existing `searchResults` prop
  // on LayerColumn — same visual treatment as the legacy quick-search
  // fallback, just sourced server-side. Union with the legacy quick-
  // search hits so both lit at once (legacy is W9 cleanup target).
  const advancedMatchUrns = useMatchUrnSet()
  const matchedNodeIds = useMemo(() => {
    const out = new Set<string>(searchResults.map((n) => n.id))
    if (advancedMatchUrns.size > 0) {
      for (const node of displayFlat) {
        const urn = (node as { urn?: string }).urn ?? node.id
        if (advancedMatchUrns.has(urn) || advancedMatchUrns.has(node.id)) {
          out.add(node.id)
        }
      }
    }
    // Kept as a Set: LayerColumn tests membership once per rendered row, and
    // an advanced search can match thousands of nodes — an array turns that
    // into an O(matches) scan per row on every render.
    return out
  }, [searchResults, advancedMatchUrns, displayFlat])

  // Action: Move entity to layer (updated for unified context menu)
  // Stages a `move_to_layer` change instead of immediately persisting via
  // updateView — the actual schema mutation happens during applyAll.
  // Right-click "move to layer": same canonical write path as handleAssignToLayer (persist the view's
  // referenceLayout.assignments; NO graph op). Kept as its own `move_to_layer` staged type for the
  // review panel, with identical persist/discard/reapply semantics.
  const moveToLayer = useCallback((nodeId: string, layerId: string) => {
    const entity = displayMap.get(nodeId)
    if (!entity) return
    if (entity.isLogical) {
      console.warn('Moving logical nodes not yet supported via context menu')
      return
    }

    const before = currentLayout()
    const conflict = assignmentOps.checkAssignmentConflict(parentMap, before.assignments, entity.urn, layerId)
    if (conflict?.type === 'containment_locked') {
      setAssignmentWarning(conflict.message)
      if (assignmentWarningTimer.current) clearTimeout(assignmentWarningTimer.current)
      assignmentWarningTimer.current = setTimeout(() => setAssignmentWarning(null), 5000)
      interactions.closeContextMenu()
      return
    }

    const targetLayer = before.layers.find(l => l.id === layerId)
    const prevLayerId = before.assignments[entity.urn]?.layerId
    const clearDescendants = explicitDescendants(entity.urn, parentMap, before.assignments)
    const after = assignmentOps.assignEntities(before, [entity.urn], layerId, { clearDescendants })
    persistReferenceLayout(after)
    // Clear any stale store instanceAssignment so the canonical move renders immediately (see handleAssignToLayer).
    useReferenceModelStore.getState().removeEntityAssignment(entity.urn)

    useStagedChangesStore.getState().stageOrReplace(
      (c) => (c.type === 'move_to_layer' || c.type === 'assign_layer') && c.targetId === nodeId,
      {
        type: 'move_to_layer',
        targetId: nodeId,
        targetUrn: entity.urn,
        before: { layerId: prevLayerId, layerName: before.layers.find(l => l.id === prevLayerId)?.name },
        after: { layerId, layerName: targetLayer?.name },
        summary: `Move '${entity.name}' → ${targetLayer?.name ?? layerId}`,
        discard: () => persistReferenceLayout(before),
        reapply: () => persistReferenceLayout(after),
      },
    )

    interactions.closeContextMenu()
  }, [displayMap, parentMap, currentLayout, persistReferenceLayout, interactions])

  // Stage a view-layout change so it (a) shows in Review & Save under "View layout", (b) is undoable via
  // the shared Undo/Redo (undo runs `discard` → persistReferenceLayout(before)), while staying DECOUPLED
  // from the data source — `layer_config` has no apply hook, so it never becomes a graph op
  // (stagedChangesToOps ignores it). persistReferenceLayout already ran, so the column is live; discard
  // reverts the whole layout (layers + assignments, e.g. deleteLayer's remap).
  const stageLayerChange = useCallback((
    targetId: string,
    before: NormalizedReferenceLayout,
    after: NormalizedReferenceLayout,
    action: 'add' | 'rename' | 'delete' | 'reorder' | 'sort',
    summary: string,
  ) => {
    useStagedChangesStore.getState().stage({
      type: 'layer_config',
      targetId,
      before: { layers: before.layers },
      after: { layers: after.layers, action },
      summary,
      discard: () => persistReferenceLayout(before),
      reapply: () => persistReferenceLayout(after),
    })
  }, [persistReferenceLayout])

  const addLayer = useCallback((name: string) => {
    const before = currentLayout()
    const palette = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#84cc16']
    const id = `layer-${Date.now()}`
    const layers = layerOps.appendLayer(before.layers, {
      id,
      name,
      description: '',
      icon: 'Layers',
      color: palette[before.layers.length % palette.length],
      entityTypes: [],
      order: before.layers.length,
    })
    const after = { ...before, layers }
    persistReferenceLayout(after)
    stageLayerChange(`layer:${id}`, before, after, 'add', `Added layer “${name}”`)
  }, [currentLayout, persistReferenceLayout, stageLayerChange])

  // Authored column width — part of the view definition (ships to every
  // viewer of the published view). Not staged as a reviewable change:
  // width is presentation, not model semantics; it rides the normal
  // layout save. Fires once per drag (pointerup), never per move.
  const resizeLayer = useCallback((id: string, width: number | null) => {
    const before = currentLayout()
    persistReferenceLayout({
      layers: layerOps.setLayerWidth(before.layers, id, width ?? undefined),
      assignments: before.assignments,
    })
  }, [currentLayout, persistReferenceLayout])

  const renameLayer = useCallback((id: string, name: string) => {
    const trimmed = name.trim()
    const before = currentLayout()
    const old = before.layers.find((l) => l.id === id)
    if (!trimmed || !old || old.name === trimmed) return
    const after = { ...before, layers: layerOps.renameLayer(before.layers, id, trimmed) }
    persistReferenceLayout(after)
    stageLayerChange(`layer:${id}`, before, after, 'rename', `Renamed layer “${old.name}” → “${trimmed}”`)
  }, [currentLayout, persistReferenceLayout, stageLayerChange])

  const deleteLayer = useCallback((id: string) => {
    const before = currentLayout()
    const target = before.layers.find((l) => l.id === id)
    if (!target) return
    const layers = layerOps.removeLayer(before.layers, id)
    const fallbackId = layers[0]?.id
    // Remap the deleted layer's assignments to the first remaining layer so their entities don't vanish
    // in curated scope (mirrors the old validLayerIds fallback). No layers remain ⇒ drop them.
    const assignments: NormalizedReferenceLayout['assignments'] = {}
    for (const [urn, entry] of Object.entries(before.assignments)) {
      if (entry.layerId !== id) assignments[urn] = entry
      else if (fallbackId) assignments[urn] = { ...entry, layerId: fallbackId }
    }
    const after = { ...before, layers, assignments }
    persistReferenceLayout(after)
    stageLayerChange(`layer:${id}`, before, after, 'delete', `Deleted layer “${target.name}”`)
  }, [currentLayout, persistReferenceLayout, stageLayerChange])

  // Reorder a layer column (drag). Assignments key off layer id, so nodes and their edges move with the
  // column for free.
  const reorderLayer = useCallback((draggedId: string, targetId: string) => {
    const before = currentLayout()
    const dragged = before.layers.find((l) => l.id === draggedId)
    const layers = layerOps.reorderLayer(before.layers, draggedId, targetId)
    if (!dragged || layers === before.layers) return
    const after = { ...before, layers }
    persistReferenceLayout(after)
    stageLayerChange(`layer:${draggedId}`, before, after, 'reorder', `Reordered layer “${dragged.name}”`)
  }, [currentLayout, persistReferenceLayout, stageLayerChange])

  const sortModeLabel = (mode: LayerNodeSortMode) => SORT_MODE_LABELS[mode] ?? mode

  // Set a layer's node sort mode. Draft → persisted on the layer config (staged, undoable).
  // Read-only → device-local override (algorithmic modes only; the menu disables Custom there).
  const handleSetLayerSortMode = useCallback((layerId: string, mode: LayerNodeSortMode | null) => {
    const viewId = useSchemaStore.getState().getActiveView()?.id ?? ''
    if (!isDraft) {
      if (mode === 'custom' || !viewId) return
      usePreferencesStore.getState().setViewSortOverride(viewId, layerId, mode)
      return
    }
    // Draft: drop any device-local override so the persisted mode is what renders.
    if (viewId) usePreferencesStore.getState().setViewSortOverride(viewId, layerId, null)
    const before = currentLayout()
    const layer = before.layers.find(l => l.id === layerId)
    if (!layer) return
    // Custom seeds orderKeys from the column's CURRENT visual order (full, un-traced roots).
    const seedOrder = mode === 'custom'
      ? (nodesByLayerRef.current.get(layerId) ?? []).map(n => n.id)
      : undefined
    const after = layerOps.setLayerNodeSortMode(before, layerId, mode, seedOrder)
    if (after === before) return
    persistReferenceLayout(after)
    // First-use guidance: entering custom mode changes an invisible property
    // (rows become drag-reorderable) — say so, once per user.
    if (mode === 'custom') {
      const prefs = usePreferencesStore.getState()
      if (!prefs.onboardingCompletedSteps.includes('custom-order-toast')) {
        prefs.completeOnboardingStep('custom-order-toast')
        useToastStore.getState().addToast({
          type: 'info',
          message: `Custom order — drag cards to arrange “${layer.name}”`,
        })
      }
    }
    const label = mode === null
      ? `View default (${sortModeLabel(before.defaultNodeSortMode ?? 'alpha-asc')})`
      : mode === 'custom' ? 'Custom order' : sortModeLabel(mode)
    stageLayerChange(`layer-sort:${layerId}`, before, after, 'sort', `Sort “${layer.name}”: ${label}`)
  }, [isDraft, currentLayout, persistReferenceLayout, stageLayerChange])

  // "Apply to all layers": promote this column's asc/desc mode to the view default and
  // clear other columns' asc/desc overrides (custom layers keep their arrangement).
  const handleApplySortToView = useCallback((layerId: string) => {
    const before = currentLayout()
    const layer = before.layers.find(l => l.id === layerId)
    if (!layer) return
    const effective = layer.nodeSortMode ?? before.defaultNodeSortMode ?? 'alpha-asc'
    if (effective === 'custom') return
    const after = layerOps.setViewDefaultSortMode(before, effective)
    const viewId = useSchemaStore.getState().getActiveView()?.id
    if (viewId) usePreferencesStore.getState().clearViewSortOverrides(viewId)
    persistReferenceLayout(after)
    stageLayerChange('view-sort', before, after, 'sort', `Default sort: ${sortModeLabel(effective)} (all layers)`)
  }, [currentLayout, persistReferenceLayout, stageLayerChange])

  // "Reset custom order": discard the layer's manual arrangement — every
  // orderKey plus the mode override — falling back to the view default.
  // Staged + undoable like every other layout gesture.
  const handleResetCustomOrder = useCallback((layerId: string) => {
    if (!isDraft) return
    const before = currentLayout()
    const layer = before.layers.find(l => l.id === layerId)
    if (!layer) return
    const after = layerOps.clearLayerOrderKeys(before, layerId)
    if (after === before) return
    persistReferenceLayout(after)
    stageLayerChange(`layer-sort:${layerId}`, before, after, 'sort', `Reset custom order in “${layer.name}”`)
  }, [isDraft, currentLayout, persistReferenceLayout, stageLayerChange])

  // Drag-reorder — the top/bottom drop bands. Works in ANY draft column: a
  // manual reorder AUTO-ADOPTS custom order (the layer flips to 'custom' and
  // seeds its current visual order), so the user never has to pick a sort mode
  // first. Custom order is HIERARCHICAL: the target's sibling set is its
  // parent's children (a child drop) or the layer's roots (a root drop); the
  // set is seeded so every neighbor has an orderKey, then a fractional key is
  // minted between the drop-position neighbors — key order always matches the
  // current visual order. A cross-set drop is a safe no-op; the MIDDLE band
  // still reparents (nest into a node).
  const handleReorderNode = useCallback((draggedId: string, targetId: string, position: 'before' | 'after') => {
    if (traceWriteLocked()) return                  // read-only while tracing
    if (draggedId === targetId) return
    const before = currentLayout()
    const ctx = siblingContext(targetId, reorderTreeRef.current)
    if (!ctx) return
    const { siblings, layerId } = ctx
    const layer = before.layers.find(l => l.id === layerId)
    if (!layer) return
    if (!siblings.includes(draggedId)) return // cross-set drop — not a reorder

    // Multi-select: dragging a node that is part of the current selection moves
    // EVERY selected sibling as one contiguous block, preserving its visual
    // order. A lone drag is a block of one.
    const selectedIds = useCanvasStore.getState().selectedNodeIds
    const block = selectedIds.includes(draggedId) && selectedIds.length > 1
      ? siblings.filter(id => id === draggedId || selectedIds.includes(id))
      : [draggedId]
    if (block.includes(targetId)) return // dropping into (or onto) the block itself

    // Auto-adopt custom order on the first manual reorder of a non-custom
    // layer (seed the roots from their current visual order so nothing jumps),
    // then seed the target sibling set so every neighbor carries an orderKey.
    let layout = before
    if (layer.nodeSortMode !== 'custom') {
      const rootIds = (nodesByLayerRef.current.get(layerId) ?? [])
        .filter(n => !n.isLogical).map(n => n.id)
      layout = layerOps.setLayerNodeSortMode(layout, layerId, 'custom', rootIds)
    }
    layout = assignmentOps.ensureSiblingOrderKeys(layout, layerId, siblings)

    const blockSet = new Set(block)
    const order = siblings.filter(id => !blockSet.has(id))
    const targetIdx = order.indexOf(targetId)
    if (targetIdx < 0) return
    const insertIdx = position === 'before' ? targetIdx : targetIdx + 1
    // keysForInsertion walks outward past any still-unkeyed neighbors and
    // returns null on malformed keys (refuse rather than corrupt the order).
    const newKeys = assignmentOps.keysForInsertion(layout, layerId, order, insertIdx, block.length)
    if (newKeys === null) return
    let after = layout
    block.forEach((memberId, i) => {
      after = assignmentOps.setAssignmentOrderKey(after, memberId, newKeys[i])
    })
    if (after === before) return
    persistReferenceLayout(after)

    const newKey = newKeys[0]
    const node = nodesRef.current.find(n => n.id === draggedId || (n.data?.urn as string) === draggedId)
    const name = block.length > 1
      ? `${block.length} nodes`
      : ((node?.data?.label as string) ?? draggedId)
    // Undo baseline: a REPEAT drag of the same node must still restore the
    // truly-original arrangement (incl. un-doing the first drag's lazy
    // seeding), so reuse the pre-change layout captured by the FIRST staged
    // reorder of this node rather than this drag's already-seeded `before`.
    const existing = useStagedChangesStore.getState().changes.find(
      (c) => c.type === 'reorder_nodes' && c.targetId === draggedId,
    )
    const baseline = ((existing?.before as { layout?: NormalizedReferenceLayout } | undefined)?.layout) ?? before
    useStagedChangesStore.getState().stageOrReplace(
      (c) => c.type === 'reorder_nodes' && c.targetId === draggedId,
      {
        type: 'reorder_nodes',
        targetId: draggedId,
        targetUrn: (node?.data?.urn as string) ?? draggedId,
        before: { orderKey: baseline.assignments[draggedId]?.orderKey ?? null, layout: baseline },
        after: { orderKey: newKey, layerId },
        summary: `Reordered '${name}' in ${layer.name}`,
        discard: () => persistReferenceLayout(baseline),
        reapply: () => persistReferenceLayout(after),
      },
    )
  }, [currentLayout, persistReferenceLayout, traceWriteLocked])

  // Keyboard-and-mouse reorder nudge — the a11y sibling of the drag bands
  // (native HTML5 DnD is mouse-only). Resolves the node's sibling set (roots
  // OR children) and delegates to handleReorderNode. Stable identity.
  const nudgeReorder = useCallback((nodeId: string, dir: 'up' | 'down' | 'top' | 'bottom') => {
    if (traceWriteLocked()) return                  // read-only while tracing
    const ctx = siblingContext(nodeId, reorderTreeRef.current)
    if (!ctx) return
    const { siblings } = ctx
    const idx = siblings.indexOf(nodeId)
    if (idx < 0) return
    if (dir === 'up' && idx > 0) handleReorderNode(nodeId, siblings[idx - 1], 'before')
    else if (dir === 'down' && idx < siblings.length - 1) handleReorderNode(nodeId, siblings[idx + 1], 'after')
    else if (dir === 'top' && idx > 0) handleReorderNode(nodeId, siblings[0], 'before')
    else if (dir === 'bottom' && idx < siblings.length - 1) handleReorderNode(nodeId, siblings[siblings.length - 1], 'after')
  }, [handleReorderNode, traceWriteLocked])

  // Context-menu "Move up / down / to top / to bottom" for any node of a draft
  // layer (roots and children alike — the nudge resolves the right sibling set
  // and auto-adopts custom order, matching the drag bands). Needs >1 sibling to
  // be meaningful.
  const reorderMenuActions = useMemo<ContextMenuAction[]>(() => {
    const target = interactions.state.contextMenu.target
    if (!nodeSortingEnabled || !isDraft || traceActive || !target || target.type !== 'node') return []
    const ctx = siblingContext(target.id, { displayMap, parentMap, nodesByLayer, nodeLayerMap })
    if (!ctx || ctx.siblings.length < 2) return []
    const idx = ctx.siblings.indexOf(target.id)
    if (idx < 0) return []
    const last = ctx.siblings.length - 1
    const nid = target.id
    const act = (id: string, label: string, icon: string, dir: 'up' | 'down' | 'top' | 'bottom', disabled: boolean, shortcut?: string): ContextMenuAction => ({
      id, label, icon: icon as ContextMenuAction['icon'], shortcut, disabled,
      onClick: () => { nudgeReorder(nid, dir); interactions.closeContextMenu() },
    })
    return [
      act('reorder-top', 'Move to top', 'ArrowUpToLine', 'top', idx === 0),
      act('reorder-up', 'Move up', 'ArrowUp', 'up', idx === 0, '⌥↑'),
      act('reorder-down', 'Move down', 'ArrowDown', 'down', idx === last, '⌥↓'),
      act('reorder-bottom', 'Move to bottom', 'ArrowDownToLine', 'bottom', idx === last),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactions.state.contextMenu.target, nodeSortingEnabled, isDraft, traceActive, displayMap, parentMap, nodeLayerMap, nodesByLayer, nudgeReorder])

  // Handler for adding child entities
  const handleAddChildEntity = useCallback((parentId: string) => {
    // The builder store's open() runs the ensureDraftOpen guard itself.
    useHierarchyBuilderStore.getState().open({ parentUrn: parentId })
  }, [])

  // Stable per-layer create/build/context-menu handlers — LayerColumn is
  // React.memo'd, so these must keep ONE identity (an inline arrow at the
  // render site re-renders every column on every canvas render).
  const openBuilderForLayer = useCallback((layerId: string) => {
    useHierarchyBuilderStore.getState().open({ layerId })
  }, [])
  const openBuildForLayer = useCallback((layerId: string) => {
    useHierarchyBuilderStore.getState().openBuild({ layerId })
  }, [])
  const handleLayerContextMenuOpen = useCallback((e: React.MouseEvent, layerId: string) => {
    // Rename / delete / reorder a layer all rewrite the reference layout.
    if (traceWriteLockedRef.current()) return
    interactions.openContextMenu(e, {
      type: 'canvas',
      position: { x: e.clientX, y: e.clientY },
      layerId,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactions.openContextMenu])

  // Toggle node expansion with Lazy Loading
  const { loadChildren, searchChildren, cancelChildLoad, isLoading: isLoadingChildren, loadingNodes, failedNodes, retryHydration, loadMoreRoots, rootsLoaded, rootsHaveMore } = useGraphHydration()

  // Direction-aware child loading: a parent's children load server-sorted per
  // its layer's effective asc/desc (custom layers order ROOTS by orderKey;
  // their children still load asc). Resolved via refs so this wrapper keeps
  // one identity for LayerColumn's memo.
  const layerSortDirectionFor = useCallback((nodeId: string): 'asc' | 'desc' => {
    const ctx = sortDirectionCtxRef.current
    const layerId = ctx.nodeLayerMap.get(nodeId)
    if (!layerId) return 'asc'
    const layer = ctx.layers.find(l => l.id === layerId)
    const mode = ctx.overrides.get(layerId) ?? layer?.nodeSortMode ?? ctx.dflt
    return mode === 'alpha-desc' ? 'desc' : 'asc'
  }, [])
  const loadChildrenSorted = useCallback(
    (parentId: string) => loadChildren(parentId, { sortDirection: layerSortDirectionFor(parentId) }),
    [loadChildren, layerSortDirectionFor],
  )

  // "Load N more" from a column. In trace mode the walk model IS the set of
  // children that carry lineage, so there is nothing more to fetch — and a
  // fetch would write the store the overlay deliberately leaves alone.
  const loadMoreChildren = useCallback(async (parentId: string) => {
    if (traceWriteLocked()) return
    await loadChildrenSorted(parentId)
  }, [loadChildrenSorted, traceWriteLocked])

  // Same for another page of ROOTS — reachable from the status chip and from
  // scrolling a column to its end, neither of which means "grow the browse
  // canvas" while the columns are showing a trace.
  const loadMoreRootsGuarded = useCallback(() => {
    if (traceWriteLocked()) return
    void loadMoreRoots()
  }, [loadMoreRoots, traceWriteLocked])

  // Child search REPLACES a parent's loaded children in the store — it
  // `removeNodes`/`removeEdges` them and `addGraph`s the hits — and records
  // nothing about what it dropped. A trace that let it run could therefore
  // never be exited back to the canvas the reader started from. The
  // magnifier is hidden while tracing (FlatTreeItem); this is the backstop.
  const searchChildrenGuarded = useCallback((parentId: string, query: string) => {
    if (traceWriteLocked()) return
    void searchChildren(parentId, query)
  }, [searchChildren, traceWriteLocked])

  // Arming a connection is the first step of staging an edge: the next click
  // resolves a target, the picker opens, and confirming writes a create_edge
  // into the store. One choke point for both entry points (the 'C' key and
  // the drawer's "Link to…"), so neither can start the flow while locked.
  const armConnectGuarded = useCallback((nodeId: string) => {
    if (traceWriteLocked()) return
    edgeConnectRef.current?.armConnect(nodeId)
  }, [traceWriteLocked])

  // Fill the forward refs declared at the top of the component. In an effect,
  // not during render: the callbacks that read them (beginTrace, the edge
  // drill) only ever fire after commit.
  useEffect(() => {
    childLoadRef.current = { cancel: cancelChildLoad, loadingNodes }
    renderMapRef.current = renderMap
  })

  // Fetch aggregated edges when the set of COLLAPSED visible containers changes.
  // (Expanded nodes are excluded: their children are already visible and stand in
  // for them, so including both ends would double-count the same TRANSFORMS edges
  // at two hierarchy levels.)
  //
  // Two gates keep this off the hot path. `/edges/aggregated` is the most
  // expensive endpoint we have — it is the tightest fair-share bucket on the
  // backend (5 rps) — and the aggregation target set changes with EVERY page of
  // children that lands. Without the quiescence gate, draining a large container
  // one page at a time produced one aggregated fan-out per page.
  //
  //   1. Skip entirely while any child load is in flight. The tree is mid-flight;
  //      whatever we computed now would be superseded the moment the page lands.
  //      `loadingNodes` is in the dep array, so settling re-runs the effect.
  //   2. Debounce, so expanding a spine (several parents loading back-to-back)
  //      collapses into a single fetch once the dust settles.
  //
  // GATED ON !trace.isTracing: skeleton-first /trace v2 returns AGGREGATED
  // edges at the trace's effective level, so the parallel /aggregated-lineage
  // fetch is redundant + racy when a trace is active. In browse mode the
  // hook fires as before.
  useEffect(() => {
    if (!showLineageFlow || nodes.length === 0) return
    if (traceActive) return
    // Wait for the tree to settle. Re-runs when loadingNodes empties.
    if (loadingNodes.size > 0) return

    const fetchDebounced = setTimeout(() => {
      const currentVisibleList = getVisibleContainerUrns()

      const urnToIdMap = new Map(nodesRef.current.map(n => [(n.data?.urn as string) || n.id, n.id]))
      const aggregationTargets = currentVisibleList.filter(urn => {
        const nodeId = urnToIdMap.get(urn)
        return nodeId && !expandedNodes.has(nodeId)
      })

      // Only fetch if the target set actually changed
      const aggregationKey = `${aggregatedCacheVersion}:` + aggregationTargets.sort().join(',')
      if (aggregationKey === prevAggregationKeyRef.current) return
      prevAggregationKeyRef.current = aggregationKey

      if (aggregationTargets.length > 0) {
        fetchAggregated(aggregationTargets, aggregationTargets)
      }
    }, 300)

    return () => clearTimeout(fetchDebounced)
  }, [showLineageFlow, getVisibleContainerUrns, fetchAggregated, nodes.length, expandedNodes, traceActive, aggregatedCacheVersion, loadingNodes])

  // Source-changed self-refresh: while the aggregated overlay is flagged
  // `source_changed`, poll readiness and invalidate the aggregated cache once
  // the rebuild completes so the "recomputing" banner self-clears. See
  // hooks/useSourceChangedRefresh.
  useSourceChangedRefresh(dataSourceId, aggregationStaleReason)

  // A node can become expanded WITHOUT going through the toggle handler that
  // loads its first page — the per-view expanded-state restore above replays a
  // saved expansion set onto a freshly-hydrated canvas that only has roots. Such
  // a node would otherwise render as an expanded container with nothing under it
  // but a "Load more" row, which reads as a bug.
  //
  // So: any expanded node with a childCount but zero loaded children gets its
  // FIRST page automatically. Pages 2+ stay explicit (that's the Load-more row).
  //
  // This cannot become a pump. `autoLoadedFirstPageRef` records every node we
  // have already auto-loaded and we never revisit one, so even a node whose
  // fetch returns nothing (childCount disagreeing with reality) is attempted
  // exactly once. Without that ref the "zero children loaded" condition would
  // stay true forever and re-fire on every render — the same shape as the
  // sentinel bug this change removes.
  const autoLoadedFirstPageRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (traceActive) return
    if (expandedNodes.size === 0) return

    for (const nodeId of expandedNodes) {
      if (autoLoadedFirstPageRef.current.has(nodeId)) continue
      if (loadingNodes.has(nodeId)) continue
      if (failedNodes.has(nodeId)) continue

      const node = displayMap.get(nodeId)
      if (!node) continue
      const childCount = (node.data?.childCount as number) ?? 0
      if (childCount === 0) continue
      // Already has children on the canvas — this is a page-2+ situation, which
      // is the Load-more row's job, not ours.
      if ((childMap.get(nodeId)?.length ?? 0) > 0) continue

      autoLoadedFirstPageRef.current.add(nodeId)
      void loadChildrenSorted(nodeId)
    }
  }, [expandedNodes, displayMap, childMap, loadingNodes, failedNodes, loadChildrenSorted, traceActive])

  // Direction-flip refetch policy: when a layer's effective asc/desc flips,
  // pages already loaded for PARTIALLY-loaded parents in that layer were
  // fetched under the old direction — re-sorting them client-side would show
  // the wrong window (the alphabetical head relabeled as the tail). Drop those
  // loaded subtrees (sparing unsaved optimistic creates) so the auto-load
  // effect above refetches page 1 under the new direction; FULLY-loaded
  // parents keep their rows and simply re-sort in useLayerAssignment.
  const prevLayerDirectionsRef = useRef<Map<string, 'asc' | 'desc'>>(new Map())
  useEffect(() => {
    const dirByLayer = new Map<string, 'asc' | 'desc'>()
    sortedLayers.forEach(l => {
      const mode = sortOverrides.get(l.id) ?? l.nodeSortMode ?? viewDefaultSortMode
      dirByLayer.set(l.id, mode === 'alpha-desc' ? 'desc' : 'asc')
    })
    // A trace never writes the canvas. Leave `prevLayerDirectionsRef` alone
    // so the flip stays PENDING and is applied on the first browse render
    // after exit (traceActive is in the dep list below).
    if (traceActive) return
    const prev = prevLayerDirectionsRef.current
    prevLayerDirectionsRef.current = dirByLayer
    const flipped = new Set(
      [...dirByLayer].filter(([id, d]) => prev.has(id) && prev.get(id) !== d).map(([id]) => id),
    )
    if (flipped.size === 0) return

    const dropIds = new Set<string>()
    const refetchParents: string[] = []
    for (const [nodeId, layerId] of nodeLayerMap) {
      if (!flipped.has(layerId) || !expandedNodes.has(nodeId)) continue
      const kids = childMap.get(nodeId) ?? []
      if (kids.length === 0) continue
      const childCount = (displayMap.get(nodeId)?.data?.childCount as number) ?? 0
      if (childCount > 0 && kids.length >= childCount) continue // fully loaded — exact client re-sort
      refetchParents.push(nodeId)
      const stack = [...kids]
      while (stack.length > 0) {
        const id = stack.pop()!
        if ((displayMap.get(id)?.data as Record<string, unknown> | undefined)?.isPending === 'create') continue
        dropIds.add(id)
        for (const childId of childMap.get(id) ?? []) stack.push(childId)
      }
    }
    if (dropIds.size === 0) return
    useCanvasStore.getState().removeNodes([...dropIds])
    // Re-arm the auto-loader for the affected parents so their first page
    // refetches immediately under the new direction.
    for (const parentId of refetchParents) autoLoadedFirstPageRef.current.delete(parentId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedLayers, sortOverrides, viewDefaultSortMode, traceActive])

  // Registry of per-column imperative geometry APIs, keyed by layer id.
  // Identity-stable Map (state initializer, never re-set) — columns
  // register/unregister via effect; the edge overlay reads it
  // imperatively (pass-through detection, badge partner positions) so
  // no React state churn is involved.
  const [columnGeometryRegistry] = useState(() => new Map<string, ColumnGeometryApi>())

  // Reveal-into-view: the LayerColumn that owns the hit URN uses its
  // virtualizer's scrollToIndex (DOM scrollIntoView can't work — rows
  // below the overscan window aren't in the DOM at all). We signal via
  // a pulse-counter object so re-revealing the same URN still scrolls.
  const [revealTarget, setRevealTarget] = useState<{ id: string; pulse: number } | null>(null)
  const revealPulseRef = useRef(0)
  const scrollHitIntoView = useCallback((nodeId: string) => {
    revealPulseRef.current += 1
    setRevealTarget({ id: nodeId, pulse: revealPulseRef.current })
  }, [])

  // THE DRAWER MUST NOT HIDE ITS OWN SUBJECT (2026-08-22). It is a flex
  // sibling, not a floating panel: opening it takes 420-560 px off the
  // board's width and the columns do not move, so the card that was just
  // clicked — usually the rightmost thing on screen — ends up outside the
  // visible box ("the drawer overflows the node"). Once the drawer's spring
  // has settled, nudge the board by the LEAST that clears the row; the
  // container's `scroll-smooth` makes that a glide, and a row already in
  // view costs nothing. The reader's own scroll position is otherwise left
  // exactly where they put it.
  useEffect(() => {
    const container = horizontalScrollRef.current
    if (!drawerNodeId || !container) return
    let frame = 0
    let width = -1
    let still = 0
    let frames = 0
    const whenSettled = () => {
      const now = container.clientWidth
      still = now === width ? still + 1 : 0
      width = now
      frames += 1
      // Three identical frames means the width has stopped moving — which is
      // true immediately when the drawer merely swapped entities and never
      // resized. The frame cap keeps a window being dragged from holding
      // this open indefinitely.
      if (still < 3 && frames < 60) { frame = requestAnimationFrame(whenSettled); return }
      const row = document.getElementById(`layer-node-${drawerNodeId}`)
      if (!row) return                       // off-window: the reveal paths own that
      const shift = shiftToClear(row.getBoundingClientRect(), container.getBoundingClientRect())
      if (shift !== 0) container.scrollLeft += shift
    }
    frame = requestAnimationFrame(whenSettled)
    return () => cancelAnimationFrame(frame)
  }, [drawerNodeId])

  // F9 — REVEAL WHILE TRACING opens the OVERLAY's chain. The browse reveal
  // below walks `parentMap` and lazy-LOADS whichever ancestors the store is
  // missing; both are canvas writes a trace must not make. The overlay
  // already holds every card the trace can show, so the chain is a lookup
  // and opening it is a re-projection. Returns true when it handled the
  // reveal — including for a urn the trace does not hold at all, which is
  // "not on this lineage", not an invitation to go fetch it.
  const expandTraceChain = useCallback((nodeId: string): boolean => {
    const o = overlayRef.current
    if (!o?.active) return false
    const chain = o.revealPath(nodeId)
    if (chain.length > 0) o.expandPath(chain)
    recordTraceExpansionSoon()
    return true
  }, [recordTraceExpansionSoon])

  // Reveal-and-focus: clicking a neighbor in the drawer's Lineage section
  // expands collapsed ancestors (lazy-loading from the backend if needed),
  // then scrolls the now-visible target into view.
  // See [useRevealNode](../../../hooks/useRevealNode.ts).
  //
  // T24 F5 — `focus` used to scrollIntoView a plain
  // `document.getElementById` lookup, which returns null for any row the
  // virtualizer has not rendered (below the overscan window) — an
  // off-window "Reveal on canvas" click silently did nothing.
  // `scrollHitIntoView` is the same virtualizer-aware pulse
  // `revealSearchHit` already used, below.
  const revealAndFocus = useRevealNode({
    parentMap,
    setExpandedNodes,
    loadChildren: loadChildrenSorted,
    provider,
    focus: scrollHitIntoView,
  })
  const revealOnCanvas = useCallback(async (nodeId: string, revealOpts?: RevealOptions) => {
    if (traceWriteLocked()) {
      // Drawing: open the overlay's own chain. Still walking: there is
      // nothing to reveal yet, and the browse reveal would lazy-LOAD the
      // ancestors it is missing straight into the store.
      if (expandTraceChain(nodeId) && !revealOpts?.skipFocus) scrollHitIntoView(nodeId)
      return
    }
    await revealAndFocus(nodeId, revealOpts)
  }, [expandTraceChain, scrollHitIntoView, revealAndFocus, traceWriteLocked])

  // Multi-locate (T24 F5): reveal each target (expanding collapsed
  // ancestors), then walk each one through the SAME virtualizer-aware
  // pulse `scrollHitIntoView` uses for a single hit — the old approach
  // queried the DOM for the whole set up front, which only ever found
  // whatever ALREADY happened to be rendered, so a target below the
  // overscan window silently never arrived, with zero feedback that
  // anything had failed. Extracted to `useLocateManyOnCanvas` (own file,
  // own tests) for the same reason `useRevealNode`/`useRevealSearchHit`
  // are hooks rather than inline closures here: this component has no
  // test harness of its own to reach the logic through.
  const locateManyOnCanvas = useLocateManyOnCanvas({
    revealAndFocus: revealOnCanvas,
    scrollHitIntoView,
    getElementById: (id) => document.getElementById(`layer-node-${id}`),
    getScrollContainer: () => horizontalScrollRef.current,
    showToast: (type, message) => { useToastStore.getState().addToast({ type, message }) },
  })

  // Reveal callback for advanced-search hits and pin clicks. Walks the
  // ancestor chain, expanding each step so the deep hit becomes
  // reachable; falls back to deepest-reachable on partial load. Shared
  // by SearchMapPanel (hit rows + bucket actions) and SearchPinOverlay
  // (W3). Uses `useRevealSearchHit` (renamed from the original Advanced
  // Search `useRevealNode` during the resilience-hardening integration to
  // coexist with the entity-drawer reveal hook above).
  const revealSearchHitBrowse = useRevealSearchHit({
    setExpandedNodes,
    loadChildren: loadChildrenSorted,
    provider,
    scrollIntoView: scrollHitIntoView,
  })
  const revealSearchHit = useCallback(async (urn: string, ancestorPath: Parameters<typeof revealSearchHitBrowse>[1]) => {
    if (traceWriteLocked()) {
      if (expandTraceChain(urn)) scrollHitIntoView(urn)
      return
    }
    await revealSearchHitBrowse(urn, ancestorPath)
  }, [expandTraceChain, scrollHitIntoView, revealSearchHitBrowse, traceWriteLocked])

  // "Frame matches" — scroll the horizontal canvas container so the first
  // match-bearing node is centered. This is a viewport-not-zoom action since
  // the context view is a horizontal layered layout (no React Flow zoom).
  //
  // Framing NEVER expands. It used to: when no match was rendered it dumped
  // every match URN *and* every ancestor URN into `expandedNodes` in one go.
  // On a 600-match result that pre-marked the entire containment closure as
  // expanded, so each child that subsequently arrived was already flagged for
  // expansion and immediately requested its own children — a breadth-first
  // auto-expansion of the whole matched subtree, one page per round-trip.
  //
  // Matches under collapsed ancestors are surfaced by the count badges on those
  // ancestors instead. To actually walk to one, the user picks a match and uses
  // "Show on canvas" (`revealSearchHit`), which expands a single ancestor spine.
  const handleFrameMatches = useCallback(async (urns: string[]) => {
    if (urns.length === 0) return
    const container = horizontalScrollRef.current
    if (!container) return

    // Scroll to the first match — or, failing that, the first match-BEARING
    // ancestor, which is the row carrying the "N inside" badge. Either way we
    // only ever target something already on screen.
    for (const urn of urns) {
      // The DOM ids are keyed by canvas node id which may equal the URN
      // or be a derived id. Search both.
      const el =
        document.getElementById(`layer-node-${urn}`) ??
        document.querySelector<HTMLElement>(`[id^="layer-node-"][data-urn="${CSS.escape(urn)}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
        return
      }
    }
  }, [])

  // Hydration phase mirrored into the canvas store by CanvasRouter — drives
  // the ghost-card stack in empty layers and the GhostLineageOverlay.
  // Anything-not-complete counts as hydrating so that:
  //   1. On the first paint (before CanvasRouter's effect has mirrored the
  //      real 'roots'/'edges' phase) we still show ghosts, not "No entities
  //      yet". The default store value is 'idle' which is NOT 'complete' —
  //      so ghosts win the race.
  //   2. As nodes stream in per-layer, layers that already have nodes show
  //      real cards while still-empty layers keep their ghosts until phase
  //      flips to 'complete'. (Per-layer empty check is applied at the prop
  //      site below.) The previous `nodes.length === 0` global gate killed
  //      ghosts in empty layers the moment any one layer received a node.
  const hydrationPhase = useCanvasStore((s) => s.hydrationPhase)
  const hydrationStatus = useCanvasStore((s) => s.hydrationStatus)
  const hydrationFailed = hydrationStatus === 'warming' || hydrationStatus === 'unavailable'
  const regionCount = useCanvasStore((s) => s.loadingRegions.size)
  const isHydratingInitial = hydrationPhase !== 'complete'

  // Floating loading toasts — keep the full set so every long-running operation
  // is explicitly announced. Wording is centralised here.
  // Two phase-explicit toasts ('ctx-hydrating-entities' / 'ctx-hydrating-edges')
  // duplicate the global 'hydration' toast from CanvasRouter intentionally: the
  // global one has a single key that recycles between phases, so users with the
  // canvas focused want a sticky in-context indicator that the entities AND
  // edges loads both happened — even if hydration is fast.
  useLoadingToast('ctx-hydrating-entities', hydrationPhase === 'roots', 'Loading entities…', 'Entities loaded', hydrationFailed)
  useLoadingToast('ctx-hydrating-edges', hydrationPhase === 'edges', 'Loading edges between entities…', 'Edges loaded', hydrationFailed)
  useLoadingToast('ctx-assignments', assignmentStatus === 'loading', 'Computing layer assignments', 'Layer assignments ready')
  useLoadingToast('ctx-agg-edges', isLoadingAggregatedEdges, 'Loading aggregated edges', 'Aggregated edges loaded')
  useLoadingToast('ctx-children', isLoadingChildren, 'Loading child entities', 'Child entities loaded')
  useLoadingToast('ctx-regions', regionCount > 0, 'Loading region data', 'Region data loaded')

  // Warn the user once when any child fetch fails — gives them an explicit
  // signal beyond the inline error rows inside the affected parent's subtree.
  const { showToast } = useToast()
  const lastFailedCountRef = useRef(0)
  useEffect(() => {
    const count = failedNodes?.size ?? 0
    if (count > lastFailedCountRef.current) {
      showToast('warning', count === 1 ? '1 entity failed to load' : `${count} entities failed to load`)
    }
    lastFailedCountRef.current = count
  }, [failedNodes, showToast])

  // View/Edit mode transitions (header Edit / Done). Entering edit =
  // opening/resuming a draft; the versioning bar tints amber and the header
  // morphs — that IS the success feedback, so no toast on the happy path.
  // Entering Edit no longer silently resumes/creates a draft. The user explicitly continues an
  // existing draft OR names a new branch in StartEditingDialog (which then switchToDrafts). The
  // shared `ensureDraftOpen` stays the path for the OTHER authoring entry points (create-link,
  // hierarchy builder, blank-model auto-draft) so this deliberate choice is only for the Edit button.
  const handleEnterEdit = useCallback(() => setShowStartEditing(true), [])

  // Done: switching branches reloads the canvas, which would silently drop
  // staged edits — so route the user through the review panel instead.
  const handleExitEdit = useCallback(() => {
    if (stagedChangeList.length > 0) {
      openStagedChangesPanel()
      showToast('warning', 'Review your pending edits — save or discard them before leaving the draft.')
      return
    }
    useBranchStore.getState().switchToMain()
  }, [stagedChangeList.length, openStagedChangesPanel, showToast])

  // ── View-metadata actions (title menu) ──────────────────────────────
  // All read the live view from the store at call time so they carry no
  // stale-closure risk and keep their dep lists minimal.

  // Inline rename — optimistic: patch the store immediately (header updates
  // instantly), persist, and on failure revert to the previous name + toast.
  const handleRenameView = useCallback((name: string) => {
    const view = useSchemaStore.getState().getActiveView()
    if (!view?.id) return
    const viewId = view.id
    const previousName = view.name
    useSchemaStore.getState().updateView(viewId, { name })
    updateView(viewId, { name }).catch(err => {
      useSchemaStore.getState().updateView(viewId, { name: previousName })
      showToast('error', err instanceof Error ? err.message : 'Failed to rename view')
    })
  }, [showToast])

  const handleEditViewDetails = useCallback(() => setViewDetailsOpen(true), [])

  // The dialog persists to the backend itself; here we mirror the fields the
  // store knows (name/description) so the header reflects the edit at once.
  const handleViewDetailsSaved = useCallback(
    (updated: { name: string; description?: string; tags?: string[] }) => {
      const viewId = useSchemaStore.getState().getActiveView()?.id
      if (!viewId) return
      useSchemaStore.getState().updateView(viewId, {
        name: updated.name,
        description: updated.description,
      })
    },
    [],
  )

  // Share — the store config carries the tier now (viewToViewConfig), so the
  // dialog seeds synchronously; the fetch survives only as a fallback for
  // store entries that predate the field.
  const handleShareView = useCallback(async () => {
    const view = useSchemaStore.getState().getActiveView()
    if (!view?.id) return
    if (view.visibility) {
      setShareSeed({ id: view.id, name: view.name, visibility: view.visibility })
      setViewVisibility(view.visibility)
      return
    }
    try {
      const full = await getView(view.id)
      setShareSeed({ id: full.id, name: full.name, visibility: full.visibility })
      setViewVisibility(full.visibility)
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to open sharing')
    }
  }, [showToast])

  // Tracks nodes currently being fetched — prevents duplicate fetches on rapid clicks.
  // A ref (not state) because we need synchronous reads inside the toggle callback.
  const pendingLoadRef = useRef<Set<string>>(new Set())

  // Merge a drill-down result into the canvas store: adds new nodes/edges
  // (idempotent — addNodes/addEdges merge by ID), then auto-expands every
  // containment ancestor so the new finer-level nodes are revealed within
  // their hosts. Used by both manual edge double-click and auto-drill on
  // node expansion.
  const mergeDrilldownIntoCanvas = useCallback((expanded: TraceV2Result) => {
    // Same spine strategy as onTraceComplete — see the comment there for the
    // full rationale. Drilldowns rarely include alien ancestors (the server
    // returns lineage between two already-visible subtrees), but applying the
    // same filter keeps the two merge paths consistent and protects against
    // the Snowflake-style re-parenting if the server response widens.
    const participantUrns = new Set<string>()
    expanded.nodes.forEach(n => participantUrns.add(n.urn))
    expanded.upstreamUrns.forEach(u => participantUrns.add(u))
    expanded.downstreamUrns.forEach(u => participantUrns.add(u))

    const knownAssignedUrns = new Set<string>(displayMap.keys())
    const { spineUrns } = computeTraceMergeSpine({
      participantUrns,
      containmentEdges: expanded.containmentEdges ?? [],
      knownAssignedUrns,
    })

    // No assignmentHint stamp on unreachable roots — see the matching
    // comment block in `onTraceComplete`. Drilldown participants with no
    // legitimate view assignment (themselves or via an ancestor) drop out
    // of `nodesByLayer` rather than being parked in the anchor's column.
    const shouldMergeNode = (urn: string): boolean =>
      (participantUrns.has(urn) || spineUrns.has(urn)) && !knownAssignedUrns.has(urn)
    const isResolvableEndpoint = (urn: string): boolean =>
      shouldMergeNode(urn) || knownAssignedUrns.has(urn)

    const newCanvasNodes = expanded.nodes
      .filter(gn => shouldMergeNode(gn.urn))
      .map(gn => {
        const metadata: Record<string, unknown> = {
          ...gn.properties,
          childCount: gn.childCount,
          sourceSystem: gn.sourceSystem,
        }
        return {
          id: gn.urn,
          type: 'default' as const,
          position: { x: 0, y: 0 },
          data: {
            label: gn.displayName,
            urn: gn.urn,
            type: gn.entityType,
            classifications: gn.tags ?? [],
            metadata,
          },
        }
      })
    if (newCanvasNodes.length > 0) addNodes(newCanvasNodes as any[])

    const newCanvasEdges = expanded.edges
      .filter(ge => isResolvableEndpoint(ge.sourceUrn) && isResolvableEndpoint(ge.targetUrn))
      .map(ge => ({
        id: ge.id,
        source: ge.sourceUrn,
        target: ge.targetUrn,
        data: {
          edgeType: ge.edgeType,
          relationship: ge.edgeType,
          confidence: ge.confidence,
        },
      }))
    if (newCanvasEdges.length > 0) {
      addEdges(newCanvasEdges as any[])
      trace.recordAddedEdgeIds(newCanvasEdges.map(e => e.id))
    }

    // Containment edges: only when target is newly-merged. Never re-parent
    // existing canvas nodes (the HARD RULE would steal their layer).
    const newContainmentCanvasEdges = (expanded.containmentEdges ?? [])
      .filter(ge => shouldMergeNode(ge.targetUrn) && isResolvableEndpoint(ge.sourceUrn))
      .map(ge => ({
        id: ge.id,
        source: ge.sourceUrn,
        target: ge.targetUrn,
        data: {
          edgeType: ge.edgeType,
          relationship: ge.edgeType,
          confidence: ge.confidence,
        },
      }))
    if (newContainmentCanvasEdges.length > 0) {
      addEdges(newContainmentCanvasEdges as any[])
      trace.recordAddedEdgeIds(newContainmentCanvasEdges.map(e => e.id))
    }

    const drillContainmentMap = new Map<string, string>()
    expanded.containmentEdges?.forEach(ce => {
      drillContainmentMap.set(ce.targetUrn, ce.sourceUrn)
    })
    setExpandedNodes(prev => {
      const next = new Set(prev)
      expanded.nodes.forEach(n => {
        let p = drillContainmentMap.get(n.urn) ?? parentMap.get(n.urn)
        while (p) {
          next.add(p)
          p = drillContainmentMap.get(p) ?? parentMap.get(p)
        }
      })
      return next
    })
  }, [addNodes, addEdges, parentMap, displayMap, trace])

  // Entity-type → hierarchy.level lookup for auto-drill. The drill-down
  // RPC takes the *current* level and returns one level finer; we derive
  // the current level from the expanded node's entity type via the schema.
  const entityTypeLevels = useMemo(() => {
    const map = new Map<string, number>()
    schemaEntityTypes.forEach(et => {
      if (typeof et.hierarchy?.level === 'number') map.set(et.id, et.hierarchy.level)
    })
    return map
  }, [schemaEntityTypes])

  // Auto-drill on expand: when a traced node is expanded, drill into every
  // AGGREGATED edge incident to it. Each drill returns the next-finer level
  // of nodes/edges between this node's subtree and the peer's subtree;
  // mergeDrilldownIntoCanvas merges them, and `useTraceFilteredHierarchy`
  // (which reads `trace.drilldowns`) reveals them in the canvas — recursively
  // at any depth.
  //
  // Single batched call: previously this fired one /trace/expand request per
  // incident aggregated edge (concurrency-6 worker pool). A hub node with
  // 30 edges produced 30 HTTP requests. Now we collect every pair into one
  // /trace/expand-batch call; the server fans out internally and returns a
  // single merged result. The drilldowns cache still keys per (s, t, lvl)
  // so re-expanding a previously-drilled node remains a no-op.
  const autoDrillOnExpand = useCallback(async (nodeId: string) => {
    if (!trace.isTracing) return
    const node = nodes.find(n => n.id === nodeId)
    if (!node) return
    const nodeUrn = (node.data?.urn as string) ?? nodeId
    const entityType = (node.data?.type as string) ?? ''
    const currentLevel = entityTypeLevels.get(entityType)
    if (currentLevel === undefined) return  // not a leveled entity (logical/tag/etc)

    // Find AGGREGATED edges incident to this node (canvas-store edges already
    // carry the trace result's edges via the post-trace merge).
    const incidentEdges = edges.filter(e => {
      const isAgg = String(((e as any).data?.edgeType) ?? '').toUpperCase() === 'AGGREGATED'
      if (!isAgg) return false
      const s = (e as any).source ?? (e as any).sourceUrn
      const t = (e as any).target ?? (e as any).targetUrn
      return s === nodeUrn || t === nodeUrn
    })
    if (incidentEdges.length === 0) return

    const pairs = incidentEdges.map(edge => ({
      sourceUrn: (edge as any).source ?? (edge as any).sourceUrn,
      targetUrn: (edge as any).target ?? (edge as any).targetUrn,
      currentLevel,
    })).filter(p => p.sourceUrn && p.targetUrn)
    if (pairs.length === 0) return

    const merged = await trace.expandAggregatedEdgesBatch(pairs)
    if (merged) mergeDrilldownIntoCanvas(merged)
  }, [trace, nodes, edges, entityTypeLevels, mergeDrilldownIntoCanvas])

  const toggleNode = useCallback(async (nodeId: string) => {
    // TRACE MODE: expansion belongs to the overlay. Opening a card is a
    // re-projection of the walk model the session already holds — no fetch,
    // no store write, and nothing to undo when the trace ends.
    if (overlayRef.current?.active) {
      overlayRef.current.toggle(nodeId)
      recordTraceExpansionSoon()
      return
    }
    // Still walking: the columns are showing BROWSE and its chevrons look
    // live, but expanding one would fetch children into the store with
    // nothing to undo it when the trace exits. A no-op, never a fall-through.
    if (traceWriteLocked()) return

    const node = displayMap.get(nodeId)

    if (node?.isLogical) {
      setExpandedNodes((prev) => {
        const next = new Set(prev)
        if (next.has(nodeId)) next.delete(nodeId)
        else next.add(nodeId)
        return next
      })
      return
    }

    // A child load for this node is already in flight (expand started by an
    // earlier click). Ignore repeat clicks until it settles: without this,
    // an impatient second click would read committed state as expanded,
    // collapse the node, and cancelChildLoad() the in-flight fetch — forcing
    // a third click to actually load. The loading spinner provides feedback
    // meanwhile; collapse works normally once the load completes (finally
    // clears pendingLoadRef).
    if (pendingLoadRef.current.has(nodeId)) return

    // Determine action from committed state via updater function — avoids stale closure read.
    let wasExpanded = false
    setExpandedNodes((prev) => {
      wasExpanded = prev.has(nodeId)
      const next = new Set(prev)
      if (wasExpanded) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })

    // Trigger fetch only when expanding, and only once per node (guard against rapid clicks).
    if (!wasExpanded && !pendingLoadRef.current.has(nodeId)) {
      pendingLoadRef.current.add(nodeId)
      try {
        // Browse path: loadChildren fetches the children + their lineage
        // edges (via getChildrenWithEdges with includeLineageEdges:true).
        // Trace path: also batch-drill the AGGREGATED edges incident to
        // this node so the server returns the next-finer level of trace
        // edges between this node's subtree and its peers' subtrees. The
        // density-tier renderer + browse-mode bundling now absorb the
        // result; the historical reason this was disabled (canvas
        // overload) no longer applies.
        await loadChildrenSorted(nodeId)
        if (trace.isTracing) {
          // Fire-and-forget: drill runs in the background and merges into
          // the canvas as it returns. No await — the children are already
          // visible from loadChildren above.
          void autoDrillOnExpand(nodeId)
        }
      } finally {
        pendingLoadRef.current.delete(nodeId)
      }
    } else if (wasExpanded) {
      // User collapsed — drop any pending/in-flight child load so a
      // slow response doesn't repopulate a now-collapsed subtree.
      cancelChildLoad(nodeId)

      // Collapse: drop every edge with an endpoint inside the collapsed
      // subtree (the node itself + all descendants). Re-expanding
      // refetches the dropped edges via `loadChildren` / drill paths so
      // the store stays clean across many expand/collapse cycles.
      //
      // Trace-mode exemption: edges merged by `/trace/v2` or
      // `autoDrillOnExpand` are tracked in
      // `useUnifiedTrace.addedEdgeIds`. We preserve the ENTIRE set —
      // both the lineage edges and the containment edges. Two reasons:
      //
      //  1. Lineage edges have no re-add path on re-expand. Neither
      //     `loadChildren` nor `autoDrillOnExpand` refetches the
      //     original `/trace/v2` lineage — it was a one-shot result.
      //     Dropping it permanently kills the trace mesh until the
      //     user re-runs the trace.
      //
      //  2. Containment edges are needed to keep the projection chain
      //     intact. `useEdgeProjection`'s `ancestorMap` walks the
      //     containment hierarchy (via `parentMap` from
      //     `useContainmentHierarchy`) to roll a drilled child's
      //     lineage edges up to its visible ancestor after collapse.
      //     If we drop the drilled containment edges, the child node
      //     stays in `canvas.nodes` but loses its parent entry — its
      //     preserved lineage edges become unprojectable, and the
      //     user sees "the ancestor lineage going into my focus node
      //     vanished".
      //
      // Trade-off: preserving trace containment means
      // `loadChildren`'s cache check (`currentChildrenCount >=
      // childCount` in `useGraphHydration.ts`) short-circuits on
      // re-expand, so browse-mode lineage between sibling children at
      // deeper levels is not re-fetched. In trace mode this is
      // acceptable — those edges are gated by
      // `useEdgeProjection`'s trace context anyway (both endpoints
      // must be in the trace context) and trace-relevant cross-edges
      // are already in `addedEdgeIds` and preserved here.
      //
      // Browse-mode collapse (no trace active) is unchanged:
      // `preserveEdgeIds === undefined` so every edge in the subtree
      // is dropped, and the next `loadChildren` re-fetches everything
      // from scratch.
      // IMPORTANT: do NOT add ``nodeId`` itself to ``subtreeIds`` —
      // only its descendants. ``removeEdgesByNodeIds`` drops every
      // edge where source OR target is in the set, so including
      // ``nodeId`` purges the parent's containment edge to
      // ``nodeId`` as well. That orphans the just-collapsed node
      // from ``useContainmentHierarchy``: the LayerColumn stops
      // rendering it (the row vanishes) AND the parent's
      // ``children.length`` drops below ``childCount`` so the
      // virtualized tree spawns a stale "↓ load N more" pill. The
      // bug only surfaced once ``useRevealSearchHit`` started
      // priming deep entities that weren't in the initial page; the
      // collapse flow was previously masked because the missing
      // child was re-fetched via the normal page-load path anyway.
      // The walk still seeds from ``nodeId`` so its descendants get
      // enumerated; we just skip adding ``nodeId`` to the removal
      // set itself.
      const subtreeIds = new Set<string>()
      const stack: string[] = [nodeId]
      while (stack.length > 0) {
        const id = stack.pop()!
        const children = childMap.get(id)
        if (!children) continue
        for (const cid of children) {
          if (!subtreeIds.has(cid)) { subtreeIds.add(cid); stack.push(cid) }
        }
      }

      // Browse-mode collapse must PRUNE the subtree's descendant NODES, not
      // just their containment edges. Dropping only edges leaves each
      // descendant in `canvas.nodes` with no incoming containment edge; in a
      // rule / entity-type-scoped Context View, `useLayerAssignment` then
      // re-homes that edge-less node to its type column as a VISUAL ROOT
      // (the root priority chain resolves it by entity type), and
      // `useContainmentHierarchy` reports it parentless — so children and
      // grandchildren float up as root-level siblings and the tree scrambles.
      // Physically removing the descendants keeps collapse a true
      // subtree-hide; re-expand refetches them via `loadChildren` (the
      // backend returns each node with a correct `childCount`, including
      // draft-created intermediates, so deeper drilling still works).
      //
      // Falls back to edge-only cleanup when:
      //   • a trace is active — trace-merged edges have no re-add path and
      //     `useTraceFilteredHierarchy` already hides non-context orphans, so
      //     the existing preserve-edges behaviour is retained; or
      //   • the subtree carries UNSAVED work. Pruning + refetch would make
      //     in-progress authoring vanish from the canvas. Unsaved work has three
      //     representations in this app, so the guard checks all three:
      //       (1) a subtree NODE with an isPending overlay (create/modify/delete);
      //       (2) a pending containment EDGE incident to the subtree — a
      //           reparented / "Move to…" node is a SAVED, markerless node whose
      //           pending marker lives on the NEW edge (useReparentNode.
      //           restageContainment); pruning the node would drop it from the
      //           canvas until a manual re-expand; and
      //       (3) a staged property edit (rename/update) in stagedChangesStore
      //           targeting a subtree node — these carry NO canvas marker at all.
      //     `removeEdgesByNodeIds` already preserves unsaved edges in that fallback.
      const { nodes: storeNodes, edges: storeEdges } = useCanvasStore.getState()
      const subtreeNodeUrns = new Set<string>()
      let pendingNodeInSubtree = false
      for (const n of storeNodes) {
        if (!subtreeIds.has(n.id)) continue
        subtreeNodeUrns.add((n.data?.urn as string | undefined) ?? n.id)
        if (n.data?.isPending) pendingNodeInSubtree = true
      }
      const pendingEdgeInSubtree = storeEdges.some(
        (e) => !!e.data?.isPending && (subtreeIds.has(e.source) || subtreeIds.has(e.target)),
      )
      const stagedEditInSubtree = useStagedChangesStore.getState().changes.some(
        (c) => subtreeIds.has(c.targetId) || (c.targetUrn ? subtreeNodeUrns.has(c.targetUrn) : false),
      )
      const subtreeHasUnsavedWork = pendingNodeInSubtree || pendingEdgeInSubtree || stagedEditInSubtree
      const canPrune = !traceActive && !subtreeHasUnsavedWork

      if (canPrune && subtreeIds.size > 0) {
        // Atomic node + incident-edge removal.
        removeStoreNodes([...subtreeIds])
        // Drop the pruned descendants from `expandedNodes` so a re-expand
        // starts from a clean single level instead of resurrecting stale
        // expansion state that points at nodes no longer in the store.
        setExpandedNodes((prev) => {
          const next = new Set(prev)
          for (const id of subtreeIds) next.delete(id)
          return next
        })
      }
      // else — the subtree carries UNSAVED work: leave it FULLY intact in the
      // store (no node or edge removal). The visual collapse is driven by
      // `expandedNodes` alone, so the rows are hidden regardless; keeping every
      // containment edge means no SAVED descendant is orphaned. Dropping the
      // saved edges here (the old `removeEdgesByNodeIds` fallback) is exactly
      // what re-homed those descendants as root-level siblings — the
      // expand/collapse "scramble" that recurs whenever the subtree mixes saved
      // nodes with new/renamed (pending) ones. Re-expand re-renders straight from
      // the intact store (loadChildren short-circuits on the already-satisfied
      // childCount, nothing duplicates), and every in-progress create / rename /
      // reparent survives.

      // Synchronous companion: drop matching entries in the aggregated-edge
      // map too. Otherwise stale child-level aggregated edges linger for up
      // to 500 ms (until the debounced fetchAggregated refreshes), producing
      // a flicker after collapse. Resolve subtree URNs from displayMap so
      // we don't depend on id == urn invariants.
      const subtreeUrns = new Set<string>()
      for (const id of subtreeIds) {
        const u = (displayMap.get(id)?.data?.urn as string | undefined) ?? id
        if (u) subtreeUrns.add(u)
      }
      if (subtreeUrns.size > 0) purgeAggregatedEdgesIncidentToUrns(subtreeUrns)
    }
  }, [displayMap, loadChildrenSorted, cancelChildLoad, childMap, removeStoreNodes, purgeAggregatedEdgesIncidentToUrns, traceActive, trace.isTracing, autoDrillOnExpand, traceWriteLocked, recordTraceExpansionSoon])




  // `traceContextSet` now comes directly from useTraceFilteredHierarchy above
  // (single source of truth for both filtering and edge projection).

  // Hovered node — needed by both edge projection (delegation) and hover highlight
  const hoveredNodeId = useHoveredNodeId()

  // Layer-index map: nodeId → layer ordinal (Source=0, Staging=1, …).
  // Drives reverse-flow detection — projected edges where target.layerIdx <
  // source.layerIdx get `isReverseFlow:true` so the renderer can route them
  // through the dedicated lane below the columns. Lazily-cheap: O(N) once
  // per layer assignment change.
  const nodeLayerIndexMap = useMemo(() => {
    const layerOrdinal = new Map<string, number>()
    sortedLayers.forEach((l, i) => layerOrdinal.set(l.id, i))
    const byNode = new Map<string, number>()
    nodeLayerMap.forEach((layerId, nodeId) => {
      const idx = layerOrdinal.get(layerId)
      if (typeof idx === 'number') byNode.set(nodeId, idx)
    })
    return byNode
  }, [sortedLayers, nodeLayerMap])

  // Browse-mode bundling is on by default. The previous behaviour gated it
  // behind `edges.length > 800`, which meant the most common dense case
  // (300–700 edges with high per-pair fan-in) never bundled — bundling
  // would only kick in after the canvas was already overloaded. Letting
  // the projection run from the first edge collapses leaf pairs to
  // collapsed-parent bundles immediately; expanded parents stay at leaf
  // resolution because the walk respects `expandedNodes`.
  const browseBundleEnabled = !overlay.active

  // Edge projection — BROWSE only. In trace mode the overlay's own wire
  // ledger has already decided the grain (see traceWireLedger), so the
  // projection would be re-deciding it from a store that holds none of the
  // trace's lineage anyway.
  // WHILE THE OVERLAY DRAWS, give the projection nothing. Its output is
  // already discarded (the wires come from the trace's own ledger), but it
  // was being handed the BROWSE lineage against the TRACE's node map — so
  // every browse edge with an endpoint outside the trace picture resolved to
  // nothing and was counted as "hidden", inflating the missing-connections
  // chip on every real trace and firing the projection's console.warn. It
  // also spent an O(E) pass per render to produce that.
  //
  // Keyed on `overlay.active`, not `traceActive`: during the walk the canvas
  // is still showing BROWSE and must keep its wires and its honest count.
  const { visibleLineageEdges: browseVisibleLineageEdges, unresolvedEdgeCount } = useEdgeProjection({
    edges: overlay.active ? (EMPTY_EDGES as typeof edges) : edges,
    aggregatedEdges: overlay.active ? (EMPTY_AGG_EDGES as typeof aggregatedEdges) : aggregatedEdges,
    nodesByLayer: renderByLayer, expandedNodes,
    displayFlat: renderFlat, displayMap: renderMap, urnToIdMap,
    showLineageFlow, isTracing: overlay.active,
    traceContextSet, isContainmentEdge,
    hoveredNodeId,
    suppressedAggEdgeKeys,
    // Browse-mode bundling: kicks in only outside trace mode and only when
    // edge density would otherwise overload the canvas. Walks endpoints up
    // the containment chain in passes; collapses parent-pairs whose fan-in
    // exceeds the threshold.
    browseBundleEnabled,
    browseBundleParentMap: parentMap,
    browseBundleFanInThreshold: lineageBundleFanIn,
    nodeLayerIndexMap,
  })

  // THE TRACE'S OWN WIRES: one line per flow, at the one grain the reader's
  // expansion has earned. Endpoints are card ids (a Context View node id IS
  // its urn), which is what LineageFlowOverlay anchors on.
  const visibleLineageEdges = useMemo(() => {
    if (!overlay.active || !overlay.view) return browseVisibleLineageEdges
    return overlay.view.wires.map(w => ({
      id: w.id,
      source: w.source,
      target: w.target,
      edgeCount: w.edgeCount,
      isBundled: w.isBundled,
      kind: w.kind,
    }))
  }, [overlay.active, overlay.view, browseVisibleLineageEdges])

  // Publish the projected lineage edge set to the canvas store so panels
  // outside the canvas (EntityDrawer's Lineage section) can mirror exactly
  // what the user sees. THIS IS A LEGAL WRITE DURING A TRACE: `visibleEdges`
  // is the "what is on screen right now" mirror, not graph content — the
  // no-writes invariant covers `nodes`/`edges`, the things exiting a trace
  // has to restore. During a trace this correctly publishes the overlay's
  // own wires, so the drawer agrees with the canvas. `visibleLineageEdges` already excludes containment
  // and rolls leaf-level edges up to visible ancestors. Dedup by
  // id-fingerprint — upstream memos can return a new array reference even
  // when content is identical, and a naive ref-based dep would cause repeated
  // store writes feeding back into a render loop.
  const visibleLineageEdgesFingerprint = useMemo(
    () => visibleLineageEdges.map((e: { id: string }) => e.id).join('|'),
    [visibleLineageEdges],
  )
  const visibleLineageEdgesRef = useRef(visibleLineageEdges)
  visibleLineageEdgesRef.current = visibleLineageEdges
  useEffect(() => {
    setVisibleEdges(visibleLineageEdgesRef.current as LineageEdge[])
    // No cleanup-reset: avoids a second store write per cycle. Stale data
    // on unmount gets overwritten by the next canvas mount; the consumer
    // (LineageNeighbors) falls back to raw `edges` when empty.
  }, [visibleLineageEdgesFingerprint, setVisibleEdges])

  // Render-mode resolution: `raw` shows every projected edge; `stubs`
  // suppresses ambient edges in favour of per-node indicators (hover /
  // selection materializes); `auto` renders everything below
  // `autoStubThreshold` and switches to a BUDGETED presentation above it.
  // The mode resolves identically in trace and browse — trace mode no
  // longer bypasses the gate. Trace's focus-incident edges stay
  // materialized via `effectiveLineageEdges` so the anchor is legible.
  const isStubsMode = useMemo(() => {
    // Trace mode: the flow IS the point, and the walk budget already
    // bounds the edge count — every trace wire draws, no stub culling.
    if (overlay.active) return false
    if (lineageRenderMode === 'raw') return false
    if (lineageRenderMode === 'stubs') return true
    return visibleLineageEdges.length > autoStubThreshold
  }, [overlay.active, lineageRenderMode, visibleLineageEdges.length, autoStubThreshold])

  // Significance ranking: bundled edge count first (a 600-edge bundle IS
  // the macro flow), confidence as the tie-break.
  const bySignificance = (a: { edgeCount?: number; confidence?: number }, b: { edgeCount?: number; confidence?: number }) =>
    ((b.edgeCount || 1) - (a.edgeCount || 1)) || ((b.confidence || 0) - (a.confidence || 0))

  // Adaptive ambient budget. Above the threshold, "Adaptive" adapts
  // instead of cliffing (old behavior: all ambient edges vanished at
  // once) or dumping (interim behavior: a 40k-path hairball): the
  // STRONGEST flows render ambiently up to the budget, and the long
  // tail is declared — per-node in/out indicators carry presence +
  // counts, and a status chip reports "showing N strongest of M" with
  // escalation to All Edges. Nothing is lost silently; the canvas stays
  // readable; SVG path count stays bounded regardless of graph size.
  const rankedAmbientEdges = useMemo(() => {
    if (!isStubsMode || lineageRenderMode !== 'auto') return null
    return [...visibleLineageEdges].sort(bySignificance).slice(0, autoStubThreshold)
  }, [isStubsMode, lineageRenderMode, visibleLineageEdges, autoStubThreshold])

  // Effective edge set passed to the renderer, plus the shown/total
  // bookkeeping the status chips surface. Focus (hover / selection /
  // trace anchor) materializes incident edges in every stub-y mode, but
  // a hub's fan is ALSO capped at the strongest `autoStubThreshold` —
  // 650 curves at once is noise; the Lineage Lens enumerates the full
  // fan properly and the chip points there.
  const edgePresentation = useMemo(() => {
    if (!isStubsMode) {
      return { edges: visibleLineageEdges, ambientShown: 0, ambientTotal: 0, focusShown: 0, focusTotal: 0 }
    }
    const ambient = rankedAmbientEdges ?? []
    const ambientTotal = lineageRenderMode === 'auto' ? visibleLineageEdges.length : 0
    const focusIds = new Set<string>()
    if (hoveredNodeId) focusIds.add(hoveredNodeId)
    if (selectedNodeId) focusIds.add(selectedNodeId)
    if (overlay.active && canvasTrace.tracedUrn) focusIds.add(urnToIdMap.get(canvasTrace.tracedUrn) ?? canvasTrace.tracedUrn)
    if (focusIds.size === 0) {
      return { edges: ambient, ambientShown: ambient.length, ambientTotal, focusShown: 0, focusTotal: 0 }
    }
    const focusAll = visibleLineageEdges.filter(e =>
      focusIds.has(e.source) || focusIds.has(e.target)
    )
    const focus = focusAll.length > autoStubThreshold
      ? [...focusAll].sort(bySignificance).slice(0, autoStubThreshold)
      : focusAll
    if (ambient.length === 0) {
      return { edges: focus, ambientShown: 0, ambientTotal, focusShown: focus.length, focusTotal: focusAll.length }
    }
    const focusIdsSet = new Set(focus.map(e => e.id))
    return {
      edges: [...focus, ...ambient.filter(e => !focusIdsSet.has(e.id))],
      ambientShown: ambient.length,
      ambientTotal,
      focusShown: focus.length,
      focusTotal: focusAll.length,
    }
  }, [isStubsMode, lineageRenderMode, rankedAmbientEdges, visibleLineageEdges, autoStubThreshold, hoveredNodeId, selectedNodeId, overlay.active, canvasTrace.tracedUrn, urnToIdMap])
  const effectiveLineageEdges = edgePresentation.edges

  // Flow ribbons — macro volume per (layer → layer) pair, aggregated over
  // EVERY projected edge (not just the budgeted subset) so the bands show
  // the true totals the budget summarizes. Only in Adaptive's summarized
  // state; user-toggleable.
  const flowRibbons = useMemo(() => {
    if (!showFlowRibbons || !isStubsMode || lineageRenderMode !== 'auto') return undefined
    const ribbons = aggregateFlowRibbons(
      visibleLineageEdges,
      nodeLayerMap,
      sortedLayers.map(l => l.id),
    )
    return ribbons.length > 0 ? ribbons : undefined
  }, [showFlowRibbons, isStubsMode, lineageRenderMode, visibleLineageEdges, nodeLayerMap, sortedLayers])

  // Edges whose drill-down is in flight — match by `${sourceUrn}->${targetUrn}`
  // against `trace.expandingPairs`. The renderer pulses these so the
  // canvas never appears frozen during the /trace/expand round-trip.
  const expandingEdgeIds = useMemo(() => {
    if (trace.expandingPairs.size === 0) return undefined
    const ids = new Set<string>()
    const resolveUrn = (id: string | undefined | null): string | undefined => {
      if (!id) return undefined
      const node = displayMap.get(id)
      return (node?.urn as string | undefined) ?? id
    }
    for (const e of effectiveLineageEdges) {
      const sUrn = resolveUrn((e as { source?: string; sourceUrn?: string }).source ?? (e as { sourceUrn?: string }).sourceUrn)
      const tUrn = resolveUrn((e as { target?: string; targetUrn?: string }).target ?? (e as { targetUrn?: string }).targetUrn)
      if (sUrn && tUrn && trace.expandingPairs.has(`${sUrn}->${tUrn}`)) {
        ids.add(e.id)
      }
    }
    return ids
  }, [trace.expandingPairs, effectiveLineageEdges, displayMap])

  // Per-node lineage counts. Drives the in/out indicators on each entity
  // card — computed in EVERY render mode so a node always communicates
  // "has lineage in/out" vs "has none" (full ribbons in stubs mode, a
  // quiet tab otherwise; see LineageFlowOverlay). Counts come from the
  // full projected set (not the hover-filtered slice) so the markers
  // reflect the entity's true lineage volume regardless of which edges
  // happen to be materialized for the current hover.
  const nodeStubCounts = useMemo(() => {
    const counts = new Map<string, { in: number; out: number }>()
    for (const e of visibleLineageEdges) {
      const s = counts.get(e.source) ?? { in: 0, out: 0 }
      s.out++
      counts.set(e.source, s)
      const t = counts.get(e.target) ?? { in: 0, out: 0 }
      t.in++
      counts.set(e.target, t)
    }
    return counts
  }, [visibleLineageEdges])

  // ── Canvas status chips: loaded-but-hidden data surfaced to the user ──
  const openNodeDrawer = useCanvasStore((s) => s.openNodeDrawer)
  const unassignedEntities = useMemo(() =>
    unassignedNodes.map((n) => ({
      id: n.id,
      label: (n.data?.label ?? n.data?.businessLabel ?? n.id) as string,
      type: n.data?.type as string | undefined,
    })), [unassignedNodes])
  // Truncated aggregated expansions: summed shown/total across all expanded
  // bundles whose detail was capped, plus a load-more that pages each one.
  const aggDetailStatus = useMemo(() => {
    let shown = 0
    let total = 0
    const truncatedIds: string[] = []
    aggregatedEdges.forEach((state, id) => {
      if (state.state === 'expanded' && state.detailTruncated) {
        shown += state.detailedEdges.length
        total += state.detailTotal ?? state.detailedEdges.length
        truncatedIds.push(id)
      }
    })
    return { shown, total, truncatedIds }
  }, [aggregatedEdges])
  const handleLoadMoreAggDetail = useCallback(() => {
    aggDetailStatus.truncatedIds.forEach(id => { void loadMoreAggregatedDetail(id) })
  }, [aggDetailStatus.truncatedIds, loadMoreAggregatedDetail])

  // ── Lineage Lens — ego-graph overlay (focus history; empty = closed).
  // Browser-style back/forward: moving the cursor never drops entries;
  // focusing a NEW node truncates the forward side first (the same
  // invariant as the staged-changes undo/redo).
  // Shared exploration links (?lens=…): decoded ONCE during the first
  // render so the lens opens directly on the shared picture (no
  // un-restored flash); the param strip and mode apply — external-
  // system updates — happen in the mount effect below. Malformed
  // tokens decode to null and the canvas opens normally.
  const [initialLensShare] = useState(() => {
    // A link that carries both opens the TRACE: it is the more specific
    // state, and two overlays racing each other on arrival is nobody's
    // intent. The lens token is dropped with the param strip below.
    if (initialTraceShare) return null
    const raw = new URLSearchParams(window.location.search).get('lens')
    return raw ? decodeLensShare(raw) : null
  })
  const [lensHistory, setLensHistory] = useState<LensHistory>(() => (
    initialLensShare
      ? { entries: initialLensShare.entries, cursor: initialLensShare.cursor }
      : EMPTY_LENS_HISTORY
  ))
  // Trace = the Lens walked to the ends: every trace affordance opens
  // the lens with the full walk ON; ordinary lens entries keep the
  // classic one-hop ⊕ walk. The legacy /trace/v2 machinery below stays
  // wired but is no longer reachable from this canvas's entry points.
  const [lensFullWalk, setLensFullWalk] = useState(false)
  const openLensAt = useCallback((nodeId: string, fullWalk: boolean) => {
    setLensFullWalk(fullWalk)
    setLensHistory({ entries: [nodeId], cursor: 0 })
  }, [])
  const openLens = useCallback((nodeId: string) => openLensAt(nodeId, false), [openLensAt])
  const lensRecenter = useCallback((nodeId: string) => setLensHistory(h => lensPush(h, nodeId)), [])
  const lensBack = useCallback(() => setLensHistory(lensBackward), [])
  const lensForward = useCallback(() => setLensHistory(lensForwardStep), [])
  // Path-trail jump: move the cursor to hop i without dropping the trail.
  const lensJumpTo = useCallback((index: number) => setLensHistory(h => lensJump(h, index)), [])
  const lensClose = useCallback(() => setLensHistory(EMPTY_LENS_HISTORY), [])
  // The lens reads ONE thing: the accumulated walk model for whichever
  // focal it is on. Server-lazy — one closure fetch on open, then a
  // further hop per ⊕ — cached per focal for the whole lens session, so
  // stepping Back is instant. Lens-local: never written to the canvas
  // store.
  const lensFocal = lensFocalOf(lensHistory)
  // The focus's name as THIS canvas knows it, for the lens's first paint:
  // until its model lands the lens can only derive a label from the URN,
  // and the capsule that says "Mapping the lineage of …" is the first
  // thing the reader sees (2026-08-22). One scan per focus change.
  const lensLabelHintFor = useCallback((urn: string): string | null => {
    const data = nodes.find(n => n.id === urn)?.data as { label?: string } | undefined
    return data?.label ?? null
  }, [nodes])
  const userLensInitialDepth = usePreferencesStore((s) => s.lensInitialDepth)
  // A share v2/v3 link's `depth` overrides the pref for exactly the
  // RESTORED focal's initial fetch: useLensWalk's own cache guard
  // (`startedRef`) means this can only ever matter for that ONE fetch —
  // once it has fired (or for any other focal), the user's own
  // preference is what's in effect, so this never becomes a silent,
  // permanent override for the rest of the session.
  const lensInitialDepth = initialLensShare && (initialLensShare.v === 2 || initialLensShare.v === 3) && lensFocal === initialLensShare.entries[initialLensShare.cursor]
    ? initialLensShare.depth
    : userLensInitialDepth
  const lensWalk = useLensWalk(lensFocal, provider, lensInitialDepth, lensFullWalk)
  // The rest of a restored exploration — applied once, inside the lens,
  // to the same focal the depth override above targets.
  const lensWalkSeed = useMemo<LensWalkSeed | null>(() => {
    if (!initialLensShare || (initialLensShare.v !== 2 && initialLensShare.v !== 3)) return null
    const { entries, cursor, direction, revealed, opened, collapsed, frameAll, framePages, frameQueries } = initialLensShare
    // T23 — a v2 link predates placements/condensed-open; the graceful
    // degrade is the same shape a fresh focal opens with (nothing
    // placed, everything condensed). T28 R3 — a v3 link's own
    // `railWindow` field still decodes (old links keep restoring) but is
    // no longer read into the seed — the window it named is gone.
    const { pinned, condensedOpen } = initialLensShare.v === 3
      ? initialLensShare
      : { pinned: [], condensedOpen: [] }
    return { nodeId: entries[cursor], direction, revealed, opened, collapsed, frameAll, framePages, frameQueries, pinned, condensedOpen }
  }, [initialLensShare])
  // "What is really inside this entity" — membership, which the lineage
  // walk structurally cannot answer (it only ever knows the
  // participants). A separate, separately-paged fetch for that reason.
  const lensChildren = useLensChildren(lensFocal, provider)
  // PERF: both hooks return a fresh object literal every render while
  // the methods inside are stable useCallbacks. Depending on the OBJECT
  // made each handler below new on every render, which changed the
  // Lens's card context identity — and both card memo comparators start
  // with `a.ctx === b.ctx &&`, so the content comparison was never
  // reached and every card re-rendered on every canvas tick. It also
  // churned the deps of the in-frame search debounce, which could keep
  // the 300ms timer resetting forever. Depend on the methods.
  const { extend: lensExtend, page: lensPage, retry: lensRetryWalk, pageSeeds: lensPageSeeds } = lensWalk
  const lensWalkApi = useMemo(
    () => ({ extend: lensExtend, page: lensPage, retry: lensRetryWalk, pageSeeds: lensPageSeeds }),
    [lensExtend, lensPage, lensRetryWalk, lensPageSeeds],
  )
  const { walkFor: lensWalkFor } = lensWalk
  const lensWalkEntry = lensFocal ? lensWalkFor(lensFocal) : null
  const { loadAllChildren: loadLensAllChildren, loadChildrenOf: loadLensChildrenOf } = lensChildren
  useEffect(() => {
    focusLensRef.current = () => {
      const target = selectedNodeId ?? drawerNodeId
      if (target) setLensHistory({ entries: [target], cursor: 0 })
    }
  }, [selectedNodeId, drawerNodeId])
  // Finish consuming the share link: strip the param, so refreshes and
  // copied URLs stay clean. The link's `mode` field is no longer applied
  // — the Lens has one body since 2026-08-23, and a link written when it
  // had two must not put a reader into a body that no longer exists.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (!params.has('lens') && !params.has('trace')) return
    params.delete('lens')
    params.delete('trace')
    const qs = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`)
  }, [initialLensShare, initialTraceShare])

  // ── Anchor Rail — the selected node's off-screen partners docked as
  // proxy chips in their owning columns. The overlay computes the
  // payload (it owns visibility truth) and pushes it here only on real
  // content change; columns render the chips; next frame the overlay
  // anchors the focus edges to the chip rects. Chip click reuses the
  // reveal mechanism (per-partner Frame); the "+N more" overflow routes
  // to the Lens — the full, searchable list.
  // ── External lineage (curated views) — "no lineage" vs "outside this
  // view". Total degrees fetched per hydration settle; external =
  // total − internal(loaded). Selection-scoped surface: a status chip
  // for the selected node. Absent totals mean UNKNOWN → no chip, never
  // a false "no lineage" claim.
  const externalDegrees = useExternalDegrees(
    activeEntityScope === 'curated' && showMissingConnectionIndicators,
  )
  // Ambient per-node cue: external = total − internal(loaded), for every
  // loaded node with a KNOWN total. One O(E) pass builds internal
  // degrees; nodes absent from externalDegrees stay absent here
  // (unknown ≠ zero). Empty map when the feature is off — the overlay
  // renders nothing.
  const externalCueByNode = useMemo(() => {
    const cue = new Map<string, { in: number; out: number }>()
    if (externalDegrees.size === 0) return cue
    const lineageTypeSet = new Set(lineageEdgeTypes)
    const internal = new Map<string, { in: number; out: number }>()
    for (const e of edges) {
      const t = (e.data?.edgeType as string) || ''
      if (lineageTypeSet.size > 0 && !lineageTypeSet.has(t)) continue
      const s = internal.get(e.source) ?? { in: 0, out: 0 }
      s.out++; internal.set(e.source, s)
      const tg = internal.get(e.target) ?? { in: 0, out: 0 }
      tg.in++; internal.set(e.target, tg)
    }
    externalDegrees.forEach((total, urn) => {
      const loc = internal.get(urn) ?? { in: 0, out: 0 }
      const exIn = Math.max(0, total.in - loc.in)
      const exOut = Math.max(0, total.out - loc.out)
      if (exIn + exOut > 0) cue.set(urn, { in: exIn, out: exOut })
    })
    return cue
  }, [externalDegrees, edges, lineageEdgeTypes])

  const selectedExternalLineage = useMemo(() => {
    if (!selectedNodeId) return null
    const total = externalDegrees.get(selectedNodeId)
    if (!total) return null
    const lineageTypeSet = new Set(lineageEdgeTypes)
    let inLoaded = 0
    let outLoaded = 0
    for (const e of edges) {
      const t = (e.data?.edgeType as string) || ''
      if (lineageTypeSet.size > 0 && !lineageTypeSet.has(t)) continue
      if (e.source === selectedNodeId) outLoaded++
      else if (e.target === selectedNodeId) inLoaded++
    }
    const exIn = Math.max(0, total.in - inLoaded)
    const exOut = Math.max(0, total.out - outLoaded)
    return exIn + exOut > 0 ? { in: exIn, out: exOut } : null
  }, [selectedNodeId, externalDegrees, edges, lineageEdgeTypes])

  // ── External lineage PREVIEW (feature-flagged) — the guided
  // click-through: fetch ONE node's out-of-scope partners on demand
  // (bounded: two edge queries + one name lookup) and show them in the
  // Lens, badged. Nothing enters the canvas store — a preview must
  // never mutate a curated view's scope.
  const externalLineagePreview = usePreferencesStore((s) => s.externalLineagePreview)
  const [externalPreview, setExternalPreview] = useState<{
    nodeId: string
    loading: boolean
    records: Array<{ urn: string; label: string; direction: 'in' | 'out'; edgeType: string }>
  } | null>(null)
  const handlePreviewExternal = useCallback(async () => {
    const urn = selectedNodeId
    if (!urn) return
    setExternalPreview({ nodeId: urn, loading: true, records: [] })
    openLens(urn)
    try {
      const types = lineageEdgeTypes.length > 0 ? lineageEdgeTypes : undefined
      const [outEdges, inEdges] = await Promise.all([
        provider.getEdges({ sourceUrns: [urn], edgeTypes: types, limit: 200 }),
        provider.getEdges({ targetUrns: [urn], edgeTypes: types, limit: 200 }),
      ])
      const loaded = new Set(useCanvasStore.getState().nodes.map(n => n.id))
      const partners = new Map<string, { direction: 'in' | 'out'; edgeType: string }>()
      for (const e of outEdges) {
        const p = e.targetUrn
        if (p && p !== urn && !loaded.has(p) && !partners.has(p)) partners.set(p, { direction: 'out', edgeType: e.edgeType ?? '' })
      }
      for (const e of inEdges) {
        const p = e.sourceUrn
        if (p && p !== urn && !loaded.has(p) && !partners.has(p)) partners.set(p, { direction: 'in', edgeType: e.edgeType ?? '' })
      }
      const partnerUrns = [...partners.keys()].slice(0, 100)
      const named = partnerUrns.length > 0
        ? await provider.getNodes({ urns: partnerUrns, limit: partnerUrns.length })
        : []
      const labelByUrn = new Map(named.map(n => [n.urn, n.displayName]))
      setExternalPreview({
        nodeId: urn,
        loading: false,
        records: partnerUrns.map(p => ({
          urn: p,
          label: labelByUrn.get(p) || p.split(':').pop() || p,
          direction: partners.get(p)!.direction,
          edgeType: partners.get(p)!.edgeType,
        })),
      })
    } catch {
      // Preview is advisory — fail closed to "no preview", never block the lens.
      setExternalPreview({ nodeId: urn, loading: false, records: [] })
    }
  }, [selectedNodeId, lineageEdgeTypes, provider, openLens])

  const [anchorProxyGroups, setAnchorProxyGroups] = useState<Map<string, AnchorProxyGroup>>(() => new Map())
  const handleAnchorProxies = useCallback((groups: Map<string, AnchorProxyGroup>) => {
    setAnchorProxyGroups(groups)
  }, [])

  // Rail focus: selection wins instantly; hover engages after a short
  // DWELL (so drive-by mouse movement doesn't flash chips) and, when the
  // hover ends with nothing selected, the rail LINGERS long enough for
  // the pointer to travel to a chip — the reason a naive hover-scoped
  // rail is unusable (it dismisses itself en route). Timers are
  // effect-scoped; every transition cancels the previous one.
  const [railFocusId, setRailFocusId] = useState<string | null>(null)
  useEffect(() => {
    if (selectedNodeId) {
      const raf = requestAnimationFrame(() => setRailFocusId(selectedNodeId))
      return () => cancelAnimationFrame(raf)
    }
    if (hoveredNodeId) {
      const t = setTimeout(() => setRailFocusId(hoveredNodeId), 250)
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => setRailFocusId(null), 1500)
    return () => clearTimeout(t)
  }, [selectedNodeId, hoveredNodeId])

  const handleProxyMore = useCallback(() => {
    const target = railFocusId ?? selectedNodeId
    if (target) openLens(target)
  }, [railFocusId, selectedNodeId, openLens])

  // ── Frame pill — offer to frame off-screen 1-hop neighbors on select ──
  // Never auto-scrolls: business users hate surprise camera moves. The
  // pill appears only when a meaningful share of the selection's
  // neighborhood is outside the viewport, and dismisses on deselect.
  const [framePill, setFramePill] = useState<{ nodeId: string; neighborIds: string[]; offCount: number } | null>(null)

  // ── Framed-mode chrome — explicit exit for the framed state ──────────
  // Clicking "Frame" reveals + centers the selection's neighborhood, and
  // the focus dimming makes the canvas read as a MODE — but the only way
  // out was the undiscoverable Esc. This context drives a persistent
  // pill that names the state, offers an explicit "Exit frame" (which
  // mirrors Esc exactly: clear the selection), and shows the Esc hint so
  // the shortcut becomes learnable. Dismissed automatically when the
  // framed selection changes or clears.
  const [framedContext, setFramedContext] = useState<{ nodeId: string; count: number } | null>(null)
  useEffect(() => {
    if (!framedContext) return
    if (selectedNodeId === framedContext.nodeId) return
    // rAF-deferred like the framePill effect — keeps the reset out of the
    // synchronous render/effect path (react-hooks/set-state-in-effect).
    const raf = requestAnimationFrame(() => setFramedContext(null))
    return () => cancelAnimationFrame(raf)
  }, [selectedNodeId, framedContext])
  const exitFrame = useCallback(() => {
    useCanvasStore.getState().clearSelection()
    setFramedContext(null)
  }, [])
  useEffect(() => {
    // rAF defers both the DOM measurement (post-paint rects) and the
    // state write off the effect's synchronous path. Deps use the STABLE
    // edge fingerprint (+ ref read) — the projected array's identity
    // churns per hover via delegation stamping, and re-measuring a hub
    // node's whole fan on every hover flick would jank. Measurement is
    // sampled: past the cap the neighborhood is off-screen-heavy by
    // construction, and the pill's decision doesn't need exact counts.
    const MEASURE_CAP = 300
    const raf = requestAnimationFrame(() => {
      if (!selectedNodeId) { setFramePill(null); return }
      const neighborIds = new Set<string>()
      for (const e of visibleLineageEdgesRef.current) {
        if (e.source === selectedNodeId && e.target !== selectedNodeId) neighborIds.add(e.target)
        else if (e.target === selectedNodeId && e.source !== selectedNodeId) neighborIds.add(e.source)
      }
      if (neighborIds.size === 0) { setFramePill(null); return }
      const box = horizontalScrollRef.current?.getBoundingClientRect()
      const ids = [...neighborIds]
      const sample = ids.slice(0, MEASURE_CAP)
      let off = 0
      for (const id of sample) {
        const el = document.getElementById(`layer-node-${id}`)
        if (!el || !box) { off++; continue }
        const r = el.getBoundingClientRect()
        if (r.bottom < box.top || r.top > box.bottom || r.right < box.left || r.left > box.right) off++
      }
      setFramePill(off / sample.length > 0.3 ? { nodeId: selectedNodeId, neighborIds: ids, offCount: off } : null)
    })
    return () => cancelAnimationFrame(raf)
  }, [selectedNodeId, visibleLineageEdgesFingerprint])

  // Highlight state: connected nodes/edges for selected node
  const { highlightState, isHighlightActive: isClickHighlightActive } = useHighlightState({
    selectedNodeId, visibleLineageEdges: effectiveLineageEdges,
    isTracing: traceActive, displayMap, childMap,
  })

  // Hover highlight: same visual effect on hover (lighter), defers to click-highlight
  const { hoverHighlight, isHoverActive } = useHoverHighlight({
    hoveredNodeId,
    visibleLineageEdges: effectiveLineageEdges,
    isTracing: traceActive,
    displayMap, childMap,
    isClickHighlightActive,
  })

  // Merge: click takes priority, hover used when no click selection
  const isHighlightActive = isClickHighlightActive || isHoverActive
  const mergedHighlightNodes = isClickHighlightActive ? highlightState.nodes : hoverHighlight.nodes
  const mergedHighlightEdges = isClickHighlightActive ? highlightState.edges : hoverHighlight.edges

  const clearSelection = useCanvasStore((s) => s.clearSelection)

  // Drill-down: double-click an AGGREGATED edge to fetch finer-level lineage
  // between the two ancestors and merge it into the canvas. The trace store
  // tracks each drilldown by `${sourceUrn}->${targetUrn}@${atLevel}` so collapse
  // can revert. Single-click still selects/opens the EdgeDetailPanel.
  const handleEdgeDoubleClick = useCallback(async (edgeId: string) => {
    // Resolve the bundle from the projected edges first — bundle ids look
    // like `bundle-${sourceId}->${targetId}` and are not in the canvas
    // store. Falling back to the store lookup keeps the legacy AGGREGATED
    // drill path working when callers pass a raw store edge id.
    const bundle = visibleLineageEdges.find(e => e.id === edgeId)
    const storeEdge = edges.find(e => e.id === edgeId)

    // ── Path 1: browse-mode bundle drill ─────────────────────────────────
    //
    // Iterative reveal: expand whichever endpoint has unrevealed children
    // (priority: source first, then target if source had nothing to expand).
    // Each double-click peels one layer; the projection re-bundles at the
    // next-finer level, so the user can keep drilling. Works in BOTH
    // browse and trace mode for client-side bundles — the trace AGGREGATED
    // server drill (Path 2) only kicks in when the bundle itself is the
    // server-returned AGG edge.
    if (bundle && (bundle.isBrowseBundle || bundle.isBundled)) {
      const isServerAgg = bundle.isAggregated  // backed by server AGGREGATED edge
      if (!isServerAgg || !trace.isTracing) {
        // Resolve against what is ON SCREEN: during a trace the rows and the
        // expansion are the overlay's, so reading displayMap/expandedNodes
        // would test the browse tree behind it and peel the wrong layer (or
        // decide there is nothing to peel).
        const onScreen = overlayRef.current?.active ? renderMapRef.current : displayMap
        const openNow: ReadonlySet<string> = overlayRef.current?.active
          ? overlayRef.current.traceExpansion
          : expandedNodes
        const trySource = onScreen.get(bundle.source)
        const tryTarget = onScreen.get(bundle.target)
        const sourceHasChildren = !!trySource && !openNow.has(bundle.source)
          && (((trySource.data?.childCount as number) ?? trySource.children?.length ?? 0) > 0)
        const targetHasChildren = !!tryTarget && !openNow.has(bundle.target)
          && (((tryTarget.data?.childCount as number) ?? tryTarget.children?.length ?? 0) > 0)
        if (sourceHasChildren) await toggleNode(bundle.source)
        if (targetHasChildren) await toggleNode(bundle.target)
        // If neither side had unrevealed children, fall through and let the
        // server-AGG drill (Path 2) try below — for nested trace structures
        // the same bundle can be both client-collapsed AND a server AGG
        // edge underneath. No-op if not in trace mode / not aggregated.
        if (sourceHasChildren || targetHasChildren) return
      }
    }

    // ── Path 2: server AGGREGATED drill (trace mode only) ────────────────
    if (!trace.isTracing) return
    const edgeForDrill: any = storeEdge ?? bundle
    if (!edgeForDrill) return
    const isAggregated =
      String((edgeForDrill?.data?.edgeType) ?? '').toUpperCase() === 'AGGREGATED'
      || edgeForDrill?.isAggregated
    if (!isAggregated) return

    // The server drill needs URNs, not visible node IDs. For server-edge
    // ids the source/target are already URNs; for projected bundles the
    // source/target are node IDs that we resolve through displayMap.
    const resolveUrn = (id: string): string | undefined => {
      if (!id) return undefined
      const node = displayMap.get(id)
      return (node?.urn as string | undefined) ?? id
    }
    const sourceUrn = resolveUrn(edgeForDrill.source ?? edgeForDrill.sourceUrn)
    const targetUrn = resolveUrn(edgeForDrill.target ?? edgeForDrill.targetUrn)
    if (!sourceUrn || !targetUrn) return

    const currentLevel = trace.result?.effectiveLevel ?? 0
    const expanded = await trace.expandAggregatedEdge(sourceUrn, targetUrn, currentLevel)
    if (expanded) mergeDrilldownIntoCanvas(expanded)
  }, [trace, edges, visibleLineageEdges, displayMap, expandedNodes, toggleNode, mergeDrilldownIntoCanvas])

  // Background click handler to clear selection/highlight
  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    // Skip if clicking on an interactive element (tree items, edges, search boxes, etc.)
    if ((e.target as HTMLElement).closest('[data-canvas-interactive]')) return
    clearSelection()
  }, [clearSelection])

  // Build Mode's target layer for this session — same 3-tier resolution as
  // the rail's onEntityStaged: the creation layer → else the root parent's
  // layer → else the first layer. Fixed for the whole batch (Build's
  // parentUrn/layerId don't change mid-Apply, unlike the rail's per-row live
  // retarget). Passed to BuildPanel's placement hint and used by onRowStaged
  // below to write both the canonical view-config entry and the optimistic
  // session assignEntityToLayer.
  const buildLayerId = builderLayerId
    ?? (builderParentUrn ? nodeLayerMap.get(builderParentUrn) : undefined)
    ?? sortedLayers[0]?.id
  // Auto-by-type placement: each Build row lands in the column configured for
  // ITS type (falling back to buildLayerId). Derived from the view's own layer
  // config — ontology-agnostic.
  const buildTypeLayerMapMemo = useMemo(() => buildTypeLayerMap(sortedLayers), [sortedLayers])

  return (
    <div
      data-trace-active={traceActive ? 'true' : 'false'}
      className={cn("h-full w-full flex flex-col overflow-hidden bg-gradient-to-br from-canvas via-canvas to-canvas-elevated/30", className)}
    >
      {/* Row layout: [left rail SearchMapPanel] + canvas column + [right-rail panels].
          When a panel opens it joins the row as a flex sibling so the entire
          canvas (header + body) shrinks horizontally rather than being
          overlaid.

          Left rail: Advanced Search (independent slot — coexists with any
          right-rail panel, so the user can keep refining their query while
          inspecting a hit in the entity drawer).
          Right rail: mutually exclusive — selection > edge-panel > creation. */}
      <div className="flex-1 flex flex-row min-h-0 overflow-hidden">
      {/* SearchMapPanel is internally AnimatePresence-gated on `open` —
          wrapping it in another AnimatePresence + conditional double-gates
          the exit (the unmount races the inner exit animation and can
          strand it). Render persistently; it owns its own presence. */}
      <SearchMapPanel
        open={advancedSearchOpen}
        onClose={() => setAdvancedSearchOpen(false)}
        viewId={activeView?.id ?? ''}
        onRevealNode={revealSearchHit}
        onFrameMatches={handleFrameMatches}
      />
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden relative">
      <ContextViewHeader
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchResults={searchResults}
        onSearchResultClick={(node) => {
          selectNode(node.id)
          // Tracing: the overlay owns expansion (and the hit may be nested
          // inside a closed card, so open the way to it too). Mid-walk there
          // is no overlay yet and browse expansion is not restored on exit,
          // so leave it alone.
          if (traceWriteLocked()) {
            if (overlay.active) {
              expandTraceChain(node.id)
              overlay.expandPath([node.id])
            }
            return
          }
          setExpandedNodes((prev) => new Set([...prev, node.id]))
        }}
        showLineageFlow={showLineageFlow}
        onToggleLineageFlow={() => setShowLineageFlow(!showLineageFlow)}
        showEdgeDirection={showEdgeDirection}
        onToggleEdgeDirection={() => setShowEdgeDirection(v => !v)}
        lineageRenderMode={lineageRenderMode}
        onSetLineageRenderMode={setLineageRenderMode}
        traceActive={traceActive}
        canTrace={selectedNodeIds.length === 1 && !selectedNodeIds[0].startsWith('logical:')}
        onStartTrace={() => { if (selectedNodeIds[0]) startCanvasTrace(selectedNodeIds[0]) }}
        onExitTrace={exitCanvasTrace}
        lineageReady={hydrationPhase === 'complete'}
        traceUpstreamDepth={traceDepthUp}
        traceDownstreamDepth={traceDepthDown}
        traceHistory={headerTraceHistory}
        onResumeTraceHistory={resumeTraceHistory}
        onClearTraceHistory={clearTraceHistory}
        onCopyTraceHistoryLink={traceHistoryLink}
        onOpenLens={() => { if (selectedNodeIds[0]) openLens(selectedNodeIds[0]) }}
        onSetTraceDepth={(dir, value) => {
          // A VIEW limit on the already-walked flow — applies instantly,
          // no refetch (the walk holds the whole flow in memory).
          if (dir === 'upstream') setTraceDepthUp(value)
          else setTraceDepthDown(value)
          recordTraceView(dir === 'upstream' ? { depthUp: value } : { depthDown: value })
        }}
        onOpenAdvancedSearch={(seedQuery) => {
          // Toggle the panel. When the user escalates from the
          // quick search (passes a seed string), force-open the
          // panel + clear the quick-search input (so the no-match
          // escalation card disappears) + stash the typed query as
          // a one-shot ``pendingSearchSeed`` (W2.7) so the empty
          // hero's "Type to search by name across this view…"
          // input opens pre-filled with the user's text. The hero
          // consumes + clears the seed on mount.
          if (seedQuery && seedQuery.trim()) {
            const trimmed = seedQuery.trim()
            setSearchQuery('')
            useSearchStore.getState().setPendingSearchSeed(trimmed)
            setAdvancedSearchOpen(true)
            return
          }
          // Plain toggle — the search panel lives on the LEFT rail,
          // so it coexists with selection / edge-panel / creation on
          // the right.
          setAdvancedSearchOpen((open) => !open)
        }}
        onTogglePropertyManager={() => setPropertyManagerOpen((open) => !open)}
        propertyManagerOpen={propertyManagerOpen}
        viewName={activeView?.name}
        entityTypeCount={activeView?.content.visibleEntityTypes.length}
        activeContextModelName={null}
        canEditView={canEditView}
        canShareView={canShareView}
        viewVisibility={viewVisibility}
        onRenameView={handleRenameView}
        onEditViewDetails={handleEditViewDetails}
        onShareView={() => void handleShareView()}
        syncStatus={layoutSyncStatus}
        onRetrySync={() => { void flushLayoutSave() }}
        isDraft={isDraft}
        canManage={canManage}
        canEnterEdit={canEnterEdit}
        onEnterEdit={handleEnterEdit}
        onExitEdit={handleExitEdit}
        pendingChangeCount={stagedChangeList.length}
        onOpenStagedChanges={openStagedChangesPanel}
        onImport={() => setShowImportDialog(true)}
        onExport={() => setShowExportDialog(true)}
        canUndo={stagedChangeList.length > 0}
        canRedo={stagedRedoStack.length > 0}
        onUndo={undoStagedChange}
        onRedo={redoStagedChange}
        canvasZoom={canvasZoom}
        onSetCanvasZoom={setCanvasZoom}
        onFitToWidth={handleFitToWidth}
        canvasDensity={canvasDensity}
        onSetCanvasDensity={setCanvasDensity}
        showCanvasTypeBadge={showCanvasTypeBadge}
        onToggleCanvasTypeBadge={toggleCanvasTypeBadge}
        subtleCanvasTreeLines={subtleCanvasTreeLines}
        onToggleSubtleCanvasTreeLines={toggleSubtleCanvasTreeLines}
        onResetCanvasDisplaySettings={resetCanvasDisplaySettings}
      />

      <div data-canvas-body className="flex-1 w-full h-full relative overflow-hidden bg-canvas flex flex-col">
        {/* Trace UI lives in TraceBottomDock at the bottom of canvas-body.
            EntityDrawer keeps the right rail. Both surfaces are independent.
            NO AnimatePresence: the dock has no exit animation to wait for
            (see TraceBottomDock), so wrapping it would only keep it mounted
            after the trace ends. It unmounts with `traceActive`. */}
        {traceActive && (
            <TraceBottomDock
              trace={dockTrace}
              displayMap={displayMap}
              availableEdgeTypes={lineageEdgeTypes}
              granularityOptions={granularityOptions}
              resolveEdgeColor={resolveEdgeColor}
              expanded={dockExpanded}
              onToggleExpanded={() => setDockExpanded(v => !v)}
              onExit={exitCanvasTrace}
              onJumpToUrn={(urn) => {
                const id = urnToIdMap.get(urn) ?? urn
                startCanvasTrace(id)
              }}
              onHistoryBack={traceBack}
              onHistoryForward={traceForward}
              canHistoryBack={traceHistory.cursor > 0}
              canHistoryForward={traceHistory.cursor < traceHistory.entries.length - 1}
              nativeMode={traceActive}
              share={traceShare}
              focusLabel={tracedLabel ?? undefined}
              outsideView={overlay.view?.outsideView ?? 0}
            />
        )}

        {/* THE CAPSULE — the board narrates while the trace computes (D4).
            Visible from the FIRST click: the session opens instantly but the
            overlay only draws once the model holds the focus, and the walk
            then runs hands-free for as long as the flow is wide. Pointer
            events only on its own buttons (the board underneath stays
            interactive), and — like the dock — no AnimatePresence: it
            unmounts with the trace. Keyed on the focus so a new trace
            re-arms the finished beat. */}
        {traceActive && canvasTrace.progress && (
          <TraceWalkIndicator
            key={tracedNodeId ?? ''}
            phase={canvasTrace.progress.phase}
            nodes={canvasTrace.progress.nodes}
            flows={canvasTrace.progress.flows}
            requests={canvasTrace.progress.requests}
            pending={canvasTrace.progress.pending}
            error={canvasTrace.progress.error}
            upCount={overlay.view?.counts.up ?? 0}
            downCount={overlay.view?.counts.down ?? 0}
            onCancel={exitCanvasTrace}
            onContinue={canvasTrace.continuePastCheckpoint}
            onRetry={canvasTrace.retryWalk}
          />
        )}


        {/* Aggregation truncation banner — backend signal that the visible
            edge set was capped. The "computing" and "last computed Xh ago"
            banners were removed: the materialization-triggered flag was
            sticky after first paint and the staleness banner fired even
            for fresh aggregations. Trust the data already on canvas. */}
        {(aggregationTruncated || edgesTruncated) && (
          <div
            data-canvas-interactive
            className="mx-4 mt-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/40 text-amber-700 text-xs flex items-center gap-2 z-20"
          >
            <span className="font-medium">Showing the largest connections — narrow the selection to see more.</span>
          </div>
        )}
        {/* Stale-source banner — a source-data change queued/ran a rebuild; the
            canvas keeps serving the previous rollup (stale-while-revalidate)
            and self-clears when the rebuild's epoch flip triggers a refetch. */}
        {aggregationStaleReason === 'source_changed' && (
          <div
            data-canvas-interactive
            className="mx-4 mt-2 px-3 py-2 rounded-md bg-blue-500/10 border border-blue-500/40 text-blue-700 text-xs flex items-center gap-2 z-20"
          >
            <span className="font-medium">Source data changed — lineage is being recomputed. Showing the previous rollup.</span>
          </div>
        )}
        {/* Edge-fetch integrity banner — an edge query failed and was
            swallowed to keep nodes rendering; the canvas may be missing
            connections. Retry re-hydrates and refetches aggregated edges. */}
        {(edgeFetchFailures > 0 || aggregationError) && (
          <div
            data-canvas-interactive
            className="mx-4 mt-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/40 text-amber-700 text-xs flex items-center gap-2 z-20"
          >
            <span className="font-medium">Some connections could not be loaded — the canvas may be incomplete.</span>
            <button
              className="ml-auto px-2 py-0.5 rounded-md border border-amber-500/40 font-semibold hover:bg-amber-500/10 transition-colors"
              onClick={() => {
                clearEdgeFetchFailures()
                invalidateAggregatedEdges()
                retryHydration()
              }}
            >
              Retry
            </button>
          </div>
        )}
        {/* Warning: missing ontology configuration */}
        {schema && containmentEdgeTypes.length === 0 && edges.length > 0 && (
          <div className="mx-4 mt-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs flex items-center gap-2 z-20">
            <span className="font-medium">No containment types configured.</span>
            <span className="text-amber-600 dark:text-amber-500">Hierarchy is disabled — all nodes appear flat. Configure your ontology to enable parent-child nesting.</span>
          </div>
        )}
        {/* Warning: containment inheritance violation attempt */}
        {assignmentWarning && (
          <div className="mx-4 mt-2 px-3 py-2 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-xs flex items-center gap-2 z-20">
            <span className="font-medium">Assignment blocked.</span>
            <span className="text-red-600 dark:text-red-500">{assignmentWarning}</span>
            <button
              className="ml-auto text-red-400 hover:text-red-600 dark:hover:text-red-300"
              onClick={() => setAssignmentWarning(null)}
            >
              &times;
            </button>
          </div>
        )}
        {/* Bulk import — uploads a file onto the current draft (server-side), then
             hands off to the Changes tab where the added/updated/deleted entities are
             reviewed and published just like manual edits. */}
        {showImportDialog && graphId && scopeWsId && (
          <ImportDialog
            wsId={scopeWsId}
            graphId={graphId}
            branchId={useBranchStore.getState().currentBranchId ?? undefined}
            viewId={activeView?.id}
            onClose={() => { setShowImportDialog(false); refreshAfterImport() }}
            onReviewChanges={() => {
              setShowImportDialog(false)
              useVersioningPanelStore.getState().openPanel('changes')
              refreshAfterImport()
            }}
            onImported={() => {
              // The import committed to the draft server-side. DON'T refresh the canvas now — that
              // would re-hydrate behind the open dialog and unmount its preview. Just remember an
              // import happened; refreshAfterImport() runs when the user closes / reviews.
              importedRef.current = true
            }}
          />
        )}
        {showExportDialog && graphId && scopeWsId && (
          <ExportDialog
            wsId={scopeWsId}
            graphId={graphId}
            viewId={activeView?.id}
            branchId={useBranchStore.getState().isDraftMode()
              ? (useBranchStore.getState().currentBranchId ?? undefined) : undefined}
            onClose={() => setShowExportDialog(false)}
          />
        )}
        {/* Start editing — the deliberate branch chooser that replaces the silent draft resume/create. */}
        {showStartEditing && graphId && scopeWsId && (
          <StartEditingDialog
            wsId={scopeWsId}
            graphId={graphId}
            viewId={activeView?.id ?? null}
            onClose={() => setShowStartEditing(false)}
          />
        )}
        {/* Save Confirmation Modal — opens when the user clicks Save Blueprint
             or the pending-changes badge. Single source of truth for reviewing
             and confirming a batch of staged edits before they hit the backend. */}
        <StagedChangesPanel onConfirm={async () => {
          if (!scopeWsId) return
          // Draft mode: persist EVERY change type — creates, edges, updates/deletes, and layer
          // moves — to the draft branch as ONE atomic, server-merged /graph/changes commit. One
          // Review & Save is exactly one commit (the backend mints urns + resolves temp refs).
          const bs = useBranchStore.getState()
          if (bs.currentBranchId && bs.graphId && bs.dataSourceId) {
            try {
              await saveStagedChangesToDraft(stagedChangeList, {
                wsId: bs.workspaceId ?? scopeWsId,
                dataSourceId: bs.dataSourceId,
                branchId: bs.currentBranchId,
                provider,
                // Re-key each new entity's layer assignment temp→real as its create resolves,
                // so a node created in a layer keeps its layer column after Save — and survives
                // any later create/commit failure without flashing out of the view. Re-keys BOTH
                // the canonical view-config entry (assignEntities/onEntityStaged wrote it at
                // create time, keyed by the temp urn) and the session store mirror.
                remapEntityId: (oldId, newId) => {
                  remapEntityId(oldId, newId)
                  persistReferenceLayout(assignmentOps.remapAssignmentUrn(currentLayout(), oldId, newId))
                },
                // After the remaps, drop any placement still keyed by a temp urn — a create that was
                // staged (writing its placement) then discarded before this Save (see assignmentMutations).
                pruneTempAssignments: () => {
                  persistReferenceLayout(assignmentOps.pruneTempAssignments(currentLayout()))
                },
                message: `Canvas edits (${stagedChangeList.length})`,
              })
              // Clear staged changes WITHOUT running discard hooks (keep the optimistic canvas).
              useStagedChangesStore.setState({ changes: [], redoStack: [], applyStatus: 'idle', lastApplyResult: null })
              // A save creates a new draft commit that every versioning surface must reflect — the
              // cumulative branch diff (Changes tab), the commit log (Commits tab), and per-entity
              // history. Invalidate the whole versioning namespace so saved changes appear at once
              // (a save is user-initiated and infrequent, so the broad refetch is fine).
              queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.all })
              await flushLayoutSave()   // durably persist the view's referenceLayout (layers + assignments)
              closeStagedChangesPanel()
              showToast('success', 'Saved to draft.')
            } catch (e) {
              showToast('error', (e as Error).message)
            }
            return
          }
          // Main mode: legacy per-change apply.
          const result = stagedChangeList.length > 0
            ? await applyStagedChanges(provider, scopeWsId)
            : { ok: 0, failed: 0 }
          if (result.failed === 0) {
            await flushLayoutSave()
            closeStagedChangesPanel()
          }
        }} />

        {/* Edge Legend — sits at the bottom-right of the (possibly shrunken)
            canvas. Right-rail panels are now flex siblings, so the canvas
            itself shrinks when one opens — the legend doesn't need its own
            offset logic. Lifts above TraceBottomDock via --trace-dock-height. */}
        <div
          className="absolute z-30 w-64 pointer-events-auto transition-all duration-300 ease-out"
          style={{
            bottom: 'calc(160px + var(--trace-dock-height, 0px))',
            right: '1rem',
          }}
        >
          <EdgeLegend defaultExpanded={false} visibleEdges={effectiveLineageEdges} />
        </div>

        {/* Status chips — loaded-but-hidden data (unresolved edges,
            unassigned entities, truncated aggregated detail). The canvas
            never hides lineage silently. */}
        <CanvasStatusChips
          rootsLoaded={rootsLoaded}
          rootsHaveMore={rootsHaveMore}
          onLoadMoreRoots={loadMoreRootsGuarded}
          // During a trace the external-scope chip speaks browse-view
          // language that contradicts the trace picture (and its counts
          // live in the trace dock) — suppressed until exit.
          selectedExternal={traceActive ? null : selectedExternalLineage}
          onPreviewExternal={externalLineagePreview ? () => { void handlePreviewExternal() } : undefined}
          // The chip counts BROWSE connections the canvas could not place. A
          // drawing trace has none to report (see the projection call site);
          // during the walk the browse picture — and its count — still stand.
          unresolvedEdgeCount={!overlay.active && showMissingConnectionIndicators ? unresolvedEdgeCount : 0}
          unassignedEntities={unassignedEntities}
          onOpenEntity={openNodeDrawer}
          aggDetailShown={aggDetailStatus.shown}
          aggDetailTotal={aggDetailStatus.total}
          onLoadMoreDetail={handleLoadMoreAggDetail}
          viewScope={activeEntityScope}
          adaptiveShown={edgePresentation.ambientShown}
          adaptiveTotal={edgePresentation.ambientTotal}
          onShowAllEdges={() => setLineageRenderMode('raw')}
          focusShown={edgePresentation.focusShown}
          focusTotal={edgePresentation.focusTotal}
          onOpenFocusLens={() => {
            const target = selectedNodeId ?? hoveredNodeId ?? drawerNodeId
            if (target) openLens(target)
          }}
        />

        {/* Frame pill — selection has off-screen neighbors; offer to frame
            them (never auto-scroll) or open the lens. */}
        <AnimatePresence>
          {framePill && (
            <motion.div
              key={`frame-pill-${framePill.nodeId}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
              className="absolute left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3 py-1.5 rounded-full backdrop-blur-md border border-white/10 shadow-lg bg-canvas-elevated/90 text-[11px] text-ink-muted pointer-events-auto"
              style={{ bottom: 'calc(3.25rem + var(--trace-dock-height, 0px))' }}
              data-canvas-interactive
            >
              <span className="tabular-nums font-medium text-ink">{framePill.offCount}</span>
              <span>connection{framePill.offCount === 1 ? '' : 's'} off-screen</span>
              <button
                type="button"
                className="px-2 py-0.5 rounded-full font-semibold text-accent-lineage hover:bg-accent-lineage/10 transition-colors"
                onClick={() => {
                  setFramedContext({ nodeId: framePill.nodeId, count: framePill.neighborIds.length })
                  void locateManyOnCanvas(framePill.neighborIds)
                  setFramePill(null)
                }}
              >
                Frame
              </button>
              <button
                type="button"
                className="px-2 py-0.5 rounded-full font-semibold text-accent-lineage hover:bg-accent-lineage/10 transition-colors"
                onClick={() => { openLens(framePill.nodeId); setFramePill(null) }}
              >
                Open lens
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Framed-mode chrome — persistent while the framed selection is
            active. Names the state, provides the explicit exit the offer
            pill (above) morphs into, and teaches the Esc shortcut. Same
            bottom-center slot as the offer for spatial continuity. */}
        <AnimatePresence>
          {framedContext && selectedNodeId === framedContext.nodeId && (
            <motion.div
              key="framed-chrome"
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.18 }}
              className="absolute left-1/2 -translate-x-1/2 z-40 flex items-center gap-2.5 pl-3 pr-1.5 py-1.5 rounded-full backdrop-blur-md border border-accent-lineage/25 shadow-lg shadow-accent-lineage/10 bg-canvas-elevated/95 text-[11px] text-ink-muted pointer-events-auto"
              style={{ bottom: 'calc(3.25rem + var(--trace-dock-height, 0px))' }}
              data-canvas-interactive
            >
              <Crosshair className="w-3.5 h-3.5 flex-shrink-0 text-accent-lineage" />
              <span className="min-w-0 max-w-[280px] truncate">
                Framing{' '}
                <span className="font-semibold text-ink">
                  {nodeMap.get(framedContext.nodeId)?.data.label ?? framedContext.nodeId}
                </span>
                {' '}· <span className="tabular-nums">{framedContext.count}</span>{' '}
                connection{framedContext.count === 1 ? '' : 's'}
              </span>
              <kbd className="flex-shrink-0 px-1.5 py-0.5 rounded-md border border-white/10 bg-white/[0.04] text-[9.5px] font-semibold uppercase tracking-wide text-ink-muted/70">
                Esc
              </kbd>
              <button
                type="button"
                onClick={exitFrame}
                className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-full font-semibold bg-accent-lineage/15 text-accent-lineage hover:bg-accent-lineage/25 active:scale-95 transition-all"
              >
                <X className="w-3 h-3" />
                Exit frame
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Layer Strip — docked horizontal navigator: you-are-here chips
            per layer, click-to-jump, add-layer (draft) and Fit. Frame-
            anchored (never in scroll content). */}
        {/* Hidden while tracing: the trace dock owns the bottom, and
            layer navigation is what the trace filter already did. */}
        {!traceActive && (
          <LayerStrip
            layers={stripLayers}
            scrollRef={horizontalScrollRef}
            // "+" routes to the existing AddLayerColumn at the canvas end —
            // one deliberate creation flow (name input there), not a
            // second create path.
            onAddLayer={isDraft ? () => {
              const el = horizontalScrollRef.current
              el?.scrollTo({ left: el.scrollWidth, behavior: 'smooth' })
            } : undefined}
            onFit={handleFitToWidth}
          />
        )}

        {/* Lineage Lens — ego-graph overlay (portal to body). */}
        <LineageLens
          history={lensHistory}
          walk={lensWalkEntry}
          walkApi={lensWalkApi}
          walkSeed={lensWalkSeed}
          childrenAll={lensChildren.allResults}
          childrenAllStatus={lensChildren.allStatus}
          onLoadChildrenOf={loadLensChildrenOf}
          onLoadAllChildren={loadLensAllChildren}
          externalPreview={externalPreview && lensFocalOf(lensHistory) === externalPreview.nodeId ? externalPreview : null}
          onRecenter={lensRecenter}
          onBack={lensBack}
          onForward={lensForward}
          onJumpTo={lensJumpTo}
          onShowPathOnCanvas={(ids) => {
            // Presenting a walk IS a frame action — same chrome, same exit.
            const focal = ids[ids.length - 1]
            if (focal) {
              const { selectedNodeIds, selectNode } = useCanvasStore.getState()
              if (!(selectedNodeIds.length === 1 && selectedNodeIds[0] === focal)) selectNode(focal)
              setFramedContext({ nodeId: focal, count: ids.length - 1 })
            }
            void locateManyOnCanvas(ids)
          }}
          onClose={lensClose}
          onRevealOnCanvas={revealOnCanvas}
          onOpenDetails={openNodeDrawer}
          onLocateAll={(ids) => {
            // "Reveal all on canvas" IS a frame action — land the user in
            // the same framed-mode chrome as the Frame pill so the state
            // is named and has an explicit exit. Select the focal node so
            // the canvas focus matches what the lens was showing (guarded:
            // selectNode toggles OFF when re-selecting the current
            // selection).
            const focal = lensFocalOf(lensHistory)
            if (focal) {
              const { selectedNodeIds, selectNode } = useCanvasStore.getState()
              if (!(selectedNodeIds.length === 1 && selectedNodeIds[0] === focal)) selectNode(focal)
              setFramedContext({ nodeId: focal, count: ids.length })
            }
            void locateManyOnCanvas(ids)
          }}
          fullWalkEnabled={lensFullWalk}
          walkProgress={lensFocal ? lensWalk.walkProgressFor(lensFocal) : null}
          labelHintFor={lensLabelHintFor}
          onFullWalkToggle={setLensFullWalk}
          onWalkContinue={() => { if (lensFocal) lensWalk.continuePastCheckpoint(lensFocal) }}
          onWalkRetry={() => { if (lensFocal) lensWalk.retryWalk(lensFocal) }}
        />

        {/* Blank (hand-built) model guidance — the full-canvas hero on a truly
            empty model, and the first-steps companion while building. Both are
            scoped to kind === 'blank' so every other view is untouched.
            Gated on hydrationStatus === 'ready': the "Start building" hero shows
            ONLY after a load actually SUCCEEDED and returned zero nodes — never
            while loading, warming, or unavailable (those show the overlay), so a
            failed/slow load can't masquerade as an empty model. */}
        {isBlankModel && hydrationStatus === 'ready' && nodes.length === 0 && (
          <BlankCanvasEmptyState
            modelName={activeView?.name ?? null}
            isDraft={isDraft}
            canManage={canManage}
            onAddEntity={() => {
              useHierarchyBuilderStore.getState().open({ layerId: sortedLayers[0]?.id })
            }}
            onStartBuilding={() => { void ensureDraftOpen() }}
          />
        )}
        {isBlankModel && isDraft && graphId && (
          <FirstStepsChecklist graphId={graphId} mainHeadSeq={mainHeadSeq} />
        )}


        {/* Layer Columns. */}
        <div
          ref={horizontalScrollRef}
          className="flex-1 overflow-auto relative scroll-smooth"
          onClick={handleBackgroundClick}
          style={{ paddingBottom: 'var(--trace-dock-height, 0px)' }}
        >
          {/* Lineage Flow Overlay - Render BEFORE columns to be behind them
              (z-index managed in component to 0, cols should be higher).
              Flow is the master switch — Trace mode respects it so the user
              can dial back ambient edge noise while keeping trace highlights
              on the nodes and trace panels open. */}
          {showLineageFlow && (
            <LineageFlowOverlay
              nodes={renderFlat}
              edges={effectiveLineageEdges}
              expandedNodes={expandedForRender}
              selectEdge={selectEdge}
              isEdgePanelOpen={isEdgePanelOpen}
              toggleEdgePanel={toggleEdgePanel}
              triggerRedrawRef={triggerEdgeRedrawRef}
              isTracing={overlay.active}
              traceResult={overlay.active ? nativeTraceResult : trace.result}
              highlightedEdges={mergedHighlightEdges}
              isHighlightActive={isHighlightActive}
              resolveEdgeColor={resolveEdgeColor}
              onEdgeDoubleClick={handleEdgeDoubleClick}
              showDirection={showEdgeDirection}
              expandingEdgeIds={expandingEdgeIds}
              geometryRegistry={columnGeometryRegistry}
              onRevealNode={scrollHitIntoView}
              flowRibbons={flowRibbons}
              focusNodeId={railFocusId}
              onAnchorProxies={handleAnchorProxies}
            />
          )}

          {/* In-progress edge while dragging a connection (shares the overlay
              coordinate space — absolute sibling inside the scroll container). */}
          <ConnectionDragLayer
            sourceId={edgeConnect.state.mode === 'dragging' ? edgeConnect.state.sourceId : null}
            pointer={edgeConnect.state.pointer}
          />

          {/* Ghost-edge overlay — dashed pulsing connectors between ghost
              cards in adjacent layers during initial hydration. Anchored
              to the actual ghost-card DOM rects (via [data-canvas-ghost]),
              so the lines land in the same vertical band where real edges
              will appear once hydration completes. Unmounts the moment any
              real node arrives (isHydratingInitial flips false). */}
          <AnimatePresence>
            {isHydratingInitial && (
              <motion.div
                key="ghost-lineage-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="absolute inset-0 pointer-events-none"
                style={{ zIndex: 1 }}
              >
                <GhostLineageOverlay layers={sortedLayers} containerRef={horizontalScrollRef} />
              </motion.div>
            )}
          </AnimatePresence>


          {/*
            z-30 + pointer-events-none on the columns wrapper:
            - z-30 puts the columns ABOVE the hit-test layer (z-20 in
              LineageFlowOverlay), so node cards win pointer events when the
              cursor is over them — even when an edge stroke passes
              geometrically over the same pixel.
            - pointer-events-none on the wrapper itself means the wrapper
              doesn't capture clicks in the inter-column gaps; events fall
              through to the hit layer below for edge interaction. The child
              LayerColumn / FlatTreeItem elements default to pointer-events:
              auto and continue to receive their own hover/click events.
          */}
          {/* Left/right gutters inside the scroll content so edges that bow
              into the leftmost column or leave the rightmost column aren't
              clipped by the overflow-auto scroll container. The width is
              derived from LineageFlowOverlay's same-column lane math
              (EXTREMITY_EDGE_GUTTER_PX) so the two stay in sync. The overlay
              SVG spans the full viewport, so insetting the columns keeps
              those curves within the visible box at the scroll extremes. */}
          <div
            className="flex h-full min-h-0 relative z-30 gap-12 pointer-events-none"
            style={{
              paddingLeft: EXTREMITY_EDGE_GUTTER_PX,
              paddingRight: EXTREMITY_EDGE_GUTTER_PX,
              // Canvas zoom — CSS `zoom` (NOT transform: scale). zoom is a
              // LAYOUT-affecting scale: the wrapper's 100/zoom% size lays
              // out back to exactly 100% of the scroll container, so the
              // scrollable area always equals the visible content. A
              // transform here left a 100/zoom% layout-sized ghost scroll
              // region (transforms never affect layout), letting users
              // scroll far past the canvas into emptiness — and wheel
              // scrolls chained into that ghost area instead of the
              // columns' internal lists.
              //
              // --canvas-hsb: measured height of the container's CLASSIC
              // horizontal scrollbar (0 for macOS overlay scrollbars).
              // Percentage heights resolve against a box that ignores
              // the scrollbar, so a plain 100% overflows the visible
              // area by the scrollbar height — clipping the columns'
              // bottom edge (and the bottom periphery scrims) below the
              // fold. Subtracting the measured gutter makes the column
              // bottom land exactly at the visible edge at every zoom.
              zoom: canvasZoom !== 1 ? canvasZoom : undefined,
              width: canvasZoom !== 1 ? `${100 / canvasZoom}%` : undefined,
              height: `calc((100% - var(--canvas-hsb, 0px)) / ${canvasZoom})`,
            }}
          >
            {sortedLayers.map((layer) => (
              <LayerColumn
                key={layer.id}
                layer={layer}
                nodes={renderByLayer.get(layer.id) ?? []}
                schema={schema}
                // An empty column means something different in each: in a Context View the
                // entities exist and just aren't assigned here; in a blank model nothing has
                // been created at all. The column says whichever is true.
                isBlankModel={isBlankModel}
                selectedNodeId={selectedNodeId}
                expandedNodes={expandedForRender}
                searchResults={matchedNodeIds}
                onSelect={selectNode}
                onToggle={toggleNode}
                onContextMenu={handleContextMenu}
                onDoubleClick={handleDoubleClick}
                // Create affordances render only in draft (edit) mode —
                // Published shows zero mutation entry points for anyone.
                onAddChild={canvasWritable ? handleAddChildEntity : undefined}
                onAddToLayer={canEditGraph ? openBuilderForLayer : undefined}
                onBuildToLayer={canEditGraph ? openBuildForLayer : undefined}
                onBeginConnect={canvasWritable ? edgeConnect.beginDrag : undefined}
                onLayerContextMenu={handleLayerContextMenuOpen}
                traceFocusId={traceActive && canvasTrace.tracedUrn
                  ? (urnToIdMap.get(canvasTrace.tracedUrn) ?? canvasTrace.tracedUrn)
                  : trace.focusId}
                traceNodes={trace.visibleTraceNodes}
                traceContextSet={traceContextSet}
                isTracing={overlay.active}
                highlightedNodes={mergedHighlightNodes}
                isHighlightActive={isHighlightActive}
                isHoverHighlight={isHoverActive && !isClickHighlightActive}
                onAnimationComplete={handleAnimationComplete}
                onLoadMore={loadMoreChildren}
                onSearchChildren={searchChildrenGuarded}
                isLoadingChildren={isLoadingChildren}
                loadingNodes={loadingNodes}
                failedNodes={failedNodes}
                onScroll={handleLayerScroll}
                onAssignToLayer={handleAssignToLayer}
                // Draft-only layer management (create lives in AddLayerColumn; these are per-column).
                onRenameLayer={isDraft ? renameLayer : undefined}
                onDeleteLayer={isDraft ? deleteLayer : undefined}
                onReorderLayer={isDraft ? reorderLayer : undefined}
                // Node sorting — the menu is available to everyone (viewers get a
                // device-local override); persisted actions are draft-gated
                // inside; the whole surface sits behind the nodeSortingEnabled
                // kill switch (persisted orders still RENDER when it's off).
                sortMode={sortOverrides.get(layer.id) ?? layer.nodeSortMode ?? viewDefaultSortMode}
                sortIsOverride={sortOverrides.has(layer.id) || layer.nodeSortMode != null}
                viewDefaultSortMode={viewDefaultSortMode}
                canPersistSort={isDraft}
                onSetSortMode={nodeSortingEnabled ? handleSetLayerSortMode : undefined}
                onApplySortToView={nodeSortingEnabled ? handleApplySortToView : undefined}
                onResetCustomOrder={nodeSortingEnabled && layer.nodeSortMode === 'custom' ? handleResetCustomOrder : undefined}
                // Reorder bands are live in ANY draft column — a manual drag
                // auto-adopts custom order, so the user never has to switch
                // sort mode first. Off during trace (the tree is filtered there,
                // so neighbor keys wouldn't match what's shown).
                reorderEnabled={nodeSortingEnabled && isDraft && !traceActive}
                onReorderDrop={handleReorderNode}
                onReorderNudge={nudgeReorder}
                isHydratingInitial={isHydratingInitial}
                revealTarget={revealTarget}
                geometryRegistry={columnGeometryRegistry}
                overscan={effectiveOverscan}
                lineageCounts={nodeStubCounts}
                externalCue={externalCueByNode}
                showLineageIndicators={showLineageFlow}
                showDensityGutter={isStubsMode && showLineageFlow && lineageRenderMode === 'auto'}
                anchorProxies={anchorProxyGroups.get(layer.id)}
                onProxyReveal={scrollHitIntoView}
                onProxyMore={handleProxyMore}
                onEndReached={rootsHaveMore ? loadMoreRootsGuarded : undefined}
                onResizeLayer={isDraft ? resizeLayer : undefined}
              />
            ))}
            {/* Draft-only: create your own layers (columns) to organise nodes into. */}
            {isDraft && <AddLayerColumn onAdd={addLayer} />}
          </div>


        </div>
      </div>
      </div>{/* end canvas column */}

      {/* Right-rail panels — flex siblings of the canvas column.
          Mutual exclusion: selection > edge-panel > creation. Only one
          is mounted at a time. Advanced Search lives on the LEFT rail
          (see above) so it always coexists with whichever right-rail
          panel is active — clicking "Reveal" on a search hit selects
          a node and opens the entity drawer without losing the
          results list. */}
      <AnimatePresence>
        {/* Creation takes the rail when active (it's an explicit action), so it
            is never hidden behind a drawer the user happened to leave open. */}
        {builderOpen && (
          <HierarchyBuilderPanel
            key="hierarchy-builder-panel"
            onClose={() => useHierarchyBuilderStore.getState().close()}
            onEntityStaged={(tempUrn, parentUrn) => {
              // The layered view only renders nodes that resolve to a layer, so
              // a freshly-staged node is invisible until assigned. Assign it to
              // the creation layer → else the parent's layer → else the first
              // layer. Writes the canonical view-config entry (keyed by the temp
              // urn, remapped to the real urn on save) plus the optimistic
              // session assignment (an instanceAssignment wins even in
              // closed-scope views, before the canonical write's render lands).
              const layer = builderLayerId
                ?? (parentUrn ? nodeLayerMap.get(parentUrn) : undefined)
                ?? sortedLayers[0]?.id
              if (layer) {
                assignEntityToLayer(tempUrn, layer)
                persistReferenceLayout(assignmentOps.assignEntities(currentLayout(), [tempUrn], layer))
              }
              if (parentUrn) {
                setExpandedNodes(prev => new Set([...prev, parentUrn]))
              }
            }}
          />
        )}
        {buildOpen && (
          <BuildPanel
            key="build-panel"
            onClose={() => useHierarchyBuilderStore.getState().close()}
            layerId={buildLayerId}
            typeLayerMap={buildTypeLayerMapMemo}
            onRowStaged={(row, urn) => {
              // Auto-by-type per row: writes the canonical view-config entry
              // (keyed by the row's temp urn, remapped to its real urn on save)
              // plus the optimistic session assignment for immediate display.
              const layer = resolveRowLayer(row, { typeLayerMap: buildTypeLayerMapMemo, fallbackLayerId: buildLayerId })
              if (layer) {
                assignEntityToLayer(urn, layer)
                persistReferenceLayout(assignmentOps.assignEntities(currentLayout(), [urn], layer))
              }
            }}
          />
        )}
        {!builderOpen && !buildOpen && drawerNodeId && (
          <EntityDrawer
            key="entity-drawer"
            // Read-only for the whole trace window, like the canvas behind it.
            writesLocked={traceActive}
            resolveNode={resolveTraceNode}
            onFocusConnections={openLens}
            onTraceUp={(nodeId) => startCanvasTrace(nodeId, 'up')}
            onTraceDown={(nodeId) => startCanvasTrace(nodeId, 'down')}
            onFullTrace={(nodeId) => startCanvasTrace(nodeId, 'both')}
            onFocusNode={revealOnCanvas}
            onLocateMany={(ids) => { void locateManyOnCanvas(ids) }}
          />
        )}
        {!builderOpen && !buildOpen && !drawerNodeId && isEdgePanelOpen && (
          <EdgeDetailPanel
            key="edge-detail-panel"
            isOpen={isEdgePanelOpen}
            onClose={closeEdgePanel}
            edgeFilters={dynamicEdgeFilters}
            onToggleFilter={toggleEdgeFilter}
          />
        )}
      </AnimatePresence>
      {/* Property Manager — independent right-rail panel. Unlike the
          selection-driven panels above it isn't mutually exclusive: it
          sits to the right of whichever inspector is open so the user
          can author display rules while a node is selected. It is
          persistently mounted and internally AnimatePresence-gated on
          `open`, so it lives OUTSIDE the exit-managed block above —
          nesting a second presence context there can strand its exit. */}
      <PropertyManagerDrawer
        viewId={activeView?.id ?? ''}
        open={propertyManagerOpen}
        onClose={() => setPropertyManagerOpen(false)}
        knownEntityTypes={activeView?.content.visibleEntityTypes ?? []}
        knownLayers={storeLayers.map((l) => l.name)}
        onSearchPredicate={(p) => {
          useSearchStore.getState().requestSearchRun(p)
          setAdvancedSearchOpen(true)
        }}
      />
      </div>{/* end flex-row wrapper */}

      {/* === UX-FIRST INTERACTION COMPONENTS === */}

      {/* Modern Context Menu - Full CRUD operations. Every mutation affordance is draft-gated:
          Published is strictly read-only, so on it the menu offers only the read affordances
          (trace, copy URN, select all). */}
      <CanvasContextMenu
        isOpen={interactions.state.contextMenu.isOpen}
        position={interactions.state.contextMenu.position}
        target={interactions.state.contextMenu.target}
        onClose={interactions.closeContextMenu}
        onEditNode={canvasWritable ? interactions.editNode : undefined}
        onDuplicateNode={canvasWritable ? interactions.duplicateNode : undefined}
        onDeleteNode={canvasWritable ? interactions.deleteNode : undefined}
        onCreateChild={canvasWritable ? interactions.createChild : undefined}
        onConnect={canvasWritable ? (id) => armConnectGuarded(id) : undefined}
        onLinkNode={canvasWritable ? (id) => {
          const node = nodes.find(n => n.id === id || (n.data?.urn as string) === id)
          useCreateLinkStore.getState().open({
            sourceUrn: (node?.data?.urn as string) || id,
            anchor: interactions.state.contextMenu.position,
          })
        } : undefined}
        onTraceNode={(id) => startCanvasTrace(id)}
        onFocusConnections={openLens}
        onCopyUrn={interactions.copyUrn}
        onEditEdge={canEditGraph ? interactions.editEdge : undefined}
        onDeleteEdge={canEditGraph ? interactions.deleteEdge : undefined}
        onReverseEdge={canEditGraph ? interactions.reverseEdge : undefined}
        onCreateNode={canEditGraph ? (_pos, layerId) => {
          // Right-clicked an empty layer column → scope the new node to that
          // layer so it lands there (and is assigned on stage, see onEntityStaged).
          useHierarchyBuilderStore.getState().open({ layerId })
        } : undefined}
        onSelectAll={interactions.selectAll}
        layers={sortedLayers}
        onMoveToLayer={isDraft ? (nodeId, layerId) => moveToLayer(nodeId, layerId) : undefined}
        customActions={reorderMenuActions}
      />

      {/* Inline Node Editor - Double-click to edit names */}
      <InlineNodeEditor
        nodeId={interactions.state.inlineEdit.nodeId}
        value={interactions.state.inlineEdit.value}
        position={interactions.state.inlineEdit.position}
        onSave={interactions.saveInlineEdit}
        onCancel={interactions.cancelInlineEdit}
      />

      {/* Quick create now lives in the Hierarchy Builder right rail
          (opened via useHierarchyBuilderStore). */}

      {/* Command Palette - Press Cmd+K */}
      <CommandPalette
        isOpen={interactions.state.commandPalette.isOpen}
        onClose={interactions.closeCommandPalette}
        onCreateEntity={canEditGraph ? (typeId) => {
          interactions.closeCommandPalette()
          useHierarchyBuilderStore.getState().open({ initialTypeId: typeId })
        } : undefined}
        onSelectEntity={(entityId) => selectNode(entityId)}
      />

      {/* Edge-type picker — appears at the drop point once a connection
          resolves a (source, target). Offers only ontology-allowed raw
          lineage types (never AGGREGATED). */}
      {edgeConnect.state.mode === 'picking'
        && edgeConnect.state.sourceId
        && edgeConnect.state.targetId
        && edgeConnect.state.pickerPos && (
        <EdgeTypePickerPopover
          sourceId={edgeConnect.state.sourceId}
          targetId={edgeConnect.state.targetId}
          position={edgeConnect.state.pickerPos}
          onPick={edgeConnect.confirm}
          onCancel={edgeConnect.cancel}
        />
      )}

      {/* Click-based "Link to…" flow — the discoverable sibling of the drag
          connect above. Mounted once, outside the mutually-exclusive right-rail
          block so it floats over whatever panel is open. */}
      <CreateLinkPopover onCreateLink={(s, t, e) => interactions.stageEdgeCreate(s, t, e)} />

      {/* View-metadata dialogs (title menu). EditViewDetailsDialog is
          prop-driven; Share is reused unchanged from the Explorer, mounted
          while shareSeed holds its fetched identity + visibility. */}
      {activeView?.id && (
        <EditViewDetailsDialog
          open={viewDetailsOpen}
          viewId={activeView.id}
          onClose={() => setViewDetailsOpen(false)}
          onSaved={handleViewDetailsSaved}
        />
      )}
      {shareSeed && (
        <ShareViewDialog
          viewId={shareSeed.id}
          viewName={shareSeed.name}
          currentVisibility={shareSeed.visibility}
          workspaceId={scopeWsId ?? undefined}
          access={viewExecCtx?.access ?? null}
          isOpen={true}
          onClose={() => setShareSeed(null)}
        />
      )}
    </div>
  )
}
