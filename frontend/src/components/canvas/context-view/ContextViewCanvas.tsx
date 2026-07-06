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
import { useCanvasStore, useCanvasVersion, type LineageEdge } from '@/store/canvas'
import { useInstanceAssignments, useReferenceModelStore } from '@/store/referenceModelStore'
import { useWorkspacesStore } from '@/store/workspaces'
import { usePreferencesStore } from '@/store/preferences'
import { useQueryClient } from '@tanstack/react-query'
import { useBranchStore, useEffectiveBranchId, useGraphId } from '@/store/branchStore'
import { usePermission, useAuthStore } from '@/store/auth'
import { canvasScopeWorkspaceId } from '@/lib/canvasScope'
import { saveStagedChangesToDraft } from '@/features/versioning/model/saveStagedChangesToDraft'
import { VERSIONING_KEYS, useResolveGraph, useProjectionWatermark } from '@/features/versioning/hooks/useVersioning'
import { useGraphProvider } from '@/providers'
import type { TraceV2Result } from '@/providers/GraphDataProvider'
import { useGraphHydration } from '@/hooks/useGraphHydration'
import { useRevealNode } from '@/hooks/useRevealNode'
import { useRevealSearchHit } from '@/hooks/useRevealSearchHit'
import { useMatchUrnSet, useSearchStore } from '@/store/searchStore'
import { useAggregatedLineage } from '@/hooks/useAggregatedLineage'
import { EdgeDetailPanel, generateEdgeTypeFilters } from '../../panels/EdgeDetailPanel'
import { EntityDrawer } from '../../panels/EntityDrawer'
import { HierarchyBuilderPanel } from '../create/HierarchyBuilderPanel'
import { useHierarchyBuilderStore } from '../create/hierarchyBuilderStore'
import { BuildPanel } from '../create/buildmode/BuildPanel'
import { buildTypeLayerMap, resolveRowLayer } from '../create/buildmode/resolveRowLayer'
import { EdgeLegend } from '../EdgeLegend'

import { useUnifiedTrace } from '@/hooks/useUnifiedTrace'
import { useEdgeDetailPanel, useEdgeTypeFilters } from '@/hooks/useEdgeFilters'
import { getEdgeTypeDefinition } from '@/utils/edgeTypeUtils'

// UX-first interaction components
import { CanvasContextMenu } from '../CanvasContextMenu'
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

import type { ViewLayerConfig, LogicalNodeConfig } from '@/types/schema'

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
import { StartEditingDialog } from './StartEditingDialog'
import { AddLayerColumn } from './AddLayerColumn'
import * as layerOps from './layerMutations'
import { LineageFlowOverlay, EXTREMITY_EDGE_GUTTER_PX } from './LineageFlowOverlay'
import { GhostLineageOverlay } from './GhostLineageOverlay'
import { ContextViewHeader } from './ContextViewHeader'
import { EditViewDetailsDialog } from './EditViewDetailsDialog'
import { ShareViewDialog } from '@/components/views/ShareViewDialog'
import { getView, updateView } from '@/services/viewApiService'
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

// Re-export for backward compatibility
export { defaultReferenceModelLayers } from './constants'

export interface ContextViewCanvasProps {
  className?: string
  layers?: ViewLayerConfig[]
  showLineageFlow?: boolean
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
  const removeEdgesByNodeIds = useCanvasStore((s) => s.removeEdgesByNodeIds)
  const removeStoreEdges = useCanvasStore((s) => s.removeEdges)
  const removeStoreNodes = useCanvasStore((s) => s.removeNodes)
  const selectNode = useCanvasStore((s) => s.selectNode)
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  const selectedNodeId = selectedNodeIds[0] ?? null
  const drawerNodeId = useCanvasStore((s) => s.drawerNodeId)
  const closeNodeDrawer = useCanvasStore((s) => s.closeNodeDrawer)
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
    return true
  }, [trace, removeStoreEdges])

  // UX-first Canvas Interactions (context menu, inline edit, quick create, command palette)
  // Forward ref so the keyboard 'C' handler (wired into useCanvasInteractions
  // before useEdgeConnect exists) can arm connect-mode on the selected node.
  const edgeConnectRef = useRef<{ armConnect: (id: string) => void } | null>(null)

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
  } | null>(null)

  // Duplicate a node's whole subtree as freshly-staged copies. onNodeCopied
  // assigns EACH copy (root + every descendant) to its ORIGINAL's layer —
  // ContextView only renders nodes that resolve to a layer, so without
  // per-node assignment the descendant copies would vanish (don't rely on
  // containment inheritance; assign explicitly). Reuses the same layer
  // resolution the create flow's onEntityStaged uses.
  const { duplicateSubtree } = useDuplicateSubtree({
    onNodeCopied: (originalId, _originalUrn, copyUrn) => {
      const wiring = duplicateWiringRef.current
      if (!wiring) return
      const layer = wiring.nodeLayerMap.get(originalId) ?? wiring.sortedLayers[0]?.id
      if (layer) wiring.assignEntityToLayer(copyUrn, layer)
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
    purgeEdgesIncidentToUrns: purgeAggregatedEdgesIncidentToUrns,
  } = useAggregatedLineage({ granularity: null })

  // Instance-level assignments from store (user drag-and-drop)
  const instanceAssignments = useInstanceAssignments()
  const effectiveAssignments = useReferenceModelStore(s => s.effectiveAssignments)
  const computeAssignments = useReferenceModelStore(s => s.computeAssignments)
  const assignmentStatus = useReferenceModelStore(s => s.assignmentStatus)
  const setLayers = useReferenceModelStore(s => s.setLayers)
  const storeLayers = useReferenceModelStore(s => s.layers)
  const syncStatus = useReferenceModelStore(s => s.syncStatus)
  const activeContextModelName = useReferenceModelStore(s => s.activeContextModelName)
  const saveToBackend = useReferenceModelStore(s => s.saveToBackend)
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
  // Reconstruct committed-draft deletions as read-only rose "ghost" nodes (from the draft-vs-main
  // diff) so a deletion stays visible in red until merged — surviving refresh. Draft-only.
  useDeletionGhosts(isDraft)
  const canManage = usePermission('workspace:datasource:manage', scopeWsId ?? undefined)
  const graphId = useGraphId()
  const canEnterEdit = !!graphId
  // Blank (hand-built) models drive the guided empty state + first-steps
  // companion; react-query dedupes this against CanvasVersioningBar's resolve.
  const resolveQ = useResolveGraph(scopeWsId ?? undefined, dataSourceId)
  const isBlankModel = resolveQ.data?.kind === 'blank'
  const mainHeadSeq = resolveQ.data?.mainHeadCommitSeq ?? 0

  // View-level rights for the title menu — deliberately independent of the
  // canvas Edit cluster (view metadata is not graph data). Scoped to the
  // canvas workspace (scopeWsId) so they line up with the rest of the view
  // state. Both mirror the backend enforcers (see the header design spec):
  //   • edit details  = workspace:view:edit OR creator
  //   • manage sharing = workspace:admin (system:admin folds in) OR creator
  //     (view_grants.py::can_manage_view_grants)
  const currentUserId = useAuthStore(s => s.user?.id) ?? null
  const isViewCreator = !!activeView?.createdBy && activeView.createdBy === currentUserId
  const canEditView = usePermission('workspace:view:edit', scopeWsId ?? undefined) || isViewCreator
  const canShareView = usePermission('workspace:admin', scopeWsId ?? undefined) || isViewCreator

  // Keyboard shortcuts. Published is read-only, so its mutating shortcuts — Delete, ⌘D (duplicate),
  // and N (create) — are neutralised there with no-ops. A bare `undefined` on onDelete would fall
  // through to useCanvasKeyboard's built-in node-removal, so it must be an explicit no-op.
  // (The context-menu mutation entry points are draft-gated separately.)
  useCanvasKeyboard({
    enabled: true,
    handlers: isDraft
      ? interactions.keyboardHandlers
      : { ...interactions.keyboardHandlers, onDelete: () => {}, onDuplicate: () => {}, onCreate: () => {} },
  })

  // Blueprint autosync is ambient: display-rule / layer edits dirty the reference model, but there
  // is no Save button. Debounce-persist for managers so their changes survive a reload. saveToBackend
  // flips syncStatus off 'dirty' (→ saving/synced/error), so this can't loop. Viewers can't save, so
  // their edits stay session-local — firing here would only spam errors at people without permission.
  useEffect(() => {
    if (syncStatus !== 'dirty' || !canManage || !scopeWsId) return
    // saveToBackend re-throws on failure; that's already surfaced via syncStatus='error' + the
    // header's retry affordance, so swallow the rejection here to avoid unhandled-rejection noise.
    const t = setTimeout(() => { saveToBackend(scopeWsId).catch(() => {}) }, 1500)
    return () => clearTimeout(t)
  }, [syncStatus, canManage, scopeWsId, saveToBackend])

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

  // Step 2: Load assignments from backend when layers are synced and nodes are available
  // Uses a ref to track what we've computed for, preventing cascading re-fetches.
  const assignmentComputedRef = useRef<string | null>(null)

  // Reset the assignment guard when the active view changes so recomputation
  // always happens for the new view (even if layer IDs happen to match).
  useEffect(() => {
    assignmentComputedRef.current = null
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

    computeAssignments(provider)
  }, [nodes.length, provider, computeAssignments, assignmentStatus, storeLayers, activeView?.id])

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
    // Capture the previous layer for diff display before mutation.
    const prevAssignment = useReferenceModelStore.getState().effectiveAssignments.get(entityId)
    const prevLayerId = prevAssignment?.layerId
    const prevLayer = storeLayers.find(l => l.id === prevLayerId)
    const targetLayer = storeLayers.find(l => l.id === layerId)
    const entity = nodes.find(n => n.id === entityId || (n.data?.urn as string) === entityId)
    const entityName = (entity?.data?.label as string) ?? entityId
    // The node's own persisted layer BEFORE the move — restored on discard.
    const prevNodeLayer = entity?.data?.layerAssignment as string | undefined

    const result = assignEntityToLayer(entityId, layerId)
    if (!result.success && result.conflict?.type === 'containment_locked') {
      setAssignmentWarning(result.conflict.message)
      // Auto-dismiss after 5 seconds
      if (assignmentWarningTimer.current) clearTimeout(assignmentWarningTimer.current)
      assignmentWarningTimer.current = setTimeout(() => setAssignmentWarning(null), 5000)
      return
    }

    // Stamp the node's OWN `layerAssignment` so the move is consistent locally
    // (drawer, node-property placement fallback) and matches what gets persisted.
    useCanvasStore.getState().updateNode(entityId, { layerAssignment: layerId })

    // Surface the assignment in the staged-changes review panel. On Save it is
    // persisted by saveStagedChangesToDraft Phase 3 as an ISOLATED node update to
    // this entity's `layerAssignment` — outside the atomic structural batch, so a
    // layer failure can never take other edits down.
    const stagedChanges = useStagedChangesStore.getState()
    stagedChanges.stageOrReplace(
      (c) => c.type === 'assign_layer' && c.targetId === entityId,
      {
        type: 'assign_layer',
        targetId: entityId,
        targetUrn: (entity?.data?.urn as string) ?? entityId,
        before: { layerId: prevLayerId, layerName: prevLayer?.name },
        after: { layerId, layerName: targetLayer?.name },
        summary: `Move '${entityName}' → ${targetLayer?.name ?? 'layer'}`,
        discard: () => {
          useCanvasStore.getState().updateNode(entityId, { layerAssignment: prevNodeLayer })
          if (prevLayerId) {
            useReferenceModelStore.getState().assignEntityToLayer(entityId, prevLayerId)
          } else {
            useReferenceModelStore.getState().removeEntityAssignment(entityId)
          }
        },
      },
    )
  }, [assignEntityToLayer, storeLayers, nodes])

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
    const node = nodes.find(n => n.id === nodeId)
    interactions.openContextMenu(e, {
      type: 'node',
      id: nodeId,
      data: node?.data as Record<string, unknown> || {},
    })
  }, [nodes, interactions])



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
    // UX-first: Double-click = inline edit (modern approach)
    // Use Shift+Double-click for trace (power user feature)
    if (event && !event.shiftKey) {
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

    // TRACE MODE: Toggle trace using unified trace hook + smart level
    toggleTraceRef.current(nodeId)
  }, [nodes, interactions])


  // Lineage flow toggle
  const [showLineageFlow, setShowLineageFlow] = useState(initialShowLineageFlow)

  // Edge direction toggle — controls arrowheads + animated mid-edge chevron
  const [showEdgeDirection, setShowEdgeDirection] = useState(true)

  // Trace bottom dock — expanded vs compact. Lifted to the canvas so a
  // global Cmd/Ctrl+I shortcut can toggle it from anywhere.
  const [dockExpanded, setDockExpanded] = useState(false)
  // Auto-collapse the dock when trace exits so a stale open state doesn't
  // immediately reappear next time the user starts a trace.
  useEffect(() => {
    if (!trace.isTracing && dockExpanded) setDockExpanded(false)
  }, [trace.isTracing, dockExpanded])
  // Cmd/Ctrl+I toggles the dock's expanded state while a trace is active.
  useEffect(() => {
    if (!trace.isTracing) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod || e.shiftKey) return
      if (e.key.toLowerCase() === 'i') {
        e.preventDefault()
        setDockExpanded(v => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [trace.isTracing])

  // Sync ontology-derived lineage edge types into trace config so the trace
  // backend traverses TRANSFORMS, AGGREGATED, and any other ontology-classified
  // lineage edges — not just AGGREGATED. (Issue #3)
  useEffect(() => {
    if (lineageEdgeTypes.length > 0) {
      trace.setConfig({ lineageEdgeTypes })
    }
  }, [lineageEdgeTypes, trace.setConfig])

  // Trace ALWAYS runs at the focus node's own level — `level: 'auto'` resolves
  // server-side to the focus's hierarchy.level, so a column-level focus traces
  // column-level lineage (TRANSFORMS, AGGREGATED, or any other ontology-
  // classified lineage edge type). The previous "auto-coarsen" hack broke
  // fine-grained TRANSFORMS lineage; removed.
  //
  // Every entry point gates on `hydrationPhase === 'complete'`. Firing a
  // trace mid-hydration returns nothing (backend has only loaded a partial
  // edge set yet) — the user is presented with a warning toast instead.
  // Reading the stores via getState() inside the callback avoids re-render
  // churn and side-steps the temporal-dead-zone of capturing variables
  // declared later in the component body.
  const guardTraceHydration = useCallback((): boolean => {
    if (useCanvasStore.getState().hydrationPhase === 'complete') return true
    useToastStore.getState().addToast({
      type: 'warning',
      message: 'Trace is unavailable until lineage finishes loading. Please wait a moment.',
      key: 'trace-not-ready',
    })
    return false
  }, [])

  const startTraceWithSmartLevel = useCallback((nodeId: string) => {
    if (!guardTraceHydration()) return
    trace.setConfig({ level: 'auto', lineageEdgeTypes })
    return trace.startTrace(nodeId)
  }, [trace, lineageEdgeTypes, guardTraceHydration])

  const toggleTraceWithSmartLevel = useCallback((nodeId: string) => {
    if (!guardTraceHydration()) return
    trace.setConfig({ level: 'auto', lineageEdgeTypes })
    return trace.toggleTrace(nodeId)
  }, [trace, lineageEdgeTypes, guardTraceHydration])

  const traceUpstreamWithSmartLevel = useCallback((nodeId: string) => {
    if (!guardTraceHydration()) return
    trace.setConfig({ level: 'auto', lineageEdgeTypes })
    return trace.traceUpstream(nodeId)
  }, [trace, lineageEdgeTypes, guardTraceHydration])

  const traceDownstreamWithSmartLevel = useCallback((nodeId: string) => {
    if (!guardTraceHydration()) return
    trace.setConfig({ level: 'auto', lineageEdgeTypes })
    return trace.traceDownstream(nodeId)
  }, [trace, lineageEdgeTypes, guardTraceHydration])

  const traceFullLineageWithSmartLevel = useCallback((nodeId: string) => {
    if (!guardTraceHydration()) return
    trace.setConfig({ level: 'auto', lineageEdgeTypes })
    return trace.traceFullLineage(nodeId)
  }, [trace, lineageEdgeTypes, guardTraceHydration])

  // Wire up the forward-declared refs (used by hooks that fire earlier in
  // render order, before granularityOptions is in scope).
  startTraceRef.current = startTraceWithSmartLevel
  toggleTraceRef.current = toggleTraceWithSmartLevel

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
  const projFresh = useProjectionWatermark(scopeWsId ?? undefined, graphId).data?.fresh
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

  // Optimized Effect: Fetch aggregated edges only when the visible set actually changes
  // Uses expandedNodes (user-driven) as the primary trigger, not nodes array reference.
  // A 500ms debounce coalesces rapid expand/collapse actions.
  //
  // GATED ON !trace.isTracing: skeleton-first /trace v2 returns AGGREGATED
  // edges at the trace's effective level, so the parallel /aggregated-lineage
  // fetch is redundant + racy when a trace is active. In browse mode the
  // hook fires as before.
  useEffect(() => {
    if (!showLineageFlow || nodes.length === 0) return
    if (trace.isTracing) return

    const fetchDebounced = setTimeout(() => {
      const currentVisibleList = getVisibleContainerUrns()

      // Exclude expanded nodes from aggregation targets.
      // When a node is expanded, its children are already in the visible list and will
      // represent it. Including BOTH parent and children causes the Cypher CONTAINS*0..5
      // traversal to find the same TRANSFORMS edges at multiple hierarchy levels,
      // producing duplicate/inflated aggregated edge counts.
      // (Earlier this caused missing lineage because orphan nodes like Snowflake weren't
      // loaded — that's now fixed by the initial graph load fetching orphan nodes.)
      const urnToIdMap = new Map(nodesRef.current.map(n => [(n.data?.urn as string) || n.id, n.id]))
      const aggregationTargets = currentVisibleList.filter(urn => {
        const nodeId = urnToIdMap.get(urn)
        return nodeId && !expandedNodes.has(nodeId)
      })

      // Only fetch if the target set actually changed
      const aggregationKey = aggregationTargets.sort().join(',')
      if (aggregationKey === prevAggregationKeyRef.current) return
      prevAggregationKeyRef.current = aggregationKey

      if (aggregationTargets.length > 0) {
        fetchAggregated(aggregationTargets, aggregationTargets)
      }
    }, 150) // Snappy refetch on expand/collapse — old 500ms felt laggy
            // when iteratively drilling. 150ms is still long enough to
            // coalesce a rapid sequence of clicks but feels live.

    return () => clearTimeout(fetchDebounced)
  }, [showLineageFlow, getVisibleContainerUrns, fetchAggregated, nodes.length, expandedNodes, trace.isTracing])

  // === Extracted Hooks ===

  // Layer assignment: rules, nodesByLayer, displayFlat, displayMap, urnToIdMap, nodeLayerMap
  const { nodesByLayer, displayFlat, displayMap, urnToIdMap, nodeLayerMap } = useLayerAssignment({
    nodes, sortedLayers, nodeEdgeFingerprint,
    instanceAssignments, effectiveAssignments,
    nodeMap, childMap, parentMap,
  })

  // Refresh the duplicate-subtree wiring ref now that its deps exist (see the
  // ref declaration near the interactions call). Read lazily by onNodeCopied /
  // onNodeDuplicated so each duplicate action sees live layer state.
  duplicateWiringRef.current = { nodeLayerMap, sortedLayers, assignEntityToLayer, parentMap, setExpandedNodes }

  // Trace filter — when a trace is active, hides everything outside the trace
  // context (traced URNs + drilldown URNs + their containment ancestors).
  // When trace is off, returns the inputs unchanged with no allocation.
  // Used by LayerColumn / edge projection so expansion reveals only traced
  // descendants, recursively to any depth.
  const {
    filteredByLayer, filteredFlat, filteredMap, contextSet: traceContextSet,
  } = useTraceFilteredHierarchy({
    nodesByLayer, displayFlat, displayMap,
    isTracing: trace.isTracing,
    traceNodes: trace.result?.traceNodes ?? new Set<string>(),
    drilldowns: trace.drilldowns,
    parentMap,
    childMap,
    expandedNodes,
  })

  // The hook returns the inputs unchanged when !isTracing, so these
  // assignments are effectively a no-op outside trace mode.
  const renderByLayer = trace.isTracing ? filteredByLayer : nodesByLayer
  const renderFlat = trace.isTracing ? filteredFlat : displayFlat
  const renderMap = trace.isTracing ? filteredMap : displayMap

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
    return Array.from(out)
  }, [searchResults, advancedMatchUrns, displayFlat])

  // Action: Move entity to layer (updated for unified context menu)
  // Stages a `move_to_layer` change instead of immediately persisting via
  // updateView — the actual schema mutation happens during applyAll.
  const moveToLayer = useCallback((nodeId: string, layerId: string) => {
    if (!activeView || !activeView.id) return

    const entity = displayMap.get(nodeId)
    if (!entity) return

    if (entity.isLogical) {
      console.warn("Moving logical nodes not yet supported via context menu")
      return
    }

    const layers = activeView.layout.referenceLayout?.layers || defaultReferenceModelLayers
    const targetLayer = layers.find(l => l.id === layerId)

    const addRuleToNode = (nodes: LogicalNodeConfig[], targetId: string): LogicalNodeConfig[] => {
      return nodes.map(node => {
        if (node.id === targetId) {
          return {
            ...node,
            rules: [
              ...(node.rules || []),
              { id: `rule-${Date.now()}`, priority: 100, urnPattern: entity.urn }
            ]
          }
        }
        if (node.children) {
          return { ...node, children: addRuleToNode(node.children, targetId) }
        }
        return node
      })
    }

    const buildUpdatedLayers = () => layers.map(l => {
      if (l.id === layerId) {
        return {
          ...l,
          rules: [
            ...(l.rules || []),
            { id: `rule-${Date.now()}`, priority: 100, urnPattern: entity.urn }
          ]
        }
      }
      if (l.logicalNodes) {
        const updatedLogicalNodes = addRuleToNode(l.logicalNodes, layerId)
        if (updatedLogicalNodes !== l.logicalNodes) {
          return { ...l, logicalNodes: updatedLogicalNodes }
        }
      }
      return l
    })

    const previousLayout = activeView.layout

    useStagedChangesStore.getState().stage({
      type: 'move_to_layer',
      targetId: nodeId,
      targetUrn: entity.urn,
      before: { layout: previousLayout },
      after: { layerId, layerName: targetLayer?.name },
      summary: `Move-to-layer rule: '${entity.name}' → ${targetLayer?.name ?? layerId}`,
      apply: async () => {
        const updatedLayers = buildUpdatedLayers()
        useSchemaStore.getState().updateView(activeView.id, {
          layout: {
            ...activeView.layout,
            referenceLayout: {
              ...activeView.layout.referenceLayout,
              layers: updatedLayers
            }
          }
        })
      },
      discard: () => {
        // No mutation occurred yet — discard is a no-op.
      },
    })

    interactions.closeContextMenu()
  }, [activeView, displayMap, interactions])

  // User-created layers: append a ViewLayerConfig to the view's layout so the new column renders
  // immediately (the canvas reads activeView.layout.referenceLayout.layers). Persistence is automatic
  // — the view→referenceModel sync mirrors it and the debounced saveToBackend commits it, so writing
  // the VIEW config (never the store directly, which the sync would revert) is all we do. Nodes created
  // in the new column pick up its id via hierarchyBuilderStore → the durable `layerAssignment`, which
  // is honoured on reload precisely because the layer id now exists in the view (the validLayerIds gate).
  // Write a new layers array to the view's layout. Local updateView → the canvas re-renders (it reads
  // this array); the view→referenceModel sync + debounced saveToBackend then persist it. All four
  // layer ops (add/rename/delete/reorder) funnel through here; the pure list math lives in layerOps.
  const persistLayers = useCallback((nextLayers: ViewLayerConfig[]) => {
    if (!activeView?.id) return
    useSchemaStore.getState().updateView(activeView.id, {
      layout: {
        ...(activeView.layout ?? {}),
        referenceLayout: {
          ...(activeView.layout?.referenceLayout ?? {}),
          layers: nextLayers,
        },
      },
    })
  }, [activeView])

  const currentLayers = useCallback(
    () => activeView?.layout?.referenceLayout?.layers ?? defaultReferenceModelLayers,
    [activeView],
  )

  const addLayer = useCallback((name: string) => {
    const layers = currentLayers()
    const palette = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#84cc16']
    persistLayers(layerOps.appendLayer(layers, {
      id: `layer-${Date.now()}`,
      name,
      description: '',
      icon: 'Layers',
      color: palette[layers.length % palette.length],
      entityTypes: [],
      order: layers.length,
    }))
  }, [currentLayers, persistLayers])

  const renameLayer = useCallback((id: string, name: string) => {
    const trimmed = name.trim()
    if (trimmed) persistLayers(layerOps.renameLayer(currentLayers(), id, trimmed))
  }, [currentLayers, persistLayers])

  const deleteLayer = useCallback((id: string) => {
    persistLayers(layerOps.removeLayer(currentLayers(), id))
  }, [currentLayers, persistLayers])

  // Reorder a layer column (drag). Entities keep their layerAssignment, so they render wherever the
  // layer now sits — nodes and their edges move with it for free.
  const reorderLayer = useCallback((draggedId: string, targetId: string) => {
    persistLayers(layerOps.reorderLayer(currentLayers(), draggedId, targetId))
  }, [currentLayers, persistLayers])

  // Handler for adding child entities
  const handleAddChildEntity = useCallback((parentId: string) => {
    // The builder store's open() runs the ensureDraftOpen guard itself.
    useHierarchyBuilderStore.getState().open({ parentUrn: parentId })
  }, [])

  // Toggle node expansion with Lazy Loading
  const { loadChildren, searchChildren, cancelChildLoad, isLoading: isLoadingChildren, loadingNodes, failedNodes } = useGraphHydration()

  // Reveal-and-focus: clicking a neighbor in the drawer's Lineage section
  // expands collapsed ancestors (lazy-loading from the backend if needed),
  // then scrolls the now-visible target into view. Works during trace mode
  // because visibility here is governed by parentMap + expandedNodes, not
  // by trace state directly. See [useRevealNode](../../../hooks/useRevealNode.ts).
  const revealAndFocus = useRevealNode({
    parentMap,
    setExpandedNodes,
    loadChildren,
    provider,
    focus: (id: string) => {
      const el = document.getElementById(`layer-node-${id}`)
      el?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'center',
      })
    },
  })

  // Multi-locate: reveal each target with skipFocus so per-node scrolls
  // don't fight each other during the cascade, then compute the
  // horizontal bounding-box of all revealed targets and centre the union
  // in the layered scroll container. Vertical seek defers to the first
  // target's scrollIntoView — vertical union centring would risk scrolling
  // past important rows in tall columns.
  const locateManyOnCanvas = useCallback(
    async (ids: string[]) => {
      await Promise.allSettled(
        ids.map((id) => revealAndFocus(id, { skipFocus: true })),
      )
      // Let any expand-driven re-layout commit before measuring.
      await new Promise<void>((r) => requestAnimationFrame(() => r()))

      const container = horizontalScrollRef.current
      if (!container) return
      const els = ids
        .map((id) => document.getElementById(`layer-node-${id}`))
        .filter((el): el is HTMLElement => !!el)
      if (els.length === 0) return

      const containerRect = container.getBoundingClientRect()
      const rects = els.map((el) => el.getBoundingClientRect())
      const minLeft = Math.min(...rects.map((r) => r.left))
      const maxRight = Math.max(...rects.map((r) => r.right))
      const unionCenterX = (minLeft + maxRight) / 2
      const viewportCenterX = containerRect.left + containerRect.width / 2
      const horizontalDelta = unionCenterX - viewportCenterX

      container.scrollTo({
        left: container.scrollLeft + horizontalDelta,
        behavior: 'smooth',
      })
      els[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    },
    [revealAndFocus],
  )

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

  // Reveal callback for advanced-search hits and pin clicks. Walks the
  // ancestor chain, expanding each step so the deep hit becomes
  // reachable; falls back to deepest-reachable on partial load. Shared
  // by SearchMapPanel (hit rows + bucket actions) and SearchPinOverlay
  // (W3). Uses `useRevealSearchHit` (renamed from the original Advanced
  // Search `useRevealNode` during the resilience-hardening integration to
  // coexist with the entity-drawer reveal hook above).
  const revealSearchHit = useRevealSearchHit({
    setExpandedNodes,
    loadChildren,
    provider,
    scrollIntoView: scrollHitIntoView,
  })

  // "Frame matches" — scroll the horizontal canvas container so the
  // first match-bearing node is centered, expanding the spine to it
  // so collapsed ancestors reveal their children. This is a viewport-
  // not-zoom action since the context view is a horizontal layered
  // layout (no React Flow zoom).
  const handleFrameMatches = useCallback(async (urns: string[]) => {
    if (urns.length === 0) return
    const container = horizontalScrollRef.current
    if (!container) return

    // First pass: look for an already-rendered node and scroll to it.
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

    // None of the matches are rendered yet — most likely they're sitting
    // under collapsed ancestors. Expand every URN we know about so the
    // matches become reachable; the user can then re-click Frame.
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      for (const urn of urns) next.add(urn)
      return next
    })
  }, [setExpandedNodes])

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
  const regionCount = useCanvasStore((s) => s.loadingRegions.size)
  const isHydratingInitial = hydrationPhase !== 'complete'

  // Floating loading toasts — keep the full set so every long-running operation
  // is explicitly announced. Wording is centralised here.
  // Two phase-explicit toasts ('ctx-hydrating-entities' / 'ctx-hydrating-edges')
  // duplicate the global 'hydration' toast from CanvasRouter intentionally: the
  // global one has a single key that recycles between phases, so users with the
  // canvas focused want a sticky in-context indicator that the entities AND
  // edges loads both happened — even if hydration is fast.
  useLoadingToast('ctx-hydrating-entities', hydrationPhase === 'roots', 'Loading entities…', 'Entities loaded')
  useLoadingToast('ctx-hydrating-edges', hydrationPhase === 'edges', 'Loading edges between entities…', 'Edges loaded')
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

  // Share — the in-store view lacks visibility, so fetch it fresh to seed
  // both the dialog and the menu's read-only visibility row.
  const handleShareView = useCallback(async () => {
    const view = useSchemaStore.getState().getActiveView()
    if (!view?.id) return
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
        await loadChildren(nodeId)
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
      const canPrune = !trace.isTracing && !subtreeHasUnsavedWork

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
      } else if (trace.isTracing) {
        // Trace mode: keep the merged lineage/containment edges (addedEdgeIds);
        // useTraceFilteredHierarchy hides non-context nodes.
        removeEdgesByNodeIds(subtreeIds, trace.addedEdgeIds)
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
  }, [displayMap, loadChildren, cancelChildLoad, childMap, removeEdgesByNodeIds, removeStoreNodes, purgeAggregatedEdgesIncidentToUrns, trace.isTracing, trace.addedEdgeIds, autoDrillOnExpand])




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
  const browseBundleEnabled = !trace.isTracing

  // Edge projection: lineageEdges, visibleLineageEdges
  // Pass the trace-filtered views so projected edges only reference visible
  // nodes; outside trace mode these are pass-through to the originals.
  const { visibleLineageEdges } = useEdgeProjection({
    edges, aggregatedEdges, nodesByLayer: renderByLayer, expandedNodes,
    displayFlat: renderFlat, displayMap: renderMap, urnToIdMap,
    showLineageFlow, isTracing: trace.isTracing,
    traceContextSet, isContainmentEdge,
    hoveredNodeId,
    suppressedAggEdgeKeys,
    traceAddedEdgeIds: trace.addedEdgeIds,
    // Trace-mode edge bundling: roll every leaf endpoint up to the focus's
    // hierarchy level so per-pair grouping collapses thousands of
    // column-to-column edges into a handful of container-to-container
    // bundles. parentMap is the canvas containment hierarchy; entityTypeLevels
    // is the ontology level map; result.effectiveLevel is what the trace
    // actually ran at.
    traceBundleParentMap: parentMap,
    entityTypeLevels,
    traceFocusLevel: trace.result?.effectiveLevel,
    // Browse-mode bundling: kicks in only outside trace mode and only when
    // edge density would otherwise overload the canvas. Walks endpoints up
    // the containment chain in passes; collapses parent-pairs whose fan-in
    // exceeds the threshold.
    browseBundleEnabled,
    browseBundleParentMap: parentMap,
    browseBundleFanInThreshold: lineageBundleFanIn,
    nodeLayerIndexMap,
  })

  // Publish the projected lineage edge set to the canvas store so panels
  // outside the canvas (EntityDrawer's Lineage section) can mirror exactly
  // what the user sees. `visibleLineageEdges` already excludes containment
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
  // suppresses them in favour of per-node stub indicators; `auto` flips
  // between the two based on `autoStubThreshold`. The mode resolves
  // identically in trace and browse — trace mode no longer bypasses the
  // gate. Trace's focus-incident edges stay materialized via
  // `effectiveLineageEdges` so the anchor is always legible.
  const isStubsMode = useMemo(() => {
    if (lineageRenderMode === 'raw') return false
    if (lineageRenderMode === 'stubs') return true
    return visibleLineageEdges.length > autoStubThreshold
  }, [lineageRenderMode, visibleLineageEdges.length, autoStubThreshold])

  // Effective edge set passed to the renderer. In stubs mode edges
  // incident to the hovered, selected, or trace-focus node materialize
  // (so the user can drill in by interacting and the trace anchor stays
  // unmissable); the canvas otherwise stays light.
  const effectiveLineageEdges = useMemo(() => {
    if (!isStubsMode) return visibleLineageEdges
    const focusIds = new Set<string>()
    if (hoveredNodeId) focusIds.add(hoveredNodeId)
    if (selectedNodeId) focusIds.add(selectedNodeId)
    if (trace.isTracing && trace.result?.focusId) focusIds.add(trace.result.focusId)
    if (focusIds.size === 0) return []
    return visibleLineageEdges.filter(e =>
      focusIds.has(e.source) || focusIds.has(e.target)
    )
  }, [visibleLineageEdges, isStubsMode, hoveredNodeId, selectedNodeId, trace.isTracing, trace.result?.focusId])

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

  // Per-node lineage counts in stubs mode. Drives the small partial-edge
  // markers on each entity card — a quiet inbound arrow on the left when
  // `in > 0`, a quiet outbound arrow on the right when `out > 0`. Counts
  // come from the full projected set (not the hover-filtered slice) so
  // the markers reflect the entity's true lineage volume regardless of
  // which edges happen to be materialized for the current hover.
  const nodeStubCounts = useMemo(() => {
    if (!isStubsMode) return new Map<string, { in: number; out: number }>()
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
  }, [visibleLineageEdges, isStubsMode])

  // Highlight state: connected nodes/edges for selected node
  const { highlightState, isHighlightActive: isClickHighlightActive } = useHighlightState({
    selectedNodeId, visibleLineageEdges: effectiveLineageEdges,
    isTracing: trace.isTracing, displayMap, childMap,
  })

  // Hover highlight: same visual effect on hover (lighter), defers to click-highlight
  const { hoverHighlight, isHoverActive } = useHoverHighlight({
    hoveredNodeId,
    visibleLineageEdges: effectiveLineageEdges,
    isTracing: trace.isTracing,
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
        const trySource = displayMap.get(bundle.source)
        const tryTarget = displayMap.get(bundle.target)
        const sourceHasChildren = !!trySource && !expandedNodes.has(bundle.source)
          && (((trySource.data?.childCount as number) ?? trySource.children?.length ?? 0) > 0)
        const targetHasChildren = !!tryTarget && !expandedNodes.has(bundle.target)
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
  // retarget). Passed to BuildPanel both to stamp a DURABLE layerAssignment
  // at stage time (mirrors the rail's create-time properties.layerAssignment)
  // and for the optimistic session assignEntityToLayer below.
  const buildLayerId = builderLayerId
    ?? (builderParentUrn ? nodeLayerMap.get(builderParentUrn) : undefined)
    ?? sortedLayers[0]?.id
  // Auto-by-type placement: each Build row lands in the column configured for
  // ITS type (falling back to buildLayerId). Derived from the view's own layer
  // config — ontology-agnostic.
  const buildTypeLayerMapMemo = useMemo(() => buildTypeLayerMap(sortedLayers), [sortedLayers])

  return (
    <div
      data-trace-active={trace.isTracing ? 'true' : 'false'}
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
      <AnimatePresence>
        {advancedSearchOpen && (
          <SearchMapPanel
            key="search-map-panel"
            open={advancedSearchOpen}
            onClose={() => setAdvancedSearchOpen(false)}
            viewId={activeView?.id ?? ''}
            onRevealNode={revealSearchHit}
            onFrameMatches={handleFrameMatches}
          />
        )}
      </AnimatePresence>
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden relative">
      <ContextViewHeader
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchResults={searchResults}
        onSearchResultClick={(node) => {
          selectNode(node.id)
          setExpandedNodes((prev) => new Set([...prev, node.id]))
        }}
        showLineageFlow={showLineageFlow}
        onToggleLineageFlow={() => setShowLineageFlow(!showLineageFlow)}
        showEdgeDirection={showEdgeDirection}
        onToggleEdgeDirection={() => setShowEdgeDirection(v => !v)}
        lineageRenderMode={lineageRenderMode}
        onSetLineageRenderMode={setLineageRenderMode}
        traceActive={trace.isTracing}
        canTrace={selectedNodeIds.length === 1 && !selectedNodeIds[0].startsWith('logical:')}
        onStartTrace={() => { if (selectedNodeIds[0]) startTraceWithSmartLevel(selectedNodeIds[0]) }}
        onExitTrace={exitTrace}
        lineageReady={hydrationPhase === 'complete'}
        traceUpstreamDepth={trace.config.upstreamDepth}
        traceDownstreamDepth={trace.config.downstreamDepth}
        onSetTraceDepth={(dir, value) => {
          // Apply the new depth, then re-fetch when a trace is active so
          // the canvas reflects the change without a manual re-trace.
          trace.setConfig(dir === 'upstream' ? { upstreamDepth: value } : { downstreamDepth: value })
          if (trace.isTracing) void trace.retrace()
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
        activeContextModelName={activeContextModelName}
        canEditView={canEditView}
        canShareView={canShareView}
        viewVisibility={viewVisibility}
        onRenameView={handleRenameView}
        onEditViewDetails={handleEditViewDetails}
        onShareView={() => void handleShareView()}
        syncStatus={syncStatus}
        onRetrySync={() => { if (scopeWsId) void saveToBackend(scopeWsId) }}
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
            EntityDrawer keeps the right rail. Both surfaces are independent. */}
        <AnimatePresence>
          {trace.isTracing && (
            <TraceBottomDock
              trace={trace}
              displayMap={displayMap}
              availableEdgeTypes={lineageEdgeTypes}
              granularityOptions={granularityOptions}
              resolveEdgeColor={resolveEdgeColor}
              expanded={dockExpanded}
              onToggleExpanded={() => setDockExpanded(v => !v)}
              onExit={exitTrace}
              onJumpToUrn={(urn) => {
                const id = urnToIdMap.get(urn) ?? urn
                startTraceWithSmartLevel(id)
              }}
            />
          )}
        </AnimatePresence>

        {/* Aggregation truncation banner — backend signal that the visible
            edge set was capped. The "computing" and "last computed Xh ago"
            banners were removed: the materialization-triggered flag was
            sticky after first paint and the staleness banner fired even
            for fresh aggregations. Trust the data already on canvas. */}
        {aggregationTruncated && (
          <div
            data-canvas-interactive
            className="mx-4 mt-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/40 text-amber-700 text-xs flex items-center gap-2 z-20"
          >
            <span className="font-medium">Showing the largest connections — narrow the selection to see more.</span>
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
                // any later create/commit failure without flashing out of the view.
                remapEntityId,
                message: `Canvas edits (${stagedChangeList.length})`,
              })
              // Clear staged changes WITHOUT running discard hooks (keep the optimistic canvas).
              useStagedChangesStore.setState({ changes: [], redoStack: [], applyStatus: 'idle', lastApplyResult: null })
              // A save creates a new draft commit that every versioning surface must reflect — the
              // cumulative branch diff (Changes tab), the commit log (Commits tab), and per-entity
              // history. Invalidate the whole versioning namespace so saved changes appear at once
              // (a save is user-initiated and infrequent, so the broad refetch is fine).
              queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.all })
              await saveToBackend(scopeWsId)   // view/blueprint config (layers) — not graph entities
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
            await saveToBackend(scopeWsId)
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

        {/* Blank (hand-built) model guidance — the full-canvas hero on a truly
            empty model, and the first-steps companion while building. Both are
            scoped to kind === 'blank' so every other view is untouched. */}
        {isBlankModel && !isHydratingInitial && nodes.length === 0 && (
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
              nodeStubCounts={nodeStubCounts}
              showStubs={isStubsMode}
              expandedNodes={expandedNodes}
              selectEdge={selectEdge}
              isEdgePanelOpen={isEdgePanelOpen}
              toggleEdgePanel={toggleEdgePanel}
              triggerRedrawRef={triggerEdgeRedrawRef}
              isTracing={trace.isTracing}
              traceResult={trace.result}
              highlightedEdges={mergedHighlightEdges}
              isHighlightActive={isHighlightActive}
              resolveEdgeColor={resolveEdgeColor}
              onEdgeDoubleClick={handleEdgeDoubleClick}
              showDirection={showEdgeDirection}
              expandingEdgeIds={expandingEdgeIds}
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
              // Canvas zoom — CSS scale on the columns area. Width/height
              // are pre-compensated so the inner flex layout stays truthful
              // at non-100% zoom; the outer overflow-auto handles scrolling.
              transform: canvasZoom !== 1 ? `scale(${canvasZoom})` : undefined,
              transformOrigin: 'top left',
              width: canvasZoom !== 1 ? `${100 / canvasZoom}%` : undefined,
              height: canvasZoom !== 1 ? `${100 / canvasZoom}%` : undefined,
            }}
          >
            {sortedLayers.map((layer) => (
              <LayerColumn
                key={layer.id}
                layer={layer}
                nodes={renderByLayer.get(layer.id) ?? []}
                schema={schema}
                selectedNodeId={selectedNodeId}
                expandedNodes={expandedNodes}
                searchResults={matchedNodeIds}
                onSelect={selectNode}
                onToggle={toggleNode}
                onContextMenu={handleContextMenu}
                onDoubleClick={handleDoubleClick}
                // Create affordances render only in draft (edit) mode —
                // Published shows zero mutation entry points for anyone.
                onAddChild={isDraft ? handleAddChildEntity : undefined}
                onAddToLayer={isDraft ? (layerId) => {
                  useHierarchyBuilderStore.getState().open({ layerId })
                } : undefined}
                onBuildToLayer={isDraft ? (layerId) => {
                  useHierarchyBuilderStore.getState().openBuild({ layerId })
                } : undefined}
                onBeginConnect={isDraft ? edgeConnect.beginDrag : undefined}
                onLayerContextMenu={(e, layerId) => interactions.openContextMenu(e, {
                  type: 'canvas',
                  position: { x: e.clientX, y: e.clientY },
                  layerId,
                })}
                traceFocusId={trace.focusId}
                traceNodes={trace.visibleTraceNodes}
                traceContextSet={traceContextSet}
                isTracing={trace.isTracing}
                highlightedNodes={mergedHighlightNodes}
                isHighlightActive={isHighlightActive}
                isHoverHighlight={isHoverActive && !isClickHighlightActive}
                onAnimationComplete={handleAnimationComplete}
                onLoadMore={loadChildren}
                onSearchChildren={searchChildren}
                isLoadingChildren={isLoadingChildren}
                loadingNodes={loadingNodes}
                failedNodes={failedNodes}
                onScroll={handleLayerScroll}
                onAssignToLayer={(entityId) => handleAssignToLayer(entityId, layer.id)}
                // Draft-only layer management (create lives in AddLayerColumn; these are per-column).
                onRenameLayer={isDraft ? renameLayer : undefined}
                onDeleteLayer={isDraft ? deleteLayer : undefined}
                onReorderLayer={isDraft ? reorderLayer : undefined}
                isHydratingInitial={isHydratingInitial}
                revealTarget={revealTarget}
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
              // layer (an instanceAssignment wins even in closed-scope views).
              const layer = builderLayerId
                ?? (parentUrn ? nodeLayerMap.get(parentUrn) : undefined)
                ?? sortedLayers[0]?.id
              if (layer) assignEntityToLayer(tempUrn, layer)
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
              // Optimistic session assignment for immediate display (the durable
              // per-row layerAssignment is already stamped at stage time). Resolve
              // the SAME auto-by-type layer as the durable stamp, per row.
              const layer = resolveRowLayer(row, { typeLayerMap: buildTypeLayerMapMemo, fallbackLayerId: buildLayerId })
              if (layer) assignEntityToLayer(urn, layer)
            }}
          />
        )}
        {!builderOpen && !buildOpen && drawerNodeId && (
          <EntityDrawer
            key="entity-drawer"
            onTraceUp={(nodeId) => traceUpstreamWithSmartLevel(nodeId)}
            onTraceDown={(nodeId) => traceDownstreamWithSmartLevel(nodeId)}
            onFullTrace={(nodeId) => traceFullLineageWithSmartLevel(nodeId)}
            onFocusNode={revealAndFocus}
            onLocateMany={locateManyOnCanvas}
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
        {/* Property Manager — independent right-rail panel. Unlike the
            selection-driven panels above it isn't mutually exclusive: it
            sits to the right of whichever inspector is open so the user
            can author display rules while a node is selected. */}
        <PropertyManagerDrawer
          key="property-manager-drawer"
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
      </AnimatePresence>
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
        onEditNode={isDraft ? interactions.editNode : undefined}
        onDuplicateNode={isDraft ? interactions.duplicateNode : undefined}
        onDeleteNode={isDraft ? interactions.deleteNode : undefined}
        onCreateChild={isDraft ? interactions.createChild : undefined}
        onConnect={isDraft ? (id) => edgeConnect.armConnect(id) : undefined}
        onLinkNode={isDraft ? (id) => {
          const node = nodes.find(n => n.id === id || (n.data?.urn as string) === id)
          useCreateLinkStore.getState().open({
            sourceUrn: (node?.data?.urn as string) || id,
            anchor: interactions.state.contextMenu.position,
          })
        } : undefined}
        onTraceNode={(id) => startTraceWithSmartLevel(id)}
        onCopyUrn={interactions.copyUrn}
        onEditEdge={isDraft ? interactions.editEdge : undefined}
        onDeleteEdge={isDraft ? interactions.deleteEdge : undefined}
        onReverseEdge={isDraft ? interactions.reverseEdge : undefined}
        onCreateNode={isDraft ? (_pos, layerId) => {
          // Right-clicked an empty layer column → scope the new node to that
          // layer so it lands there (and is assigned on stage, see onEntityStaged).
          useHierarchyBuilderStore.getState().open({ layerId })
        } : undefined}
        onSelectAll={interactions.selectAll}
        layers={sortedLayers}
        onMoveToLayer={isDraft ? (nodeId, layerId) => moveToLayer(nodeId, layerId) : undefined}
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
        onCreateEntity={isDraft ? (typeId) => {
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
          isOpen={true}
          onClose={() => setShareSeed(null)}
        />
      )}
    </div>
  )
}
