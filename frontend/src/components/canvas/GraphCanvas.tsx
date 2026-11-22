/**
 * GraphCanvas - Unified React Flow graph canvas
 *
 * Replaces both LineageCanvas and LayeredLineageCanvas as the main canvas
 * for all free-floating graph views. Composes shared hooks for:
 * - Containment hierarchy (useContainmentHierarchy)
 * - Trace with auto-merge + auto-expand (useCanvasTrace)
 * - Progressive loading (useGraphHydration)
 * - ELK.js layout (useElkLayout)
 * - Progressive edge disclosure (useAggregatedLineage)
 * - Edge roll-up to visible ancestors (useEdgeProjection)
 * - Click/hover highlighting (useHighlightState, useHoverHighlight)
 * - Edge filtering (useEdgeDetailPanel, useEdgeTypeFilters)
 * - Context menu, inline edit, quick create, command palette (useCanvasInteractions)
 * - Keyboard shortcuts (useCanvasKeyboard)
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type ReactFlowInstance,
  applyNodeChanges,
  applyEdgeChanges,
  SelectionMode,
  useStoreApi,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AnimatePresence } from 'framer-motion'
import { ArrowRight, ArrowDown, Loader2, GitBranch, ZoomIn } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isApplePlatform } from '@/lib/platform'
import { HoverTip } from '@/components/ui/HoverTip'
import { generateColorFromType } from '@/lib/type-visuals'
import { FeedMoreChip } from './FeedMoreChip'

// Node/Edge components
import { GhostNode } from './nodes/GhostNode'
import { GenericNode } from './nodes/GenericNode'
import { LineageEdge } from './edges/LineageEdge'
import { AggregatedEdge } from './edges/AggregatedEdge'
import { searchLineIds } from './searchLines'
import { EdgeLegend } from './EdgeLegend'
import { EntityDrawer } from '../panels/entity/EntityDrawer'
import { RelationshipDrawer } from '../panels/RelationshipDrawer'
import { lineForTarget, targetFromLine, type DrawnLine } from '@/lib/drawerEdgeTarget'
import { SearchMapPanel } from './search/SearchMapPanel'
import { PropertyManagerDrawer } from './property-manager/PropertyManagerDrawer'
import { PropertyOpHost } from './property-manager/PropertyOpHost'
import { useDisplayRuleEngine } from '@/hooks/useDisplayRuleEngine'
import { useViewLibrary } from '@/hooks/useViewLibrary'
import { useEffectiveBranchId } from '@/store/branchStore'
import { CanvasSearchTrigger } from './search/CanvasSearchTrigger'
import { useRevealSearchHit } from '@/hooks/useRevealSearchHit'
import { EdgeDetailPanel, generateEdgeTypeFilters } from '../panels/EdgeDetailPanel'

// UX components
import { CanvasContextMenu, type ContextMenuAction } from './CanvasContextMenu'
import { useAskAboutNode } from '@/features/discussions/useAskAboutNode'
import { compareSelectionAction, menuSelection } from './selectionMenu'
import { SelectionBar } from './context-view/SelectionBar'
import { StagedChangesPanel } from './context-view/StagedChangesPanel'
import { Kbd } from '@/components/ui/Kbd'
import { remapIdSet, useCanvasEditGate, useDraftSave, useStagedUndoShortcuts } from '@/features/versioning/canvas/useDraftSave'
import { useCanvasPropertyJobs } from '@/features/versioning/canvas/useCanvasPropertyJobs'
import { InlineNodeEditor } from './InlineNodeEditor'
import { CommandPalette } from './CommandPalette'
import { TraceToolbar } from './TraceToolbar'
import { CanvasToolRow } from './CanvasToolRow'
import { CanvasDisplayMenu } from './context-view/header/DisplayMenu'
import { HierarchyBuilderPanel } from './create/HierarchyBuilderPanel'
import { useHierarchyBuilderStore } from './create/hierarchyBuilderStore'
import { BuilderEmptyState } from './create/BuilderEmptyState'
import { BuildPanel } from './create/buildmode/BuildPanel'

// Hooks
import { useGraphHydration } from '@/hooks/useGraphHydration'
import { useRevealNode } from '@/hooks/useRevealNode'
import { useCanvasReveal } from '@/store/canvasReveal'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { useElkLayout } from '@/hooks/useElkLayout'
import { useContainmentHierarchy } from '@/hooks/useContainmentHierarchy'
import { useCanvasTrace } from '@/hooks/useCanvasTrace'
import { useAggregatedLineage } from '@/hooks/useAggregatedLineage'
import { useHighlightState, useHoverHighlight, useHoveredNodeId } from '@/hooks/useHighlightState'
import { useEdgeDetailPanel, useEdgeTypeFilters, useEdgeFiltersStore } from '@/hooks/useEdgeFilters'
import { useSemanticZoom } from '@/hooks/useSemanticZoom'
import { useCanvasInteractions } from '@/hooks/useCanvasInteractions'
import { useCanvasKeyboard } from '@/hooks/useCanvasKeyboard'
import { useDuplicateSubtree } from '@/hooks/useDuplicateSubtree'
import { useLoadingNotification, useAppNotifications } from '@/components/ui/notifications'
import { EdgeTypePickerPopover } from './edge-create/EdgeTypePickerPopover'
import { CreateLinkPopover } from './edge-create/CreateLinkPopover'
import { useCreateLinkStore } from './edge-create/createLinkStore'
import { deriveConnectableEdges, validateDrawnEdge } from '@/services/ontologyPreflightService'

// Stores
import { useSchemaStore, normalizeEdgeType, useEdgeTypeMetadataMap } from '@/store/schema'
import {
  useViewContainmentEdgeTypes,
  useViewIsContainmentEdge,
  useViewLineageEdgeTypes,
  useViewRelationshipTypes,
  useViewEntityTypes,
  useViewSchemaIsReady,
} from '@/hooks/useViewSchema'
import { useShallow } from 'zustand/react/shallow'
import { isSelectableNode, useCanvasStore, type LineageNode, type LineageEdge as LineageEdgeType } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useSearchStore } from '@/store/searchStore'
import { usePreferencesStore } from '@/store/preferences'
import { usePersonaMode } from '@/store/persona'
import { drawerWidthCss } from '@/components/panels/shell/drawerWidth'
import { useFeature } from '@/store/features'

// Types
import type { HierarchyNode } from '@/types/hierarchy'

// ============================================
// Node/Edge type registrations
// ============================================

const nodeTypes = { ghost: GhostNode, generic: GenericNode }
const edgeTypes = { lineage: LineageEdge, aggregated: AggregatedEdge as any }

/** Maximum nodes rendered in the DOM before viewport culling kicks in */
const MAX_VISIBLE_NODES = 2000
/** Maximum children shown per parent before "Show More" */
const MAX_CHILDREN_PER_PARENT = 20
const NO_SEARCH_LINES: ReadonlySet<string> = new Set()

// ============================================
// Component
// ============================================

export function GraphCanvas({ className }: { className?: string }) {
  // 1. Schema readiness guard
  const isSchemaReady = useViewSchemaIsReady()

  const { notify } = useAppNotifications()
  // 2. Canvas store
  // Actions only (stable) — never the whole store, which re-rendered this canvas on every write.
  const { setNodes, setEdges, selectNode, selectEdge, setSelection, clearSelection, addEdges } = useCanvasStore(useShallow((s) => ({
    setNodes: s.setNodes, setEdges: s.setEdges, selectNode: s.selectNode, selectEdge: s.selectEdge,
    setSelection: s.setSelection, clearSelection: s.clearSelection, addEdges: s.addEdges,
  })))
  const setVisibleEdges = useCanvasStore((s) => s.setVisibleEdges)
  const rawNodes = useCanvasStore((s) => s.nodes)
  const rawEdges = useCanvasStore((s) => s.edges)
  // Mirrors ContextViewCanvas's isHydratingInitial — CanvasRouter writes
  // hydrationPhase into the canvas store for every canvas type, so the empty
  // state can avoid flashing before the initial load lands.
  const hydrationPhase = useCanvasStore((s) => s.hydrationPhase)
  const isHydratingInitial = hydrationPhase !== 'complete'
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  const selectedNodeId = selectedNodeIds[0] ?? null
  const drawerNodeId = useCanvasStore((s) => s.drawerNodeId)
  const drawerNodeIds = useCanvasStore((s) => s.drawerNodeIds)
  // One entity's details or several compared — either way the entity drawer holds the rail.
  const entityDrawerOpen = !!drawerNodeId || !!drawerNodeIds
  const drawerEdge = useCanvasStore((s) => s.drawerEdge)
  const openEdgeDrawer = useCanvasStore((s) => s.openEdgeDrawer)
  // 3. Schema / ontology
  const schema = useSchemaStore((s) => s.schema)
  const containmentEdgeTypes = useViewContainmentEdgeTypes()
  const lineageEdgeTypes = useViewLineageEdgeTypes()
  const isContainmentEdge = useViewIsContainmentEdge()
  const relationshipTypes = useViewRelationshipTypes()
  const schemaEntityTypes = useViewEntityTypes()
  const edgeTypeMetadata = useEdgeTypeMetadataMap()
  const { showMinimap, showGrid, drawerWidth } = usePreferencesStore()
  // Both views share the toolbar (CanvasToolRow); LOD, the Explore chip, the
  // layout-direction switch and the edge-details panel are the Technical view's.
  const technical = usePersonaMode() === 'technical'

  // 4. Local state
  const [showLineageFlow, setShowLineageFlow] = useState(true)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  // Hierarchy Builder open state — drives right-rail mutual exclusion with the
  // inspectors ("creation takes the rail"). Selector, not getState-in-render.
  // `surface` distinguishes the 400px rail from the wider Build Mode panel —
  // only one of the two (never both) mounts at a time.
  const builderMounted = useHierarchyBuilderStore((s) => s.isOpen && s.surface === 'rail')
  // The builder holds the rail unless it stepped aside for an entity's details (it stays mounted, hidden).
  const builderOpen = useHierarchyBuilderStore((s) => s.isOpen && s.surface === 'rail' && !s.suspended)
  const buildOpen = useHierarchyBuilderStore((s) => s.isOpen && s.surface === 'build')
  // Advanced search (Map + Builder + Power tools + Ask) — mounted as a
  // flex-sibling drawer alongside EntityDrawer / EdgeDetailPanel.
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false)
  // Property Manager — display-rule tag overlay. Mounted as a flex-sibling
  // drawer (parity with ContextViewCanvas); the engine recomputes match
  // sets so GenericNode renders the tag chips.
  const [propertyManagerOpen, setPropertyManagerOpen] = useState(false)
  // Select several, armed from the toolbar: a plain click adds to the selection.
  const [multiSelectArmed, setMultiSelectArmed] = useState(false)
  const activeView = useSchemaStore((s) => s.getActiveView())
  useDisplayRuleEngine(activeView?.id ?? null)
  // The view's display rules (the draft's own, on a draft) and saved queries, from its library.
  const libraryBranchId = useEffectiveBranchId(
    activeView?.workspaceId ?? '', activeView?.dataSourceId ?? null, activeView?.id ?? null)
  useViewLibrary(activeView?.id ?? null, libraryBranchId)
  // A relationship the drawer shows was resolved from THIS view's lines —
  // leaving the view (or this canvas) closes it, trail and all.
  useEffect(() => () => {
    const s = useCanvasStore.getState()
    if (s.drawerEdge || s.drawerHistory.entries.some((e) => e.kind === 'edge')) s.forceCloseDrawer()
  }, [activeView?.id])

  // Viewport-aware node filtering for large graphs
  const [viewportBounds, setViewportBounds] = useState<{ x: number; y: number; zoom: number } | null>(null)

  // Ref to hold semanticZoom.onViewportChange (defined later, avoids declaration order issue)
  const semanticZoomRef = useRef<((viewport: any) => void) | null>(null)

  const handleViewportChange = useCallback((viewport: { x: number; y: number; zoom: number }) => {
    setViewportBounds(viewport)
    semanticZoomRef.current?.(viewport)
  }, [])

  // 5. Containment hierarchy (shared hook)
  const { parentMap, childMap, nodeMap } = useContainmentHierarchy({
    nodes: rawNodes,
    edges: rawEdges,
    isContainmentEdge,
  })

  // 6. Compute VISIBLE nodes — the core expand/collapse logic.
  //
  // A node is visible if:
  //   (a) It's a root (no containment parent), OR
  //   (b) Every ancestor in its containment chain is expanded
  //       AND it's within the per-parent child cap (MAX_CHILDREN_PER_PARENT)
  //
  // hiddenChildCounts tracks how many children are hidden per parent for "Load More" UI.
  //
  // Tracks per-parent how many extra children to show beyond the default cap.
  const [childPageSize, setChildPageSize] = useState<Map<string, number>>(new Map())

  const { visibleNodeIds, displayMap, hiddenChildCounts } = useMemo(() => {
    const visible = new Set<string>()
    const dMap = new Map<string, HierarchyNode>()
    const hiddenCounts = new Map<string, number>()

    // Count visible children per parent (for capping)
    const visibleChildCount = new Map<string, number>()

    // Helper: check if a node's entire ancestor chain is expanded
    const isAncestorChainExpanded = (nodeId: string): boolean => {
      const parent = parentMap.get(nodeId)
      if (!parent) return true // Root — always visible
      if (!expandedNodes.has(parent)) return false // Parent collapsed — hidden
      return isAncestorChainExpanded(parent) // Check grandparent recursively
    }

    // First pass: determine which nodes WOULD be visible (ignoring cap)
    const wouldBeVisible = new Set<string>()
    rawNodes.forEach(n => {
      if (n.data.type === 'ghost') return
      if (isAncestorChainExpanded(n.id)) wouldBeVisible.add(n.id)
    })

    // Second pass: apply per-parent child cap
    rawNodes.forEach(n => {
      if (n.data.type === 'ghost') return
      if (!wouldBeVisible.has(n.id)) return

      const parent = parentMap.get(n.id)
      if (parent && expandedNodes.has(parent)) {
        // This is a child of an expanded parent — check cap
        const currentCount = visibleChildCount.get(parent) ?? 0
        const pageSize = childPageSize.get(parent) ?? MAX_CHILDREN_PER_PARENT
        if (currentCount >= pageSize) {
          // Over cap — track as hidden
          hiddenCounts.set(parent, (hiddenCounts.get(parent) ?? 0) + 1)
          return // Don't add to visible
        }
        visibleChildCount.set(parent, currentCount + 1)
      }

      visible.add(n.id)
    })

    // Build displayMap for ALL loaded nodes (needed by highlight/edge projection)
    rawNodes.forEach(n => {
      if (n.data.type === 'ghost') return
      const childIds = childMap.get(n.id) ?? []
      dMap.set(n.id, {
        id: n.id,
        typeId: (n.data.type as string) ?? '',
        name: (n.data.label as string) ?? n.id,
        data: n.data as Record<string, unknown>,
        children: childIds
          .map(cid => nodeMap.get(cid))
          .filter(Boolean)
          .map(cn => ({
            id: cn!.id,
            typeId: (cn!.data.type as string) ?? '',
            name: (cn!.data.label as string) ?? cn!.id,
            data: cn!.data as Record<string, unknown>,
            children: [],
            depth: 0,
            urn: (cn!.data.urn as string) ?? cn!.id,
            entityTypeOption: (cn!.data.type as string) ?? '',
            tags: (cn!.data.classifications as string[]) ?? [],
          })),
        depth: 0,
        urn: (n.data.urn as string) ?? n.id,
        entityTypeOption: (n.data.type as string) ?? '',
        tags: (n.data.classifications as string[]) ?? [],
      })
    })

    return { visibleNodeIds: visible, displayMap: dMap, hiddenChildCounts: hiddenCounts }
  }, [rawNodes, parentMap, expandedNodes, childMap, nodeMap, childPageSize])

  // Visible nodes and edges — filtered by expansion state
  const visibleNodes = useMemo(() =>
    rawNodes.filter(n => visibleNodeIds.has(n.id)),
    [rawNodes, visibleNodeIds]
  )

  // Note: visibleRawEdges removed — edge projection in allVisibleEdges
  // handles visibility by projecting to visible ancestors, not filtering.

  // 7. Progressive loading
  const { loadChildren, cancelChildLoad, isLoading: isLoadingChildren, loadingNodes, failedNodes, loadMoreFeeds } = useGraphHydration()
  useLoadingNotification('graph-children', isLoadingChildren, 'Expanding hierarchy')
  const provider = useGraphProvider()

  // Reveal a search hit on this canvas — same flow as ContextViewCanvas
  // (walk ancestor chain, expand each step, then select + scroll).
  const revealSearchHit = useRevealSearchHit({ setExpandedNodes, provider })

  // "Ask about this" on a node — nothing while questions are off.
  const askAboutNode = useAskAboutNode()

  // 8. Trace system (shared hook)
  const trace = useCanvasTrace({
    nodes: rawNodes,
    edges: rawEdges,
    isContainmentEdge,
    expandedNodes,
    setExpandedNodes,
    setShowLineageFlow,
  })

  // 9. Build traceContextSet
  const traceContextSet = useMemo(() => {
    const set = new Set<string>()
    if (!trace.isTracing) return set
    if (trace.focusId) set.add(trace.focusId)
    if (trace.focusId) {
      let curr = parentMap.get(trace.focusId)
      while (curr) {
        set.add(curr)
        curr = parentMap.get(curr)
      }
    }
    trace.visibleTraceNodes.forEach((id) => {
      set.add(id)
      let curr = parentMap.get(id)
      while (curr) {
        set.add(curr)
        curr = parentMap.get(curr)
      }
    })
    return set
  }, [trace.isTracing, trace.focusId, trace.visibleTraceNodes, parentMap])

  // 9b. Aggregated Lineage — fetches rolled-up lineage from the backend.
  // Lineage edges in the graph DB typically connect deep entities (tables, columns).
  // The aggregation service rolls them up to whatever level is currently visible.
  // This is WHY ContextViewCanvas shows lineage but raw edges alone don't.
  const {
    aggregatedEdges,
    fetchAggregated,
    isLoading: isLoadingAggEdges,
  } = useAggregatedLineage({ granularity: null })
  useLoadingNotification('graph-agg', isLoadingAggEdges, 'Loading lineage')

  // Stable ref for nodes (avoids effect dependency on nodes array)
  const nodesRef = useRef(rawNodes)
  nodesRef.current = rawNodes

  // Track previous aggregation targets to avoid redundant fetches
  const prevAggregationKeyRef = useRef('')

  // Fetch aggregated lineage when visible node set changes.
  //
  // GATED ON !trace.isTracing: when a trace is active, the trace response
  // already carries the AGGREGATED edges at the right level (skeleton-first
  // contract — see backend/app/api/v2/endpoints/graph.py). Issuing a parallel
  // /aggregated-lineage fetch would double the network roundtrip and risk
  // racing the two results into the canvas. In browse mode (no active trace)
  // the hook fires as before to populate level-0 rollups for context.
  useEffect(() => {
    if (!showLineageFlow || rawNodes.length === 0) return
    if (trace.isTracing) return

    const fetchDebounced = setTimeout(() => {
      // Collect URNs of all visible nodes
      const visibleUrns = rawNodes
        .filter(n => visibleNodeIds.has(n.id))
        .map(n => (n.data?.urn as string) || n.id)
        .filter(Boolean)

      if (visibleUrns.length === 0) return

      // Only fetch for COLLAPSED visible nodes (expanded ones' children handle themselves)
      const urnToId = new Map(nodesRef.current.map(n => [(n.data?.urn as string) || n.id, n.id]))
      const aggregationTargets = visibleUrns.filter(urn => {
        const nodeId = urnToId.get(urn)
        return nodeId && !expandedNodes.has(nodeId)
      })

      // Skip if target set hasn't changed
      const aggregationKey = aggregationTargets.sort().join(',')
      if (aggregationKey === prevAggregationKeyRef.current) return
      prevAggregationKeyRef.current = aggregationKey

      if (aggregationTargets.length > 0) {
        fetchAggregated(aggregationTargets, aggregationTargets)
      }
    }, 500) // 500ms debounce

    return () => clearTimeout(fetchDebounced)
  }, [showLineageFlow, rawNodes.length, visibleNodeIds, expandedNodes, fetchAggregated, trace.isTracing])

  // 10. Edge projection — the core of multi-level lineage visualization.
  //
  // For every edge in rawEdges, we find the VISIBLE ancestor of each endpoint:
  // - If a node is visible, it maps to itself
  // - If a node is hidden (inside collapsed parent), walk up parentMap until
  //   we find a visible ancestor → project the edge to that ancestor
  //
  // This enables "inherited lineage": if Domain A → Domain B (lineage) and
  // Domain B is expanded, we show edges from Domain A to each of B's visible children.
  //
  // Containment edges: only shown when BOTH endpoints are directly visible (no projection)
  // Lineage edges: projected to visible ancestors, shown at all zoom levels

  // Helper: find the nearest visible ancestor of a node
  const findVisibleAncestor = useCallback((nodeId: string): string | null => {
    if (visibleNodeIds.has(nodeId)) return nodeId
    const parent = parentMap.get(nodeId)
    if (!parent) return null // Node not in tree at all
    return findVisibleAncestor(parent)
  }, [visibleNodeIds, parentMap])

  const allVisibleEdges = useMemo(() => {
    const result: Array<typeof rawEdges[0] & { _isContainment: boolean; _isProjected: boolean }> = []
    const seen = new Set<string>() // Deduplicate projected edges
    const linesByKey = new Map<string, (typeof result)[number]>()

    for (const edge of rawEdges) {
      const edgeType = normalizeEdgeType(edge)
      const isContainment = isContainmentEdge(edgeType)

      if (isContainment) {
        // Containment: only show when BOTH endpoints are directly visible
        if (visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)) {
          result.push({ ...edge, _isContainment: true, _isProjected: false })
        }
      } else {
        // Lineage: project to visible ancestors
        const visibleSource = findVisibleAncestor(edge.source)
        const visibleTarget = findVisibleAncestor(edge.target)

        if (visibleSource && visibleTarget && visibleSource !== visibleTarget) {
          // Deduplicate: multiple underlying edges may project to the same visible pair.
          // The line keeps every one of them as a member, so it can say which
          // relationships it stands for (the relationship drawer lists them).
          const projectedKey = `${visibleSource}->${visibleTarget}:${edgeType}`
          const drawn = linesByKey.get(projectedKey)
          if (drawn) {
            (drawn.data as { members: LineageEdgeType[] }).members.push(edge)
            continue
          }
          seen.add(projectedKey)

          const isProjected = visibleSource !== edge.source || visibleTarget !== edge.target
          const line = {
            ...edge,
            id: isProjected ? `proj:${edge.id}` : edge.id,
            source: visibleSource,
            target: visibleTarget,
            data: { ...edge.data, members: [edge] },
            _isContainment: false,
            _isProjected: isProjected,
          }
          linesByKey.set(projectedKey, line)
          result.push(line)
        }
      }
    }

    // B. Aggregated lineage edges from the backend aggregation service.
    // These represent rolled-up lineage (e.g., Domain A → Domain B based on
    // underlying table-level TRANSFORMS edges). This is the primary source of
    // lineage visibility at the top level.
    aggregatedEdges.forEach((aggState, _key) => {
      if (aggState.state !== 'collapsed') return
      const agg = aggState.aggregated
      if (!agg?.sourceUrn || !agg?.targetUrn) return

      // Map URNs to visible node IDs
      const sourceId = findVisibleAncestor(agg.sourceUrn)
      const targetId = findVisibleAncestor(agg.targetUrn)
      if (!sourceId || !targetId || sourceId === targetId) return

      const aggKey = `agg:${sourceId}->${targetId}`
      if (seen.has(aggKey)) return
      seen.add(aggKey)

      result.push({
        id: agg.id || aggKey,
        source: sourceId,
        target: targetId,
        type: 'aggregated',
        data: {
          edgeType: 'AGGREGATED',
          relationship: 'aggregated',
          isAggregated: true,
          edgeCount: agg.edgeCount ?? 1,
          edgeTypes: agg.edgeTypes ?? [],
          confidence: agg.confidence ?? 1,
        },
        _isContainment: false,
        _isProjected: sourceId !== agg.sourceUrn || targetId !== agg.targetUrn,
      } as any)
    })

    return result
  }, [rawEdges, visibleNodeIds, isContainmentEdge, findVisibleAncestor, aggregatedEdges])

  // A Connections search's matched edges light their lines as a channel of
  // their own: the reader's own highlights (useEdgeFiltersStore) stay theirs.
  // This view's matches only, and none while a trace draws.
  const searchViewId = useSearchStore((s) => s.viewId)
  const matchedEdges = useSearchStore((s) => s.matchedEdges)
  const searchLines = useMemo(() => (trace.isTracing || matchedEdges.length === 0 || searchViewId !== activeView?.id
    ? NO_SEARCH_LINES
    : searchLineIds(matchedEdges, allVisibleEdges, findVisibleAncestor, isContainmentEdge)),
  [trace.isTracing, matchedEdges, searchViewId, activeView?.id, allVisibleEdges, findVisibleAncestor, isContainmentEdge])

  // Lineage-only subset for highlight computation
  const lineageEdges = useMemo(() =>
    allVisibleEdges.filter(e => !e._isContainment),
    [allVisibleEdges]
  )

  // Publish the projected lineage edge set so EntityDrawer's Lineage section
  // can mirror what the user sees on canvas (see canvas.ts:visibleEdges).
  // Dedup by id-fingerprint so unstable upstream memos (allVisibleEdges
  // re-derives on every aggregatedEdges Map churn) don't cause repeated
  // store writes that feed back into a render loop.
  const lineageEdgesFingerprint = useMemo(
    () => lineageEdges.map((e) => e.id).join('|'),
    [lineageEdges],
  )
  const lineageEdgesRef = useRef(lineageEdges)
  lineageEdgesRef.current = lineageEdges
  useEffect(() => {
    setVisibleEdges(lineageEdgesRef.current as LineageEdgeType[])
    // No cleanup-reset: avoids a second store write per cycle that triggers
    // a re-render in any subscriber (LineageNeighbors) and feeds the loop.
    // Stale data on unmount is overwritten by the next canvas mount; if no
    // canvas is mounted, LineageNeighbors falls back to raw `edges`.
  }, [lineageEdgesFingerprint, setVisibleEdges])

  // 12. Highlight state — uses lineageEdges for click/hover highlighting
  const hoveredNodeId = useHoveredNodeId()
  const { highlightState, isHighlightActive: isClickHighlightActive } = useHighlightState({
    selectedNodeId,
    visibleLineageEdges: lineageEdges,
    isTracing: trace.isTracing,
    displayMap,
    childMap,
  })
  const { hoverHighlight, isHoverActive } = useHoverHighlight({
    hoveredNodeId,
    visibleLineageEdges: lineageEdges,
    isTracing: trace.isTracing,
    displayMap,
    childMap,
    isClickHighlightActive,
  })
  const isHighlightActive = isClickHighlightActive || isHoverActive
  const mergedHighlightNodes = isClickHighlightActive
    ? highlightState.nodes
    : hoverHighlight.nodes
  const mergedHighlightEdges = isClickHighlightActive
    ? highlightState.edges
    : hoverHighlight.edges
  // The line the relationship drawer is open on shows as selected for as long as the drawer is
  // open on it. Nothing else dims for it.
  const openLine = useMemo(
    () => (drawerEdge ? lineForTarget(drawerEdge, allVisibleEdges as DrawnLine[]) : null),
    [drawerEdge, allVisibleEdges],
  )

  // 13. Edge filters
  const { isOpen: isEdgePanelOpen, toggle: toggleEdgePanel, close: closeEdgePanel } =
    useEdgeDetailPanel()
  const { filters: edgeFilters, toggle: toggleEdgeFilter } = useEdgeTypeFilters()
  const ontologyMetadata = useMemo(() => ({ edgeTypeMetadata }), [edgeTypeMetadata])
  const dynamicEdgeFilters = useMemo(() => {
    if (rawEdges.length === 0) return edgeFilters
    return generateEdgeTypeFilters(
      rawEdges,
      relationshipTypes,
      containmentEdgeTypes,
      ontologyMetadata,
    )
  }, [rawEdges, relationshipTypes, containmentEdgeTypes, ontologyMetadata, edgeFilters])

  // 13a. Wire EdgeDetailPanel's filter state into actual canvas rendering.
  // The store has been driving the panel UI for a while — this is what makes
  // the toggles affect the graph the user sees.
  const directionFilter = useEdgeFiltersStore((s) => s.directionFilter)
  const focusedFilterNodeId = useEdgeFiltersStore((s) => s.focusedNodeId)
  const highlightedEdgeIds = useEdgeFiltersStore((s) => s.highlightedEdgeIds)
  const isolateMode = useEdgeFiltersStore((s) => s.isolateMode)

  // Set of normalized edge types the user has left enabled. `null` means "no
  // filters configured yet" (schema not loaded / no edges discovered) and we
  // pass everything through rather than nuking the graph.
  const enabledEdgeTypes = useMemo<Set<string> | null>(() => {
    if (!dynamicEdgeFilters || dynamicEdgeFilters.length === 0) return null
    return new Set(dynamicEdgeFilters.filter((f) => f.enabled).map((f) => f.type))
  }, [dynamicEdgeFilters])

  // Direction filter — when a node is focused via the panel, restrict the
  // displayed lineage edges to that node's incoming / outgoing / upstream /
  // downstream set. Transitive sets are computed via iterative DFS to avoid
  // recursion limits on large graphs.
  const directionEdgeIds = useMemo<Set<string> | null>(() => {
    if (!focusedFilterNodeId || directionFilter === 'all') return null
    if (directionFilter === 'incoming') {
      return new Set(
        allVisibleEdges.filter((e) => e.target === focusedFilterNodeId).map((e) => e.id),
      )
    }
    if (directionFilter === 'outgoing') {
      return new Set(
        allVisibleEdges.filter((e) => e.source === focusedFilterNodeId).map((e) => e.id),
      )
    }
    const ids = new Set<string>()
    const visited = new Set<string>()
    const stack = [focusedFilterNodeId]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (visited.has(node)) continue
      visited.add(node)
      for (const e of allVisibleEdges) {
        if (directionFilter === 'upstream' && e.target === node) {
          ids.add(e.id)
          stack.push(e.source)
        } else if (directionFilter === 'downstream' && e.source === node) {
          ids.add(e.id)
          stack.push(e.target)
        }
      }
    }
    return ids
  }, [allVisibleEdges, focusedFilterNodeId, directionFilter])

  // 14. ELK Layout
  const { applyLayout, isLayouting, direction, toggleDirection } = useElkLayout()
  const [layoutedNodes, setLayoutedNodes] = useState<LineageNode[]>([])
  // Ref mirror so the reveal-focus adapter can read post-layout positions
  // without re-binding every render. Synced below on every render.
  const layoutedNodesRef = useRef<LineageNode[]>([])
  layoutedNodesRef.current = layoutedNodes
  const prevLayoutSig = useRef('')
  const hasAppliedInitialLayout = useRef(false)
  const fitViewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null)

  const scheduleFitView = useCallback(() => {
    if (!rfInstance) return
    if (fitViewTimer.current) clearTimeout(fitViewTimer.current)
    fitViewTimer.current = setTimeout(() => {
      rfInstance.fitView({ padding: 0.2, duration: 300 })
      hasAppliedInitialLayout.current = true
      fitViewTimer.current = null
    }, 250)
  }, [rfInstance])

  // Reveal + center the viewport on a node by id. Used by EntityDrawer's
  // LineageNeighbors so clicking a neighbor pans the canvas to it — and,
  // when the neighbor is hidden inside collapsed parents, expands the
  // ancestor chain (lazy-loading from the backend if needed) before
  // panning. See [useRevealNode](../../hooks/useRevealNode.ts).
  //
  // The pan adapter reads from `layoutedNodes` (post-elk positions) via a
  // ref because canvas-store positions are pre-layout. Trace mode is
  // transparent here — visibility is governed by parentMap + expandedNodes,
  // not by trace state, so the cascade works under both browse and trace.
  const revealAndFocus = useRevealNode({
    parentMap,
    setExpandedNodes,
    loadChildren,
    provider,
    focus: (id: string) => {
      if (!rfInstance) return
      const node =
        layoutedNodesRef.current.find((n) => n.id === id) ??
        useCanvasStore.getState().nodes.find((n) => n.id === id)
      if (!node) return
      rfInstance.setCenter(node.position.x, node.position.y, {
        zoom: rfInstance.getZoom(),
        duration: 400,
      })
    },
  })
  // "Show on canvas" from a question pans here the same way.
  useCanvasReveal(revealAndFocus)

  // Multi-locate: reveal a batch of targets in parallel, then fit the
  // viewport so all of them are on screen. Each reveal runs the same
  // expand-ancestors cascade as the single-click path; using
  // Promise.allSettled lets a partial failure (e.g. one URN that
  // backend lookup rejects) still surface the successful subset rather
  // than abandoning the whole batch.
  const locateManyOnCanvas = useCallback(
    async (ids: string[]) => {
      // skipFocus: true on each reveal so the canvas doesn't run N
      // competing setCenter animations during the cascade. The trailing
      // fitView below produces a single coherent pan/zoom.
      await Promise.allSettled(
        ids.map((id) => revealAndFocus(id, { skipFocus: true })),
      )
      if (!rfInstance) return
      const targets = ids
        .map((id) => layoutedNodesRef.current.find((n) => n.id === id))
        .filter((n): n is LineageNode => !!n)
      if (targets.length === 0) return
      rfInstance.fitView({
        nodes: targets.map((n) => ({ id: n.id })),
        padding: 0.25,
        duration: 500,
      })
    },
    [rfInstance, revealAndFocus],
  )

  const scheduleFitViewRef = useRef(scheduleFitView)
  scheduleFitViewRef.current = scheduleFitView

  useEffect(() => {
    if (rfInstance && layoutedNodes.length > 0 && !hasAppliedInitialLayout.current) {
      scheduleFitView()
    }
  }, [rfInstance, layoutedNodes, scheduleFitView])

  // Edges for ELK: all edges where BOTH endpoints are visible (containment + lineage)
  // ELK uses these for positioning — containment edges create hierarchical structure
  const layoutEdges = useMemo(() =>
    rawEdges.filter(e => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)),
    [rawEdges, visibleNodeIds]
  )

  // Layout signature — derived from visible nodes + their edges + direction
  const layoutSignature = useMemo(() => {
    if (visibleNodes.length === 0) return ''
    const nodeIds = visibleNodes.map((n) => n.id).sort().join(',')
    const edgeIds = layoutEdges.map((e) => e.id).sort().join(',')
    return `${nodeIds}|${edgeIds}|${direction}`
  }, [visibleNodes, layoutEdges, direction])

  // ELK layout — uses incremental layout when nodes are added (expand),
  // full layout on initial load or when direction changes.
  useEffect(() => {
    if (visibleNodes.length === 0) {
      setLayoutedNodes([])
      prevLayoutSig.current = ''
      hasAppliedInitialLayout.current = false
      return
    }
    if (layoutSignature === prevLayoutSig.current) return
    prevLayoutSig.current = layoutSignature

    // FLAT layout — pass ALL edges (containment + lineage) so ELK's layered
    // algorithm naturally creates hierarchical layers:
    //   Layer 0: roots (no incoming containment)
    //   Layer 1: children (incoming CONTAINS edge from layer 0)
    //   Layer 2: grandchildren, etc.
    // This is how DataHub/OpenMetadata do it — no compound nodes, just edge-driven layers.
    applyLayout(visibleNodes, layoutEdges, schemaEntityTypes as any)
      .then((positioned) => {
        setLayoutedNodes(positioned as LineageNode[])
        if (!hasAppliedInitialLayout.current) scheduleFitViewRef.current()
      })
      .catch((err) => {
        console.error('[GraphCanvas] Layout failed:', err)
        setLayoutedNodes(visibleNodes)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutSignature, applyLayout])

  // 16. Semantic zoom — ontology-driven auto-expand/collapse on zoom
  const semanticZoom = useSemanticZoom({
    rfInstance,
    expandedNodes,
    setExpandedNodes,
    displayMap,
    parentMap,
    schemaEntityTypes: schemaEntityTypes as any,
    loadChildren,
    enabled: true,
  })
  semanticZoomRef.current = semanticZoom.onViewportChange

  // 17. Toggle node expansion with lazy loading
  // Stable callback refs for node data props (avoids new function refs on every render)
  const loadChildrenRef = useRef(loadChildren)
  loadChildrenRef.current = loadChildren

  const stableOnLoadMore = useCallback((parentId: string) => {
    // Increase visible cap for this parent (show more already-loaded children)
    setChildPageSize(prev => {
      const next = new Map(prev)
      const current = next.get(parentId) ?? MAX_CHILDREN_PER_PARENT
      next.set(parentId, current + MAX_CHILDREN_PER_PARENT)
      return next
    })
    // Also trigger backend fetch for more children (if not all loaded)
    loadChildrenRef.current(parentId)
  }, [])

  const pendingLoadRef = useRef<Set<string>>(new Set())
  const toggleNode = useCallback(
    async (nodeId: string) => {
      // Register manual override so semantic zoom doesn't undo this action
      semanticZoom.registerManualOverride(nodeId)

      // A child load for this node is already in flight. Ignore repeat
      // clicks until it settles: otherwise an impatient second click reads
      // committed state as expanded, collapses the node, and cancels the
      // in-flight fetch — forcing a third click to actually load. Collapse
      // works normally once the load completes (finally clears pendingLoadRef).
      if (pendingLoadRef.current.has(nodeId)) return

      let wasExpanded = false
      setExpandedNodes((prev) => {
        wasExpanded = prev.has(nodeId)
        const next = new Set(prev)
        if (wasExpanded) next.delete(nodeId)
        else next.add(nodeId)
        return next
      })
      if (!wasExpanded && !pendingLoadRef.current.has(nodeId)) {
        pendingLoadRef.current.add(nodeId)
        try {
          await loadChildren(nodeId)
        } finally {
          pendingLoadRef.current.delete(nodeId)
        }
      } else if (wasExpanded) {
        // User collapsed mid-load — drop the result so a slow response
        // doesn't repopulate a now-collapsed subtree.
        cancelChildLoad(nodeId)
      }
    },
    [loadChildren, cancelChildLoad, semanticZoom],
  )

  const toggleNodeRef = useRef(toggleNode)
  toggleNodeRef.current = toggleNode

  const stableOnToggle = useCallback((nodeId: string) => {
    toggleNodeRef.current(nodeId)
  }, [])

  // 15. Display edges — ALL visible edges with distinct styles per type
  //
  // Containment (parent→child): thin dashed gray, smooth step routing
  //   → Visible whenever the parent is expanded, clearly shows hierarchy
  // Lineage (data flow): thick solid colored, animated, bezier routing
  //   → Shows data dependencies, highlights on hover/click
  //
  // When lineage flow is off, hide lineage but still show containment structure.
  // Flow is the master switch — Trace mode respects it so the canvas can be
  // dialed back to "trace highlights on nodes only" when desired.
  const displayEdges = useMemo(() => {
    const matchesTypeFilter = (edge: typeof allVisibleEdges[number]): boolean => {
      if (!enabledEdgeTypes) return true
      const normalized = normalizeEdgeType(edge).toLowerCase()
      const original = (edge.data?.edgeType || edge.data?.relationship || 'unknown').toLowerCase()
      return enabledEdgeTypes.has(normalized) || enabledEdgeTypes.has(original)
    }
    return allVisibleEdges
      .filter(edge => {
        // Containment edges are subject to the type filter (so users can hide
        // structural edges) but ignore the lineage Flow toggle.
        if (edge._isContainment) {
          return matchesTypeFilter(edge)
        }
        // Lineage edges follow the Flow toggle, regardless of trace state
        if (!showLineageFlow) return false
        if (!matchesTypeFilter(edge)) return false
        // Direction filter (only active when a focus node is set)
        if (directionEdgeIds && !directionEdgeIds.has(edge.id)) return false
        // Isolate mode — only render highlighted edges. Requires at least one
        // highlight to avoid the surprise of "isolate mode hides everything".
        if (isolateMode && highlightedEdgeIds.size > 0 && !highlightedEdgeIds.has(edge.id)) return false
        return true
      })
      .map(edge => {
        if (edge._isContainment) {
          // Containment: thin dashed gray — shows hierarchy structure
          return {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            type: 'smoothstep' as const,
            animated: false,
            style: {
              stroke: '#94a3b8',
              strokeDasharray: '6,4',
              strokeWidth: 1.5,
              opacity: isHighlightActive ? 0.3 : 0.6,
            },
            data: {
              edgeType: edge.data?.edgeType ?? 'CONTAINS',
              isContainment: true,
            },
          }
        }
        // Lineage: solid colored animated — shows data flow
        const isProjected = (edge as any)._isProjected
        const isAggregated = (edge.data as any)?.isAggregated === true
        // A search lights its lines after a click or hover highlight, dimming
        // the rest as they do.
        const isSearchMatch = searchLines.has(edge.id)
        const searchDims = !isHighlightActive && searchLines.size > 0 && !isSearchMatch
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          // Use 'aggregated' edge component for rolled-up edges (shows edge count badge)
          type: isAggregated ? 'aggregated' as const : 'lineage' as const,
          selected: edge.id === openLine?.id,
          animated: (!isProjected && !isAggregated && (!isHighlightActive || mergedHighlightEdges.has(edge.id)) && !searchDims)
            || (isSearchMatch && !isHighlightActive),
          style: {
            opacity: (isHighlightActive && !mergedHighlightEdges.has(edge.id)) || searchDims ? 0.15 : (isProjected ? 0.7 : 1),
            strokeDasharray: isProjected && !isAggregated ? '8,4' : undefined,
          },
          data: {
            edgeType: edge.data?.edgeType ?? edge.data?.relationship ?? '',
            confidence: edge.data?.confidence ?? 1,
            isTraced: trace.isTracing && trace.result?.traceEdges?.has(edge.id),
            isProjected,
            isAggregated,
            edgeCount: (edge.data as any)?.edgeCount,
            sourceEdgeCount: (edge.data as any)?.edgeCount,
            isSearchMatch: isSearchMatch && !isHighlightActive,
          },
        }
      })
  }, [allVisibleEdges, showLineageFlow, trace.isTracing, trace.result, isHighlightActive, mergedHighlightEdges, enabledEdgeTypes, directionEdgeIds, isolateMode, highlightedEdgeIds, openLine, searchLines])
  // (trace.isTracing/trace.result kept in deps because the map step inside reads them for isTraced flagging)

  // Graph mutations (create/update/delete node + edge) 403 server-side when the admin turns
  // editModeEnabled off (graph.py's require_edit_mode), so the affordances that reach those
  // routes are hidden rather than left to fail.
  const editModeEnabled = useFeature('editModeEnabled')
  // Graph edits are kept only in a draft the caller may write, with edit mode on — and a trace is
  // read-only for its whole life. The same gate as the Context View's, and the same save.
  const { scopeWsId, dataSourceId, viewId, graphId, branchId, isDraft, canEditGraph } = useCanvasEditGate()
  const canvasWritable = canEditGraph && !trace.isTracing
  // Bulk property changes: the one dialog writes to the draft open here, and its jobs are followed.
  const propertyGraphWrite = useCanvasPropertyJobs({ wsId: scopeWsId, graphId, branchId, writable: canvasWritable })
  const saveToDraft = useDraftSave({
    wsId: scopeWsId,
    viewId,
    // An entity open before the save stays open after it: its expansion was keyed by its temp urn.
    remapEntityIds: (ids) => setExpandedNodes((prev) => remapIdSet(prev, ids)),
  })
  useStagedUndoShortcuts(isDraft)
  const isStagedPanelOpen = useStagedChangesStore((s) => s.isReviewPanelOpen)

  // A card's More button opens the menu its right-click does. interactions is
  // defined later, so this and the edge menu below reach it through a ref.
  const interactionsRef = useRef<any>(null)
  const openNodeMenu = useCallback((e: React.MouseEvent, id: string) => {
    interactionsRef.current?.openContextMenu(e, {
      type: 'node',
      id,
      data: useCanvasStore.getState().nodes.find((n) => n.id === id)?.data,
    })
  }, [])

  // 16. Display nodes with visual state — only VISIBLE nodes (expand/collapse aware)
  const displayNodes = useMemo(() => {
    const base = layoutedNodes.length > 0 ? layoutedNodes : visibleNodes
    const allNodes = base.map((node) => ({
      ...node,
      data: {
        ...node.data,
        isLoading: loadingNodes.has(node.id),
        isTraced: trace.isInTrace(node.id),
        isDimmed:
          (trace.isTracing && !traceContextSet.has(node.id)) ||
          (isHighlightActive && !mergedHighlightNodes.has(node.id)),
        isUpstream: trace.isUpstream(node.id),
        isDownstream: trace.isDownstream(node.id),
        isFocus: trace.isFocus(node.id),
        isHighlighted: mergedHighlightNodes.has(node.id),
        isExpanded: expandedNodes.has(node.id),
        // Hidden child count — drives "Load More" badge on the node
        _hiddenCount: hiddenChildCounts.get(node.id) ?? 0,
        onLoadMore: stableOnLoadMore,
        onToggleExpanded: stableOnToggle,
        onTraceUpstream: trace.traceUpstream,
        onTraceDownstream: trace.traceDownstream,
        onOpenMenu: openNodeMenu,
        // Add inside stages an entity: offered in a draft, with editing on.
        canAddInside: editModeEnabled && !!libraryBranchId,
      },
    }))

    // Viewport-aware filtering: only activate when node count exceeds threshold
    if (allNodes.length > MAX_VISIBLE_NODES && viewportBounds) {
      const { x: vx, y: vy, zoom } = viewportBounds
      const buffer = 500 // px buffer around viewport
      const viewWidth = (window.innerWidth || 1920) / zoom
      const viewHeight = (window.innerHeight || 1080) / zoom
      const viewLeft = -vx / zoom - buffer / zoom
      const viewTop = -vy / zoom - buffer / zoom
      const viewRight = viewLeft + viewWidth + 2 * buffer / zoom
      const viewBottom = viewTop + viewHeight + 2 * buffer / zoom

      allNodes.forEach((node) => {
        const inView =
          node.position.x < viewRight &&
          node.position.x + 200 > viewLeft &&
          node.position.y < viewBottom &&
          node.position.y + 80 > viewTop
        if (!inView) {
          node.hidden = true
        }
      })

      // Ensure visible count doesn't exceed cap
      const visible = allNodes.filter((n) => !n.hidden)
      if (visible.length > MAX_VISIBLE_NODES) {
        // Prioritize by depth (parents first) -- sort by depth ascending
        visible.sort(
          (a, b) =>
            (((a.data as any)?.depth as number) ?? 0) -
            (((b.data as any)?.depth as number) ?? 0),
        )
        visible.slice(MAX_VISIBLE_NODES).forEach((n) => {
          n.hidden = true
        })
      }
    }

    return allNodes
  }, [
    layoutedNodes,
    rawNodes,
    loadingNodes,
    trace,
    traceContextSet,
    isHighlightActive,
    mergedHighlightNodes,
    stableOnLoadMore,
    stableOnToggle,
    openNodeMenu,
    editModeEnabled,
    libraryBranchId,
    viewportBounds,
    expandedNodes,
    hiddenChildCounts,
  ])

  // 17. The store's selection, drawn. It is the ONE selection: React Flow's own is ignored (see
  // onNodesChange), so the rings, the selection bar and every bulk action read the same thing. A
  // card whose selection did not change keeps its object, so ⌘-clicking one re-renders that one.
  const selectedIdSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])
  const flowNodes = useMemo(
    () => displayNodes.map((n) => (!!n.selected === selectedIdSet.has(n.id) ? n : { ...n, selected: !n.selected })),
    [displayNodes, selectedIdSet],
  )

  // ⇧-drag draws a box; what it holds becomes the selection when it is let go — one write, not one
  // per pointer move. React Flow reports the box as select changes, starting from what it draws as
  // selected (the store's selection, as far as it is on the canvas).
  const boxRef = useRef<Set<string> | null>(null)
  const rfStore = useStoreApi()
  const onSelectionStart = useCallback(() => {
    const held = new Set(useCanvasStore.getState().selectedNodeIds)
    boxRef.current = new Set((rfInstance?.getNodes() ?? []).filter((n) => held.has(n.id)).map((n) => n.id))
  }, [rfInstance])
  const onSelectionEnd = useCallback(() => {
    const box = boxRef.current
    boxRef.current = null
    if (box) setSelection([...box])
    // React Flow then frames the box's cards in a layer of its own, over them, that swallows their
    // clicks and right-clicks until the pane is clicked. The selection bar is this canvas's frame.
    queueMicrotask(() => rfStore.setState({ nodesSelectionActive: false }))
  }, [setSelection, rfStore])

  // 18. Handlers
  // Apply position/selection changes to layoutedNodes so drags are preserved.
  // We DON'T update rawNodes (the store) for position changes — those are layout-managed.
  // We DO update the store for selection changes.
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      // Selection is the store's (selectedNodeIds): a select change is kept only as the box being
      // drawn — a click is answered by onNodeClick. Never written into the nodes, where every click
      // rewrote the whole graph.
      const box = boxRef.current
      const rest = changes.filter((c) => {
        if (c.type !== 'select') return true
        if (box && c.selected) box.add(c.id)
        else if (box) box.delete(c.id)
        return false
      })
      if (rest.length === 0) return
      // Update layouted nodes with position changes (drag support)
      setLayoutedNodes((prev) => {
        if (prev.length === 0) return prev
        return applyNodeChanges(rest, prev) as LineageNode[]
      })
      // Update the store for non-position changes (measured sizes, etc.)
      const nonPositionChanges = rest.filter(c => c.type !== 'position')
      if (nonPositionChanges.length > 0) {
        setNodes(applyNodeChanges(nonPositionChanges, rawNodes) as LineageNode[])
      }
    },
    [rawNodes, setNodes],
  )

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      // A line's selection is the drawer's (openLine) — React Flow's own select changes are not kept.
      const rest = changes.filter((c) => c.type !== 'select')
      if (rest.length > 0) setEdges(applyEdgeChanges(rest, rawEdges) as LineageEdgeType[])
    },
    [rawEdges, setEdges],
  )

  // ⌘/Ctrl- or ⇧-click adds a card to the selection (or takes it out); a plain click selects it alone.
  const onNodeClick: NodeMouseHandler = useCallback(
    (event, node) => {
      // A Mac Ctrl-click is the secondary click: the context menu answers it.
      if (isApplePlatform() && event.ctrlKey && !event.metaKey) return
      selectNode(node.id, multiSelectArmed || event.metaKey || event.ctrlKey || event.shiftKey)
    },
    [selectNode, multiSelectArmed],
  )

  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (event, node) => {
      if (event.shiftKey) {
        // Shift+Double-click: trace
        trace.toggleTrace(node.id)
      } else {
        // Regular double-click: expand/collapse
        toggleNode(node.id)
      }
    },
    [trace, toggleNode],
  )

  const onPaneClick = useCallback(() => clearSelection(), [clearSelection])

  // Edge click
  // A click opens what the line stands for in the relationship drawer — one
  // relationship, or the several a projected line folds together.
  const onEdgeClick: EdgeMouseHandler = useCallback(
    (_, edge) => {
      selectEdge(edge.id)
      const line = allVisibleEdges.find((e) => e.id === edge.id) ?? edge
      openEdgeDrawer(targetFromLine(line as DrawnLine, (id) => rawEdges.find((e) => e.id === id)))
    },
    [selectEdge, openEdgeDrawer, allVisibleEdges, rawEdges],
  )

  // Edge context menu — uses ref because interactions is defined later
  const onEdgeContextMenu: EdgeMouseHandler = useCallback(
    (event, edge) => {
      event.preventDefault()
      interactionsRef.current?.openContextMenu(event as unknown as React.MouseEvent, {
        type: 'edge',
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })
    },
    [],
  )

  // Valid hand-drawable edge types between two entity types — the SHARED ontology helper used
  // everywhere (lineage-only: containment is set via Add child / "Move to", never drawn), already
  // endpoint-validated. Returns only the allowed options.
  const getValidEdgeTypes = useCallback(
    (sourceType: string, targetType: string) =>
      deriveConnectableEdges(sourceType, targetType, relationshipTypes, containmentEdgeTypes, schemaEntityTypes).filter(o => o.allowed),
    [relationshipTypes, containmentEdgeTypes, schemaEntityTypes],
  )

  // Edge picker state — the shared EdgeTypePickerPopover is shown when >1 valid type exists.
  const [edgePicker, setEdgePicker] = useState<{
    sourceId: string
    targetId: string
    position: { x: number; y: number }
  } | null>(null)

  // Create a lineage edge of a specific type, validated against the ontology + existing edges
  // (rejects invalid/duplicate; containment is never created here). Deterministic id so the store's
  // id-dedup also catches an exact duplicate.
  const createEdgeWithType = useCallback(
    (source: string, target: string, edgeTypeId: string) => {
      const sourceNode = rawNodes.find(n => n.id === source)
      const targetNode = rawNodes.find(n => n.id === target)
      const verdict = validateDrawnEdge({
        sourceType: (sourceNode?.data?.type as string) ?? null,
        targetType: (targetNode?.data?.type as string) ?? null,
        edgeType: edgeTypeId,
        relationshipTypes,
        containmentEdgeTypes,
        existingEdges: useCanvasStore.getState().edges,
        sourceId: source,
        targetId: target,
        entityTypes: schemaEntityTypes,
      })
      if (!verdict.allowed) {
        notify('error', verdict.reason ?? 'That relationship isn’t allowed between these entities.')
        setEdgePicker(null)
        return
      }
      addEdges([{
        id: `e-${source}-${target}-${edgeTypeId.toUpperCase()}`,
        source,
        target,
        type: 'lineage',
        data: { edgeType: edgeTypeId, relationship: edgeTypeId },
        animated: true,
      }])
      setEdgePicker(null)
    },
    [rawNodes, addEdges, relationshipTypes, containmentEdgeTypes, schemaEntityTypes, notify],
  )

  // Create edge by dragging between node handles — ontology-aware
  // Shows picker when multiple valid types exist; auto-creates when only one
  const onConnect: OnConnect = useCallback(
    (connection) => {
      if (!connection.source || !connection.target) return

      const sourceNode = rawNodes.find(n => n.id === connection.source)
      const targetNode = rawNodes.find(n => n.id === connection.target)
      if (!sourceNode || !targetNode) return

      const sourceType = (sourceNode.data.type as string) ?? ''
      const targetType = (targetNode.data.type as string) ?? ''
      const validTypes = getValidEdgeTypes(sourceType, targetType)

      if (validTypes.length === 0) {
        notify('info', 'No relationship is allowed between these entities. Use “Add child” to nest one inside the other.')
        return
      }

      if (validTypes.length === 1) {
        createEdgeWithType(connection.source, connection.target, validTypes[0].edgeType)
        return
      }

      // Multiple valid types — show the shared picker (which also disables already-connected types).
      const targetEl = document.querySelector(`[data-id="${connection.target}"]`)
      const rect = targetEl?.getBoundingClientRect()
      setEdgePicker({
        sourceId: connection.source,
        targetId: connection.target,
        position: rect
          ? { x: rect.left + rect.width / 2, y: rect.top }
          : { x: window.innerWidth / 2, y: window.innerHeight / 2 },
      })
    },
    [rawNodes, getValidEdgeTypes, createEdgeWithType, notify],
  )

  // Edge reconnection — ontology-aware. Containment can't be re-drawn (route to "Move to"); a
  // lineage edge is re-validated against the ontology + existing edges before moving.
  const onReconnect = useCallback(
    (oldEdge: any, newConnection: any) => {
      if (!newConnection.source || !newConnection.target) return

      const originalType = (oldEdge.data?.edgeType ?? oldEdge.data?.relationship ?? '') as string
      if (containmentEdgeTypes.some(t => t.toUpperCase() === originalType.toUpperCase())) {
        notify('info', 'Containment can’t be reconnected — use “Move to” to change an entity’s parent.')
        return
      }

      const sourceNode = rawNodes.find(n => n.id === newConnection.source)
      const targetNode = rawNodes.find(n => n.id === newConnection.target)
      if (!sourceNode || !targetNode) return

      const sourceType = (sourceNode.data.type as string) ?? ''
      const targetType = (targetNode.data.type as string) ?? ''
      // Preserve the edge's OWN relationship type (case-insensitively) — never silently
      // substitute a different one; if it isn't valid for the new endpoints, block instead.
      const validTypes = getValidEdgeTypes(sourceType, targetType)
      const edgeType = validTypes.find(o => o.edgeType.toUpperCase() === originalType.toUpperCase())?.edgeType
      if (!edgeType) {
        notify('error', `“${originalType || 'This relationship'}” isn’t allowed between these entities.`)
        return
      }

      // Re-validate the moved edge (dup check excludes the edge being moved).
      const verdict = validateDrawnEdge({
        sourceType, targetType, edgeType, relationshipTypes, containmentEdgeTypes,
        existingEdges: useCanvasStore.getState().edges.filter(e => e.id !== oldEdge.id),
        sourceId: newConnection.source, targetId: newConnection.target,
        entityTypes: schemaEntityTypes,
      })
      if (!verdict.allowed) {
        notify('error', verdict.reason ?? 'That relationship isn’t allowed between these entities.')
        return
      }

      const { removeEdge, addEdges: addEdgesFresh } = useCanvasStore.getState()
      removeEdge(oldEdge.id)
      addEdgesFresh([{
        id: `e-${newConnection.source}-${newConnection.target}-${edgeType.toUpperCase()}`,
        source: newConnection.source,
        target: newConnection.target,
        type: 'lineage',
        data: { edgeType, relationship: edgeType },
        animated: true,
      }])
    },
    [rawNodes, getValidEdgeTypes, relationshipTypes, containmentEdgeTypes, schemaEntityTypes, notify],
  )

  // Connection validation — checks ALL ontology relationship types
  // A connection is valid if ANY relationship type allows this source→target type combination
  const isValidConnection = useCallback(
    (connection: any) => {
      if (connection.source === connection.target) return false

      const sourceNode = rawNodes.find(n => n.id === connection.source)
      const targetNode = rawNodes.find(n => n.id === connection.target)
      if (!sourceNode || !targetNode) return false

      const sourceType = (sourceNode.data.type as string) ?? ''
      const targetType = (targetNode.data.type as string) ?? ''

      return getValidEdgeTypes(sourceType, targetType).length > 0
    },
    [rawNodes, getValidEdgeTypes],
  )

  // ESC-driven trace exit. Mirrors ContextViewCanvas: purges the edges the
  // trace merged into the canvas store, clears trace state, and reverts
  // ancestor-chain auto-expansion. Without this, ESC fell through to plain
  // selection-clear and the trace dock stayed open.
  const exitTrace = useCallback(() => {
    if (!trace.isTracing) return false
    const idsToRemove = Array.from(trace.addedEdgeIds)
    trace.clearTrace()
    if (idsToRemove.length > 0) {
      useCanvasStore.getState().removeEdges(idsToRemove)
    }
    trace.resetAddedEdgeIds()
    setExpandedNodes(new Set())
    return true
  }, [trace])

  // 19. Canvas interactions (context menu, inline edit, quick create, command palette)
  const { duplicateSubtree } = useDuplicateSubtree()
  const interactions = useCanvasInteractions({
    onTraceNode: (nodeId) => trace.startTrace(nodeId),
    onNodeCreated: (nodeId) => selectNode(nodeId),
    duplicateSubtree,
    onNodeDuplicated: (originalId, newUrn) => {
      // Mirrors HierarchyBuilderPanel's onEntityStaged: expand the original's
      // parent (reveals the new sibling) and the copy itself (reveals its
      // just-staged children without a second click).
      const parentId = parentMap.get(originalId)
      setExpandedNodes((prev) => {
        const next = new Set(prev)
        if (parentId) next.add(parentId)
        next.add(newUrn)
        return next
      })
    },
    onCloseEdgePanel: () => {
      // Hidden behind the relationship drawer, the Explorer is not what Esc closes.
      if (isEdgePanelOpen && !drawerEdge) {
        closeEdgePanel()
        return true
      }
      return false
    },
    onCloseEntityDrawer: () => {
      // Review & Save takes Esc first — held while a save or a publish from it runs.
      if (isStagedPanelOpen) {
        if (useStagedChangesStore.getState().applyStatus !== 'applying') useStagedChangesStore.getState().closeReviewPanel()
        return true
      }
      if (drawerEdge || drawerNodeIds) {
        useCanvasStore.getState().requestDrawerMove(() => {
          useCanvasStore.getState().closeNodeDrawer()
          clearSelection()
        })
        return true
      }
      if (selectedNodeId) {
        clearSelection()
        return true
      }
      return false
    },
    onExitTrace: exitTrace,
    // ⌘A: the cards on the canvas — not what is collapsed away or culled off screen.
    selectableIds: () => (rfInstance?.getNodes() ?? []).filter((n) => !n.hidden).map((n) => n.id),
  })

  useCanvasKeyboard({ enabled: true, handlers: interactions.keyboardHandlers })
  interactionsRef.current = interactions

  // A right-click on a card that is part of a selection of several offers the several together.
  const contextTarget = interactions.state.contextMenu.target
  const selectionMenuActions = useMemo<ContextMenuAction[]>(() => {
    if (contextTarget?.type !== 'node' || !isSelectableNode(contextTarget.id)) return []
    const ids = menuSelection(contextTarget.id, selectedNodeIds)
    return ids.length > 1 ? [compareSelectionAction(ids, interactions.closeContextMenu)] : []
  }, [contextTarget, selectedNodeIds, interactions.closeContextMenu])

  // 20. Minimap color
  const minimapNodeColor = useCallback(
    (node: LineageNode) => {
      const entityType = schema?.entityTypes.find((et) => et.id === node.data.type)
      if (entityType) return entityType.visual.color
      return generateColorFromType(node.data.type as string)
    },
    [schema],
  )

  // 21. Hover detection for useHoveredNodeId
  const onNodeMouseEnter: NodeMouseHandler = useCallback((_, node) => {
    document.documentElement.dataset.hoveredNode = node.id
  }, [])
  const onNodeMouseLeave: NodeMouseHandler = useCallback(() => {
    delete document.documentElement.dataset.hoveredNode
  }, [])

  // Schema guard
  if (!isSchemaReady) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-canvas">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-accent-lineage" />
          <span className="text-sm text-ink-muted">Loading schema...</span>
        </div>
      </div>
    )
  }

  // RENDER
  return (
    <div className={cn('w-full h-full relative flex flex-col', className)}>
      {/* The toolbar — the same tools in both views (CanvasToolRow). */}
      <CanvasToolRow
        lead={
          <>
            <h2 className="text-sm font-display font-semibold text-ink whitespace-nowrap">Graph View</h2>
            {technical && (
              <>
                <span className="px-2 py-0.5 rounded-md bg-accent-lineage/10 text-accent-lineage text-2xs font-medium">
                  {trace.isTracing ? 'Tracing' : 'Explore'}
                </span>
                <HoverTip
                  className="inline-flex"
                  label={semanticZoom.isEnabled ? 'Stop expanding entities as you zoom' : 'Expand entities as you zoom in, and collapse them as you zoom out'}
                  detail="Level of detail follows the zoom"
                >
                  <button
                    type="button"
                    onClick={semanticZoom.toggle}
                    className={cn(
                      'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-all',
                      semanticZoom.isEnabled
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'bg-black/5 dark:bg-white/10 text-ink-muted',
                    )}
                  >
                    <ZoomIn className="w-3.5 h-3.5" />
                    {semanticZoom.isEnabled ? 'LOD On' : 'LOD Off'}
                  </button>
                </HoverTip>
              </>
            )}
          </>
        }
        // Advanced search — in the row, so it covers nothing on the canvas.
        search={
          <CanvasSearchTrigger
            open={advancedSearchOpen}
            onToggle={() => setAdvancedSearchOpen((v) => !v)}
            inline
          />
        }
        display={
          <CanvasDisplayMenu
            zoom={rfInstance ? {
              onZoomIn: () => void rfInstance.zoomIn({ duration: 200 }),
              onZoomOut: () => void rfInstance.zoomOut({ duration: 200 }),
              onFit: () => void rfInstance.fitView({ padding: 0.2, duration: 300 }),
            } : undefined}
            mapAndGrid
          />
        }
        showLineageFlow={showLineageFlow}
        onToggleLineageFlow={() => setShowLineageFlow(!showLineageFlow)}
        traceActive={trace.isTracing}
        onStartTrace={(id) => void trace.startTrace(id)}
        onExitTrace={exitTrace}
        multiSelectArmed={multiSelectArmed}
        onToggleMultiSelect={() => setMultiSelectArmed((v) => !v)}
        propertyManagerOpen={propertyManagerOpen}
        onTogglePropertyManager={activeView?.id ? () => setPropertyManagerOpen((v) => !v) : undefined}
        onRevealOnCanvas={revealAndFocus}
      />

      {/* Canvas + right-rail row. The rail panels (builder / EntityDrawer /
          EdgeDetailPanel) are width-animated flex siblings, so opening one
          shrinks the ReactFlow area rather than overlaying it — parity with
          ContextViewCanvas. The absolute HUD (stats, legend) stays anchored
          to the root and floats over this row; the toolbar sits above it. */}
      <div className="flex-1 min-h-0 flex">
      {/* React Flow Canvas */}
      <div className="relative flex-1 min-w-0">
        {/* Trace Toolbar — full controls, only when tracing (same as ContextViewCanvas/HierarchyCanvas) */}
        <AnimatePresence>
          {trace.isTracing && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
              <TraceToolbar
                focusNodeName={displayMap.get(trace.focusId || '')?.name || trace.focusId || 'Unknown'}
                upstreamCount={trace.upstreamCount}
                downstreamCount={trace.downstreamCount}
                showUpstream={trace.showUpstream}
                showDownstream={trace.showDownstream}
                onToggleUpstream={() => trace.setShowUpstream(!trace.showUpstream)}
                onToggleDownstream={() => trace.setShowDownstream(!trace.showDownstream)}
                onExitTrace={() => {
                  trace.clearTrace()
                  setExpandedNodes(new Set())
                }}
                onRetrace={trace.retrace}
                onTraceUpstream={() => trace.focusId && trace.traceUpstream(trace.focusId)}
                onTraceDownstream={() => trace.focusId && trace.traceDownstream(trace.focusId)}
                onTraceFullLineage={() => trace.focusId && trace.traceFullLineage(trace.focusId)}
                config={trace.config}
                onConfigChange={trace.setConfig}
                traceResult={trace.result}
                statistics={trace.statistics}
                isLoading={trace.isLoading}
                availableLineageEdgeTypes={lineageEdgeTypes}
                position="top"
              />
            </div>
          )}
        </AnimatePresence>

        <ReactFlow
          onInit={setRfInstance}
          onMoveEnd={(_, viewport) => handleViewportChange(viewport)}
          nodes={flowNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onPaneClick={onPaneClick}
          onConnect={onConnect}
          onReconnect={onReconnect}
          onEdgeClick={onEdgeClick}
          onEdgeContextMenu={onEdgeContextMenu}
          isValidConnection={isValidConnection}
          onNodeContextMenu={(event, node) => {
            event.preventDefault()
            interactions.openContextMenu(event as any, {
              type: 'node',
              id: node.id,
              data: node.data as Record<string, unknown>,
            })
          }}
          defaultEdgeOptions={{
            type: 'lineage',
            animated: true,
            interactionWidth: 20,
          }}
          // ⇧-drag draws a box (React Flow's selection key); plain drag pans.
          onSelectionStart={onSelectionStart}
          onSelectionEnd={onSelectionEnd}
          multiSelectionKeyCode="Shift"
          selectionMode={SelectionMode.Partial}
          // Delete is the canvas keyboard's: a STAGED delete (useCanvasKeyboard → deleteSelected).
          // React Flow's own Backspace removed the selected nodes from the store outright.
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.05}
          maxZoom={2}
          className="bg-canvas"
          proOptions={{ hideAttribution: true }}
        >
          {showGrid && (
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              className="opacity-40"
            />
          )}
          {showMinimap && (
            <MiniMap
              nodeColor={minimapNodeColor}
              className={cn(
                'glass-panel-subtle !rounded-xl !overflow-hidden',
                '!bottom-4 !right-4',
                // Its mask as a variable rather than the inline maskColor, so the dark theme in globals.css can override it.
                '[--xy-minimap-mask-background-color:rgb(0_0_0/0.1)]',
              )}
              pannable
              zoomable
            />
          )}
          <Controls
            className={cn(
              'glass-panel-subtle !rounded-xl !overflow-hidden !shadow-lg',
              '!bottom-4 !left-4',
            )}
            showInteractive={false}
          />
          {isLoadingChildren && (
            <div className="absolute top-20 right-4 glass-panel-subtle rounded-lg px-3 py-2 flex items-center gap-2">
              <div className="w-3 h-3 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-ink-secondary">Loading children...</span>
            </div>
          )}
        </ReactFlow>
        {rawNodes.length === 0 && !isHydratingInitial && <BuilderEmptyState />}
        {/* Roots/orphans beyond the first page — above the stats bar. */}
        <FeedMoreChip loadingNodes={loadingNodes} failedNodes={failedNodes} onLoadMore={keys => void loadMoreFeeds(keys)} bottomClass="bottom-16" />
        {/* What is selected, and what can be done with several at once — above the stats bar and
            the load-more chip, between the zoom controls and the minimap. */}
        <SelectionBar
          nodeIds={selectedNodeIds}
          labelFor={(id) => displayMap.get(id)?.name || id}
          onRemove={(id) => selectNode(id, true)}
          onClear={clearSelection}
          onOpenShared={() => useCanvasStore.getState().openNodesDrawer(selectedNodeIds)}
          sharedEditable={canvasWritable}
          placementClassName={cn('left-16 bottom-24', showMinimap ? 'right-[14.5rem]' : 'right-16')}
          hint={<><Kbd shortcut="mod" /> click adds one<span className="mx-0.5 text-ink-muted/60" aria-hidden>·</span><Kbd shortcut="shift" /> drag selects a box</>}
        />
      </div>

      {/* Stats Bar */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3">
        {technical && (
        <HoverTip
          label={direction === 'LR' ? 'Lay the graph out top to bottom' : 'Lay the graph out left to right'}
          detail={`Laid out ${direction === 'LR' ? 'left to right' : 'top to bottom'} now`}
          className="inline-flex"
        >
          <button
            onClick={toggleDirection}
            className="glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2 hover:bg-accent-lineage/10 transition-colors"
          >
            {direction === 'LR' ? (
              <ArrowRight className="w-3.5 h-3.5 text-accent-lineage" />
            ) : (
              <ArrowDown className="w-3.5 h-3.5 text-accent-lineage" />
            )}
            <span className="text-2xs text-ink-muted">{direction}</span>
          </button>
        </HoverTip>
        )}
        {isLayouting && (
          <div className="glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2">
            <Loader2 className="w-3 h-3 text-accent-lineage animate-spin" />
            <span className="text-2xs text-ink-muted">Layouting...</span>
          </div>
        )}
        <div className="glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2">
          <span className="text-2xs text-ink-muted">
            {(() => {
              const visibleCount = displayNodes.filter((n) => !n.hidden).length
              return visibleCount < rawNodes.length
                ? `${visibleCount} of ${rawNodes.length} entities`
                : `${rawNodes.length} entities`
            })()} &middot; {displayEdges.length} relationships
          </span>
        </div>
        {(technical || isEdgePanelOpen) && (
        <button
          onClick={toggleEdgePanel}
          className={cn(
            'glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2 transition-colors',
            isEdgePanelOpen && 'bg-accent-lineage/10 border-accent-lineage',
          )}
        >
          <GitBranch className="w-3.5 h-3.5 text-accent-lineage" />
          <span className="text-2xs text-ink-muted">Edge Details</span>
        </button>
        )}
      </div>

      {/* Edge Legend */}
      {/* Clear of the details drawer, at whatever width it is dragged to, and above the minimap
          while it is shown: its top is 183px up (1rem, React Flow's 15px panel margin, 152px tall). */}
      <div
        className={cn(
          'absolute z-30 w-64 pointer-events-auto transition-all duration-300 ease-out',
          showMinimap ? 'bottom-[12.5rem]' : 'bottom-40',
          !(entityDrawerOpen || drawerEdge) && 'right-4',
        )}
        style={entityDrawerOpen || drawerEdge
          ? { right: `calc(${drawerWidthCss(drawerWidth, !!drawerNodeIds || drawerEdge?.kind === 'relationships')} + 1rem)` }
          : undefined}
      >
        <EdgeLegend defaultExpanded={false} visibleEdges={allVisibleEdges} />
      </div>

      {/* Right rail — mutual exclusion: creation takes the rail (an explicit
          action), so the builder is never hidden behind an inspector the user
          left open. Mirrors ContextViewCanvas. */}
      {builderMounted && (
        <HierarchyBuilderPanel
          onClose={() => useHierarchyBuilderStore.getState().close()}
          onEntityStaged={(_tempUrn, parentUrn) => {
            // Node ids are urns here (useGraphHydration sets id: n.urn), so
            // expanding by parentUrn reveals the freshly-staged child.
            if (parentUrn) setExpandedNodes((prev) => new Set([...prev, parentUrn]))
          }}
        />
      )}
      {buildOpen && (
        <BuildPanel onClose={() => useHierarchyBuilderStore.getState().close()} />
      )}
      <AnimatePresence>
        {!builderOpen && !buildOpen && !entityDrawerOpen && !drawerEdge && isEdgePanelOpen && (
          <EdgeDetailPanel
            isOpen={isEdgePanelOpen}
            onClose={closeEdgePanel}
            edgeFilters={dynamicEdgeFilters}
            onToggleFilter={toggleEdgeFilter}
          />
        )}
      </AnimatePresence>
      {!builderOpen && !buildOpen && (
        <EntityDrawer
          // Edits are draft-only, and a trace is read-only for its whole life.
          canEdit={canvasWritable}
          writesLocked={trace.isTracing}
          onTraceUp={trace.traceUpstream}
          onTraceDown={trace.traceDownstream}
          onFullTrace={trace.traceFullLineage}
          onFocusNode={revealAndFocus}
          onLocateMany={locateManyOnCanvas}
        />
      )}
      {!builderOpen && !buildOpen && drawerEdge && (
        <RelationshipDrawer
          canEdit={canvasWritable}
          writesLocked={trace.isTracing}
          onFocusNode={revealAndFocus}
          onLocateMany={locateManyOnCanvas}
          onDeleteEdge={canvasWritable ? interactions.deleteEdge : undefined}
          onReverseEdge={canvasWritable ? interactions.reverseEdge : undefined}
        />
      )}
      </div>{/* end canvas + right-rail row */}

      {/* Advanced search panel — its trigger (⌘⇧F) is in the toolbar. The
          panel mounts as a flex-sibling drawer (parity with ContextViewCanvas).
          Disabled when no view is active. */}
      <AnimatePresence>
        {activeView?.id && advancedSearchOpen && (
          <SearchMapPanel
            key="advanced-search-panel"
            open={advancedSearchOpen}
            onClose={() => setAdvancedSearchOpen(false)}
            viewId={activeView.id}
            onRevealNode={(urn, ancestorPath) =>
              revealSearchHit(urn, ancestorPath)
            }
          />
        )}
      </AnimatePresence>

      {/* Property Manager — display-rule tag overlay drawer. */}
      <AnimatePresence>
        {activeView?.id && (
          <PropertyManagerDrawer
            key="property-manager-drawer"
            viewId={activeView.id}
            open={propertyManagerOpen}
            onClose={() => setPropertyManagerOpen(false)}
            knownEntityTypes={schemaEntityTypes.map((et) => et.id)}
            onSearchPredicate={(p) => {
              useSearchStore.getState().requestSearchRun(p, 'property-manager')
              setAdvancedSearchOpen(true)
            }}
          />
        )}
      </AnimatePresence>
      <PropertyOpHost
        viewId={activeView?.id ?? ''}
        graphWrite={propertyGraphWrite}
        onOpenManager={() => setPropertyManagerOpen(true)}
        knownEntityTypes={schemaEntityTypes.map((et) => et.id)}
      />

      {/* UX Components */}
      <CanvasContextMenu
        isOpen={interactions.state.contextMenu.isOpen}
        position={interactions.state.contextMenu.position}
        target={interactions.state.contextMenu.target}
        onClose={interactions.closeContextMenu}
        onEditNode={interactions.editNode}
        onDuplicateNode={editModeEnabled ? interactions.duplicateNode : undefined}
        onDeleteNode={editModeEnabled ? interactions.deleteNode : undefined}
        onCreateChild={editModeEnabled ? interactions.createChild : undefined}
        onLinkNode={editModeEnabled ? (id) => {
          const node = rawNodes.find(n => n.id === id)
          useCreateLinkStore.getState().open({
            sourceUrn: (node?.data?.urn as string) || id,
            anchor: interactions.state.contextMenu.position,
          })
        } : undefined}
        onTraceNode={(id) => trace.startTrace(id)}
        onAskAboutNode={askAboutNode}
        onCopyUrn={interactions.copyUrn}
        onEditEdge={interactions.editEdge}
        onDeleteEdge={editModeEnabled ? interactions.deleteEdge : undefined}
        onReverseEdge={editModeEnabled ? interactions.reverseEdge : undefined}
        onCreateNode={editModeEnabled ? () => useHierarchyBuilderStore.getState().open() : undefined}
        onSelectAll={interactions.selectAll}
        customActions={selectionMenuActions}
      />
      {/* Review & Save — opened from the controls above, a drawer's "Review & Save", or a
          notification; saves this canvas's staged edits to the draft as one commit. */}
      <StagedChangesPanel
        wsId={scopeWsId} graphId={graphId} dataSourceId={dataSourceId} viewId={viewId}
        onReveal={(id) => {
          useCanvasStore.getState().openNodeDrawer(id)
          void revealAndFocus(id)
        }}
        onConfirm={saveToDraft}
      />
      <InlineNodeEditor
        nodeId={interactions.state.inlineEdit.nodeId}
        value={interactions.state.inlineEdit.value}
        position={interactions.state.inlineEdit.position}
        onSave={interactions.saveInlineEdit}
        onCancel={interactions.cancelInlineEdit}
      />
      <CommandPalette
        isOpen={interactions.state.commandPalette.isOpen}
        onClose={interactions.closeCommandPalette}
        onCreateEntity={editModeEnabled ? (typeId) => {
          interactions.closeCommandPalette()
          useHierarchyBuilderStore.getState().open({ initialTypeId: typeId })
        } : undefined}
        onSelectEntity={(entityId) => selectNode(entityId)}
      />

      {/* Edge Type Picker — the SHARED ontology-driven, duplicate-aware popover (lineage-only). */}
      {edgePicker && (
        <EdgeTypePickerPopover
          sourceId={edgePicker.sourceId}
          targetId={edgePicker.targetId}
          position={edgePicker.position}
          onPick={(edgeType) => createEdgeWithType(edgePicker.sourceId, edgePicker.targetId, edgeType)}
          onCancel={() => setEdgePicker(null)}
        />
      )}

      {/* Click-based "Link to…" flow — the discoverable sibling of handle-drag connect. */}
      <CreateLinkPopover onCreateLink={(s, t, e) => interactions.stageEdgeCreate(s, t, e)} />
    </div>
  )
}

export default GraphCanvas
