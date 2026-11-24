/**
 * HierarchyCanvas - Hierarchy-style Reference Model View
 * 
 * Displays entities in a hierarchical nested container structure with:
 * - Collapsible containers that roll up children
 * - Left-to-right flow across hierarchy levels
 * - Search to find and expand to any node
 * - Roll-up counts (e.g., "15 tables, 247 columns")
 * - Progressive expansion from root to leaf, a level at a time (useExpandBelow)
 *
 * The rows are ONE flat, virtualized list (the open tree, walked in the order it is drawn), not
 * cards nested inside cards: a warehouse opened a level at a time holds tens of thousands of
 * rows, and only the ones on screen are mounted.
 */

import { memo, useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { CHILDREN_PAGE_SIZE } from '@/config/pagination'
import { formatShortcut, isApplePlatform } from '@/lib/platform'
import { HoverTip } from '@/components/ui/HoverTip'
import { useSchemaStore, isContainmentEdgeType } from '@/store/schema'
import { useViewContainmentEdgeTypes, useViewLineageEdgeTypes } from '@/hooks/useViewSchema'
import { isSelectableNode, useCanvasStore } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useOpensDetailsOnSelect } from '@/store/detailsOnSelect'
import { useDisplayRuleLook } from '@/store/displayRuleMatchStore'
import { useFeature } from '@/store/features'
import { useSearchStore } from '@/store/searchStore'
import { useGraphHydration } from '@/hooks/useGraphHydration'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { useLoadingNotification } from '@/components/ui/notifications'

// UX-first interaction components (shared across canvases)
import { CanvasContextMenu, type ContextMenuAction, type ContextMenuTarget } from './CanvasContextMenu'
import { useAskAboutNode } from '@/features/discussions/useAskAboutNode'
import { QuestionRowMark } from '@/features/discussions/QuestionRowMark'
import { compareSelectionAction, menuSelection } from './selectionMenu'
import { SelectionBar } from './context-view/SelectionBar'
import { StagedChangesPanel } from './context-view/StagedChangesPanel'
import { LoadMoreItem } from './context-view/LoadMoreItem'
import { sameRow } from './context-view/rowEquality'
import { shouldAutoLoadFirstPage } from './context-view/autoLoadFirstPage'
import {
  RESUME_LABELS, isPausedOn, nextLevel, outermost, pausedMenuActions, useExpandBelow, type ExpandTree, type PausedRun,
} from './context-view/useExpandBelow'
import { remapIdSet, useCanvasEditGate, useDraftSave, useStagedUndoShortcuts } from '@/features/versioning/canvas/useDraftSave'
import { useCanvasPropertyJobs } from '@/features/versioning/canvas/useCanvasPropertyJobs'
import { CreateLinkPopover } from './edge-create/CreateLinkPopover'
import { useCreateLinkStore } from './edge-create/createLinkStore'
import { InlineNodeEditor } from './InlineNodeEditor'
import { CommandPalette } from './CommandPalette'
import { SearchMatchBadge } from './search/SearchMatchBadge'
import { useSearchHighlight } from './search/useSearchHighlight'
import { useEntityDecoration, nodeDecorationClass } from '@/features/versioning/canvas/useDiffDecoration'
import { useCanvasInteractions } from '@/hooks/useCanvasInteractions'
import { useCanvasKeyboard } from '@/hooks/useCanvasKeyboard'
import { useDuplicateSubtree } from '@/hooks/useDuplicateSubtree'

// Editor components (shared across canvases)
import { FeedMoreChip } from './FeedMoreChip'
import { HierarchyBuilderPanel } from './create/HierarchyBuilderPanel'
import { useHierarchyBuilderStore } from './create/hierarchyBuilderStore'
import { BuilderEmptyState } from './create/BuilderEmptyState'
import { BuildPanel } from './create/buildmode/BuildPanel'
import { EntityDrawer } from '../panels/entity/EntityDrawer'
import { SearchMapPanel } from './search/SearchMapPanel'
import { PropertyManagerDrawer } from './property-manager/PropertyManagerDrawer'
import { PropertyOpHost } from './property-manager/PropertyOpHost'
import { DisplayRuleTagChips } from './property-manager/DisplayRuleTagChips'
import { useDisplayRuleEngine } from '@/hooks/useDisplayRuleEngine'
import { useViewLibrary } from '@/hooks/useViewLibrary'
import { useEffectiveBranchId } from '@/store/branchStore'
import { CanvasSearchTrigger } from './search/CanvasSearchTrigger'
import { useRevealSearchHit } from '@/hooks/useRevealSearchHit'
import { TraceToolbar } from './TraceToolbar'
import { CanvasToolRow } from './CanvasToolRow'
import { CanvasDisplayMenu } from './context-view/header/DisplayMenu'
import { useCanvasTrace } from '@/hooks/useCanvasTrace'
import type { HierarchyNode } from '@/types/hierarchy'
import { useContainmentHierarchy } from '@/hooks/useContainmentHierarchy'
import { useCanvasReveal } from '@/store/canvasReveal'
import { resolveEntityName, technicalIdentity } from '@/lib/entityDisplayName'
import { useCanvasIdentityProperty } from '@/components/dataSource/NodeIdentity'
import { usePersonaMode } from '@/store/persona'
import { usePreferencesStore } from '@/store/preferences'

interface HierarchyCanvasProps {
  className?: string
}

/** Each level's indent, px; its guide rail runs down the middle of it. */
const INDENT = 24
/** A row before it is measured — the card and the gap under it — near its real height, so that
 *  measuring a row scrolled to moves nothing below it. Technical rows add the ID line. */
const ROW_ESTIMATE = 74
const TECHNICAL_LINE = 17
/** The selection bar's lane over the foot of the list: its offset from the bottom and its height. */
const SELECTION_BAR_ROOM = 128
/** New rows that slide in. A level opened at once mounts none of that: it simply appears. */
const ANIMATE_NEW_MAX = 20

const NO_IDS: ReadonlySet<string> = new Set()

/** A row of the flat list: an entity, or the paging row under an open container's children.
 *  `guides` are the colours of the levels above it; `posInSet` / `setSize` place an entity among the
 *  siblings drawn with it — a virtualized tree has to say so itself (aria-posinset / setsize). */
type TreeRow =
  | { kind: 'node'; node: HierarchyNode; depth: number; guides: readonly string[]; posInSet: number; setSize: number }
  | { kind: 'more'; parent: HierarchyNode; depth: number; guides: readonly string[]; remaining: number }

// Recursive count of all descendants
function countDescendants(node: HierarchyNode): { total: number; byType: Record<string, number> } {
  const byType: Record<string, number> = {}
  let total = 0

  const traverse = (n: HierarchyNode) => {
    total++
    byType[n.typeId] = (byType[n.typeId] ?? 0) + 1
    n.children.forEach(traverse)
  }

  node.children.forEach(traverse)
  return { total, byType }
}

export function HierarchyCanvas({ className }: HierarchyCanvasProps) {
  // Use individual selectors to avoid re-rendering on unrelated store changes
  const nodes = useCanvasStore(s => s.nodes)
  const edges = useCanvasStore(s => s.edges)
  const selectNode = useCanvasStore(s => s.selectNode)
  const clearSelection = useCanvasStore(s => s.clearSelection)
  const selectedNodeIds = useCanvasStore(s => s.selectedNodeIds)
  // Every selected row wears its ring — the selection is the store's, all of it.
  const selectedIdSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])
  // Mirrors ContextViewCanvas's isHydratingInitial — CanvasRouter writes
  // hydrationPhase into the canvas store for every canvas type, so the empty
  // state can avoid flashing before the initial load lands.
  const hydrationPhase = useCanvasStore((s) => s.hydrationPhase)
  const isHydratingInitial = hydrationPhase !== 'complete'
  const schema = useSchemaStore((s) => s.schema)
  const containmentEdgeTypes = useViewContainmentEdgeTypes()
  const lineageEdgeTypes = useViewLineageEdgeTypes()
  const {
    loadChildren, cancelChildLoad, loadingNodes, failedNodes, exhaustedParents, loadMoreFeeds, isLoading: isLoadingChildren,
  } = useGraphHydration()
  // Legacy inline quick-filter (substring over visible nodes) — left
  // in place as a complementary quick-filter alongside the new
  // server-side SearchMapPanel. Full removal is tracked separately
  // because the searchResults prop is consumed by several sub-trees.
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<string[]>([])
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const searchInputRef = useRef<HTMLInputElement>(null)
  const pendingLoadRef = useRef<Set<string>>(new Set())
  // Containers whose first page has been asked for (by a click, a level run or the effect that
  // furnishes rows opened any other way) — never asked for again by that effect.
  const autoLoadedFirstPageRef = useRef<Set<string>>(new Set())
  // Advanced search (Map + Builder + Power tools + Ask) — same surface
  // mounted on ContextView and Graph canvases.
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false)
  const [propertyManagerOpen, setPropertyManagerOpen] = useState(false)
  // Select several, armed from the toolbar: a plain click adds to the selection.
  const [multiSelectArmed, setMultiSelectArmed] = useState(false)
  const activeView = useSchemaStore((s) => s.getActiveView())
  const provider = useGraphProvider()
  // Property Manager display-rule engine — publishes match sets so the
  // HierarchyContainer rows render tag chips.
  useDisplayRuleEngine(activeView?.id ?? null)
  // The view's display rules (the draft's own, on a draft) and saved queries, from its library.
  const libraryBranchId = useEffectiveBranchId(
    activeView?.workspaceId ?? '', activeView?.dataSourceId ?? null, activeView?.id ?? null)
  useViewLibrary(activeView?.id ?? null, libraryBranchId)
  // A row to bring on screen once the list holds it: the list is virtualized, so a row opened
  // just now is not in the DOM to scroll to. It expires, so a row that never shows (a filter
  // hides it) cannot pull the list to it seconds later.
  const [scrollTarget, setScrollTarget] = useState<{ id: string; until: number } | null>(null)
  const scrollToRow = useCallback((id: string) => setScrollTarget({ id, until: Date.now() + 2000 }), [])
  const revealSearchHit = useRevealSearchHit({
    setExpandedNodes, provider, scrollIntoView: scrollToRow,
    // A level the reveal furnished itself is not fetched again by the first-page effect below.
    markFirstPageHandled: (id) => { autoLoadedFirstPageRef.current.add(id) },
  })

  // Edit Mode State (shared across canvases). `surface` distinguishes the
  // 400px rail from the wider Build Mode panel — only one mounts at a time.
  const builderMounted = useHierarchyBuilderStore(s => s.isOpen && s.surface === 'rail')
  // The builder holds the rail unless it stepped aside for an entity's details (it stays mounted, hidden).
  const builderOpen = useHierarchyBuilderStore(s => s.isOpen && s.surface === 'rail' && !s.suspended)
  const buildOpen = useHierarchyBuilderStore(s => s.isOpen && s.surface === 'build')

  // Build containment hierarchy using shared hook (must precede trace + traceContextSet)
  const isContainmentEdge = useCallback(
    (normalizedType: string) => isContainmentEdgeType(normalizedType, containmentEdgeTypes),
    [containmentEdgeTypes]
  )
  const { parentMap, childMap, rootNodes: hierarchyRoots, nodeMap } = useContainmentHierarchy({
    nodes, edges, isContainmentEdge,
  })

  // "Ask about this" on a node — nothing while questions are off.
  const askAboutNode = useAskAboutNode()

  // Unified Trace System (shared hook handles merge + auto-expand)
  const trace = useCanvasTrace({
    nodes, edges, isContainmentEdge, expandedNodes, setExpandedNodes,
  })

  // Build trace context set that includes ancestors of traced nodes
  // This ensures parent containers stay visible when children are in the trace
  const traceContextSet = useMemo(() => {
    const set = new Set<string>()

    if (!trace.isTracing) return set

    // Add all visible trace nodes
    trace.visibleTraceNodes.forEach(id => set.add(id))

    // Add all ancestors of traced nodes so containers stay visible
    trace.visibleTraceNodes.forEach(id => {
      let curr = parentMap.get(id)
      while (curr) {
        set.add(curr)
        curr = parentMap.get(curr)
      }
    })

    return set
  }, [trace.isTracing, trace.visibleTraceNodes, parentMap])

  // ESC-driven trace exit. Mirrors ContextViewCanvas: purges trace-merged
  // edges from the canvas store, clears trace state, and reverts ancestor-
  // chain auto-expansion. Without this, ESC fell through to selection-clear
  // and the trace dock stayed open.
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

  // UX-first Canvas Interactions (context menu, inline edit, quick create, command palette)
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
    onCloseEntityDrawer: () => {
      // Review & Save takes Esc first — held while a save or a publish from it runs.
      if (isStagedPanelOpen) {
        if (useStagedChangesStore.getState().applyStatus !== 'applying') useStagedChangesStore.getState().closeReviewPanel()
        return true
      }
      // Several entities compared: Esc closes the drawer, and the selection with it.
      if (useCanvasStore.getState().drawerNodeIds) {
        useCanvasStore.getState().requestDrawerMove(() => {
          useCanvasStore.getState().closeNodeDrawer()
          clearSelection()
        })
        return true
      }
      return false
    },
    onExitTrace: exitTrace,
    // ⌘A: the rows on screen — not what is collapsed away.
    selectableIds: () => visibleRowIds,
  })

  // Keyboard shortcuts
  useCanvasKeyboard({
    enabled: true,
    handlers: interactions.keyboardHandlers,
  })

  // Build hierarchy tree from the shared containment maps. Names follow the
  // persona, as on the other canvases, so the rows sort and search by the
  // names they show.
  //
  // A node that comes out of a rebuild as it went in is the SAME object as before: a page landing
  // rebuilds the tree, and only the rows it changed (its container, and the containers above) then
  // re-render — not every row on screen.
  const personaMode = usePersonaMode()
  const builtNodesRef = useRef(new Map<string, HierarchyNode>())
  const hierarchyTree = useMemo(() => {
    if (!nodes.length) return []
    const before = builtNodesRef.current
    const built = new Map<string, HierarchyNode>()
    builtNodesRef.current = built

    const buildTree = (nodeId: string, depth: number): HierarchyNode | null => {
      const node = nodeMap.get(nodeId)
      if (!node) return null

      const children = (childMap.get(nodeId) ?? [])
        .map((childId) => buildTree(childId, depth + 1))
        .filter((n): n is HierarchyNode => n !== null)
        .sort((a, b) => a.name.localeCompare(b.name))

      const fresh: HierarchyNode = {
        id: node.id,
        typeId: node.data.type as string,
        name: resolveEntityName(node.data, personaMode, node.id),
        data: node.data as Record<string, unknown>,
        children,
        depth,
        urn: (node.data.urn as string) ?? node.id,
        entityTypeOption: (node.data.type as string) ?? '',
        tags: (node.data.classifications as string[]) ?? [],
      }
      const prior = before.get(node.id)
      const kept = prior && sameRow(prior, fresh) ? prior : fresh
      built.set(node.id, kept)
      return kept
    }

    return hierarchyRoots
      .map((n) => buildTree(n.id, 0))
      .filter((n): n is HierarchyNode => n !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [nodes.length, hierarchyRoots, childMap, nodeMap, personaMode])

  // Flatten tree for search
  const flatNodes = useMemo(() => {
    const flat: HierarchyNode[] = []
    const traverse = (node: HierarchyNode, path: string[]) => {
      flat.push({ ...node, data: { ...node.data, _path: [...path, node.id] } })
      node.children.forEach((child) => traverse(child, [...path, node.id]))
    }
    hierarchyTree.forEach((root) => traverse(root, []))
    return flat
  }, [hierarchyTree])

  // Search functionality
  // Guard: only update searchResults when the value actually changes to prevent
  // infinite re-render loops (setSearchResults([]) creates a new reference each time).
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults(prev => prev.length === 0 ? prev : [])
      return
    }

    const query = searchQuery.toLowerCase()
    const results = flatNodes
      .filter((node) =>
        node.name.toLowerCase().includes(query) ||
        node.typeId.toLowerCase().includes(query) ||
        (node.data.urn as string)?.toLowerCase().includes(query)
      )
      .map((n) => n.id)

    setSearchResults(results)
  }, [searchQuery, flatNodes])

  const flatIndex = useMemo(() => new Map(flatNodes.map((n) => [n.id, n])), [flatNodes])

  // Show rows: open the path to each, then scroll the first into view and pulse it (matches the
  // jump-to-node feedback in other canvases). Never selects — the entity drawer's "locate" leaves
  // what the drawer holds (several entities, compared) as it is. False when none is in the tree.
  const revealRows = useCallback((nodeIds: readonly string[]) => {
    const paths = nodeIds.map((id) => flatIndex.get(id)?.data._path as string[] | undefined)
    const first = nodeIds.find((id) => flatIndex.has(id))
    if (!first) return false
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      paths.forEach((path) => path?.forEach((id) => next.add(id)))
      return next
    })
    scrollToRow(first)
    return true
  }, [flatIndex, scrollToRow])
  const revealRow = useCallback((nodeId: string) => { revealRows([nodeId]) }, [revealRows])
  const locateRows = useCallback((nodeIds: string[]) => { revealRows(nodeIds) }, [revealRows])

  // Expand path to search result, and select it
  const expandToNode = useCallback((nodeId: string) => {
    if (revealRows([nodeId])) selectNode(nodeId)
  }, [revealRows, selectNode])
  // "Show on canvas" from a question opens the path the same way.
  useCanvasReveal(expandToNode)

  // The canvas filter (Isolate / Hide) drops rows here, from the list itself — not row by row as
  // they render — so the virtualizer's count and offsets close up around them. A selected row is
  // never dropped (useSearchHighlight's rule).
  const matchUrnSet = useSearchStore((s) => s.matchUrnSet)
  const ancestorMatchCounts = useSearchStore((s) => s.ancestorMatchCounts)
  const canvasFilterMode = useSearchStore((s) => s.canvasFilterMode)
  const filtering = matchUrnSet.size > 0 && canvasFilterMode !== 'highlight'
  const typeColors = useMemo(
    () => new Map((schema?.entityTypes ?? []).map((et) => [et.id, et.visual?.color ?? '#6b7280'])),
    [schema],
  )

  // The rows, in the order they are drawn: a collapsed subtree contributes nothing. Under an open
  // container's children, one paging row while more of it remain — its first page included, so the
  // row says it is loading. Not built from what is loading: a page starting or settling would
  // otherwise walk every row again. Each row carries the colours of the levels above it, for its
  // guide rails.
  const keptBySelection = filtering ? selectedIdSet : NO_IDS
  const rows = useMemo(() => {
    const out: TreeRow[] = []
    const hidden = (n: HierarchyNode) => {
      if (!filtering || keptBySelection.has(n.id)) return false
      const key = n.urn ?? n.id
      const isMatch = matchUrnSet.has(key)
      return canvasFilterMode === 'isolate' ? !isMatch && (ancestorMatchCounts.get(key) ?? 0) === 0 : isMatch
    }
    const level = (siblings: readonly HierarchyNode[], depth: number, guides: readonly string[]) => {
      const shown = siblings.filter((n) => !hidden(n))
      shown.forEach((n, i) => {
        out.push({ kind: 'node', node: n, depth, guides, posInSet: i + 1, setSize: shown.length })
        if (!expandedNodes.has(n.id)) return
        const inner = [...guides, typeColors.get(n.typeId) ?? '#6b7280']
        level(n.children, depth + 1, inner)
        const childCount = Number(n.data.childCount ?? 0) || 0
        const remaining = Math.max(0, childCount - n.children.length)
        const more = remaining > 0 && exhaustedParents.get(n.id) !== childCount
        if (more) out.push({ kind: 'more', parent: n, depth: depth + 1, guides: inner, remaining })
      })
    }
    level(hierarchyTree, 0, [])
    return out
  }, [hierarchyTree, expandedNodes, exhaustedParents, typeColors,
    filtering, canvasFilterMode, matchUrnSet, ancestorMatchCounts, keptBySelection])
  // The entity rows alone — what a Shift-range, ⌘A and the arrow keys walk.
  const visibleRowIds = useMemo(
    () => rows.flatMap((r) => (r.kind === 'node' ? [r.node.id] : [])),
    [rows],
  )
  const rowIndex = useMemo(() => new Map(visibleRowIds.map((id, i) => [id, i])), [visibleRowIds])

  // Row click → selection, as on the Context View's columns. Cmd/Ctrl toggles the row; Shift ADDS
  // every row between the last-clicked one and this one, as drawn; a plain click selects it alone.
  // With no last click on screen, a Shift-click toggles the row in, as Cmd/Ctrl would.
  const handleRowSelect = useCallback((id: string, e: React.MouseEvent) => {
    // A Mac Ctrl-click is the secondary click: the context menu answers it.
    if (isApplePlatform() && e.ctrlKey && !e.metaKey) return
    if (e.shiftKey) {
      const { lastNodeClick, selectedNodeIds: held, setSelection } = useCanvasStore.getState()
      const from = lastNodeClick.nodeId ? rowIndex.get(lastNodeClick.nodeId) : undefined
      const to = rowIndex.get(id)
      if (from !== undefined && to !== undefined) {
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        setSelection([...new Set([...held, ...visibleRowIds.slice(lo, hi + 1)])])
        return
      }
    }
    selectNode(id, multiSelectArmed || e.shiftKey || e.metaKey || e.ctrlKey)
  }, [rowIndex, visibleRowIds, selectNode, multiSelectArmed])

  // A right-click on a row that is part of a selection of several offers the several together.
  const contextTarget = interactions.state.contextMenu.target
  const selectionMenuActions = useMemo<ContextMenuAction[]>(() => {
    if (contextTarget?.type !== 'node' || !isSelectableNode(contextTarget.id)) return []
    const ids = menuSelection(contextTarget.id, selectedNodeIds)
    return ids.length > 1 ? [compareSelectionAction(ids, interactions.closeContextMenu)] : []
  }, [contextTarget, selectedNodeIds, interactions.closeContextMenu])

  // Toggle node expansion with lazy loading
  const toggleNode = useCallback(async (nodeId: string) => {
    // A child load for this node is already in flight. Ignore repeat clicks
    // until it settles: otherwise an impatient second click reads the node
    // as expanded, collapses it, and cancels the in-flight fetch — forcing a
    // third click to actually load. Collapse works once the load completes.
    if (pendingLoadRef.current.has(nodeId)) return

    // 1. Determine local expansion state
    const isCurrentlyExpanded = expandedNodes.has(nodeId)

    // Update state
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (isCurrentlyExpanded) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })


    // If we are collapsing, abort any pending/in-flight load for this node
    // so a slow response doesn't repopulate a collapsed subtree.
    if (isCurrentlyExpanded) {
      cancelChildLoad(nodeId)
      // A first page cut off here is asked for again when the row next opens, however it opens.
      autoLoadedFirstPageRef.current.delete(nodeId)
      return
    }

    // 2. Load Children using Generic Hook — the first page is in hand, for the effect below.
    autoLoadedFirstPageRef.current.add(nodeId)
    pendingLoadRef.current.add(nodeId)
    try {
      await loadChildren(nodeId)
    } finally {
      pendingLoadRef.current.delete(nodeId)
    }
  }, [loadChildren, cancelChildLoad, expandedNodes])

  // A container opened any other way — a whole level at once, a search's path, a trace — with
  // nothing of it loaded gets its FIRST page here (the Context View's rule,
  // shouldAutoLoadFirstPage); otherwise it opens onto nothing. Once per container, so one whose
  // page brings nothing is not asked again and this can never pump. Later pages are the paging
  // row's.
  useEffect(() => {
    for (const nodeId of expandedNodes) {
      if (loadingNodes.has(nodeId) || failedNodes.has(nodeId)) continue
      if (!shouldAutoLoadFirstPage({
        nodeId, displayMap: flatIndex, childMap, autoLoaded: autoLoadedFirstPageRef.current,
      })) continue
      autoLoadedFirstPageRef.current.add(nodeId)
      void loadChildren(nodeId)
    }
  }, [expandedNodes, flatIndex, childMap, loadingNodes, failedNodes, loadChildren])

  // ── OPEN WHAT IS INSIDE, a level at a time (useExpandBelow) ──────────────
  // The toolbar's Expand (the whole tree), a row's menu, the selection bar, and ⇧→ / ⇧← on a
  // row: as on the Context View. One expansion update per level, each container's first page
  // through the loader the chevron uses (its bounded queue); every level only when the reader
  // switches All levels on, pausing every 2,000 entities loaded — the toolbar, and the menu and the
  // selection bar on the rows a paused run started from, then offer its choices.
  const expandDepthMode = usePreferencesStore((s) => s.expandDepthMode) ?? 'level'
  const setExpandDepthMode = usePreferencesStore((s) => s.setExpandDepthMode)
  const expandTree = useMemo<ExpandTree>(() => ({
    expanded: expandedNodes,
    childrenOf: (id) => flatIndex.get(id)?.children.map((c) => c.id) ?? [],
    isContainer: (id) => {
      const n = flatIndex.get(id)
      return !!n && (n.children.length > 0 || Number(n.data.childCount ?? 0) > 0)
    },
  }), [expandedNodes, flatIndex])
  const { expand: runExpand, cancel: cancelExpand, resume: resumeExpand, running: expanding, paused: expandPaused } = useExpandBelow({
    ...expandTree,
    parentOf: (id) => parentMap.get(id),
    open: (ids) => setExpandedNodes((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    }),
    // The run asks for these first pages itself: the effect above is told they are in hand.
    loadFirstPage: (id) => {
      autoLoadedFirstPageRef.current.add(id)
      return loadChildren(id)
    },
    cancelLoad: cancelChildLoad,
    loading: loadingNodes,
    loadedCount: () => useCanvasStore.getState().nodes.length,
    firstPageSize: (id) => Math.min(Number(flatIndex.get(id)?.data.childCount ?? 0), CHILDREN_PAGE_SIZE),
    labelOf: (id) => flatIndex.get(id)?.name || id,
  })
  // A run says what it is doing in its own keyed toast; the generic one would say it twice.
  useLoadingNotification('hier-children', isLoadingChildren && !expanding, 'Expanding hierarchy')
  const expandRows = useCallback((ids: readonly string[]) => {
    runExpand(ids, expandDepthMode === 'all')
  }, [runExpand, expandDepthMode])
  const rootIds = useMemo(() => hierarchyTree.map((n) => n.id), [hierarchyTree])
  const expandAll = useCallback(() => expandRows(rootIds), [expandRows, rootIds])
  // With every container open, the toolbar's Expand has nothing left to do and says so. Not asked
  // while a run goes: the control is Stop then, and each page landing would walk the tree again.
  const canExpandAll = useMemo(
    () => !expanding && nextLevel(rootIds, expandTree).ids.length > 0,
    [expanding, rootIds, expandTree],
  )

  // What Collapse closes for these rows. COLLAPSE EVERYTHING INSIDE: the rows stay open on their
  // first level and every row beneath them closes. With nothing open beneath — straight after one
  // "Expand next level" — it closes the rows themselves ("Collapse"), so the way back from the
  // last step is always offered.
  const collapseTargets = useCallback((ids: readonly string[]) => {
    const roots = outermost(ids, (id) => parentMap.get(id))
    const below: string[] = []
    const stack = roots.flatMap((id) => expandTree.childrenOf(id))
    while (stack.length > 0) {
      const id = stack.pop()!
      if (!expandTree.expanded.has(id)) continue
      below.push(id)
      stack.push(...expandTree.childrenOf(id))
    }
    if (below.length > 0) return { close: below, self: false }
    const open = roots.filter((id) => expandTree.expanded.has(id))
    return { close: open, self: open.length > 0 }
  }, [parentMap, expandTree])
  // Closing also stops what is still loading or queued for them (a no-op for the rest). Nothing
  // loaded is let go: a single collapse here keeps its rows too, and the next open shows them
  // without a fetch.
  const closeRows = useCallback((ids: readonly string[]) => {
    if (expanding) cancelExpand()
    for (const id of ids) {
      cancelChildLoad(id)
      autoLoadedFirstPageRef.current.delete(id)
    }
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      return next
    })
  }, [expanding, cancelExpand, cancelChildLoad])
  const collapseInside = useCallback((ids: readonly string[]) => {
    const { close } = collapseTargets(ids)
    if (close.length > 0) closeRows(close)
  }, [collapseTargets, closeRows])
  const collapseAll = useCallback(() => closeRows([...expandedNodes]), [closeRows, expandedNodes])
  /** What Expand and Collapse would do for these rows, for the menu and the bar. */
  const expandChoices = useCallback((ids: readonly string[]) => {
    const roots = outermost(ids, (id) => parentMap.get(id))
    const collapse = collapseTargets(roots)
    return {
      canExpand: nextLevel(roots, expandTree).ids.length > 0,
      canCollapse: collapse.close.length > 0,
      collapseLabel: collapse.self ? 'Collapse' : 'Collapse everything inside',
      // The run paused at a checkpoint is the one these rows started.
      paused: isPausedOn(expandPaused, roots) ? expandPaused : null,
    }
  }, [parentMap, expandTree, collapseTargets, expandPaused])
  // The menu's rows, for the entity right-clicked or the selection it is part of: Expand (with
  // its All levels switch), Collapse — or, while a run is going, the way to stop it; paused, on
  // the rows it started from, its choices (elsewhere an Expand replaces it).
  const expandMenuActions = useMemo<ContextMenuAction[]>(() => {
    const { target, isOpen } = interactions.state.contextMenu
    // Only while the menu is open: its target outlives it, and this walks the open tree beneath.
    if (!isOpen || !target || target.type !== 'node') return []
    if (expanding && !expandPaused) return [{ id: 'expand-stop', label: 'Stop opening', icon: 'CircleStop', onClick: cancelExpand }]
    const ids = menuSelection(target.id, selectedNodeIds)
    const { canExpand, canCollapse, collapseLabel, paused } = expandChoices(ids)
    if (paused) return pausedMenuActions(paused, resumeExpand, cancelExpand)
    const all = expandDepthMode === 'all'
    return [
      ...(canExpand ? [{
        id: 'expand-below',
        label: all ? 'Expand all levels' : 'Expand next level',
        icon: all ? 'ChevronsDown' as const : 'ChevronDown' as const,
        shortcut: '⇧→',
        toggle: { label: 'All levels', checked: all, onChange: (on: boolean) => setExpandDepthMode(on ? 'all' : 'level') },
        onClick: () => expandRows(ids),
      }] : []),
      ...(canCollapse ? [{
        id: 'collapse-inside',
        label: collapseLabel,
        icon: 'ChevronsUp' as const,
        shortcut: '⇧←',
        onClick: () => collapseInside(ids),
      }] : []),
    ]
  }, [interactions.state.contextMenu, selectedNodeIds, expanding, expandPaused, cancelExpand, resumeExpand, expandChoices,
    expandDepthMode, setExpandDepthMode, expandRows, collapseInside])
  // The selection bar's: the same, for every entity held.
  const selectionExpand = useMemo(() => {
    const held = selectedNodeIds.filter(isSelectableNode)
    if (held.length < 2) return undefined
    const { canExpand, canCollapse, collapseLabel, paused } = expandChoices(held)
    const going = expanding && !expandPaused
    if (!canExpand && !canCollapse && !going && !paused) return undefined
    return {
      collapseLabel,
      allLevels: expandDepthMode === 'all',
      onToggleAllLevels: () => setExpandDepthMode(expandDepthMode === 'all' ? 'level' : 'all'),
      onExpand: canExpand ? () => expandRows(held) : undefined,
      onCollapse: canCollapse ? () => collapseInside(held) : undefined,
      running: going,
      paused: paused ? { ...paused, onResume: resumeExpand } : undefined,
      onCancel: cancelExpand,
    }
  }, [selectedNodeIds, expandChoices, expanding, expandPaused, expandDepthMode, setExpandDepthMode, expandRows, collapseInside,
    cancelExpand, resumeExpand])

  // Keyboard shortcut for search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'f') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
      if (e.key === 'Escape') {
        setSearchQuery('')
        searchInputRef.current?.blur()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // ── THE LIST (HierarchyList, below): what its rows and keys call ──
  // Read through a ref, so the list — and each row — re-renders for what it shows, not for every
  // render of the canvas around it.
  const listActions: HierarchyListActions = {
    select: handleRowSelect,
    toggle: (id) => { void toggleNode(id) },
    openContextMenu: (e, id) => interactions.openContextMenu(e, { type: 'node', id, data: flatIndex.get(id)?.data || {} }),
    startInlineEdit: (id) => {
      const node = flatIndex.get(id)
      const element = document.getElementById(`hierarchy-node-${id}`)
      if (!element || !node) return
      const rect = element.getBoundingClientRect()
      interactions.startInlineEdit(
        id,
        node.name,
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        (node.data.businessLabel as string | undefined)?.trim() ? 'businessLabel' : 'label',
      )
    },
    expandRows,
    collapseInside,
    loadMore: (id) => { void loadChildren(id) },
    selectNode,
    parentOf: (id) => parentMap.get(id),
    isContainer: expandTree.isContainer,
  }
  const listActionsRef = useRef(listActions)
  useEffect(() => { listActionsRef.current = listActions })
  const clearScrollTarget = useCallback(() => setScrollTarget(null), [])
  const searchResultSet = useMemo(() => new Set(searchResults), [searchResults])
  // The paging row's one-page-ahead fetch, as on the Context View — off while a filter drops
  // rows (the row would stay in view and drain its container).
  const pageAhead = !filtering

  return (
    <div className={cn("h-full w-full flex flex-col overflow-hidden bg-canvas relative", className)}>
      {/* Roots/orphans beyond the first page — reachable, and said so. */}
      <FeedMoreChip loadingNodes={loadingNodes} failedNodes={failedNodes} onLoadMore={keys => void loadMoreFeeds(keys)} />
      {/* The toolbar — the same tools in both views (CanvasToolRow). The rows draw no lineage
          lines, so there is no Lineage switch. */}
      <CanvasToolRow
        lead={
          <div className="flex items-center gap-1">
            <TreeExpandControl
              allLevels={expandDepthMode === 'all'}
              onToggleAllLevels={() => setExpandDepthMode(expandDepthMode === 'all' ? 'level' : 'all')}
              onExpand={canExpandAll ? expandAll : undefined}
              running={expanding}
              paused={expandPaused}
              onResume={resumeExpand}
              onStop={cancelExpand}
            />
            <HoverTip className="inline-flex" label="Close every row" detail="Back to the top-level entities">
              <button type="button" onClick={collapseAll} aria-label="Collapse all" className="btn btn-ghost btn-sm">
                <LucideIcons.ChevronsDownUp className="w-4 h-4" />
              </button>
            </HoverTip>
            {/* Advanced search — in the row, so it covers none of the buttons beside it; here,
                not by the filter box, which keeps the room the row saves for a search. */}
            <CanvasSearchTrigger
              open={advancedSearchOpen}
              onToggle={() => setAdvancedSearchOpen((v) => !v)}
              inline
            />
          </div>
        }
        search={
          <div className="relative flex-1 min-w-0 max-w-xs">
            <LucideIcons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder={`Search entities… (${formatShortcut('mod+f')})`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="input pl-9 pr-8 py-1.5 w-full text-sm"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink"
              >
                <LucideIcons.X className="w-4 h-4" />
              </button>
            )}
          </div>
        }
        display={<CanvasDisplayMenu />}
        traceActive={trace.isTracing}
        onStartTrace={(id) => void trace.startTrace(id)}
        onExitTrace={exitTrace}
        multiSelectArmed={multiSelectArmed}
        onToggleMultiSelect={() => setMultiSelectArmed((v) => !v)}
        propertyManagerOpen={propertyManagerOpen}
        onTogglePropertyManager={activeView?.id ? () => setPropertyManagerOpen((v) => !v) : undefined}
        onRevealOnCanvas={revealRow}
      >
        {/* Search Results */}
        {searchQuery && searchResults.length > 0 && (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span className="text-xs text-ink-muted">
              {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}:
            </span>
            {searchResults.slice(0, 5).map((id) => {
              const node = flatNodes.find((n) => n.id === id)
              return (
                <button
                  key={id}
                  onClick={() => expandToNode(id)}
                  className="px-2 py-1 rounded-md bg-accent-lineage/10 text-accent-lineage text-xs hover:bg-accent-lineage/20 transition-colors"
                >
                  {node?.name}
                </button>
              )
            })}
            {searchResults.length > 5 && (
              <span className="text-xs text-ink-muted">
                +{searchResults.length - 5} more
              </span>
            )}
          </div>
        )}
      </CanvasToolRow>

      {/* Tree + right-rail row. The rail panels (builder / EntityDrawer) are
          width-animated flex siblings, so opening one shrinks the tree area
          rather than overlaying it — parity with GraphCanvas (44d8811).
          SearchMapPanel/PropertyManagerDrawer stay outside this row, same as
          GraphCanvas — they mount below as their own flex-sibling drawers. */}
      <div className="flex-1 min-h-0 flex">
        {/* Hierarchy Content — the selection bar floats over it, outside the scroll. */}
        <div className="relative flex-1 min-w-0">
        {hierarchyTree.length === 0 ? (
          <div className="h-full overflow-auto p-6 custom-scrollbar">
            {!isHydratingInitial && <BuilderEmptyState />}
          </div>
        ) : (
          <HierarchyList
            rows={rows}
            visibleRowIds={visibleRowIds}
            rowIndex={rowIndex}
            schema={schema}
            selectedIds={selectedIdSet}
            expandedNodes={expandedNodes}
            loadingNodes={loadingNodes}
            failedNodes={failedNodes}
            searchResults={searchResultSet}
            isTraceActive={trace.isTracing}
            traceContextSet={traceContextSet}
            traceFocusId={trace.focusId}
            expanding={expanding}
            editable={editModeEnabled}
            selectionBarRoom={selectedNodeIds.length > 1}
            pageAhead={pageAhead}
            scrollTarget={scrollTarget}
            onScrollTargetDone={clearScrollTarget}
            actionsRef={listActionsRef}
          />
        )}
        <SelectionBar
          nodeIds={selectedNodeIds}
          labelFor={(id) => flatIndex.get(id)?.name || id}
          onRemove={(id) => selectNode(id, true)}
          onClear={clearSelection}
          onOpenShared={() => useCanvasStore.getState().openNodesDrawer(selectedNodeIds)}
          sharedEditable={canvasWritable}
          expand={selectionExpand}
          placementClassName="left-4 right-4 bottom-16"
        />
        </div>

        {/* Right rail — mutual exclusion: creation takes the rail (an
            explicit action), so the builder is never hidden behind an
            inspector the user left open. Mirrors GraphCanvas. */}
        {builderMounted && (
          <HierarchyBuilderPanel
            onClose={() => useHierarchyBuilderStore.getState().close()}
            onEntityStaged={(_tempUrn, parentUrn) => {
              if (parentUrn) setExpandedNodes(prev => new Set([...prev, parentUrn]))
            }}
          />
        )}
        {buildOpen && (
          <BuildPanel onClose={() => useHierarchyBuilderStore.getState().close()} />
        )}
        {!builderOpen && !buildOpen && (
          <EntityDrawer
            // Edits are draft-only, and a trace is read-only for its whole life.
            canEdit={canvasWritable}
            writesLocked={trace.isTracing}
            onTraceUp={trace.traceUpstream}
            onTraceDown={trace.traceDownstream}
            onFullTrace={trace.traceFullLineage}
            onFocusNode={revealRow}
            onLocateMany={locateRows}
          />
        )}
      </div>{/* end tree + right-rail row */}

      {/* Trace Toolbar */}
      <AnimatePresence>
        {trace.isTracing && (
          <div className="absolute top-20 left-1/2 -translate-x-1/2 z-50">
            <TraceToolbar
              focusNodeName={flatNodes.find(n => n.id === trace.focusId)?.name || trace.focusId || 'Unknown'}
              upstreamCount={trace.upstreamCount}
              downstreamCount={trace.downstreamCount}
              showUpstream={trace.showUpstream}
              showDownstream={trace.showDownstream}
              onToggleUpstream={() => trace.setShowUpstream(!trace.showUpstream)}
              onToggleDownstream={() => trace.setShowDownstream(!trace.showDownstream)}
              onExitTrace={() => trace.clearTrace()}
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

      {/* Advanced search — same SearchMapPanel surface mounted on every
          canvas; its trigger (⌘⇧F) is in the header. The panel is a
          flex-sibling drawer alongside EntityDrawer. */}
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
        knownEntityTypes={activeView?.content.visibleEntityTypes ?? []}
      />

      {/* === UX-FIRST INTERACTION COMPONENTS (Unified with LineageCanvas) === */}

      {/* Context Menu - Right-click on nodes */}
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
          const node = flatNodes.find(n => n.id === id)
          useCreateLinkStore.getState().open({
            sourceUrn: node?.urn || id,
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
        expandActions={expandMenuActions}
      />

      {/* Review & Save — opened from the header's controls, a drawer's "Review & Save", or a
          notification; saves this canvas's staged edits to the draft as one commit. */}
      <StagedChangesPanel
        wsId={scopeWsId} graphId={graphId} dataSourceId={dataSourceId} viewId={viewId}
        onReveal={(id) => {
          useCanvasStore.getState().openNodeDrawer(id)
          revealRow(id)
        }}
        onConfirm={saveToDraft}
      />

      {/* Inline Node Editor - Double-click to edit names */}
      <InlineNodeEditor
        nodeId={interactions.state.inlineEdit.nodeId}
        value={interactions.state.inlineEdit.value}
        position={interactions.state.inlineEdit.position}
        onSave={interactions.saveInlineEdit}
        onCancel={interactions.cancelInlineEdit}
      />

      {/* Command Palette - Press Cmd+Shift+P */}
      <CommandPalette
        isOpen={interactions.state.commandPalette.isOpen}
        onClose={interactions.closeCommandPalette}
        onCreateEntity={editModeEnabled ? (typeId) => {
          interactions.closeCommandPalette()
          useHierarchyBuilderStore.getState().open({ initialTypeId: typeId })
        } : undefined}
        onSelectEntity={(entityId) => selectNode(entityId)}
      />

      {/* Click-based "Link to…" flow — this canvas has no drag-connect, so this
          popover is its only lineage-linking affordance. */}
      <CreateLinkPopover onCreateLink={(s, t, e) => interactions.stageEdgeCreate(s, t, e)} />
    </div>
  )
}

/** What the list's rows and keys call — the canvas's, read through a ref. */
interface HierarchyListActions {
  select: (id: string, e: React.MouseEvent) => void
  toggle: (id: string) => void
  openContextMenu: (e: React.MouseEvent, id: string) => void
  startInlineEdit: (id: string) => void
  expandRows: (ids: readonly string[]) => void
  collapseInside: (ids: readonly string[]) => void
  loadMore: (id: string) => void
  selectNode: (id: string, additive?: boolean) => void
  parentOf: (id: string) => string | undefined
  isContainer: (id: string) => boolean
}

interface HierarchyListProps {
  rows: readonly TreeRow[]
  /** The entity rows alone, in order — what the keys walk — and each one's place among them. */
  visibleRowIds: readonly string[]
  rowIndex: ReadonlyMap<string, number>
  schema: ReturnType<typeof useSchemaStore.getState>['schema']
  selectedIds: ReadonlySet<string>
  expandedNodes: ReadonlySet<string>
  loadingNodes: ReadonlySet<string>
  failedNodes: ReadonlySet<string>
  searchResults: ReadonlySet<string>
  isTraceActive: boolean
  traceContextSet: ReadonlySet<string>
  traceFocusId: string | null
  /** A level run is opening rows: they appear, they do not slide in. */
  expanding: boolean
  /** Double-click renames. */
  editable: boolean
  /** Room at the foot for the selection bar floating over it. */
  selectionBarRoom: boolean
  /** The paging row's one-page-ahead fetch. */
  pageAhead: boolean
  /** A row to bring on screen and pulse once the list holds it — until it expires. */
  scrollTarget: { id: string; until: number } | null
  onScrollTargetDone: () => void
  actionsRef: React.RefObject<HierarchyListActions>
}

/** The rows: ONE flat, virtualized list, as the Context View's columns are (LayerColumn), and the
 *  keys that walk it. Its own component, so a scroll re-renders the rows on screen — not the
 *  canvas, its toolbar and its drawers. */
const HierarchyList = memo(function HierarchyList({
  rows, visibleRowIds, rowIndex, schema, selectedIds, expandedNodes, loadingNodes, failedNodes, searchResults,
  isTraceActive, traceContextSet, traceFocusId, expanding, editable, selectionBarRoom, pageAhead,
  scrollTarget, onScrollTargetDone, actionsRef,
}: HierarchyListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Where each entity sits in the list, for the virtualizer.
  const rowPos = useMemo(() => {
    const pos = new Map<string, number>()
    rows.forEach((r, i) => { if (r.kind === 'node') pos.set(r.node.id, i) })
    return pos
  }, [rows])
  // One identity per list: a new one would have the virtualizer re-measure every row on each render.
  const getItemKey = useCallback((index: number) => {
    const row = rows[index]!
    return row.kind === 'node' ? row.node.id : `more:${row.parent.id}`
  }, [rows])
  const personaMode = usePersonaMode()
  const showEntityIds = usePreferencesStore((s) => s.showCanvasEntityIds) ?? true
  const showTypeBadge = usePreferencesStore((s) => s.showCanvasTypeBadge) ?? true
  const rowEstimate = ROW_ESTIMATE + (personaMode === 'technical' && showEntityIds ? TECHNICAL_LINE : 0)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowEstimate,
    overscan: 8,
    paddingStart: 24,
    // Clear of the selection bar floating over the foot of the list — the last row, and a row
    // the keys bring on screen.
    paddingEnd: selectionBarRoom ? SELECTION_BAR_ROOM : 24,
    scrollPaddingEnd: selectionBarRoom ? SELECTION_BAR_ROOM : 0,
    getItemKey,
  })
  // The persona or Display settings change every row's height: measured sizes held for rows off
  // screen are let go, or the list keeps their old heights (as LayerColumn does).
  useEffect(() => { virtualizer.measure() }, [personaMode, showEntityIds, showTypeBadge, virtualizer])

  // Rows that appeared since the list last changed slide in — the first few, where the reader
  // opened one container. A level opened at once (a run) and the first paint simply appear.
  const seenRowsRef = useRef<ReadonlySet<string> | null>(null)
  const newRows = useMemo(() => {
    const seen = seenRowsRef.current
    if (!seen || expanding) return NO_IDS
    const fresh = new Set<string>()
    for (const id of visibleRowIds) {
      if (fresh.size >= ANIMATE_NEW_MAX) break
      if (!seen.has(id)) fresh.add(id)
    }
    return fresh
  }, [visibleRowIds, expanding])
  useEffect(() => { seenRowsRef.current = new Set(visibleRowIds) }, [visibleRowIds])

  // A row asked for (a reveal, a search hit, the drawer's locate) is brought on screen once the
  // list holds it, and pulses.
  useEffect(() => {
    if (!scrollTarget) return
    if (Date.now() > scrollTarget.until) { onScrollTargetDone(); return }
    const index = rowPos.get(scrollTarget.id)
    if (index === undefined) return
    onScrollTargetDone()
    virtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' })
    useCanvasStore.getState().pulseNode(scrollTarget.id)
  }, [scrollTarget, onScrollTargetDone, rowPos, virtualizer])

  // ── KEYBOARD: the tree is one tab stop and the arrows walk its rows (the WAI-ARIA tree) ──
  // ↑ ↓ Home End move; → opens a row (or steps into it), ← closes it (or steps out); ⇧→ / ⇧←
  // expand the next level / collapse inside, as on the Context View; Space adds the row to the
  // selection, Enter selects it. The ring shows only while the keys are driving.
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [keyNav, setKeyNav] = useState(false)
  const focusRow = useCallback((id: string | undefined) => {
    if (!id) return
    setFocusedId(id)
    setKeyNav(true)
    const index = rowPos.get(id)
    if (index !== undefined) virtualizer.scrollToIndex(index, { align: 'auto' })
  }, [rowPos, virtualizer])
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (visibleRowIds.length === 0) return
    const actions = actionsRef.current
    const at = focusedId !== null ? rowIndex.get(focusedId) : undefined
    const last = visibleRowIds.length - 1
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusRow(visibleRowIds[at === undefined ? 0 : Math.min(at + 1, last)]); return
      case 'ArrowUp': e.preventDefault(); focusRow(visibleRowIds[at === undefined ? 0 : Math.max(at - 1, 0)]); return
      case 'Home': e.preventDefault(); focusRow(visibleRowIds[0]); return
      case 'End': e.preventDefault(); focusRow(visibleRowIds[last]); return
    }
    const id = at !== undefined ? visibleRowIds[at] : undefined
    if (!id) return
    // Typed on a control inside a row, Space and Enter are the control's.
    const onTree = e.target === e.currentTarget
    switch (e.key) {
      case 'ArrowRight': {
        e.preventDefault()
        const below = visibleRowIds[at! + 1]
        if (e.shiftKey) actions.expandRows([id])
        else if (!expandedNodes.has(id)) { if (actions.isContainer(id)) actions.toggle(id) }
        else if (below && actions.parentOf(below) === id) focusRow(below)
        return
      }
      case 'ArrowLeft':
        e.preventDefault()
        if (e.shiftKey) actions.collapseInside([id])
        else if (expandedNodes.has(id)) actions.toggle(id)
        else focusRow(actions.parentOf(id))
        return
      case ' ':
        if (!onTree) return
        e.preventDefault()
        actions.selectNode(id, true)
        return
      case 'Enter': {
        if (!onTree || e.metaKey || e.ctrlKey) return
        // Enter on the row already selected is the canvas's "Enter — Edit Selected": let it
        // through. Selecting, it stops here, or the canvas would also edit what WAS selected.
        if (selectedIds.size === 1 && selectedIds.has(id)) return
        e.stopPropagation()
        actions.selectNode(id)
        return
      }
    }
  }, [visibleRowIds, focusedId, rowIndex, focusRow, expandedNodes, selectedIds, actionsRef])

  // The rows' handlers keep one identity, so a row re-renders for what it shows.
  const onRowSelect = useCallback((id: string, e: React.MouseEvent) => {
    setFocusedId(id)
    actionsRef.current.select(id, e)
  }, [actionsRef])
  const onRowToggle = useCallback((id: string) => actionsRef.current.toggle(id), [actionsRef])
  const onRowContextMenu = useCallback((e: React.MouseEvent, id: string) => actionsRef.current.openContextMenu(e, id), [actionsRef])
  const onRowDoubleClick = useCallback((id: string) => actionsRef.current.startInlineEdit(id), [actionsRef])

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label="Hierarchy"
      aria-multiselectable
      aria-activedescendant={keyNav && focusedId && rowIndex.has(focusedId) ? `hierarchy-node-${focusedId}` : undefined}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onFocus={(e) => {
        // Tabbed in (not clicked): the ring shows at once, on the row the keys start from — the
        // one they left, the row selected, or the first on screen — brought into view.
        if (e.target !== e.currentTarget || !isFocusVisible(e.currentTarget)) return
        const onScreen = virtualizer.getVirtualItems().map((v) => rows[v.index]).find((r) => r?.kind === 'node')
        focusRow(focusedId && rowIndex.has(focusedId)
          ? focusedId
          : [...selectedIds].find((id) => rowIndex.has(id)) ?? (onScreen?.kind === 'node' ? onScreen.node.id : undefined))
      }}
      onBlur={() => setKeyNav(false)}
      onPointerDown={() => setKeyNav(false)}
      className="relative h-full overflow-auto custom-scrollbar outline-none"
    >
      <div className="relative mx-6" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className={cn('absolute left-0 top-0 w-full pb-2', row.kind === 'node' && row.depth === 0 && item.index > 0 && 'pt-1')}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {/* Guide rails, one per level above, in that level's colour: what a nested
                  card's border used to say — "inside this" — in a list that is flat. */}
              {row.guides.map((color, i) => (
                <span
                  key={i}
                  aria-hidden
                  className="absolute top-0 bottom-0 w-px pointer-events-none"
                  style={{ left: i * INDENT + INDENT / 2, background: `color-mix(in srgb, ${color} 40%, transparent)` }}
                />
              ))}
              {row.kind === 'node' ? (
                <HierarchyRow
                  node={row.node}
                  depth={row.depth}
                  posInSet={row.posInSet}
                  setSize={row.setSize}
                  schema={schema}
                  isSelected={selectedIds.has(row.node.id)}
                  isExpanded={expandedNodes.has(row.node.id)}
                  isLoading={loadingNodes.has(row.node.id)}
                  isSearchResult={searchResults.has(row.node.id)}
                  isFocused={keyNav && focusedId === row.node.id}
                  animateIn={newRows.has(row.node.id)}
                  onSelect={onRowSelect}
                  onToggle={onRowToggle}
                  onContextMenu={onRowContextMenu}
                  onDoubleClick={editable ? onRowDoubleClick : undefined}
                  isTraceActive={isTraceActive}
                  isHighlighted={isTraceActive && traceContextSet.has(row.node.id)}
                  isFocusNode={traceFocusId === row.node.id}
                />
              ) : (
                <div role="none" style={{ marginLeft: row.depth * INDENT }}>
                  <LoadMoreItem
                    parentId={row.parent.id}
                    depth={0}
                    parentIsLast={[]}
                    count={row.remaining}
                    // Nothing of it here yet: its first page is loading, or queued.
                    isLoading={loadingNodes.has(row.parent.id)
                      || (row.parent.children.length === 0 && !failedNodes.has(row.parent.id))}
                    failed={failedNodes.has(row.parent.id) && !loadingNodes.has(row.parent.id)}
                    onLoadMore={() => actionsRef.current.loadMore(row.parent.id)}
                    // Re-armed only once the list has grown, so it pages as the reader
                    // scrolls to it — never a container drained unattended. Not for a
                    // level a search's path opened: the reader was carried there.
                    autoLoad={pageAhead && !holdsOnlyRevealedChildren(row.parent)}
                    rearmKey={visibleRowIds.length}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})

interface HierarchyRowProps {
  node: HierarchyNode
  /** Its level: 0 for a root. */
  depth: number
  /** Its place among the siblings drawn with it, and how many there are. */
  posInSet: number
  setSize: number
  schema: ReturnType<typeof useSchemaStore.getState>['schema']
  isSelected: boolean
  isExpanded: boolean
  /** A page of its children is on its way. */
  isLoading: boolean
  isSearchResult: boolean
  /** The keys are on this row. */
  isFocused: boolean
  /** Newly shown, and few enough to slide in. */
  animateIn: boolean
  onSelect: (id: string, event: React.MouseEvent) => void
  onToggle: (id: string) => void
  onContextMenu: (e: React.MouseEvent, nodeId: string) => void
  onDoubleClick?: (nodeId: string, event: React.MouseEvent) => void
  // Trace highlighting props
  isTraceActive: boolean
  /** In the trace, or an ancestor keeping one in view. */
  isHighlighted: boolean
  isFocusNode: boolean
}

/** One row of the list: an entity's card, indented to its level. Its children are rows of their own. */
const HierarchyRow = memo(function HierarchyRow({
  node,
  depth,
  posInSet,
  setSize,
  schema,
  isSelected,
  isExpanded,
  isLoading,
  isSearchResult,
  isFocused,
  animateIn,
  onSelect,
  onToggle,
  onContextMenu,
  onDoubleClick,
  isTraceActive,
  isHighlighted,
  isFocusNode,
}: HierarchyRowProps) {
  const entityType = schema?.entityTypes.find((et) => et.id === node.typeId)
  const visual = entityType?.visual
  const childCount = (node.data.childCount as number) || 0
  const hasChildren = node.children.length > 0 || childCount > 0
  // Where a click doesn't open an entity's details, its row offers them.
  const offerDetails = !useOpensDetailsOnSelect()
  // The jump-to-row pulse (a reveal, a locate).
  const isPulsing = useCanvasStore((s) => s.pulseNodeIds.has(node.id))

  // W2.1 — advanced-search match decoration. Lights up the row when
  // the URN is a direct match, surfaces an N-level subtree count
  // badge when this is a collapsed ancestor of matches, and dims
  // the row when spotlight mode is active and nothing in this
  // subtree matched.
  const {
    isDirectMatch: isAdvancedSearchMatch,
    ancestorMatchCount,
    ancestorBreakdown,
    isSpotlightDim,
  } = useSearchHighlight(node.urn ?? node.id, { isSelected })
  // Change decoration — staged (dashed) + committed-vs-main (solid), default-on on a draft.
  const changeDeco = useEntityDecoration(node.urn ?? node.id)
  // Technical mode's ID under the name: the data source's identifier property, else the URN —
  // left out when it is the name, or when Display settings hide the IDs.
  const personaMode = usePersonaMode()
  const identityProperty = useCanvasIdentityProperty()
  const showEntityIds = usePreferencesStore((s) => s.showCanvasEntityIds) ?? true
  // Display's "Show entity type badge", as on Context View rows.
  const showTypeBadge = usePreferencesStore((s) => s.showCanvasTypeBadge) ?? true
  const technical = showEntityIds
    ? technicalIdentity(node.data, personaMode, { identityProperty, urn: node.urn, name: node.name })
    : undefined

  // The view's display rules: a tint and a frame for this card. A focus, a
  // trace highlight or a change decoration paints the same card, and wins.
  const ruleLook = useDisplayRuleLook(changeDeco || isFocusNode || isHighlighted ? undefined : (node.urn ?? node.id))
  const isDimmed = (isTraceActive && !isHighlighted) || isSpotlightDim

  // Calculate roll-up counts
  const rollUpCounts = useMemo(() => {
    if (hasChildren && !isExpanded) {
      return countDescendants(node)
    }
    return null
  }, [node, hasChildren, isExpanded])

  // Format roll-up display
  const rollUpDisplay = useMemo(() => {
    if (!rollUpCounts || !schema) return null

    const parts: string[] = []
    Object.entries(rollUpCounts.byType).forEach(([typeId, count]) => {
      const type = schema.entityTypes.find((et) => et.id === typeId)
      if (type) {
        parts.push(`${count} ${count === 1 ? type.name.toLowerCase() : type.pluralName.toLowerCase()}`)
      }
    })

    return parts.join(', ')
  }, [rollUpCounts, schema])

  return (
    <motion.div
      id={`hierarchy-node-${node.id}`}
      role="treeitem"
      aria-level={depth + 1}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-selected={isSelected}
      initial={animateIn ? { opacity: 0, x: -8 } : false}
      animate={{ opacity: 1, x: 0 }}
      transition={MOTION.fadeIn}
      style={{ marginLeft: depth * INDENT }}
      className="relative"
    >
      {/* Node Container */}
      <div
        className={cn(
          "relative rounded-xl border-2 overflow-hidden transition-all duration-200",
          "bg-canvas-elevated",
          isPulsing && "lineage-pulse",
          // Where the keys are — the selection's ring keeps its own colour.
          isFocused && "outline outline-2 outline-offset-2 outline-accent-lineage/60",
          isSelected && !isFocusNode && "ring-2 ring-offset-2",
          isSearchResult && !isSelected && "ring-2 ring-amber-400/50 ring-offset-1",
          // W2.1 — advanced-search direct-match glow (reuses the
          // shared ``search-match-pulse`` keyframes already used by
          // FlatTreeItem so all canvases pulse identically).
          isAdvancedSearchMatch && !isSelected && !isFocusNode
            && "ring-2 ring-amber-500/60 shadow-[0_0_22px_-2px_rgba(245,158,11,0.55)] search-match-pulse",
          // Trace styling - consistent across all canvases
          isFocusNode && "ring-4 ring-amber-400 ring-offset-2 shadow-[0_0_30px_rgba(251,191,36,0.5)] scale-[1.02] z-50",
          isHighlighted && !isFocusNode && "ring-2 ring-purple-400 ring-offset-1 shadow-[0_0_15px_rgba(192,132,252,0.3)]",
          isDimmed && "opacity-30 grayscale-[0.6] blur-[0.3px] scale-[0.98]",
          // Change decoration — dashed=staged (unsaved), solid=committed (not merged); color by type.
          !isSelected && !isFocusNode && nodeDecorationClass(changeDeco),
        )}
        style={{
          borderColor: isFocusNode ? '#fbbf24' : isHighlighted ? '#c084fc' : visual?.color ?? '#6b7280',
          borderLeftWidth: '4px',
          ['--tw-ring-color' as string]: isFocusNode ? '#fbbf24' : isHighlighted ? '#c084fc' : visual?.color ?? '#6b7280',
          ...(ruleLook.fillColor && {
            backgroundColor: `color-mix(in srgb, ${ruleLook.fillColor} 14%, var(--nx-bg-elevated))`,
          }),
          ...(ruleLook.frameKind && {
            outline: `2px ${ruleLook.frameKind} ${ruleLook.frameColor}`,
            outlineOffset: 2,
          }),
        }}
      >
        {/* Header (always visible) */}
        <div
          className={cn(
            "group/row flex items-center gap-3 px-4 py-3 cursor-pointer",
            "hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          )}
          // Shift-click takes a range; without this the browser also paints a text selection
          // across every row between the two clicks.
          onMouseDown={(e) => { if (e.shiftKey) e.preventDefault() }}
          onClick={(e) => onSelect(node.id, e)}
          onDoubleClick={(e) => onDoubleClick?.(node.id, e)}
          onContextMenu={(e) => {
            e.preventDefault()
            onContextMenu?.(e, node.id)
          }}
        >
          {/* Expand/Collapse Button */}
          {hasChildren && (
            <button
              // The tree's arrow keys open and close rows; one tab stop per row would be thousands.
              tabIndex={-1}
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${node.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onToggle(node.id)
              }}
              className={cn(
                "w-6 h-6 rounded-md flex items-center justify-center",
                "hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
              )}
              style={{ color: visual?.color ?? '#6b7280' }}
            >
              <motion.div
                animate={{ rotate: isExpanded && !isLoading ? 90 : 0 }}
                transition={{ duration: 0.15 }}
              >
                {isLoading
                  ? <LucideIcons.Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                  : <LucideIcons.ChevronRight className="w-4 h-4" />}
              </motion.div>
            </button>
          )}

          {/* Spacer if no children */}
          {!hasChildren && <div className="w-6" />}


          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {showTypeBadge && (
                <span
                  className="text-2xs font-medium uppercase tracking-wider"
                  style={{ color: visual?.color ?? '#6b7280' }}
                >
                  {entityType?.name ?? node.typeId}
                </span>
              )}
              {hasChildren && (
                // What it holds, loaded or not — "0" on a container never opened read as empty.
                <span className="px-1.5 py-0.5 rounded text-2xs font-medium bg-black/5 dark:bg-white/10 text-ink-muted">
                  {Math.max(node.children.length, childCount).toLocaleString()}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <h4 className="text-sm font-medium text-ink truncate flex-1 min-w-0">
                {node.name}
              </h4>
              {/* W2.1 — N-level subtree match count. Shown only on
                  collapsed rows so the badge doesn't double-up
                  the visible matches once the user expands. */}
              {ancestorMatchCount > 0 && !isExpanded && hasChildren && schema && (
                <SearchMatchBadge
                  count={ancestorMatchCount}
                  breakdown={ancestorBreakdown}
                  schema={schema}
                />
              )}
            </div>

            {/* Technical identity — head-truncated, as on Context View rows: sibling URNs share a
                long prefix, so an end ellipsis would cut the part that tells them apart. */}
            {technical && (
              <HoverTip label={<span className="break-all">{`${technical.property}: ${technical.value}`}</span>} className="block min-w-0 mt-0.5">
                <span
                  className="block text-[10px] font-mono text-ink-muted/70 truncate"
                  style={{ direction: 'rtl', textAlign: 'left' }}
                >
                  {technical.value}
                </span>
              </HoverTip>
            )}

            {/* Roll-up counts when collapsed */}
            {rollUpDisplay && !isExpanded && (
              <p className="text-2xs text-ink-muted mt-0.5">
                Contains {rollUpDisplay}
              </p>
            )}
          </div>

          {/* Tags */}
          {node.data.classifications && Array.isArray(node.data.classifications) && (
            <div className="flex items-center gap-1">
              {(node.data.classifications as string[]).filter(Boolean).slice(0, 2).map((tag, idx) => (
                <span
                  key={`${tag}-${idx}`}
                  className="px-1.5 py-0.5 rounded text-2xs font-medium"
                  style={{ backgroundColor: `${visual?.color ?? '#6b7280'}15`, color: visual?.color ?? '#6b7280' }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Display-rule tags — shared premium chip cluster (same as the
              other canvases). */}
          <DisplayRuleTagChips urn={node.urn ?? node.id} size="xs" />
          {/* Questions asked about this row (nothing otherwise). */}
          <QuestionRowMark urn={node.urn ?? node.id} label={node.name} />

          {/* Details on demand — hover-visible, and kept on the selected row. */}
          {offerDetails && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                useCanvasStore.getState().openNodeDrawer(node.id)
              }}
              className={cn(
                'flex items-center justify-center w-6 h-6 rounded-md hover:bg-black/10 dark:hover:bg-white/10 transition-all hover:scale-110 active:scale-95',
                isSelected ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
              )}
              aria-label={`Open details of ${node.name}`}
            >
              <LucideIcons.PanelRightOpen className="w-4 h-4 text-ink-muted" />
            </button>
          )}

          {/* Add child — hover-visible; direct store import so the list never threads an
              onAddChild prop to every row. */}
          {(entityType?.hierarchy?.canContain?.length ?? 0) > 0 && (
            <HoverTip label={`Add inside ${node.name}`} detail="Opens the builder with this as the parent" className="inline-flex">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  useHierarchyBuilderStore.getState().open({ parentUrn: node.urn ?? node.id })
                }}
                className="opacity-0 group-hover/row:opacity-100 flex items-center justify-center w-6 h-6 rounded-md hover:bg-black/10 dark:hover:bg-white/10 transition-all hover:scale-110 active:scale-95"
                aria-label={`Add inside ${node.name}`}
              >
                <LucideIcons.Plus className="w-4 h-4" style={{ color: visual?.color ?? '#6b7280' }} />
              </button>
            </HoverTip>
          )}

          {/* Expand indicator */}
          {hasChildren && !isExpanded && (
            <div className="flex items-center gap-1 text-ink-muted">
              <LucideIcons.MoreHorizontal className="w-4 h-4" />
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
})

/** Focus that came from the keys, not a click — where the browser can tell. */
function isFocusVisible(el: HTMLElement): boolean {
  try { return el.matches(':focus-visible') } catch { return true }
}

/** Every child of `node` on the canvas came with a search's path, none with a page of its own. */
function holdsOnlyRevealedChildren(node: HierarchyNode): boolean {
  return node.children.length > 0
    && node.children.every((child) => (child.data as { viaReveal?: boolean } | undefined)?.viaReveal === true)
}

/** The toolbar's Expand, for the whole tree: the next level at each press — or, with All levels
 *  on (the remembered preference the Context View's Expand shares), every level, pausing every
 *  2,000 entities loaded. While a run goes, the way to stop it; paused — whichever rows it was
 *  started from — its choices, so closing its prompt never strands it. */
function TreeExpandControl({ allLevels, onToggleAllLevels, onExpand, running, paused, onResume, onStop }: {
  allLevels: boolean
  onToggleAllLevels: () => void
  /** Absent with nothing to open. */
  onExpand?: () => void
  running: boolean
  paused: PausedRun | null
  onResume: (how: 'more' | 'all') => void
  onStop: () => void
}) {
  const segment = cn(
    'flex items-center gap-1.5 h-8 text-xs font-medium whitespace-nowrap transition-colors duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-lineage/40',
  )
  if (paused) {
    const choice = cn(segment, 'px-2.5 hover:bg-accent-lineage/15')
    return (
      <span
        role="group"
        aria-label={paused.message}
        className="flex items-center rounded-lg border border-accent-lineage/30 bg-accent-lineage/10 text-accent-lineage overflow-hidden"
      >
        <HoverTip className="inline-flex" label={paused.message} detail={paused.detail}>
          <button type="button" onClick={() => onResume('more')} className={choice}>
            <LucideIcons.ChevronsDown className="w-3.5 h-3.5" strokeWidth={2.2} aria-hidden />
            {RESUME_LABELS.more}
          </button>
        </HoverTip>
        <HoverTip className="inline-flex" label="Open everything still closed" detail="Without pausing again">
          <button type="button" onClick={() => onResume('all')} className={cn(choice, 'border-l border-accent-lineage/30')}>
            <LucideIcons.ArrowDownToLine className="w-3.5 h-3.5" strokeWidth={2.2} aria-hidden />
            {RESUME_LABELS.all}
          </button>
        </HoverTip>
        <HoverTip className="inline-flex" label={RESUME_LABELS.stop} detail="What has loaded stays open">
          <button type="button" onClick={onStop} className={cn(choice, 'border-l border-accent-lineage/30')}>
            <LucideIcons.CircleStop className="w-3.5 h-3.5" strokeWidth={2.2} aria-hidden />
            {RESUME_LABELS.stop}
          </button>
        </HoverTip>
      </span>
    )
  }
  if (running) {
    return (
      <HoverTip className="inline-flex" label="Stop opening" detail="What has loaded stays open">
        <button
          type="button"
          onClick={onStop}
          className={cn(segment, 'px-2.5 rounded-lg border border-accent-lineage/30 bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/15')}
        >
          {/* The selection bar's Stop, not a spinner: a run paused at a checkpoint is not busy. */}
          <LucideIcons.CircleStop className="w-3.5 h-3.5" strokeWidth={2.2} aria-hidden />
          Stop opening
        </button>
      </HoverTip>
    )
  }
  return (
    <span
      role="group"
      aria-label="Expand the hierarchy"
      className="flex items-center rounded-lg border border-glass-border bg-black/[0.03] dark:bg-white/[0.04] overflow-hidden"
    >
      <HoverTip
        className="inline-flex"
        label={!onExpand ? 'Everything is open' : allLevels ? 'Open every level' : 'Open the next level'}
        detail={!onExpand
          ? 'Collapse all to start again from the top'
          : allLevels
            ? 'A level at a time, loading what is inside — pausing every 2,000 entities to ask'
            : 'Each press opens one level deeper, loading what is inside'}
      >
        <button
          type="button"
          onClick={onExpand}
          disabled={!onExpand}
          aria-label={allLevels ? 'Expand all levels' : 'Expand next level'}
          className={cn(segment, 'px-2 text-ink hover:text-accent-lineage hover:bg-black/[0.04] dark:hover:bg-white/[0.06] disabled:opacity-40 disabled:pointer-events-none')}
        >
          {allLevels
            ? <LucideIcons.ChevronsDown className="w-4 h-4" aria-hidden />
            : <LucideIcons.ChevronDown className="w-4 h-4" aria-hidden />}
        </button>
      </HoverTip>
      <HoverTip
        className="inline-flex"
        label={allLevels ? 'All levels at once' : 'One level at a time'}
        detail={allLevels ? 'Switch off to open one level per press' : 'Switch on to open every level, with checkpoints'}
      >
        <button
          type="button"
          role="switch"
          aria-checked={allLevels}
          aria-label="All levels"
          onClick={onToggleAllLevels}
          className={cn(segment, 'gap-1.5 pl-2 pr-2.5 text-[11px] text-ink-muted hover:text-ink border-l border-glass-border')}
        >
          All levels
          <span className={cn('relative inline-flex h-3.5 w-6 rounded-full transition-colors', allLevels ? 'bg-accent-lineage' : 'bg-black/15 dark:bg-white/20')}>
            <span className={cn('absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-transform', allLevels ? 'translate-x-3' : 'translate-x-0.5')} />
          </span>
        </button>
      </HoverTip>
    </span>
  )
}

