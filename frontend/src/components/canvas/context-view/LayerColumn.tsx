/**
 * LayerColumn - Single column in the Context View representing a data layer
 *
 * Features:
 * - Collapsible with vertical text
 * - Breadcrumb navigation for focused subtrees
 * - Virtualized flat tree rendering with expand/collapse (scales to 1000+ items)
 * - Inline search and load-more support
 * - Keyboard navigation (arrow keys, home/end, enter)
 */

import React, { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { useSchemaStore } from '@/store/schema'
import { usePreferencesStore } from '@/store/preferences'
import {
  useAncestorMatchCounts,
  useCanvasFilterMode,
  useMatchUrnSet,
} from '@/store/searchStore'
import type { ViewLayerConfig } from '@/types/schema'
import type { HierarchyNode, FlatTreeNode, ColumnGeometryApi, AnchorProxyGroup } from './types'
import { FlatTreeItem } from './FlatTreeItem'
import { LoadMoreItem } from './LoadMoreItem'
import { SearchBoxItem } from './SearchBoxItem'
import { GhostFlatTreeItem, GHOST_COUNT_PER_LAYER } from './GhostFlatTreeItem'
import { densityRowHeights } from './density'

interface LayerColumnProps {
  layer: ViewLayerConfig
  nodes: HierarchyNode[]
  schema: ReturnType<typeof useSchemaStore.getState>['schema']
  selectedNodeId: string | null
  expandedNodes: Set<string>
  searchResults: ReadonlySet<string>
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void
  onDoubleClick: (id: string, event?: React.MouseEvent) => void
  onAddChild?: (parentId: string) => void
  onAddToLayer?: (layerId: string) => void
  /**
   * True only for a `kind === 'blank'` model — one authored from nothing.
   *
   * It changes what an empty column MEANS, and therefore what it must say. In a Context View
   * the entities exist perfectly well in the graph; this column simply has none ASSIGNED to it,
   * and telling the user "No entities yet" says their data is missing when it is not — the most
   * alarming thing you can tell someone about their own graph. In a blank model nothing has been
   * created yet, and "No entities yet" is exactly right.
   */
  isBlankModel?: boolean
  /** "Build a lot at once" scoped to this layer — a quieter sibling of onAddToLayer. */
  onBuildToLayer?: (layerId: string) => void
  /** When set (draft/authoring mode), enables the hover connection handle on cards. */
  onBeginConnect?: (sourceId: string, start: { x: number; y: number }) => void
  /** Right-click on empty space in this layer column (draft/authoring mode). */
  onLayerContextMenu?: (e: React.MouseEvent, layerId: string) => void
  traceFocusId: string | null
  traceNodes: Set<string>
  traceContextSet: Set<string>
  isTracing?: boolean
  highlightedNodes?: Set<string>
  isHighlightActive?: boolean
  isHoverHighlight?: boolean
  onAnimationComplete?: () => void
  onLoadMore?: (parentId: string) => void
  onSearchChildren?: (parentId: string, query: string) => void
  isLoadingChildren?: boolean
  loadingNodes?: Set<string>
  failedNodes?: Set<string>
  onScroll?: () => void
  onAssignToLayer?: (entityId: string) => void
  /** Draft-only layer management. Presence gates each affordance — the parent passes these only in
   *  Edit mode, so View mode stays read-only. Reorder moves the column; its nodes/edges follow. */
  onRenameLayer?: (layerId: string, name: string) => void
  onDeleteLayer?: (layerId: string) => void
  onReorderLayer?: (draggedLayerId: string, targetLayerId: string) => void
  /** True during initial canvas hydration when this layer has no nodes yet.
   * Shows the ghost-card stack instead of the "No entities yet" empty state.
   * See ContextViewCanvas where this is computed from useCanvasStore.hydrationPhase. */
  isHydratingInitial?: boolean
  /** Pulse signal from a "Reveal in canvas" action. When this changes,
   *  the column scrolls the matching row into view via the virtualizer
   *  (DOM scrolling can't work — rows below the overscan window aren't
   *  mounted). Columns that don't own the URN no-op. */
  revealTarget?: { id: string; pulse: number } | null
  /** Shared registry the column registers its geometry API into (keyed
   *  by layer id) so the edge overlay can estimate row positions for
   *  unmounted rows via the virtualizer's measurements cache. */
  geometryRegistry?: Map<string, ColumnGeometryApi>
  /** Virtualizer overscan override — the canvas shrinks it at zoom-out
   *  (the enlarged layout viewport already supplies the extra rows). */
  overscan?: number
  /** Per-node lineage in/out counts (from the canvas's projected set) —
   *  drives the density gutter. */
  lineageCounts?: Map<string, { in: number; out: number }>
  /** Show the connection-density gutter (summarized edge modes only). */
  showDensityGutter?: boolean
  /** Anchor Rail — the selected node's off-screen partners that live in
   *  THIS column, docked as proxy chips the edge overlay anchors to. */
  anchorProxies?: AnchorProxyGroup
  /** Chip click — scroll the real row into view (per-partner Frame). */
  onProxyReveal?: (nodeId: string) => void
  /** "+N more" overflow — open the Lineage Lens for the full list. */
  onProxyMore?: () => void
}

// Stable key for each flat tree item (used by virtualizer for measurement cache stability)
function getItemKey(item: FlatTreeNode, _index: number): string {
  if (item.isSkeleton) return `skeleton-${item.node.id}-${item.skeletonIndex}`
  if (item.isSearchBox) return `search-${item.node.id}`
  if (item.isLoadMore) return `loadmore-${item.node.id}`
  if (item.isFailed) return `error-${item.node.id}`
  return item.node.id
}

export const LayerColumn = React.memo(function LayerColumn({
  layer,
  nodes,
  schema,
  selectedNodeId,
  expandedNodes,
  searchResults,
  onSelect,
  onToggle,
  onContextMenu,
  onDoubleClick,
  onAddChild,
  onAddToLayer,
  isBlankModel = false,
  onBuildToLayer,
  onBeginConnect,
  onLayerContextMenu,
  traceFocusId,
  traceNodes: _traceNodes,
  traceContextSet,
  isTracing = false,
  highlightedNodes,
  isHighlightActive = false,
  isHoverHighlight = false,
  onAnimationComplete: _onAnimationComplete,
  onLoadMore,
  onSearchChildren,
  isLoadingChildren,
  loadingNodes,
  failedNodes,
  onScroll,
  onAssignToLayer,
  onRenameLayer,
  onDeleteLayer,
  onReorderLayer,
  isHydratingInitial = false,
  revealTarget,
  geometryRegistry,
  overscan = 15,
  lineageCounts,
  showDensityGutter = false,
  anchorProxies,
  onProxyReveal,
  onProxyMore,
}: LayerColumnProps) {
  // A layer that has zero entity types, rules, instance assignments, AND
  // logical nodes is configured to receive nothing — showing ghost cards
  // there reads as "still loading" when the truth is "nothing was ever
  // going to land here". Detect this upfront so the empty state appears
  // immediately rather than after hydration completes.
  const layerHasConfiguredSources = useMemo(() => {
    const hasEntityTypes = (layer.entityTypes?.length ?? 0) > 0
    const hasRules = (layer.rules?.length ?? 0) > 0
    const hasAssignments = (layer.entityAssignments?.length ?? 0) > 0
    const hasLogicalNodes = (layer.logicalNodes?.length ?? 0) > 0
    const acceptsUnassigned = layer.showUnassigned === true
    return hasEntityTypes || hasRules || hasAssignments || hasLogicalNodes || acceptsUnassigned
  }, [layer])

  const shouldShowGhosts = isHydratingInitial && layerHasConfiguredSources

  const [localFocusId, setLocalFocusId] = useState<string | null>(null)
  const [breadcrumb, setBreadcrumb] = useState<HierarchyNode[]>([])
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [childSearchQueries, setChildSearchQueries] = useState<Record<string, string>>({})
  const [activeSearchNodes, setActiveSearchNodes] = useState<Set<string>>(new Set())
  const [isDragOver, setIsDragOver] = useState(false)
  const [focusIndex, setFocusIndex] = useState(-1)
  // Draft layer-management: inline rename, delete-confirm, and which kind of drag is hovering
  // (a layer being reordered vs an entity being reassigned) so the drop hint reads right.
  const [isRenaming, setIsRenaming] = useState(false)
  const [draftName, setDraftName] = useState(layer.name)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [dragKind, setDragKind] = useState<'entity' | 'layer' | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const toggleSearchNode = useCallback((nodeId: string) => {
    setActiveSearchNodes(prev => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
        // Also optionally clear the search query if closed
        setChildSearchQueries(q => {
          const newQ = { ...q }
          delete newQ[nodeId]
          return newQ
        })
      } else {
        next.add(nodeId)
      }
      return next
    })

    // Auto-expand the node so the user immediately sees the search box drop down
    if (!activeSearchNodes.has(nodeId) && !expandedNodes.has(nodeId)) {
      onToggle(nodeId)
    }
  }, [activeSearchNodes, expandedNodes, onToggle])

  // Search-driven canvas filter state. ``matchUrnSet`` is the source of
  // truth for "is this row a direct match"; ``ancestorMatchCounts > 0``
  // means the row sits on the spine to at least one match.
  // ``canvasFilterMode`` is the user's choice from the MatchBar:
  //   highlight → no skip (today's behavior, dim happens in
  //               FlatTreeItem via useSearchHighlight)
  //   isolate   → drop everything that's not a match and not a spine row
  //   hide      → drop direct matches; keep everything else
  // The selected row is exempt from skipping so the user never loses
  // visual contact with what they're inspecting.
  const matchUrnSet = useMatchUrnSet()
  const ancestorMatchCounts = useAncestorMatchCounts()
  const canvasFilterMode = useCanvasFilterMode()

  // Build flat tree from hierarchy (visible items only)
  const rawFlatTree = useMemo(() => {
    const result: FlatTreeNode[] = []

    // Iterative findNode — prevents stack overflow on deep hierarchies
    let rootNodes = nodes
    if (localFocusId) {
      const findStack = [...nodes]
      rootNodes = []
      while (findStack.length > 0) {
        const n = findStack.pop()!
        if (n.id === localFocusId) { rootNodes = [n]; break }
        for (let i = n.children.length - 1; i >= 0; i--) findStack.push(n.children[i])
      }
    }

    // Iterative flat-tree builder using explicit stack
    type FrameItem =
      | { kind: 'node'; node: HierarchyNode; depth: number; isLast: boolean; parentIsLast: boolean[] }
      | { kind: 'loadMore'; parent: HierarchyNode; depth: number; parentIsLast: boolean[]; count: number }

    const stack: FrameItem[] = []
    // Push root nodes in reverse so first root is processed first
    for (let i = rootNodes.length - 1; i >= 0; i--) {
      stack.push({ kind: 'node', node: rootNodes[i], depth: 0, isLast: i === rootNodes.length - 1, parentIsLast: [] })
    }

    while (stack.length > 0) {
      const frame = stack.pop()!

      if (frame.kind === 'loadMore') {
        result.push({
          node: frame.parent,
          depth: frame.depth,
          isLast: true,
          parentIsLast: frame.parentIsLast,
          isLoadMore: true,
          loadMoreCount: frame.count,
        })
        continue
      }

      const { node, depth, isLast, parentIsLast } = frame
      result.push({ node, depth, isLast, parentIsLast: [...parentIsLast] })

      // Only expand children if node is expanded
      if (!expandedNodes.has(node.id) || (node.children.length === 0 && !((node.data.childCount as number) || 0))) continue

      const childCount = (node.data.childCount as number) || (node.data._collapsedChildCount as number) || node.children.length
      const isNodeLoading = loadingNodes?.has(node.id) ?? false
      const childParentIsLast = [...parentIsLast, isLast]

      // Inline search box
      if (activeSearchNodes.has(node.id)) {
        result.push({
          node,
          depth: depth + 1,
          isLast: node.children.length === 0 && !isNodeLoading,
          parentIsLast: childParentIsLast,
          isSearchBox: true,
        })
      }

      // Error row
      const isNodeFailed = (failedNodes?.has(node.id) ?? false) && !isNodeLoading && node.children.length === 0
      if (isNodeFailed) {
        result.push({
          node,
          depth: depth + 1,
          isLast: true,
          parentIsLast: childParentIsLast,
          isFailed: true,
        })
      }
      // Skeleton placeholders
      else if (isNodeLoading && node.children.length === 0) {
        const skeletonCount = Math.min(childCount || 3, 4)
        for (let i = 0; i < skeletonCount; i++) {
          result.push({
            node,
            depth: depth + 1,
            isLast: i === skeletonCount - 1,
            parentIsLast: childParentIsLast,
            isSkeleton: true,
            skeletonIndex: i,
          })
        }
      } else {
        // Push children onto stack in reverse order (+ optional loadMore at bottom)
        const displayChildren = node.children
        const activeQuery = childSearchQueries[node.id]?.trim().toLowerCase()
        // In trace mode the trace API already returns the complete set of
        // trace-relevant nodes; pulling more siblings just produces noise that
        // useTraceFilteredHierarchy hides anyway. Suppress the "X more" pill.
        const hasMore = !isTracing && node.children.length < childCount && !activeQuery

        if (hasMore) {
          stack.push({ kind: 'loadMore', parent: node, depth: depth + 1, parentIsLast: childParentIsLast, count: childCount - node.children.length })
        }

        for (let i = displayChildren.length - 1; i >= 0; i--) {
          stack.push({
            kind: 'node',
            node: displayChildren[i],
            depth: depth + 1,
            isLast: i === displayChildren.length - 1 && !hasMore,
            parentIsLast: childParentIsLast,
          })
        }
      }
    }

    return result
  }, [nodes, expandedNodes, localFocusId, activeSearchNodes, childSearchQueries, loadingNodes, failedNodes, isTracing])

  // Canvas filter pass: drop rows the user asked to hide via the
  // MatchBar's Isolate / Hide modes. We filter at the data layer (not
  // per-row via CSS) so the virtualizer's row-count and offset math
  // collapse around the dropped rows — Isolate mode on a 10k-node
  // hierarchy should render only the matched ancestor chain, not 10k
  // invisible rows. Search-aux rows (load-more, skeletons, search
  // boxes) ride along with their parent node's visibility.
  const flatTree = useMemo(() => {
    // Fast path: no active search OR plain highlight mode — return
    // raw tree by reference so downstream memos don't invalidate on
    // search-state changes that don't affect visibility.
    if (matchUrnSet.size === 0) return rawFlatTree
    if (canvasFilterMode === 'highlight') return rawFlatTree

    const isVisibleNode = (n: HierarchyNode): boolean => {
      // Selection always wins so the user can never accidentally
      // make their inspected row vanish.
      if (selectedNodeId === n.id) return true
      const key = n.urn ?? n.id
      const isMatch = matchUrnSet.has(key)
      const onSpine = (ancestorMatchCounts.get(key) ?? 0) > 0
      if (canvasFilterMode === 'isolate') {
        return isMatch || onSpine
      }
      // 'hide' — drop the matched leaves but keep ancestor context.
      return !isMatch
    }

    return rawFlatTree.filter((item) => isVisibleNode(item.node))
  }, [
    rawFlatTree, matchUrnSet, ancestorMatchCounts, canvasFilterMode,
    selectedNodeId,
  ])

  // Count total including nested
  const totalCount = useMemo(() => {
    const count = (n: HierarchyNode): number =>
      1 + n.children.reduce((acc, c) => acc + count(c), 0)
    return nodes.reduce((acc, n) => acc + count(n), 0)
  }, [nodes])

  // Fetch the next page of a parent's children. Stable identity — the row that
  // calls this used to be an IntersectionObserver sentinel whose one-shot latch
  // was reset every time this callback's identity churned.
  const handleLoadMore = useCallback((nodeId: string) => {
    onLoadMore?.(nodeId)
  }, [onLoadMore])

  // Handle focus (zoom into subtree)
  const handleFocus = useCallback((node: HierarchyNode | null) => {
    if (!node) {
      setLocalFocusId(null)
      setBreadcrumb([])
      return
    }

    // Build breadcrumb trail
    const trail: HierarchyNode[] = []
    const findPath = (n: HierarchyNode, target: string, path: HierarchyNode[]): boolean => {
      if (n.id === target) {
        trail.push(...path, n)
        return true
      }
      for (const child of n.children) {
        if (findPath(child, target, [...path, n])) return true
      }
      return false
    }

    nodes.forEach(root => findPath(root, node.id, []))

    setLocalFocusId(node.id)
    setBreadcrumb(trail.slice(0, -1)) // Exclude current node from breadcrumb

    // Auto-expand the focused node
    if (!expandedNodes.has(node.id)) {
      onToggle(node.id)
    }
  }, [nodes, expandedNodes, onToggle])

  // Navigate breadcrumb
  const handleBreadcrumbClick = useCallback((node: HierarchyNode | null) => {
    if (!node) {
      handleFocus(null)
    } else {
      handleFocus(node)
    }
  }, [handleFocus])

  // ── 4.5 Keyboard Navigation ───────────────────────────────────────────────
  // Only the real FlatTreeItem rows (no skeletons, errors, search boxes, load-more)
  const navigableItems = useMemo(
    () => flatTree.filter(item => !item.isSearchBox && !item.isSkeleton && !item.isFailed && !item.isLoadMore),
    [flatTree]
  )

  // O(1) lookup: node ID → navigable index
  const navigableIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    navigableItems.forEach((item, idx) => map.set(item.node.id, idx))
    return map
  }, [navigableItems])

  // O(1) lookup: node ID → flatTree index (for virtualizer.scrollToIndex)
  const nodeToFlatIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    flatTree.forEach((item, idx) => {
      if (!item.isSkeleton && !item.isSearchBox && !item.isFailed && !item.isLoadMore) {
        map.set(item.node.id, idx)
      }
    })
    return map
  }, [flatTree])

  // Anchor Rail chip labels — the proxy's row lives in THIS column's
  // flat tree, so the display name resolves locally (no extra plumbing).
  const proxyLabel = useCallback((nodeId: string): string => {
    const idx = nodeToFlatIndexMap.get(nodeId)
    return idx !== undefined ? flatTree[idx].node.name : nodeId
  }, [nodeToFlatIndexMap, flatTree])

  // ── Animation batching: track which items are newly appeared (cap at 20) ──
  const prevFlatTreeKeysRef = useRef<Set<string>>(new Set())
  const newItemKeys = useMemo(() => {
    const currentKeys = new Set(flatTree.map((item, idx) => getItemKey(item, idx)))
    const prevKeys = prevFlatTreeKeysRef.current
    const newKeys = new Set<string>()
    for (const key of currentKeys) {
      if (!prevKeys.has(key)) {
        newKeys.add(key)
        if (newKeys.size >= 20) break // Cap animation batch for perf
      }
    }
    prevFlatTreeKeysRef.current = currentKeys
    return newKeys
  }, [flatTree])

  // Track tree structure changes — enable glide transition briefly after expand/collapse,
  // but NOT during scroll (which also updates translateY on virtual items).
  const isGlidingRef = useRef(false)
  const glideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    isGlidingRef.current = true
    clearTimeout(glideTimerRef.current)
    glideTimerRef.current = setTimeout(() => { isGlidingRef.current = false }, 300)
    return () => clearTimeout(glideTimerRef.current)
  }, [flatTree.length])

  // Reset focus when tree content changes
  useEffect(() => {
    setFocusIndex(-1)
  }, [nodes, localFocusId])

  // ── Virtualizer ───────────────────────────────────────────────────────────
  // Estimates must match the heights FlatTreeItem renders at the current
  // canvas density — densityRowHeights() is the shared source of truth so
  // scroll position stays stable across density changes. Default guards
  // users whose persisted preferences predate this field.
  const density = usePreferencesStore(s => s.canvasDensity) ?? 'spacious'
  const rowHeights = useMemo(() => densityRowHeights(density), [density])
  const virtualizer = useVirtualizer({
    count: flatTree.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const item = flatTree[index]
      if (item.isSearchBox) return rowHeights.searchBox
      if (item.isSkeleton) return rowHeights.skeleton
      if (item.isFailed) return rowHeights.failed
      if (item.isLoadMore) return rowHeights.loadMore
      return item.depth === 0 ? rowHeights.root : rowHeights.child
    },
    overscan,
    getItemKey: (index) => getItemKey(flatTree[index], index),
  })

  // Re-measure all virtualized rows when density flips so the cached
  // measurements from the previous density don't leave the row stack
  // pinned to stale heights.
  useEffect(() => {
    virtualizer.measure()
  }, [density, virtualizer])

  // Auto-scroll keyboard-focused row into view via virtualizer
  const focusedNodeId = navigableItems[focusIndex]?.node.id ?? null
  useEffect(() => {
    if (!focusedNodeId) return
    const flatIndex = nodeToFlatIndexMap.get(focusedNodeId)
    if (flatIndex !== undefined) {
      virtualizer.scrollToIndex(flatIndex, { align: 'auto', behavior: 'smooth' })
    }
  }, [focusedNodeId, nodeToFlatIndexMap, virtualizer])

  // Auto-scroll a freshly-revealed search hit into view via the
  // virtualizer. DOM-based scrollIntoView can't work here because the
  // hit row may be hundreds of items below the overscan window, so it
  // simply doesn't exist in the DOM. Each "Reveal in canvas" click
  // bumps `revealTarget.pulse`, which re-fires this effect even when
  // the same URN is revealed twice. Columns that don't own the URN
  // no-op (their nodeToFlatIndexMap won't have the entry).
  //
  // After the vertical scroll fires, we also chain a horizontal
  // ``scrollIntoView({ inline: 'center' })`` so the LayerColumn
  // itself is brought into the canvas viewport — without this the
  // virtualizer scrolls the row to the center of its OWN column but
  // the column may sit entirely off-screen, requiring the user to
  // manually pan. That's the source of the "3-click reveal" problem.
  const lastRevealPulseRef = useRef<number>(-1)
  useEffect(() => {
    if (!revealTarget) return
    if (lastRevealPulseRef.current === revealTarget.pulse) return
    const flatIndex = nodeToFlatIndexMap.get(revealTarget.id)
    if (flatIndex === undefined) return  // Wait for flatTree to update
    lastRevealPulseRef.current = revealTarget.pulse
    const targetId = revealTarget.id
    // Tiny delay so the virtualizer has its post-expand size estimates
    // before we ask it to compute a scroll offset for an off-screen row.
    const timer = setTimeout(() => {
      virtualizer.scrollToIndex(flatIndex, { align: 'center', behavior: 'smooth' })
      // Two rAFs: the first lets the virtualizer kick off its scroll
      // (which materializes the row in the DOM via overscan), the
      // second lets the row mount before we ask it to scroll its
      // horizontally-scrollable ancestor (the canvas's
      // ``horizontalScrollRef`` container) into view.
      // ``block: 'nearest'`` keeps the virtualizer's vertical scroll
      // from being overridden; ``inline: 'center'`` is what brings
      // the LayerColumn horizontally on-screen.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const row = document.getElementById(`layer-node-${targetId}`)
          if (row) {
            row.scrollIntoView({
              inline: 'center',
              block: 'nearest',
              behavior: 'smooth',
            })
          }
        })
      })
    }, 50)
    return () => clearTimeout(timer)
  }, [revealTarget, nodeToFlatIndexMap, virtualizer])

  // Auto-scroll trace focus node into view — runs ONCE per focus change.
  // Without the ref guard the effect re-fires every time nodeToFlatIndexMap
  // re-memoizes (which happens during scroll-driven virtualizer reflows),
  // snapping the user back to the focus and preventing them from scrolling
  // up or down through the lineage. With the guard the focus is centered
  // when a trace starts; afterwards the user's scroll position is theirs.
  const lastCenteredFocusRef = useRef<string | null>(null)
  useEffect(() => {
    if (!traceFocusId) {
      lastCenteredFocusRef.current = null
      return
    }
    if (lastCenteredFocusRef.current === traceFocusId) return
    const flatIndex = nodeToFlatIndexMap.get(traceFocusId)
    if (flatIndex === undefined) return
    const timer = setTimeout(() => {
      virtualizer.scrollToIndex(flatIndex, { align: 'center', behavior: 'smooth' })
      lastCenteredFocusRef.current = traceFocusId
    }, 100)
    return () => clearTimeout(timer)
  }, [traceFocusId, nodeToFlatIndexMap, virtualizer])

  // ── Expansion reveal ────────────────────────────────────────────────
  // When a node is expanded, its subtree materializes BELOW it — if the
  // parent sits near the bottom of the column's viewport (expanding the
  // last visible row is the common case), every new row lands below the
  // fold and the expansion reads as a silent no-op ("I expanded and
  // nothing loaded"). Watch for newly-expanded ids owned by THIS column
  // and nudge the first row of the new subtree into view once it exists
  // in the flat tree (skeleton or real child). align:'auto' scrolls the
  // minimum distance and no-ops when the row is already visible, so
  // mid-viewport expansions never jump. Pending reveals expire so a
  // slow child load can't hijack the user's scroll seconds later.
  const prevExpandedRef = useRef<Set<string>>(expandedNodes)
  const pendingExpandRevealRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    const prev = prevExpandedRef.current
    prevExpandedRef.current = expandedNodes
    const pending = pendingExpandRevealRef.current
    expandedNodes.forEach(id => {
      if (!prev.has(id) && nodeToFlatIndexMap.has(id)) {
        pending.set(id, Date.now() + 2000)
      }
    })
    pending.forEach((deadline, id) => {
      if (!expandedNodes.has(id) || deadline < Date.now()) {
        pending.delete(id)
        return
      }
      const idx = nodeToFlatIndexMap.get(id)
      if (idx === undefined) return
      const parentDepth = flatTree[idx]?.depth ?? 0
      const next = flatTree[idx + 1]
      // Subtree rows haven't materialized yet — keep waiting (flatTree
      // changes re-fire this effect).
      if (!next || next.depth <= parentDepth) return
      pending.delete(id)
      virtualizer.scrollToIndex(idx + 1, { align: 'auto', behavior: 'smooth' })
    })
  }, [expandedNodes, flatTree, nodeToFlatIndexMap, virtualizer])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const count = navigableItems.length
    if (count === 0) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setFocusIndex(i => Math.min(i + 1, count - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setFocusIndex(i => (i <= 0 ? 0 : i - 1))
        break
      case 'ArrowRight': {
        e.preventDefault()
        const item = navigableItems[focusIndex]
        if (item && !expandedNodes.has(item.node.id)) onToggle(item.node.id)
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        const item = navigableItems[focusIndex]
        if (item && expandedNodes.has(item.node.id)) onToggle(item.node.id)
        break
      }
      case 'Enter': {
        const item = navigableItems[focusIndex]
        if (item) onSelect(item.node.id)
        break
      }
      case 'Home':
        e.preventDefault()
        setFocusIndex(0)
        break
      case 'End':
        e.preventDefault()
        setFocusIndex(count - 1)
        break
    }
  }, [navigableItems, focusIndex, expandedNodes, onToggle, onSelect])

  // Entity rows currently in the tree (expanded children included).
  // Auxiliary rows — search boxes, skeletons, load-more, failed
  // placeholders — are UI, not entities: counting them pushed the header
  // past the loaded total ("402 / 400"). Entity rows are a strict subset
  // of loaded entities, so X ≤ Y holds by construction.
  const visibleCount = useMemo(
    () => flatTree.reduce((acc, it) =>
      acc + (it.isSkeleton || it.isSearchBox || it.isFailed || it.isLoadMore ? 0 : 1), 0),
    [flatTree],
  )

  // ── Overflow chips: track scroll position so we can show accurate
  // "↑ N above / ↓ N below" indicators that respond to user scroll. ─────────
  const [scrollTick, setScrollTick] = useState(0)
  const handleScroll = useCallback(() => {
    onScroll?.()
    // Bump tick so the memoized counts re-derive from fresh scrollTop/clientHeight.
    setScrollTick(t => (t + 1) & 0xffff)
  }, [onScroll])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setScrollTick(t => (t + 1) & 0xffff))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const isRealRow = useCallback((it: FlatTreeNode) =>
    !it.isSkeleton && !it.isSearchBox && !it.isFailed && !it.isLoadMore
  , [])

  const overflowCounts = useMemo(() => {
    void scrollTick
    const el = scrollContainerRef.current
    if (!el || flatTree.length === 0) return { above: 0, below: 0 }
    const scrollTop = el.scrollTop
    const viewportBottom = scrollTop + el.clientHeight
    const items = virtualizer.getVirtualItems()
    if (items.length === 0) return { above: 0, below: 0 }

    let firstVisibleFlatIndex = -1
    let lastVisibleFlatIndex = -1
    for (const it of items) {
      const startsBeforeBottom = it.start < viewportBottom - 1
      const endsAfterTop = it.end > scrollTop + 1
      if (startsBeforeBottom && endsAfterTop) {
        if (firstVisibleFlatIndex === -1) firstVisibleFlatIndex = it.index
        lastVisibleFlatIndex = it.index
      }
    }
    if (firstVisibleFlatIndex === -1) return { above: 0, below: 0 }

    let above = 0
    for (let i = 0; i < firstVisibleFlatIndex; i++) {
      if (isRealRow(flatTree[i])) above++
    }
    let below = 0
    for (let i = lastVisibleFlatIndex + 1; i < flatTree.length; i++) {
      if (isRealRow(flatTree[i])) below++
    }
    return { above, below }
  }, [scrollTick, flatTree, virtualizer, isRealRow])

  const scrollToFlatIndex = useCallback((index: number, align: 'start' | 'end') => {
    if (index < 0 || index >= flatTree.length) return
    virtualizer.scrollToIndex(index, { align, behavior: 'smooth' })
  }, [virtualizer, flatTree.length])

  // ── Density gutter buckets ────────────────────────────────────────────────
  // Where does connection mass live across the WHOLE column (not just the
  // viewport)? Bucket the flat tree by index; each bucket sums the in+out
  // lineage counts of its rows. Normalized 0..1 for the heat strip.
  const densityBuckets = useMemo(() => {
    if (!showDensityGutter || !lineageCounts || lineageCounts.size === 0 || flatTree.length === 0) return null
    // Too few rows to have off-screen mass worth mapping.
    if (flatTree.length < 24) return null
    const n = Math.min(48, flatTree.length)
    const vals = new Array<number>(n).fill(0)
    flatTree.forEach((item, idx) => {
      if (item.isSkeleton || item.isSearchBox || item.isFailed || item.isLoadMore) return
      const c = lineageCounts.get(item.node.id)
      if (!c) return
      vals[Math.min(n - 1, Math.floor((idx / flatTree.length) * n))] += c.in + c.out
    })
    const max = Math.max(...vals)
    if (max <= 0) return null
    const normalized = vals.map(v => v / max)
    // Contrast gate: a heatmap with no contrast is just a stripe. When
    // density is near-uniform (most buckets close to the max), the strip
    // carries no information — hide it entirely rather than render a
    // solid bar that reads as a broken border.
    const hot = normalized.filter(v => v > 0.55).length
    if (hot / normalized.length > 0.6) return null
    return normalized
  }, [showDensityGutter, lineageCounts, flatTree])

  // Click on the gutter → jump the column to the corresponding tree region.
  const handleGutterClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.height <= 0 || flatTree.length === 0) return
    const fraction = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    scrollToFlatIndex(Math.min(flatTree.length - 1, Math.floor(fraction * flatTree.length)), 'start')
  }, [flatTree.length, scrollToFlatIndex])

  // ── Geometry API registration ─────────────────────────────────────────────
  // Exposes estimated row rects to the edge overlay WITHOUT mounting rows.
  // Offsets come from the virtualizer's measurements cache (exact for
  // measured rows, estimate-derived for unmounted ones). The lookup map is
  // kept fresh via a ref so registration happens once per column mount
  // (`virtualizer` is instance-stable).
  const nodeToFlatIndexMapRef = useRef(nodeToFlatIndexMap)
  nodeToFlatIndexMapRef.current = nodeToFlatIndexMap
  useEffect(() => {
    if (!geometryRegistry) return
    // Matches the `py-2` on the totalSize wrapper below — virtualizer
    // offsets are relative to the padded content box.
    const LIST_PAD_TOP = 8
    const api: ColumnGeometryApi = {
      hasNode: (nodeId) => nodeToFlatIndexMapRef.current.has(nodeId),
      getNodeRect: (nodeId) => {
        const el = scrollContainerRef.current
        if (!el) return null
        const idx = nodeToFlatIndexMapRef.current.get(nodeId)
        if (idx === undefined) return null
        const m = virtualizer.measurementsCache[idx]
        if (!m) return null
        const rect = el.getBoundingClientRect()
        // Canvas-zoom compensation: virtualizer offsets are unscaled local
        // px while getBoundingClientRect returns scaled viewport px.
        const scale = el.clientHeight > 0 ? rect.height / el.clientHeight : 1
        return {
          top: rect.top + (LIST_PAD_TOP + m.start - el.scrollTop) * scale,
          height: m.size * scale,
          left: rect.left,
          right: rect.right,
        }
      },
    }
    geometryRegistry.set(layer.id, api)
    return () => { geometryRegistry.delete(layer.id) }
  }, [geometryRegistry, layer.id, virtualizer])

  return (
    <motion.div
      data-layer-id={layer.id}
      className={cn(
        // pointer-events-auto re-establishes interactivity for all descendants.
        // The parent columns wrapper is pointer-events-none (so inter-column
        // gaps fall through to the edge hit-test layer); pointer-events is an
        // inherited CSS property, so without this explicit `auto` chevrons,
        // headers, and node cards would inherit `none` and become inert.
        "flex flex-col relative group/column transition-all duration-300 pointer-events-auto",
        isCollapsed ? "min-w-[60px] max-w-[60px]" : "flex-1 min-w-[320px] max-w-[480px]"
      )}
      layout
    >
      {/* Subtle column separator line with gradient fade */}
      <div className="absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-glass-border/50 to-transparent" />

      {/* Layer Header - Glass morphism style + drag target (4.3).
          When collapsed, the header is the only content in the column; it
          stretches (`flex-1`) so every collapsed column shares the same
          vertical extent as its expanded siblings regardless of count
          digit count or icon size. */}
      <div
        className={cn(
          "sticky top-0 z-10 backdrop-blur-xl border-b cursor-pointer transition-all duration-200",
          isCollapsed ? "flex-1 px-2 py-4" : "flex-shrink-0 px-4 py-3",
          isDragOver
            ? "border-white/30"
            : "border-white/[0.08] dark:border-white/[0.05]"
        )}
        style={{
          background: `linear-gradient(135deg, ${layer.color}12 0%, ${layer.color}05 100%)`,
          boxShadow: isDragOver ? `inset 0 0 0 2px ${layer.color}80, 0 0 20px ${layer.color}20` : undefined,
        }}
        onClick={() => isCollapsed && setIsCollapsed(false)}
        onDragOver={(e) => {
          const types = e.dataTransfer.types
          const isLayer = types.includes('text/x-layer-id')
          const isEntity = types.includes('text/x-entity-id')
          // Only accept a drag this column can actually handle (getData is unreadable in dragover, so
          // gate on the presence of the typed key + the matching handler).
          if ((isLayer && onReorderLayer) || (isEntity && onAssignToLayer)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setIsDragOver(true)
            setDragKind(isLayer ? 'layer' : 'entity')
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) { setIsDragOver(false); setDragKind(null) }
        }}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragOver(false)
          setDragKind(null)
          const layerId = e.dataTransfer.getData('text/x-layer-id')
          if (layerId && onReorderLayer) { onReorderLayer(layerId, layer.id); return }
          const entityId = e.dataTransfer.getData('text/x-entity-id')
          if (entityId && onAssignToLayer) onAssignToLayer(entityId)
        }}
      >
        {/* Drop hint overlay */}
        {isDragOver && (
          <div
            className="absolute inset-0 flex items-center justify-center rounded-sm pointer-events-none"
            style={{ backgroundColor: `${layer.color}15` }}
          >
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-black/40 border border-white/20 backdrop-blur-sm">
              <LucideIcons.MoveRight className="w-3.5 h-3.5" style={{ color: layer.color }} />
              <span className="text-xs font-medium" style={{ color: layer.color }}>
                {dragKind === 'layer' ? 'Drop to reorder here' : `Move to ${layer.name}`}
              </span>
            </div>
          </div>
        )}
        <div className={cn(
          "flex items-center",
          isCollapsed ? "flex-col gap-3 h-full" : "gap-3"
        )}>
          {/* Collapse/Expand Toggle + Icon Container */}
          <div className="flex items-center gap-2">
            {!isCollapsed && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setIsCollapsed(true)
                }}
                className="p-1 rounded-lg hover:bg-white/[0.1] text-ink-muted hover:text-ink transition-all"
                title="Collapse layer"
              >
                <LucideIcons.PanelLeftClose className="w-4 h-4" />
              </button>
            )}
            <div
              draggable={!!onReorderLayer}
              onDragStart={onReorderLayer ? (e) => {
                e.stopPropagation()
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/x-layer-id', layer.id)
              } : undefined}
              title={onReorderLayer ? `Drag to reorder ${layer.name}` : undefined}
              className={cn(
                "rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm transition-all duration-300",
                isCollapsed ? "w-10 h-10" : "w-9 h-9 group-hover/column:scale-105 group-hover/column:shadow-md",
                onReorderLayer && "cursor-grab active:cursor-grabbing"
              )}
              style={{
                background: `linear-gradient(145deg, ${layer.color}25 0%, ${layer.color}15 100%)`,
                boxShadow: `0 2px 8px ${layer.color}20`
              }}
            >
              <DynamicIcon
                name={layer.icon ?? 'Layers'}
                className={cn(
                  "transition-transform duration-300",
                  isCollapsed ? "w-5 h-5" : "w-4 h-4 group-hover/column:scale-110"
                )}
                style={{ color: layer.color }}
              />
            </div>
          </div>

          {/* Collapsed state - vertical text.
              `h-full` on the inner stack + `mt-auto` on the expand button
              anchors the expand affordance to the bottom of the column
              while the name/count sit at the top. With multiple collapsed
              columns side by side the spine alignment now matches even
              when entity counts differ in width. */}
          {isCollapsed ? (
            <div className="flex flex-col items-center gap-2 h-full w-full">
              <span
                className="text-xs font-semibold writing-mode-vertical transform rotate-180"
                style={{ color: layer.color, writingMode: 'vertical-rl' }}
                title={layer.name}
              >
                {layer.name}
              </span>
              <div
                className="px-1.5 py-1 rounded-full text-[10px] font-semibold tabular-nums"
                style={{ backgroundColor: `${layer.color}20`, color: layer.color }}
              >
                {totalCount}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setIsCollapsed(false)
                }}
                className="p-1.5 rounded-lg hover:bg-white/[0.1] text-ink-muted hover:text-ink transition-all mt-auto"
                title="Expand layer"
              >
                <LucideIcons.PanelLeftOpen className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <>
              {isRenaming && onRenameLayer ? (
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') { onRenameLayer(layer.id, draftName); setIsRenaming(false) }
                    if (e.key === 'Escape') { setDraftName(layer.name); setIsRenaming(false) }
                  }}
                  onBlur={() => { onRenameLayer(layer.id, draftName); setIsRenaming(false) }}
                  className="flex-1 min-w-0 px-2 py-1 rounded-lg bg-canvas-overlay border border-accent-lineage/60 text-sm font-semibold text-ink outline-none"
                />
              ) : (
                <div className="flex-1 min-w-0 flex items-center gap-1">
                  <LayerHeaderTitle
                    name={layer.name}
                    description={layer.description}
                    color={layer.color}
                  />
                  {onRenameLayer && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setDraftName(layer.name); setIsRenaming(true) }}
                      className="opacity-0 group-hover/column:opacity-100 p-1 rounded text-ink-muted hover:text-ink hover:bg-white/10 transition-all flex-shrink-0"
                      title="Rename layer"
                    >
                      <LucideIcons.Pencil className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2">
                {/* Loading pill — replaces the entity-count pill while this
                    layer is hydrating with no entities yet. Premium spinner +
                    layer-tinted background makes the loading state legible at
                    a glance from anywhere on the canvas. */}
                {shouldShowGhosts && flatTree.length === 0 ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.92 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.92 }}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-full backdrop-blur-sm border"
                    style={{
                      backgroundColor: `${layer.color}1a`,
                      borderColor: `${layer.color}40`,
                      color: layer.color,
                    }}
                  >
                    <LucideIcons.Loader2 className="w-3 h-3 animate-spin" />
                    <span className="text-[10px] font-semibold tracking-wide">Loading…</span>
                  </motion.div>
                ) : (
                  <div
                    className="flex items-center gap-1 px-2 py-1 rounded-full bg-white/[0.06] dark:bg-white/[0.04] backdrop-blur-sm border border-white/[0.08]"
                    title={`${visibleCount.toLocaleString()} entit${visibleCount === 1 ? 'y' : 'ies'} in the tree · ${totalCount.toLocaleString()} loaded in this layer (collapsed children included — expand rows to reveal them)`}
                  >
                    <span className="text-[10px] font-semibold text-ink" style={{ color: layer.color }}>
                      {visibleCount}
                    </span>
                    <span className="text-[9px] text-ink-muted/60">/</span>
                    <span className="text-[10px] text-ink-muted/60">{totalCount}</span>
                  </div>
                )}
                {onAddToLayer && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onAddToLayer(layer.id)
                    }}
                    className="p-1.5 rounded-lg bg-green-500/10 hover:bg-green-500/20 text-green-500 transition-all duration-200 hover:scale-110 active:scale-95"
                    title={`Add entity to ${layer.name}`}
                  >
                    <LucideIcons.Plus className="w-3.5 h-3.5" />
                  </button>
                )}
                {onBuildToLayer && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onBuildToLayer(layer.id)
                    }}
                    className="p-1.5 rounded-lg bg-accent-lineage/10 hover:bg-accent-lineage/20 text-accent-lineage transition-all duration-200 hover:scale-110 active:scale-95"
                    title={`Build a lot at once in ${layer.name}`}
                  >
                    <LucideIcons.LayoutGrid className="w-3.5 h-3.5" />
                  </button>
                )}
                {/* Delete — hover-revealed trash → inline check/✗ confirm (the check's tooltip warns
                    when the layer has entities: they fall back to the default layer on removal). */}
                {onDeleteLayer && (
                  confirmingDelete ? (
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDeleteLayer(layer.id); setConfirmingDelete(false) }}
                        title={totalCount > 0
                          ? `Delete — ${totalCount} ${totalCount === 1 ? 'entity' : 'entities'} will move to the default layer`
                          : 'Delete layer'}
                        className="p-1.5 rounded-lg bg-rose-500/15 text-rose-500 hover:bg-rose-500/25 transition-all"
                      >
                        <LucideIcons.Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmingDelete(false) }}
                        title="Cancel"
                        className="p-1.5 rounded-lg text-ink-muted hover:bg-white/10 transition-all"
                      >
                        <LucideIcons.X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true) }}
                      className="opacity-0 group-hover/column:opacity-100 p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 transition-all duration-200"
                      title={`Delete ${layer.name}`}
                    >
                      <LucideIcons.Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )
                )}
              </div>
            </>
          )}
        </div>

        {/* Breadcrumb Navigation - Modern pill style (hidden when collapsed) */}
        {!isCollapsed && (
          <AnimatePresence>
            {breadcrumb.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0, marginTop: 8 }}
                animate={{ opacity: 1, height: 'auto', marginTop: 8 }}
                exit={{ opacity: 0, height: 0, marginTop: 0 }}
                className="flex items-center gap-1 overflow-x-auto no-scrollbar"
              >
                <button
                  onClick={() => handleBreadcrumbClick(null)}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-ink-muted hover:text-ink transition-all duration-200 flex-shrink-0"
                >
                  <LucideIcons.Home className="w-3 h-3" />
                  <span className="text-[10px] font-medium">Root</span>
                </button>
                {breadcrumb.map((node) => (
                  <React.Fragment key={node.id}>
                    <LucideIcons.ChevronRight className="w-3 h-3 text-ink-muted/40 flex-shrink-0" />
                    <button
                      onClick={() => handleBreadcrumbClick(node)}
                      className="px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-ink-muted hover:text-ink transition-all duration-200 truncate max-w-[100px] flex-shrink-0 text-[10px] font-medium"
                      title={node.name}
                    >
                      {node.name}
                    </button>
                  </React.Fragment>
                ))}
                <LucideIcons.ChevronRight className="w-3 h-3 text-ink-muted/40 flex-shrink-0" />
                <span
                  className="px-2 py-1 rounded-lg text-[10px] font-semibold truncate"
                  style={{ backgroundColor: `${layer.color}20`, color: layer.color }}
                >
                  Current
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </div>

      {/* Flat Tree Content - Virtualized, hidden when collapsed */}
      {!isCollapsed && (
        <div className="flex-1 relative flex flex-col min-h-0">
          {/* Top overflow chip — shown when items are clipped above the viewport.
              Lives outside the scroll container so it stays anchored to the
              viewport edge instead of scrolling with content. */}
          <AnimatePresence>
            {overflowCounts.above > 0 && (
              <motion.button
                key="above"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                onClick={() => scrollToFlatIndex(0, 'start')}
                className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-2.5 py-1 rounded-full backdrop-blur-md border border-white/10 shadow-md text-[11px] font-medium pointer-events-auto hover:scale-105 active:scale-95 transition-transform"
                style={{
                  backgroundColor: `${layer.color}22`,
                  color: layer.color,
                  boxShadow: `0 4px 14px ${layer.color}25`,
                }}
                title="Scroll to top"
              >
                <LucideIcons.ChevronUp className="w-3 h-3" />
                <span className="tabular-nums">{overflowCounts.above} above</span>
              </motion.button>
            )}
          </AnimatePresence>

          {/* Bottom overflow chip — shown when items are clipped below the viewport. */}
          <AnimatePresence>
            {overflowCounts.below > 0 && (
              <motion.button
                key="below"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                onClick={() => scrollToFlatIndex(flatTree.length - 1, 'end')}
                className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-2.5 py-1 rounded-full backdrop-blur-md border border-white/10 shadow-md text-[11px] font-medium pointer-events-auto hover:scale-105 active:scale-95 transition-transform"
                style={{
                  backgroundColor: `${layer.color}22`,
                  color: layer.color,
                  boxShadow: `0 4px 14px ${layer.color}25`,
                }}
                title="Scroll to bottom"
              >
                <LucideIcons.ChevronDown className="w-3 h-3" />
                <span className="tabular-nums">{overflowCounts.below} below</span>
              </motion.button>
            )}
          </AnimatePresence>

          {/* ── Anchor Rail — docked stand-ins for the SELECTED node's
              off-screen partners that live in this column. Real DOM
              chips: the edge overlay anchors focus edges to these rects,
              so "where does this go" always has a visible, named
              destination — never an estimated position. Click = scroll
              the real row into view (per-partner Frame); "+N more"
              routes to the Lineage Lens for the complete searchable
              list. Offset below/above the count chips so the two
              surfaces never collide. ── */}
          <AnimatePresence>
            {anchorProxies && anchorProxies.proxies.length > 0 && (() => {
              const upProxies = anchorProxies.proxies.filter(p => p.direction === 'up')
              const downProxies = anchorProxies.proxies.filter(p => p.direction === 'down')
              const renderChip = (p: typeof anchorProxies.proxies[number]) => (
                <button
                  key={p.nodeId}
                  id={`anchor-proxy-${p.nodeId}`}
                  type="button"
                  data-canvas-interactive
                  onClick={(e) => { e.stopPropagation(); onProxyReveal?.(p.nodeId) }}
                  title={`${proxyLabel(p.nodeId)} — off-screen ${p.direction === 'up' ? 'above' : 'below'}. Click to scroll it into view.`}
                  className="pointer-events-auto w-full flex items-center gap-1.5 px-2 py-1 rounded-md bg-canvas-elevated/95 backdrop-blur-md border border-white/10 shadow-md text-[11px] font-medium text-ink hover:scale-[1.02] active:scale-[0.98] transition-transform min-w-0"
                  style={{ borderLeft: `2px solid ${p.color}` }}
                >
                  {p.direction === 'up'
                    ? <LucideIcons.ChevronUp className="w-3 h-3 flex-shrink-0 text-ink-muted/70" />
                    : <LucideIcons.ChevronDown className="w-3 h-3 flex-shrink-0 text-ink-muted/70" />}
                  <span className="truncate">{proxyLabel(p.nodeId)}</span>
                  {p.count > 1 && (
                    <span className="ml-auto flex-shrink-0 tabular-nums text-ink-muted/70">×{p.count}</span>
                  )}
                </button>
              )
              const moreChip = anchorProxies.moreCount > 0 && onProxyMore && (
                <button
                  key="anchor-more"
                  type="button"
                  data-canvas-interactive
                  onClick={(e) => { e.stopPropagation(); onProxyMore() }}
                  title="Every connection of the selected entity, grouped and searchable"
                  className="pointer-events-auto w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded-md bg-canvas-elevated/90 backdrop-blur-md border border-white/10 shadow-md text-[10.5px] font-medium text-ink-muted hover:text-ink hover:scale-[1.02] active:scale-[0.98] transition-all"
                >
                  <LucideIcons.Focus className="w-3 h-3 flex-shrink-0" />
                  +{anchorProxies.moreCount} more · Open lens
                </button>
              )
              return (
                <motion.div
                  key="anchor-rail"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                  className="pointer-events-none"
                >
                  {(upProxies.length > 0 || (downProxies.length === 0 && moreChip)) && (
                    <div className="absolute top-9 left-3 right-3 z-30 flex flex-col gap-1">
                      {upProxies.map(renderChip)}
                      {downProxies.length === 0 && moreChip}
                    </div>
                  )}
                  {(downProxies.length > 0) && (
                    <div className="absolute bottom-9 left-3 right-3 z-30 flex flex-col gap-1">
                      {downProxies.map(renderChip)}
                      {moreChip}
                    </div>
                  )}
                </motion.div>
              )
            })()}
          </AnimatePresence>

          {/* Density gutter — a slim heat strip on the column's right edge
              showing where connection mass lives across the FULL scroll
              range (the budget/stub modes summarize edges, this shows
              where the summarized mass is). Click a hot zone to jump. */}
          {densityBuckets && (
            <button
              type="button"
              data-canvas-interactive
              onClick={handleGutterClick}
              title="Connection density across this column — click to jump"
              className="absolute right-[2px] top-8 bottom-8 w-[4px] z-20 pointer-events-auto cursor-pointer flex flex-col gap-[1px] opacity-60 hover:opacity-100 transition-opacity"
            >
              {densityBuckets.map((v, i) => (
                <span
                  key={i}
                  className="flex-1 w-full rounded-full"
                  style={{
                    // Floor at 0.15: cool zones stay invisible; only real
                    // concentrations mark the strip.
                    backgroundColor: v > 0.15
                      ? `rgba(99, 102, 241, ${(0.15 + Math.pow(v, 1.5) * 0.65).toFixed(3)})`
                      : 'transparent',
                  }}
                />
              ))}
            </button>
          )}

          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
            onContextMenu={(e) => {
              // Right-click on EMPTY layer space → create-in-this-layer menu.
              // Clicks landing on a node card are handled by the card's own
              // context menu, so bail out for those.
              if (!onLayerContextMenu) return
              if ((e.target as HTMLElement).closest('[data-canvas-interactive]')) return
              e.preventDefault()
              e.stopPropagation()
              onLayerContextMenu(e, layer.id)
            }}
            tabIndex={0}
            className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar relative outline-none focus-visible:ring-1 focus-visible:ring-accent-lineage/30 focus-visible:ring-inset"
          >
          {/* Subtle top fade for scroll indication — slimmer now that the
              floating chip handles the indicator role. */}
          <div className="absolute top-0 left-0 right-0 h-3 bg-gradient-to-b from-canvas/80 to-transparent pointer-events-none z-10" />

          {flatTree.length === 0 ? (
            <AnimatePresence mode="wait" initial={false}>
              {shouldShowGhosts ? (
                <motion.div
                  key="ghost-stack"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                  className="py-2 px-1 flex flex-col"
                >
                  {/* Clear caption — removes any ambiguity about whether the
                      ghost cards mean "loading" or "empty layer". */}
                  <div
                    className="flex items-center gap-2 px-3 py-2 mx-1 mb-1 rounded-lg backdrop-blur-sm border"
                    style={{
                      backgroundColor: `${layer.color}10`,
                      borderColor: `${layer.color}25`,
                    }}
                  >
                    <LucideIcons.Loader2
                      className="w-3.5 h-3.5 animate-spin flex-shrink-0"
                      style={{ color: layer.color }}
                    />
                    <span
                      className="text-[11px] font-medium tracking-wide"
                      style={{ color: layer.color }}
                    >
                      Loading {layer.name} entities…
                    </span>
                  </div>
                  {Array.from({ length: GHOST_COUNT_PER_LAYER }).map((_, i) => (
                    <GhostFlatTreeItem key={`ghost-${i}`} index={i} layer={layer} depth={0} />
                  ))}
                </motion.div>
              ) : (
                <motion.div
                  key="empty-state"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                  className="flex flex-col items-center justify-center py-16 px-4"
                >
                  <div
                    className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                    style={{ backgroundColor: `${layer.color}10` }}
                  >
                    <LucideIcons.FolderOpen
                      className="w-8 h-8"
                      style={{ color: `${layer.color}40` }}
                    />
                  </div>
                  <p className="text-sm font-medium text-ink-muted/60">
                    {isBlankModel ? 'No entities yet' : 'No assigned entities yet'}
                  </p>
                  {/* The hint follows the affordance. `onAddToLayer` is what renders the "+"
                      (see the header above), and the caller only passes it inside a draft — so
                      with editing unavailable (read-only, or version control switched off) there
                      is no "+" anywhere on screen, and telling someone to click one is just a
                      small lie in the corner of the page. */}
                  {onAddToLayer && (
                    <p className="text-xs text-ink-muted/40 mt-1">
                      {isBlankModel ? 'Click + to add entities' : 'Click + to assign entities'}
                    </p>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          ) : (
            <div
              className="py-2 px-1 w-full"
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const item = flatTree[virtualRow.index]
                const itemKey = getItemKey(item, virtualRow.index)
                const isNew = newItemKeys.has(itemKey)

                // Shared absolute positioning for the measured container
                // Glide transition only during expand/collapse (not scroll)
                const virtualStyle: React.CSSProperties = {
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                  ...(isGlidingRef.current && !isNew && {
                    transition: 'transform 0.15s ease-out',
                  }),
                }

                // Inner animation wrapper style — applied INSIDE the measured div
                // so scale/opacity don't affect virtualizer measurements
                const animStyle: React.CSSProperties | undefined = isNew ? {
                  animation: `flatTreeSlideIn 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94) backwards`,
                  animationDelay: `${Math.min(virtualRow.index * 0.02, 0.3)}s`,
                  transformOrigin: 'left center',
                } : undefined

                // Error row — shown when loadChildren failed
                if (item.isFailed) {
                  const indentWidth = item.depth * 16
                  return (
                    <div
                      key={itemKey}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={virtualStyle}
                    >
                      <div
                        style={animStyle}
                        className="flex items-center gap-2 mx-1 rounded-xl px-3 py-2 cursor-pointer group/error"
                        onClick={() => onLoadMore && onLoadMore(item.node.id)}
                      >
                        <div style={{ paddingLeft: 12 + indentWidth }} className="flex items-center gap-2">
                          <div className="w-6 h-6 flex-shrink-0 flex items-center justify-center">
                            <LucideIcons.AlertCircle className="w-3.5 h-3.5 text-red-400/70" />
                          </div>
                          <span className="text-xs text-red-400/70 group-hover/error:text-red-400 transition-colors">
                            Failed to load — click to retry
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                }

                // Skeleton loading placeholder — uses the shared GhostFlatTreeItem
                // so initial-hydration ghosts and child-expansion skeletons share
                // one visual language.
                if (item.isSkeleton) {
                  const skeletonAnimStyle: React.CSSProperties | undefined = isNew ? {
                    animation: `flatTreeSkeletonGrow 0.22s cubic-bezier(0.25, 0.46, 0.45, 0.94) backwards`,
                    animationDelay: `${(item.skeletonIndex ?? 0) * 0.06}s`,
                    transformOrigin: 'left top',
                    overflow: 'hidden',
                  } : undefined
                  return (
                    <div
                      key={itemKey}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={virtualStyle}
                    >
                      <div style={skeletonAnimStyle}>
                        <GhostFlatTreeItem
                          index={item.skeletonIndex ?? 0}
                          layer={layer}
                          depth={Math.max(1, item.depth)}
                        />
                      </div>
                    </div>
                  )
                }

                if (item.isSearchBox) {
                  return (
                    <div
                      key={itemKey}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={virtualStyle}
                    >
                      <div style={isNew ? {
                        animation: `flatTreeFadeIn 0.15s cubic-bezier(0.25, 0.46, 0.45, 0.94) backwards`,
                      } : undefined}>
                        <SearchBoxItem
                          parentId={item.node.id}
                          depth={item.depth}
                          parentIsLast={item.parentIsLast}
                          value={childSearchQueries[item.node.id] || ''}
                          onChange={(val) => {
                            setChildSearchQueries(prev => ({ ...prev, [item.node.id]: val }))
                            if (val.trim()) {
                              onSearchChildren && onSearchChildren(item.node.id, val)
                            } else {
                              // If search is cleared, refetch the original children
                              onLoadMore && onLoadMore(item.node.id)
                            }
                          }}
                          isLoading={isLoadingChildren}
                          layer={layer}
                        />
                      </div>
                    </div>
                  )
                }

                if (item.isLoadMore) {
                  return (
                    <div
                      key={itemKey}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={virtualStyle}
                    >
                      <LoadMoreItem
                        parentId={item.node.id}
                        depth={item.depth}
                        parentIsLast={item.parentIsLast}
                        count={item.loadMoreCount!}
                        isLoading={loadingNodes?.has(item.node.id) ?? false}
                        onLoadMore={() => handleLoadMore(item.node.id)}
                      />
                    </div>
                  )
                }

                // Regular FlatTreeItem — animation wrapper inside measured container
                const { node, depth, isLast, parentIsLast } = item
                const navIdx = navigableIndexMap.get(node.id) ?? -1
                return (
                  <div
                    key={itemKey}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={virtualStyle}
                  >
                    <div style={animStyle}>
                      <FlatTreeItem
                        node={node}
                        depth={depth}
                        isLast={isLast}
                        parentIsLast={parentIsLast}
                        layer={layer}
                        schema={schema}
                        isSelected={selectedNodeId === node.id}
                        isExpanded={expandedNodes.has(node.id)}
                        isLoading={loadingNodes?.has(node.id) ?? false}
                        isSearchResult={searchResults.has(node.id)}
                        isHighlighted={traceContextSet.has(node.id)}
                        isFocusNode={traceFocusId === node.id}
                        isTracing={isTracing}
                        isClickHighlighted={isHighlightActive && !isHoverHighlight && (highlightedNodes?.has(node.id) ?? false)}
                        isHoverHighlighted={isHighlightActive && isHoverHighlight && (highlightedNodes?.has(node.id) ?? false)}
                        isDimmedByHighlight={isHighlightActive && !(highlightedNodes?.has(node.id) ?? false)}
                        isFocused={focusIndex >= 0 && navIdx === focusIndex}
                        onSelect={onSelect}
                        onToggle={onToggle}
                        onContextMenu={onContextMenu}
                        onDoubleClick={onDoubleClick}
                        onAddChild={onAddChild}
                        onFocus={handleFocus}
                        onToggleSearch={toggleSearchNode}
                        isSearchVisible={activeSearchNodes.has(node.id)}
                        onBeginConnect={onBeginConnect}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Bottom fade — slimmer now that the floating chip handles the
              indicator role. Sits beneath the bottom chip as a soft mask. */}
          <div className="absolute bottom-0 left-0 right-0 h-3 bg-gradient-to-t from-canvas/80 to-transparent pointer-events-none z-10" />
          </div>
        </div>
      )}
    </motion.div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// LayerHeaderTitle — name + description block for an expanded layer column.
//
// Wraps the title in a 2-line clamp so long names wrap legibly and a hover
// popover that materialises ONLY when text is actually truncated. The
// popover (createPortal + framer-motion) mirrors LineageDisplayPopover's
// pattern so the two header surfaces feel like a matched set.
// ─────────────────────────────────────────────────────────────────────────────

const TITLE_HOVER_OPEN_DELAY_MS = 180
const TITLE_HOVER_CLOSE_DELAY_MS = 80
const TITLE_POPOVER_WIDTH = 320

function LayerHeaderTitle({
  name,
  description,
  color,
}: {
  name: string
  description?: string
  color?: string
}) {
  const resolvedColor = color ?? '#6b7280'
  const containerRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLHeadingElement>(null)
  const descRef = useRef<HTMLParagraphElement>(null)
  const [isTruncated, setIsTruncated] = useState(false)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Detect overflow after layout / on every name/description change. The
  // popover only opens when there's actually more text to show.
  useLayoutEffect(() => {
    const nameOverflow = nameRef.current ? nameRef.current.scrollHeight > nameRef.current.clientHeight + 1 : false
    const descOverflow = descRef.current ? descRef.current.scrollHeight > descRef.current.clientHeight + 1 : false
    setIsTruncated(nameOverflow || descOverflow)
  }, [name, description])

  // Re-check on container resize (column width can change as users open
  // the right-rail drawer or toggle adjacent layers).
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const nameOverflow = nameRef.current ? nameRef.current.scrollHeight > nameRef.current.clientHeight + 1 : false
      const descOverflow = descRef.current ? descRef.current.scrollHeight > descRef.current.clientHeight + 1 : false
      setIsTruncated(nameOverflow || descOverflow)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      // Prefer left-aligned with the title; clamp to viewport so the popover
      // never bleeds off-screen for the right-most column.
      const left = Math.max(
        8,
        Math.min(rect.left, window.innerWidth - TITLE_POPOVER_WIDTH - 8),
      )
      setAnchor({ top: rect.bottom + 6, left })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEffect(() => () => {
    clearTimeout(openTimerRef.current)
    clearTimeout(closeTimerRef.current)
  }, [])

  const scheduleOpen = () => {
    if (!isTruncated) return
    clearTimeout(closeTimerRef.current)
    clearTimeout(openTimerRef.current)
    openTimerRef.current = setTimeout(() => setOpen(true), TITLE_HOVER_OPEN_DELAY_MS)
  }
  const scheduleClose = () => {
    clearTimeout(openTimerRef.current)
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => setOpen(false), TITLE_HOVER_CLOSE_DELAY_MS)
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 min-w-0"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={scheduleOpen}
      onBlur={scheduleClose}
    >
      <h3
        ref={nameRef}
        className="text-sm font-semibold tracking-tight line-clamp-2 leading-snug"
        style={{ color: resolvedColor }}
        title={isTruncated ? undefined : name}
      >
        {name}
      </h3>
      {description && (
        <p
          ref={descRef}
          className="text-[10px] text-ink-muted/70 line-clamp-2 mt-0.5 leading-snug"
        >
          {description}
        </p>
      )}

      {/* No AnimatePresence: the tooltip unmounts instantly on close so an
          interrupted exit can never strand an invisible click-blocker at
          z-1000 over the canvas. It still animates in. */}
      {typeof document !== 'undefined' && createPortal(
        <>
          {open && anchor && (
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.14, ease: 'easeOut' }}
              role="tooltip"
              onMouseEnter={() => {
                clearTimeout(closeTimerRef.current)
              }}
              onMouseLeave={scheduleClose}
              style={{
                position: 'fixed',
                top: anchor.top,
                left: anchor.left,
                width: TITLE_POPOVER_WIDTH,
                zIndex: 1000,
              }}
              className="rounded-xl bg-canvas-elevated/95 backdrop-blur-xl border border-black/[0.10] dark:border-white/[0.08] shadow-2xl shadow-black/20 dark:shadow-black/40 overflow-hidden"
            >
              <div
                className="px-3 py-2 border-b border-black/[0.06] dark:border-white/[0.04]"
                style={{
                  background: `linear-gradient(135deg, ${resolvedColor}18 0%, ${resolvedColor}08 100%)`,
                }}
              >
                <div className="text-[13px] font-semibold tracking-tight leading-snug" style={{ color: resolvedColor }}>
                  {name}
                </div>
              </div>
              {description && (
                <div className="px-3 py-2.5 text-[12px] text-ink/85 leading-relaxed whitespace-pre-wrap">
                  {description}
                </div>
              )}
            </motion.div>
          )}
        </>,
        document.body,
      )}
    </div>
  )
}
