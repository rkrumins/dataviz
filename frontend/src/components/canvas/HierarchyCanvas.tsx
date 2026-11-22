/**
 * HierarchyCanvas - Hierarchy-style Reference Model View
 * 
 * Displays entities in a hierarchical nested container structure with:
 * - Collapsible containers that roll up children
 * - Left-to-right flow across hierarchy levels
 * - Search to find and expand to any node
 * - Roll-up counts (e.g., "15 tables, 247 columns")
 * - Progressive expansion from root to leaf
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
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
  const { loadChildren, cancelChildLoad, loadingNodes, failedNodes, loadMoreFeeds, isLoading: isLoadingChildren } = useGraphHydration()
  useLoadingNotification('hier-children', isLoadingChildren, 'Expanding hierarchy')
  // Legacy inline quick-filter (substring over visible nodes) — left
  // in place as a complementary quick-filter alongside the new
  // server-side SearchMapPanel. Full removal is tracked separately
  // because the searchResults prop is consumed by several sub-trees.
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<string[]>([])
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const searchInputRef = useRef<HTMLInputElement>(null)
  const pendingLoadRef = useRef<Set<string>>(new Set())
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
  const revealSearchHit = useRevealSearchHit({ setExpandedNodes, provider })

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
  const personaMode = usePersonaMode()
  const hierarchyTree = useMemo(() => {
    if (!nodes.length) return []

    const buildTree = (nodeId: string, depth: number): HierarchyNode | null => {
      const node = nodeMap.get(nodeId)
      if (!node) return null

      const children = (childMap.get(nodeId) ?? [])
        .map((childId) => buildTree(childId, depth + 1))
        .filter((n): n is HierarchyNode => n !== null)
        .sort((a, b) => a.name.localeCompare(b.name))

      return {
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
    setTimeout(() => {
      const element = document.getElementById(`hierarchy-node-${first}`)
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      useCanvasStore.getState().pulseNode(first)
    }, 100)
    return true
  }, [flatIndex])
  const revealRow = useCallback((nodeId: string) => { revealRows([nodeId]) }, [revealRows])
  const locateRows = useCallback((nodeIds: string[]) => { revealRows(nodeIds) }, [revealRows])

  // Expand path to search result, and select it
  const expandToNode = useCallback((nodeId: string) => {
    if (revealRows([nodeId])) selectNode(nodeId)
  }, [revealRows, selectNode])
  // "Show on canvas" from a question opens the path the same way.
  useCanvasReveal(expandToNode)

  // The rows on screen, in the order they are drawn: a collapsed subtree contributes nothing.
  const visibleRowIds = useMemo(() => {
    const ids: string[] = []
    const walk = (n: HierarchyNode) => {
      ids.push(n.id)
      if (expandedNodes.has(n.id)) n.children.forEach(walk)
    }
    hierarchyTree.forEach(walk)
    return ids
  }, [hierarchyTree, expandedNodes])
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
      return
    }

    // 2. Load Children using Generic Hook
    pendingLoadRef.current.add(nodeId)
    try {
      await loadChildren(nodeId)
    } finally {
      pendingLoadRef.current.delete(nodeId)
    }
  }, [loadChildren, cancelChildLoad, expandedNodes])

  // Expand/collapse all
  const expandAll = useCallback(() => {
    const allIds = flatNodes.map((n) => n.id)
    setExpandedNodes(new Set(allIds))
  }, [flatNodes])

  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set())
  }, [])

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

  return (
    <div className={cn("h-full w-full flex flex-col overflow-hidden bg-canvas relative", className)}>
      {/* Roots/orphans beyond the first page — reachable, and said so. */}
      <FeedMoreChip loadingNodes={loadingNodes} failedNodes={failedNodes} onLoadMore={keys => void loadMoreFeeds(keys)} />
      {/* The toolbar — the same tools in both views (CanvasToolRow). The rows draw no lineage
          lines, so there is no Lineage switch. */}
      <CanvasToolRow
        lead={
          <div className="flex items-center gap-1">
            <HoverTip className="inline-flex" label="Open every row" detail="Shows everything inside each entity">
              <button type="button" onClick={expandAll} aria-label="Expand all" className="btn btn-ghost btn-sm">
                <LucideIcons.ChevronsDownUp className="w-4 h-4 rotate-180" />
              </button>
            </HoverTip>
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
        <div className={cn('relative h-full overflow-auto p-6 custom-scrollbar', selectedNodeIds.length > 1 && 'pb-24')}>
          {hierarchyTree.length === 0 ? (
            !isHydratingInitial && <BuilderEmptyState />
          ) : (
            <div className="space-y-3">
              {hierarchyTree.map((rootNode) => (
                <HierarchyContainer
                  key={rootNode.id}
                  node={rootNode}
                  schema={schema}
                  selectedIds={selectedIdSet}
                  expandedNodes={expandedNodes}
                  searchResults={searchResults}
                  onSelect={handleRowSelect}
                  onToggle={toggleNode}
                  onContextMenu={(e, nodeId) => {
                    interactions.openContextMenu(e, {
                      type: 'node',
                      id: nodeId,
                      data: flatNodes.find(n => n.id === nodeId)?.data || {}
                    })
                  }}
                  onDoubleClick={!editModeEnabled ? undefined : (nodeId, e) => {
                    const node = flatNodes.find(n => n.id === nodeId)
                    const element = document.getElementById(`hierarchy-node-${nodeId}`)
                    if (element && node) {
                      const rect = element.getBoundingClientRect()
                      interactions.startInlineEdit(
                        nodeId,
                        node.name,
                        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
                        (node.data.businessLabel as string | undefined)?.trim() ? 'businessLabel' : 'label',
                      )
                    }
                  }}
                  isTraceActive={trace.isTracing}
                  traceContextSet={traceContextSet}
                  traceFocusId={trace.focusId}
                />
              ))}
            </div>
          )}
        </div>
        <SelectionBar
          nodeIds={selectedNodeIds}
          labelFor={(id) => flatIndex.get(id)?.name || id}
          onRemove={(id) => selectNode(id, true)}
          onClear={clearSelection}
          onOpenShared={() => useCanvasStore.getState().openNodesDrawer(selectedNodeIds)}
          sharedEditable={canvasWritable}
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

interface HierarchyContainerProps {
  node: HierarchyNode
  schema: ReturnType<typeof useSchemaStore.getState>['schema']
  selectedIds: ReadonlySet<string>
  expandedNodes: Set<string>
  searchResults: string[]
  onSelect: (id: string, event: React.MouseEvent) => void
  onToggle: (id: string) => void
  onContextMenu?: (e: React.MouseEvent, nodeId: string) => void
  onDoubleClick?: (nodeId: string, event: React.MouseEvent) => void
  depth?: number
  // Trace highlighting props
  isTraceActive?: boolean
  traceContextSet?: Set<string>
  traceFocusId?: string | null
}

function HierarchyContainer({
  node,
  schema,
  selectedIds,
  expandedNodes,
  searchResults,
  onSelect,
  onToggle,
  onContextMenu,
  onDoubleClick,
  depth = 0,
  isTraceActive = false,
  traceContextSet = new Set(),
  traceFocusId = null,
}: HierarchyContainerProps) {
  const entityType = schema?.entityTypes.find((et) => et.id === node.typeId)
  const visual = entityType?.visual
  const childCount = (node.data.childCount as number) || 0
  const hasChildren = node.children.length > 0 || childCount > 0
  const isExpanded = expandedNodes.has(node.id)
  const isSelected = selectedIds.has(node.id)
  const isSearchResult = searchResults.includes(node.id)
  // Where a click doesn't open an entity's details, its row offers them.
  const offerDetails = !useOpensDetailsOnSelect()

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
    isHidden: isHiddenByCanvasFilter,
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

  // Trace highlighting
  const isHighlighted = isTraceActive && traceContextSet.has(node.id)
  const isFocusNode = traceFocusId === node.id
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

  // Canvas filter Isolate / Hide modes drop this row entirely — after every
  // hook, so a row that is hidden and shown again runs the same hooks.
  if (isHiddenByCanvasFilter) return null

  // Indentation based on depth
  const indent = depth * 24

  return (
    <div
      id={`hierarchy-node-${node.id}`}
      style={{ marginLeft: indent }}
      className="relative"
    >
      {/* Connector line */}
      {depth > 0 && (
        <div
          className="absolute left-0 top-0 bottom-0 w-px bg-glass-border"
          style={{ left: -12 }}
        />
      )}

      {/* Node Container */}
      <motion.div
        layout
        className={cn(
          "relative rounded-xl border-2 overflow-hidden transition-all duration-200",
          "bg-canvas-elevated",
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
                animate={{ rotate: isExpanded ? 90 : 0 }}
                transition={{ duration: 0.15 }}
              >
                <LucideIcons.ChevronRight className="w-4 h-4" />
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
                <span className="px-1.5 py-0.5 rounded text-2xs font-medium bg-black/5 dark:bg-white/10 text-ink-muted">
                  {node.children.length}
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

          {/* Add child — hover-visible; direct store import so the recursive
              render never threads an onAddChild prop down every level. */}
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

        {/* Children (collapsible) */}
        <AnimatePresence>
          {hasChildren && isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="px-4 pb-4 pt-1 space-y-2 border-t border-glass-border/50">
                {node.children.map((child) => (
                  <HierarchyContainer
                    key={child.id}
                    node={child}
                    schema={schema}
                    selectedIds={selectedIds}
                    expandedNodes={expandedNodes}
                    searchResults={searchResults}
                    onSelect={onSelect}
                    onToggle={onToggle}
                    onContextMenu={onContextMenu}
                    onDoubleClick={onDoubleClick}
                    depth={depth + 1}
                    isTraceActive={isTraceActive}
                    traceContextSet={traceContextSet}
                    traceFocusId={traceFocusId}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}

