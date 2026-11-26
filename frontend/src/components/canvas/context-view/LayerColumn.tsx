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
import { HoverTip } from '@/components/ui/HoverTip'
import { useSchemaStore } from '@/store/schema'
import { useViewEntityTypes } from '@/hooks/useViewSchema'
import { usePreferencesStore } from '@/store/preferences'
import { usePersonaMode } from '@/store/persona'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import {
  useAncestorMatchCounts,
  useCanvasFilterMode,
  useMatchUrnSet,
} from '@/store/searchStore'
import { narrowRows } from '@/features/narrow/narrowRows'
import { useNarrowVisibility } from '@/features/narrow/narrowStore'
import type { LayerNodeSortAlgo, LayerNodeSortMode, ViewLayerConfig } from '@/types/schema'
import type { HierarchyNode, FlatTreeNode, ColumnGeometryApi } from './types'
import { FlatTreeItem, type GroupActions, type RowSelectModifiers } from './FlatTreeItem'
import { ChangeKindTag, DropHint } from './DropHint'
import { dropSurfaceClass, moveHint, sameHint, type DropHintSpec } from './dropKind'
import { draggedEntity } from './entityDrag'
import { draggedLayer, setDraggedLayer } from './layerDrag'
import { useReparentNode } from './useReparentNode'
import { COLUMN_KIND_ICON, columnKind, columnKindCopy, type ColumnKind, type ColumnKindCopy, type MapOffer } from './columnKind'
import { ColumnKindMark } from './ColumnKindMark'
import { nodeIndexOf } from '@/lib/storeIndex'
import { resolveEntityName } from '@/lib/entityDisplayName'
import type { PlacedOut, PlacementInfo } from './placement'
import { groupNameClash, groupSubtreeIds, listGroups, parentGroupOf } from './layerMutations'
import { LayerSortMenu, SORT_MODE_ICONS, SORT_MODE_LABELS } from './LayerSortMenu'
import { ValueView, humanizeKey } from '@/components/ui/ValueView'
import { LoadMoreItem } from './LoadMoreItem'
import { SearchBoxItem } from './SearchBoxItem'
import { SearchHitInlineRow } from './SearchHitInlineRow'
import { GhostFlatTreeItem, GHOST_COUNT_PER_LAYER } from './GhostFlatTreeItem'
import { densityRowHeights, layerHeaderTokens, TECHNICAL_LINE_HEIGHT } from './density'
import { SPINE_MAX_WIDTH_PX } from './layerFold'
import { inlineSearchHits, type InlineSearchHitRow } from './inlineSearchHits'
import { formatUnitCount, unitMeaning, unitNoun } from './connections/connectionUnits'
import { useColumnPeripheryStore } from '@/store/columnPeriphery'
import { useAnchorRailStore } from '@/store/anchorRail'
import { useEndpoints } from '@/components/panels/relationship/useEndpoints'
import { LineEndTag } from './LineEndTag'
import { lineEndOf, type LineEnds } from './lineEnd'
import { sideVolume, type NodePorts } from './lineagePorts'
import { InfoTooltip } from '../search/panel/builder-atoms/InfoTooltip'
import { useViewRowSearch } from '../search/session/ViewSearchSessionContext'
import { matchesQuick } from '../search/session/quickPredicate'
import type { AncestorRef } from '@/types/search'
import { asOfText, cappedText, feedCountSentence } from '@/features/search-views/model'

interface LayerColumnProps {
  layer: ViewLayerConfig
  nodes: HierarchyNode[]
  schema: ReturnType<typeof useSchemaStore.getState>['schema']
  selectedNodeId: string | null
  /** Every selected row. `selectedNodeId` stays the ONE row the keyboard and
   *  the drawer reason about; this is what the rows paint from, so a
   *  multi-selection does not render as one highlighted row and four that
   *  look untouched. Omitted = just `selectedNodeId`. */
  selectedNodeIds?: ReadonlySet<string>
  expandedNodes: Set<string>
  searchResults: ReadonlySet<string>
  onSelect: (id: string, multi?: boolean) => void
  /** Shift-range result: the selection already held, plus the visible rows
   *  from the last-clicked one to the clicked one — resolved HERE because
   *  this column owns the visible order. */
  onSelectRange: (ids: string[]) => void
  /** ⌘A in the column: select everything the layer shows, folded containers'
   *  insides included — the same answer the layer's menu gives (layerSelection.ts).
   *  Absent, ⌘A selects the rows the column has open. */
  onSelectAllInLayer?: (layerId: string) => void
  onToggle: (id: string) => void
  /** ⇧→ on a row: open the next level inside it (or every level, as the reader
   *  chose) — the menu's Expand. ⇧← : collapse everything inside it. */
  onExpandBelow?: (id: string) => void
  onCollapseInside?: (id: string) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void
  onDoubleClick: (id: string, event?: React.MouseEvent) => void
  onAddChild?: (parentId: string) => void
  onAddToLayer?: (layerId: string) => void
  /** The entity the column is mapped to, which its "+" adds inside — named by the "+" and the empty hint. */
  addInsideName?: string
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
  /** Every seed of the current trace. A bulk trace has several, and all of
   *  them are focus nodes; `traceFocusId` remains the ONE the column would
   *  centre on. Omitted = just `traceFocusId`. */
  traceFocusIds?: ReadonlySet<string>
  traceNodes: Set<string>
  traceContextSet: Set<string>
  isTracing?: boolean
  highlightedNodes?: Set<string>
  isHighlightActive?: boolean
  onAnimationComplete?: () => void
  onLoadMore?: (parentId: string, auto?: boolean) => void
  /** Walk a search hit's ancestors open and scroll to it. The inline hit
   *  rows are pointers into the result set — the entity itself may be
   *  nowhere near loaded — so clicking one has to go through the canvas's
   *  reveal, the same one the results panel uses. */
  onRevealSearchHit?: (urn: string, ancestorPath: AncestorRef[]) => void
  loadingNodes?: Set<string>
  failedNodes?: Set<string>
  /** Open scope: this column's type feeds still have more (present only then).
   *  Drawn as a column-level row that auto-loads while the column GROWS and
   *  offers a click when a page lands elsewhere — never an unattended drain.
   *  `remaining`: what those feeds' types still hold on the server (null/absent:
   *  a feed has no total). */
  feedMore?: { loading: boolean; failed: boolean; remaining?: number | null; types?: string[] }
  onFeedMore?: (layerId: string) => void
  /** A subset view's layer: what its search has listed, of how many, and as of when.
   *  Its header counts the matches, not the children loaded rows report. */
  subsetFeed?: {
    delivered: number
    total: number | null
    status: 'complete' | 'running'
    countStatus: 'exact' | 'lowerBound'
    stale: boolean
    asOf: string | null
    capped: boolean
  }
  /** What an empty layer says, in place of "No assigned entities yet". */
  emptyText?: string
  /** A capped subset layer's ways to the rest of its matches. */
  onSearchInLayer?: (layerId: string) => void
  onExportLayer?: (layerId: string) => void
  /** Parents the server says have no further pages, with the childCount that
   *  was said against: no load-more row while the parent still has that count,
   *  even when some of its children render in other columns. */
  exhaustedParents?: Map<string, number>
  /** Every loaded child of each parent, whichever column it is drawn in (the canvas's containment
   *  map). A child placed in another column is loaded — counting only this column's rows offered a
   *  "Load 1 more" for it that could never arrive. */
  loadedChildren?: Map<string, string[]>
  /** Entities PLACED in a column apart from their parent, with their full path in the data. */
  placedApart?: Map<string, PlacementInfo>
  /** Parents whose children are placed in other columns (the other end of a placement). */
  placedOut?: Map<string, PlacedOut>
  /** Take the reader to a placed entity's parent (expanding its path on the way). */
  onRevealPlacement?: (placement: PlacementInfo) => void
  /** Undo a row's view placement (show it under its parent again). */
  onReturnPlacement?: (entityId: string, parentName?: string) => void
  onScroll?: () => void
  onAssignToLayer?: (entityId: string, layerId: string) => void
  /** Draft-only layer management. Presence gates each affordance — the parent passes these only in
   *  Edit mode, so View mode stays read-only. Reorder moves the column; its nodes/edges follow. */
  onRenameLayer?: (layerId: string, name: string) => void
  /** Groups — view-only containers in this layer: create (optionally inside another group), rename,
   *  delete, and place an entity into one (a drop on the group row). */
  onCreateGroup?: (layerId: string, name: string, parentGroupId?: string) => void
  onRenameGroup?: (layerId: string, groupId: string, name: string) => void
  onDeleteGroup?: (layerId: string, groupId: string, groupName: string) => void
  onPlaceInGroup?: (entityId: string, layerId: string, groupId: string, groupName: string) => void
  /** Move a group (with everything in it) from one layer to a layer — the same one or another. */
  onMoveGroup?: (fromLayerId: string, groupId: string, toLayerId: string, newParentId: string | null) => void
  /** Every layer's groups — where a group on this column can move to. */
  groupDestinations?: Array<{ layerId: string; layerName: string; groups: Array<{ id: string; name: string; path: string }> }>
  onMoveGroupContents?: (layerId: string, fromId: string, toId: string) => void
  onUngroup?: (layerId: string, groupId: string, groupName: string) => void
  onDeleteLayer?: (layerId: string) => void
  /** Delete in one click, with an Undo in its notice (the header's delete asks first instead). */
  onDeleteWithUndo?: (layerId: string) => void
  onReorderLayer?: (draggedLayerId: string, targetLayerId: string) => void
  /** Right-click on the header (folded or not): this layer's menu — insert a layer beside it,
   *  rename, colour, move, delete. Reachable from the Layer Strip too, so no scrolling is needed. */
  onHeaderContextMenu?: (e: React.MouseEvent, layerId: string) => void
  /** This layer's menu is open (from its header's ⋯, a right-click, or its Layer Strip pill): the
   *  header's actions tray stays out until it closes, rather than vanishing from under it. */
  layerMenuOpen?: boolean
  /** Draft: insert a new layer just before this one — the "+" on the header's left edge, which
   *  sits in the gutter between this column and the one before it. */
  onInsertLayerBefore?: (layerId: string) => void
  /** Bumped to open this layer's name for editing: Rename in its menu, or a layer just inserted. */
  renameNonce?: number
  /** Bumped to start naming a new group in this layer: New group in its menu. */
  newGroupNonce?: number
  /** Just inserted: the column fades in where it lands (its neighbours glide aside on their own). */
  isNew?: boolean
  /** Effective node sort mode for this column (override → layer → view default). */
  sortMode?: LayerNodeSortMode
  /** True when the column deviates from the view default (sort menu indicator dot). */
  sortIsOverride?: boolean
  /** The view-wide default named in the sort menu's "View default" item. */
  viewDefaultSortMode?: LayerNodeSortAlgo
  /** Draft mode — enables the persisted sort actions (Custom order / Apply to all layers). */
  canPersistSort?: boolean
  /** Presence mounts the header sort menu. `mode === null` clears the layer override. */
  onSetSortMode?: (layerId: string, mode: LayerNodeSortMode | null) => void
  onApplySortToView?: (layerId: string) => void
  /** Presence shows "Reset custom order" in the sort menu (custom-sorted layers). */
  onResetCustomOrder?: (layerId: string) => void
  /** Custom-order drag-reorder (draft + custom sort mode): root rows show
   *  before/after drop bands; drops land in handleReorderNode on the canvas. */
  reorderEnabled?: boolean
  onReorderDrop?: (draggedId: string, targetId: string, position: 'before' | 'after') => void
  /** Keyboard reorder nudge (⌥↑/↓) — resolves the sibling set canvas-side so it
   *  works for roots and children alike. */
  onReorderNudge?: (nodeId: string, dir: 'up' | 'down') => void
  /** Whether a dragged entity is among a row's siblings — the set custom order arranges. */
  reorderAccepts?: (draggedId: string, targetId: string) => boolean
  /** The canvas takes moves (a draft open and writable, editing on): any row can be dropped inside
   *  another, a data change. */
  moveEnabled?: boolean
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
   *  drives the density gutter AND the per-row ambient hairlines. */
  lineageCounts?: Map<string, { in: number; out: number }>
  /** Per-node out-of-view lineage counts (curated views) — sky cue. */
  externalCue?: ReadonlyMap<string, { in: number; out: number }>
  /** Lineage in/out per entity over the whole graph (`/nodes/degree`) —
   *  absent = not known. Lets a card's port say "lineage exists" even when
   *  none of it leads to anything on this canvas. */
  lineageTotals?: ReadonlyMap<string, { in: number; out: number }>
  /** Entities whose total could not be counted (being asked again). */
  lineageUnknown?: ReadonlySet<string>
  /** Per row: flows the canvas placed outside this view (useEdgeProjection's
   *  offCanvasByNode) — what makes a port hollow. */
  lineageOutside?: ReadonlyMap<string, { in: number; out: number }>
  /** Where each card's lines plug in, by side and direction (lineagePorts.ts). */
  lineagePorts?: ReadonlyMap<string, NodePorts>
  /** Render the per-row ambient in/out hairlines (follows the lineage-
   *  flow master switch). Now anchored to the row box, not the overlay. */
  showLineageIndicators?: boolean
  /** Show the flow-density gutter (summarized edge modes only). */
  showDensityGutter?: boolean
  /** Entry click — reveal the entity on the canvas (the drawer's reveal:
   *  its ancestors open, it scrolls into view and pulses). */
  onProxyReveal?: (nodeId: string) => void
  /** Entry click for one that stands for several entities: open the card
   *  down to them, and scroll to them. */
  onProxyRevealMany?: (nodeIds: string[]) => void
  /** An entity's containment ancestors, nearest first — where an entry's
   *  partner sits. */
  railPathOf?: (id: string) => readonly string[]
  /** A node the canvas draws but its store does not hold (a trace's), so an
   *  entry can name it. */
  resolveNode?: (id: string) => LineageNode | null
  /** The ends of the line the relationship drawer is open on: their rows, and
   *  the rail entry for an end scrolled away, say which end they are. */
  lineEnds?: LineEnds | null
  /** "+N more" overflow — open the Lineage Lens for the full list. */
  onProxyMore?: () => void
  /** The user scrolled this column to its true end (only fires on
   *  columns that actually scroll) — the canvas uses it to auto-load
   *  the next page of ROOTS one page ahead. */
  onEndReached?: () => void
  /** Draft mode: persist a resized width into the VIEW definition
   *  (null clears it). Absent ⇒ resizes stay a personal override. */
  onResizeLayer?: (layerId: string, width: number | null) => void
  /** Anchored column paging: the anchor whose children are this column's rows,
   *  and how many of them are still unloaded. Absent once the column holds the
   *  lot (or when the layer has no anchor), which is what hides the row. */
  anchorMore?: { anchorUrn: string; remaining: number }
  /** Why an anchored column can never fill — see anchorIssueByLayer. Changes
   *  the empty state from "nothing assigned" (untrue here) to the real reason. */
  anchorIssue?: 'missing' | 'duplicate'
  /** A column of types: how many entities of other types are placed in it by hand. */
  handPlaced?: number
  /** Mapping the column to an entity (a view change, columnKind.ts `mapOffer`): what it offers
   *  here, or why not. Absent: nothing to say (a column of types, or no editing). */
  mapOffer?: MapOffer
  /** Open the picker that maps this column to an entity — or, mapped already, to another. */
  onMapLayer?: (layerId: string) => void
  /** Show the entity this column is mapped to as a row in it instead. */
  onUnmapLayer?: (layerId: string) => void
  /** Folded into a spine. The canvas's fold window decides (useLayerFold);
   *  the column only asks, through `onFoldChange`. */
  isFolded?: boolean
  /** A spine's width, px — one width for every spine on the canvas. */
  spineWidth?: number
  /** Changes whenever ANY column's fold changes, so a neighbour slides into
   *  the room a fold opens instead of jumping (see `layoutDependency`). */
  foldEpoch?: string
  /** Folded only: this layer's rows with a line to an OPEN layer, and how
   *  many lines arrive at (`in`) and leave (`out`) each — where the lineage
   *  lands on the spine. */
  foldPorts?: ReadonlyMap<string, { in: number; out: number }>
  /** Folded only: lines between this layer and another folded one (or
   *  inside it). Not drawn, but counted on the spine. */
  foldUndrawnLines?: number
  /** Fold or unfold this column. Absent, the column has no fold control. */
  onFoldChange?: (layerId: string, folded: boolean) => void
}

/** A spine narrower than this drops to its compact type and padding. */
const NARROW_SPINE_PX = 36

/** One control in a header's actions tray: `p-1.5` round a 14px glyph, and the gap. */
const TRAY_BUTTON_PX = 28
/** The tray's leading edge, where its backing fades in over the name. */
const TRAY_FADE_PX = 24
/** How much of the name the tray must leave uncovered while it shows; what
 *  does not fit beside that waits in the layer's menu (⋯). */
const TITLE_PEEK_PX = 96
/** The tray's own controls besides the sort and ⋯, most wanted first. */
type TrayAction = 'add' | 'group' | 'build' | 'rename' | 'delete'

const compactCount = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

/** No Anchor Rail in a column: no one to name. */
const NO_RAIL_IDS: readonly string[] = []

/** Empty room past a column's last row: the height of its edge scrims, and of
 *  the gap its bottom tray keeps from the edge (`h-12`, `bottom-12`). */
const LIST_PAD_END_PX = 48

/** A pin: where lines meet a folded layer's spine, half outside its edge. */
const FOLD_PIN =
  'absolute top-1/2 -translate-y-1/2 w-1 h-2.5 rounded-full ring-[1.5px] ring-canvas'

// Stable key for each flat tree item (used by virtualizer for measurement cache stability)
function getItemKey(item: FlatTreeNode, _index: number): string {
  if (item.isSkeleton) return `skeleton-${item.node.id}-${item.skeletonIndex}`
  if (item.isSearchBox) return `search-${item.node.id}`
  if (item.isSearchHit) return `hit-${item.node.id}-${item.hit?.node.urn ?? 'more'}`
  if (item.isLoadMore) return `loadmore-${item.node.id}`
  if (item.isFailed) return `error-${item.node.id}`
  return item.node.id
}

/**
 * A container nobody has browsed: every child it currently holds was put
 * there out of band by a search reveal (`viaReveal`), not by a page anyone
 * asked for.
 *
 * The "N more" row is also a one-page-ahead sentinel, and a path-only reveal
 * scrolls the hit into view — which drops that row into the viewport for
 * every ancestor on the spine without the reader having scrolled at all.
 * Each one then pages itself, which is exactly the cost the reveal exists to
 * avoid (three `children-with-edges` and three notifications for one three-deep
 * hit). Being carried somewhere is not the same as scrolling there, so the
 * sentinel stays disarmed until the container holds something the reader
 * actually asked for. The button is unaffected.
 */
function holdsOnlyRevealedChildren(node: HierarchyNode): boolean {
  return node.children.length > 0
    && node.children.every(
      (child) => (child.data as { viaReveal?: boolean } | undefined)?.viaReveal === true,
    )
}

export const LayerColumn = React.memo(function LayerColumn({
  layer,
  nodes,
  schema,
  selectedNodeId,
  selectedNodeIds,
  expandedNodes,
  searchResults,
  onSelect,
  onSelectRange,
  onSelectAllInLayer,
  onToggle,
  onExpandBelow,
  onCollapseInside,
  onContextMenu,
  onDoubleClick,
  onAddChild,
  onAddToLayer,
  addInsideName,
  isBlankModel = false,
  onBuildToLayer,
  onBeginConnect,
  onLayerContextMenu,
  traceFocusId,
  traceFocusIds,
  traceNodes: _traceNodes,
  traceContextSet,
  isTracing = false,
  highlightedNodes,
  isHighlightActive = false,
  onAnimationComplete,
  onLoadMore,
  onRevealSearchHit,
  loadingNodes,
  failedNodes,
  exhaustedParents,
  loadedChildren,
  placedApart,
  placedOut,
  onRevealPlacement,
  onReturnPlacement,
  feedMore,
  onFeedMore,
  onScroll,
  onAssignToLayer,
  onRenameLayer,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onPlaceInGroup,
  onMoveGroup,
  groupDestinations,
  onMoveGroupContents,
  onUngroup,
  onDeleteLayer,
  onDeleteWithUndo,
  onReorderLayer,
  onHeaderContextMenu,
  layerMenuOpen = false,
  onInsertLayerBefore,
  renameNonce = 0,
  newGroupNonce = 0,
  isNew = false,
  sortMode = 'alpha-asc',
  sortIsOverride = false,
  viewDefaultSortMode = 'alpha-asc',
  canPersistSort = false,
  onSetSortMode,
  onApplySortToView,
  onResetCustomOrder,
  reorderEnabled = false,
  onReorderDrop,
  onReorderNudge,
  reorderAccepts,
  moveEnabled = false,
  isHydratingInitial = false,
  revealTarget,
  geometryRegistry,
  overscan = 15,
  lineageCounts,
  externalCue,
  lineageTotals,
  lineageUnknown,
  lineageOutside,
  lineagePorts,
  showLineageIndicators = false,
  showDensityGutter = false,
  onProxyReveal,
  onProxyRevealMany,
  railPathOf,
  resolveNode,
  lineEnds = null,
  onProxyMore,
  onEndReached,
  onResizeLayer,
  anchorMore,
  anchorIssue,
  handPlaced = 0,
  mapOffer,
  onMapLayer,
  onUnmapLayer,
  subsetFeed,
  emptyText,
  onSearchInLayer,
  onExportLayer,
  isFolded = false,
  spineWidth = SPINE_MAX_WIDTH_PX,
  foldEpoch = '',
  foldPorts,
  foldUndrawnLines = 0,
  onFoldChange,
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

  // Custom-order guidance state: hint dismissal is a one-time preferences flag;
  // the end-zone hover drives the "Move to end" affordance.
  const customOrderHintDismissed = usePreferencesStore(
    s => s.onboardingCompletedSteps.includes('custom-order-hint'),
  )
  const completeOnboardingStep = usePreferencesStore(s => s.completeOnboardingStep)
  const [endZoneHover, setEndZoneHover] = useState(false)

  // Per-layer column width. Precedence: personal (localStorage)
  // override → authored view width (layer.width, ships to all viewers)
  // → default flex range. In DRAFT mode (onResizeLayer present) a drag
  // writes the VIEW definition and clears any personal override so the
  // editor sees exactly what viewers will see; outside draft, drags
  // stay personal. Width pins exactly (min == max) so dragging is 1:1.
  const [customWidth, setCustomWidthState] = useState<number | null>(() => {
    try {
      const w = JSON.parse(localStorage.getItem('nx-layer-widths') ?? '{}')[layer.id]
      return typeof w === 'number' ? w : null
    } catch { return null }
  })
  const persistPersonalWidth = useCallback((w: number | null) => {
    try {
      const all = JSON.parse(localStorage.getItem('nx-layer-widths') ?? '{}')
      if (w === null) delete all[layer.id]
      else all[layer.id] = w
      localStorage.setItem('nx-layer-widths', JSON.stringify(all))
    } catch { /* storage unavailable — session-only width */ }
  }, [layer.id])
  const effectiveWidth = customWidth ?? layer.width ?? null

  const [localFocusId, setLocalFocusId] = useState<string | null>(null)
  const [breadcrumb, setBreadcrumb] = useState<HierarchyNode[]>([])
  const isCollapsed = isFolded
  const requestFold = (folded: boolean) => onFoldChange?.(layer.id, folded)
  const [activeSearchNodes, setActiveSearchNodes] = useState<Set<string>>(new Set())
  const [isDragOver, setIsDragOver] = useState(false)
  const [focusIndex, setFocusIndex] = useState(-1)
  // Draft layer-management: inline rename, delete-confirm, and which kind of drag is hovering
  // (a layer being reordered vs an entity being reassigned) so the drop hint reads right.
  const [isRenaming, setIsRenaming] = useState(false)
  const [isNamingGroup, setIsNamingGroup] = useState(false)
  // Group rows' actions, bound to this layer (stable, so rows keep their memo).
  const groupActions = useMemo<GroupActions | undefined>(() =>
    onCreateGroup && onRenameGroup && onDeleteGroup && onPlaceInGroup && onMoveGroup && onMoveGroupContents && onUngroup ? {
      layerId: layer.id,
      layerName: layer.name,
      groups: listGroups([layer], layer.id),
      nameTaken: (name, parentId, exceptId) => !!groupNameClash([layer], layer.id, parentId, [name], exceptId ? [exceptId] : []),
      parentOf: (groupId) => parentGroupOf([layer], layer.id, groupId) ?? null,
      otherLayers: (groupDestinations ?? []).filter((d) => d.layerId !== layer.id),
      subtreeOf: (groupId) => groupSubtreeIds([layer], layer.id, groupId),
      create: (name, parentGroupId) => onCreateGroup(layer.id, name, parentGroupId),
      rename: (groupId, name) => onRenameGroup(layer.id, groupId, name),
      remove: (groupId, name) => onDeleteGroup(layer.id, groupId, name),
      place: (entityId, groupId, groupName) => onPlaceInGroup(entityId, layer.id, groupId, groupName),
      move: (groupId, newParentId, toLayerId) => onMoveGroup(layer.id, groupId, toLayerId ?? layer.id, newParentId),
      receive: (groupId, fromLayerId, newParentId) => onMoveGroup(fromLayerId, groupId, layer.id, newParentId),
      moveContents: (fromId, toId) => onMoveGroupContents(layer.id, fromId, toId),
      ungroup: (groupId, name) => onUngroup(layer.id, groupId, name),
    } : undefined,
  [layer, groupDestinations, onCreateGroup, onRenameGroup, onDeleteGroup, onPlaceInGroup, onMoveGroup, onMoveGroupContents, onUngroup])
  const [draftGroupName, setDraftGroupName] = useState('')
  const headerNameTaken = draftGroupName.trim() !== '' && !!groupNameClash([layer], layer.id, null, [draftGroupName])
  const [draftName, setDraftName] = useState(layer.name)
  // A name left as the header shows it is no rename — least of all for a column whose name follows
  // its entity, which a rename would stop following.
  const commitRename = () => { if (onRenameLayer && draftName.trim() !== layer.name) onRenameLayer(layer.id, draftName) }
  // A rename asked for from outside (the layer menu, or a layer just inserted): open the name the
  // moment the request is new — adjusted during render, so there is no effect and no extra paint.
  const [renameSeen, setRenameSeen] = useState(0)
  if (renameNonce > renameSeen && onRenameLayer) {
    setRenameSeen(renameNonce)
    setDraftName(layer.name)
    setIsRenaming(true)
  }
  // A new group asked for from the layer menu (the Business view's header keeps
  // its own button there): open its name, the same way.
  const [newGroupSeen, setNewGroupSeen] = useState(0)
  if (newGroupNonce > newGroupSeen && onCreateGroup) {
    setNewGroupSeen(newGroupNonce)
    setDraftGroupName('')
    setIsNamingGroup(true)
  }
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [dragKind, setDragKind] = useState<'entity' | 'layer' | 'group' | null>(null)
  // A column hovering this header: where it lands — after this one coming from the left, before it
  // from the right (reorderLayer's rule).
  const [layerDropTitle, setLayerDropTitle] = useState<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // ── Drag auto-scroll (rAF-driven) ──────────────────────────────────────────
  // dragover events are irregular and stop entirely while the pointer holds
  // still, so scrolling directly from them stutters. Instead dragover samples
  // the pointer (see the container's onDragOver) and this loop scrolls every
  // frame with distance-proportional speed, stopping itself once no fresh
  // sample has arrived for ~200ms (drag ended or left the column).
  const dragPointerRef = useRef<{ y: number; t: number } | null>(null)
  const dragScrollRafRef = useRef<number | null>(null)
  const dragScrollStep = useCallback(() => {
    const el = scrollContainerRef.current
    const sample = dragPointerRef.current
    if (!el || !sample || performance.now() - sample.t > 200) {
      dragScrollRafRef.current = null
      dragPointerRef.current = null
      return
    }
    const rect = el.getBoundingClientRect()
    const zone = 48
    if (sample.y < rect.top + zone) {
      el.scrollTop -= Math.ceil((rect.top + zone - sample.y) / 4)
    } else if (sample.y > rect.bottom - zone) {
      el.scrollTop += Math.ceil((sample.y - (rect.bottom - zone)) / 4)
    }
    dragScrollRafRef.current = requestAnimationFrame(dragScrollStep)
  }, [])
  useEffect(() => () => {
    if (dragScrollRafRef.current != null) cancelAnimationFrame(dragScrollRafRef.current)
  }, [])

  // The view's ONE search, seen through the narrow slice a column reads.
  // A row-level search box is a scoped instance of that search, not a
  // search of its own: it clamps the session to one container, and the
  // answer comes back here as a local filter over the children already
  // loaded plus the hits the server found deeper inside.
  //
  // Deliberately NOT the session. The session changes identity on every
  // character typed in the header box, and everything below memoises on
  // what this reads — so subscribing to it rebuilt every column's flat
  // tree per keystroke with no row box open anywhere. This slice holds
  // nothing (and keeps its identity) until a box clamps the search, and
  // it is the same idle object on the canvases that provide no session.
  const rowSearch = useViewRowSearch()
  const rowScope = rowSearch.scope
  const quick = rowSearch.quick
  const advancedView = rowSearch.view
  const resultMatchesQuick = rowSearch.resultMatchesQuick

  // What THIS row's box holds — read off the session, never a copy of it.
  // There is one query; a per-row copy drifts the moment a second box opens
  // or the header's × clears the search, and then a box goes on filtering
  // with a word the user can no longer see.
  const boxTextFor = useCallback((n: HierarchyNode): string => (
    rowScope && rowScope.insideUrn === (n.urn ?? n.id)
      ? (quick?.text ?? '')
      : ''
  ), [rowScope, quick])

  const toggleSearchNode = useCallback((nodeId: string) => {
    setActiveSearchNodes(prev => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })

    // Closing the box ends its search. The text lives on the session now,
    // so leaving the scope clamped would keep this container's hit rows on
    // screen with nothing left on the row to explain where they came from.
    const closing = activeSearchNodes.has(nodeId)
    if (closing && rowScope && rowScope.insideUrn === nodeId) {
      rowSearch.setQuick({ text: '' })
      rowSearch.clearScope()
    }

    // Auto-expand the node so the user immediately sees the search box drop down
    if (!closing && !expandedNodes.has(nodeId)) {
      onToggle(nodeId)
    }
  }, [activeSearchNodes, expandedNodes, onToggle, rowScope, rowSearch])

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
  // The canvas's narrowing (features/narrow), or null for the whole view.
  const narrow = useNarrowVisibility()

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
      | { kind: 'loadMore'; parent: HierarchyNode; depth: number; parentIsLast: boolean[]; count: number | null; feed?: boolean }
      | { kind: 'searchHits'; parent: HierarchyNode; depth: number; parentIsLast: boolean[]
          rows: InlineSearchHitRow[]; overflow: number; endsTheGroup: boolean }

    const stack: FrameItem[] = []
    // Neither column-level "Load more" belongs to a trace: the walk has
    // already brought every row the trace draws, and a page loaded under it
    // has nowhere to go (the canvas ignores the click while tracing) — the
    // per-parent rows below stand down the same way.
    // Open scope: the column's type feeds have more. Pushed FIRST so the LIFO
    // stack emits it LAST — the very foot of the column, below any anchor row.
    if (feedMore && !localFocusId && !isTracing) {
      stack.push({
        kind: 'loadMore',
        parent: {
          id: `feed:${layer.id}`,
          urn: `feed:${layer.id}`,
          name: layer.name,
          typeId: '',
          data: {},
          children: [],
          depth: 0,
          entityTypeOption: '',
          tags: [],
        } as HierarchyNode,
        depth: 0,
        parentIsLast: [],
        count: null,
        feed: true,
      })
    }
    // An ANCHORED column draws the anchor's children as its roots, so the
    // anchor row that would normally carry "Load more" is not on screen. Give
    // the COLUMN one instead, standing in for the anchor: LoadMoreItem keys off
    // `node.id`, so handing it the anchor's id routes the click into exactly
    // the same paged `loadChildren(anchorUrn)` every expandable row uses.
    // Pushed first, so the LIFO stack emits it last — at the foot of the column.
    if (anchorMore && !localFocusId && !isTracing) {
      stack.push({
        kind: 'loadMore',
        // A COMPLETE stand-in, not a two-field cast: the row pipeline walks
        // `children` on whatever node a frame carries.
        parent: {
          id: anchorMore.anchorUrn,
          urn: anchorMore.anchorUrn,
          name: layer.name,
          typeId: '',
          data: {},
          children: [],
          depth: 0,
          entityTypeOption: '',
          tags: [],
        } as HierarchyNode,
        depth: 0,
        parentIsLast: [],
        count: anchorMore.remaining,
      })
    }
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
          isFeedMore: frame.feed === true,
        })
        continue
      }

      if (frame.kind === 'searchHits') {
        frame.rows.forEach((row, i) => {
          result.push({
            node: frame.parent,
            depth: frame.depth,
            isLast: frame.endsTheGroup && frame.overflow === 0 && i === frame.rows.length - 1,
            parentIsLast: frame.parentIsLast,
            isSearchHit: true,
            hit: row.hit,
            crumbs: row.crumbs,
          })
        })
        if (frame.overflow > 0) {
          result.push({
            node: frame.parent,
            depth: frame.depth,
            isLast: frame.endsTheGroup,
            parentIsLast: frame.parentIsLast,
            isSearchHit: true,
            overflow: frame.overflow,
          })
        }
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
        const activeQuery = boxTextFor(node).trim().toLowerCase()
        // The row box FILTERS the children this parent already has — it no
        // longer replaces them. `matchesQuick` abstains (passes the row)
        // whenever the query looks somewhere a display name cannot answer
        // for, so the local pass never hides a child the server would
        // return as a hit.
        //
        // NOT during a trace. The trace's tree is an overlay: a filtered
        // view of the graph, chosen by the walk. FlatTreeItem withdraws the
        // magnifier from trace rows, so a box left open from before the
        // trace must not go on subtracting rows from it — nor may the
        // session's hits below, which come from the browse graph underneath
        // and are exactly what the walk left out.
        const displayChildren = !isTracing && activeQuery && quick
          ? node.children.filter(c => matchesQuick(c.name, quick))
          : node.children
        // In trace mode the trace API already returns the complete set of
        // trace-relevant nodes; pulling more siblings just produces noise that
        // useTraceFilteredHierarchy hides anyway. Suppress the "X more" pill.
        const loaded = Math.max(node.children.length, loadedChildren?.get(node.id)?.length ?? 0)
        const hasMore = !isTracing && loaded < childCount && !activeQuery
          && exhaustedParents?.get(node.id) !== childCount

        // What the session found INSIDE this container, at any depth — the
        // half of the answer that is NOT already on the canvas. These rows
        // are read straight off the result page and never written to the
        // store, which is the whole difference from the row box this
        // replaces.
        //
        // `resultMatchesQuick` is what keeps them honest. A result set
        // outlives its query — type one character into the box and the
        // debounced lane skips it, leaving the previous, possibly VIEW-WIDE
        // answer standing — and drawing from that splices foreign entities
        // under this container, their full paths passed off as crumbs.
        //
        // The dedupe set is the FILTERED children, not the loaded ones: the
        // local pass can only read a display name, so a child the server
        // matched on its description is hidden by it. Deduping against the
        // full set would drop that hit too, and the match would vanish.
        const inline = !isTracing && activeQuery && resultMatchesQuick
          && advancedView?.kind === 'results'
          ? inlineSearchHits(
            node.urn ?? node.id,
            advancedView.result.hits ?? [],
            new Set(displayChildren.map(c => c.urn ?? c.id)),
          )
          : null
        const hasInline = inline !== null && (inline.rows.length > 0 || inline.overflow > 0)

        if (hasMore) {
          stack.push({ kind: 'loadMore', parent: node, depth: depth + 1, parentIsLast: childParentIsLast, count: childCount - loaded })
        }

        if (inline && hasInline) {
          stack.push({
            kind: 'searchHits', parent: node, depth: depth + 1, parentIsLast: childParentIsLast,
            rows: inline.rows, overflow: inline.overflow, endsTheGroup: !hasMore,
          })
        }

        for (let i = displayChildren.length - 1; i >= 0; i--) {
          stack.push({
            kind: 'node',
            node: displayChildren[i],
            depth: depth + 1,
            isLast: i === displayChildren.length - 1 && !hasMore && !hasInline,
            parentIsLast: childParentIsLast,
          })
        }
      }
    }

    return result
  }, [nodes, expandedNodes, localFocusId, activeSearchNodes, boxTextFor, loadingNodes, failedNodes, isTracing, quick, advancedView, resultMatchesQuick, anchorMore, exhaustedParents, loadedChildren, feedMore, layer.id, layer.name])

  // Canvas filter pass: drop rows the user asked to hide via the
  // MatchBar's Isolate / Hide modes. We filter at the data layer (not
  // per-row via CSS) so the virtualizer's row-count and offset math
  // collapse around the dropped rows — Isolate mode on a 10k-node
  // hierarchy should render only the matched ancestor chain, not 10k
  // invisible rows. Search-aux rows (load-more, skeletons, search
  // boxes) ride along with their parent node's visibility.
  const flatTree = useMemo(() => {
    // A NARROWED canvas keeps its members and the way to them, before any
    // search filter — a search inside a narrowing still works. Not while a
    // trace is drawn: the trace is then what is being read.
    const narrowed = narrow && !isTracing
      ? narrowRows(rawFlatTree, narrow, (id) => selectedNodeId === id || !!selectedNodeIds?.has(id))
      : rawFlatTree
    // Fast path: no active search OR plain highlight mode — return
    // raw tree by reference so downstream memos don't invalidate on
    // search-state changes that don't affect visibility.
    if (matchUrnSet.size === 0) return narrowed
    if (canvasFilterMode === 'highlight') return narrowed

    const isVisibleNode = (n: HierarchyNode): boolean => {
      // Selection always wins so the user can never accidentally
      // make their inspected row vanish.
      if (selectedNodeId === n.id || selectedNodeIds?.has(n.id)) return true
      const key = n.urn ?? n.id
      const isMatch = matchUrnSet.has(key)
      const onSpine = (ancestorMatchCounts.get(key) ?? 0) > 0
      if (canvasFilterMode === 'isolate') {
        return isMatch || onSpine
      }
      // 'hide' — drop the matched leaves but keep ancestor context.
      return !isMatch
    }

    return narrowed.filter((item) => {
      // An inline hit row IS a match, but its `node` is the container it
      // hangs under — so `isVisibleNode` would answer for the wrong entity
      // and keep the row in Hide mode, which exists to take matches away.
      if (item.isSearchHit) return canvasFilterMode !== 'hide'
      return isVisibleNode(item.node)
    })
  }, [
    rawFlatTree, narrow, isTracing, matchUrnSet, ancestorMatchCounts, canvasFilterMode,
    selectedNodeId, selectedNodeIds,
  ])

  const viewEntityTypes = useViewEntityTypes()
  // Header totals, 'Layer + known children'. `loadedCount` is the entities
  // loaded into this column, nested included; group wrappers are not entities.
  // `layerTotal` adds what the column knows is still unloaded: each row's
  // childCount less its loaded children (wherever drawn; none once the server
  // said no more pages), the anchor's remainder, and the type feeds' remainder.
  // A row whose every containable type (per the view's ontology) this column
  // feeds with a known total adds no remainder of its own: the feeds already
  // count those children. childCount is not split by type, so a row that can
  // also hold an unfed type keeps its remainder rather than lose those children.
  const { loadedCount, layerTotal } = useMemo(() => {
    const fed = new Set(feedMore?.remaining != null ? (feedMore.types ?? []).map(t => t.toLowerCase()) : [])
    const coveredByFeed = new Set(fed.size === 0 ? [] : viewEntityTypes
      .filter(et => {
        const canContain = et.hierarchy?.canContain ?? []
        return canContain.length > 0 && canContain.every(t => fed.has(t.toLowerCase()))
      })
      .map(et => et.id.toLowerCase()))
    let loadedCount = 0
    let unloaded = (anchorMore?.remaining ?? 0) + (feedMore?.remaining ?? 0)
    const stack = [...nodes]
    while (stack.length > 0) {
      const n = stack.pop()!
      for (const c of n.children) stack.push(c)
      if (n.isLogical) continue
      loadedCount++
      const childCount = (n.data.childCount as number) || (n.data._collapsedChildCount as number) || 0
      if (childCount === 0 || exhaustedParents?.get(n.id) === childCount) continue
      if (coveredByFeed.has(String(n.typeId).toLowerCase())) continue
      unloaded += Math.max(0, childCount - Math.max(n.children.length, loadedChildren?.get(n.id)?.length ?? 0))
    }
    return { loadedCount, layerTotal: loadedCount + unloaded }
  }, [nodes, anchorMore, feedMore, exhaustedParents, loadedChildren, viewEntityTypes])
  const totalIsFloor = subsetFeed
    ? subsetFeed.status === 'running' || subsetFeed.countStatus === 'lowerBound'
    : !!feedMore && feedMore.remaining == null  // a feed with more has no server total
  const totalLabel = subsetFeed
    ? `${(subsetFeed.total ?? subsetFeed.delivered).toLocaleString()}${totalIsFloor ? '+' : ''}`
    : `${layerTotal.toLocaleString()}${totalIsFloor ? '+' : ''}`
  const subsetAsOf = subsetFeed?.stale ? asOfText(subsetFeed.asOf) : null
  // A count still rising with nothing known past what is listed reads "4+", not "4 / 4+".
  const subsetShowsTotal = !!subsetFeed && (!totalIsFloor || (subsetFeed.total ?? 0) > subsetFeed.delivered)

  // TRACE HEADER: what this lane contributes to the LINEAGE — participants,
  // not rows. Each root carries the view model's own count of the
  // participants inside it (`onLineage`, self excluded), so the lane total is
  // that plus the roots that are participants themselves. Counting rendered
  // rows instead would fold in the HOSTS — the containers the flow merely
  // passes through, which the view model is explicit are never on the lineage
  // — and a column of chrome reporting "8 on this lineage" is exactly the
  // inflated count this rebuild exists to remove.
  const onLineageCount = useMemo(() => {
    if (!isTracing) return 0
    return nodes.reduce((acc, n) => {
      const role = (n.data as Record<string, unknown> | undefined)?.traceRole
      const inside = Number((n.data as Record<string, unknown> | undefined)?.onLineage ?? 0) || 0
      return acc + inside + (role && role !== 'host' ? 1 : 0)
    }, 0)
  }, [isTracing, nodes])
  const onLineageLabel = `${onLineageCount.toLocaleString()} on this lineage`

  // Fetch the next page of a parent's children. Stable identity — the row that
  // calls this used to be an IntersectionObserver sentinel whose one-shot latch
  // was reset every time this callback's identity churned.
  const handleLoadMore = useCallback((nodeId: string, auto?: boolean) => {
    onLoadMore?.(nodeId, auto)
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
    () => flatTree.filter(item => !item.isSearchBox && !item.isSkeleton && !item.isFailed && !item.isLoadMore && !item.isSearchHit),
    [flatTree]
  )

  // O(1) lookup: node ID → navigable index
  const navigableIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    navigableItems.forEach((item, idx) => map.set(item.node.id, idx))
    return map
  }, [navigableItems])

  // Row click → selection. Cmd/Ctrl toggles; Shift ADDS everything between
  // the last-clicked row and this one, in the order the column is DRAWN
  // (navigableItems, so a collapsed subtree contributes nothing — a range is
  // what the user can see, not what the tree happens to hold). Adds, because
  // a selection is often built across columns: a range here must not drop
  // the entities already picked in another.
  //
  // The anchor is the store's lastNodeClick, which bumps on every click. When
  // it names a row in another column — or nothing has been clicked yet — a
  // shift-click toggles this one row in, as Cmd/Ctrl would, rather than
  // silently doing nothing or replacing what is held.
  const handleRowSelect = useCallback((id: string, modifiers: RowSelectModifiers) => {
    if (modifiers.range) {
      const { lastNodeClick, selectedNodeIds: held } = useCanvasStore.getState()
      const anchorId = lastNodeClick.nodeId
      const from = anchorId ? navigableIndexMap.get(anchorId) : undefined
      const to = navigableIndexMap.get(id)
      if (from !== undefined && to !== undefined) {
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        const range = navigableItems.slice(lo, hi + 1).map((item) => item.node.id)
        onSelectRange([...new Set([...held, ...range])])
        return
      }
      onSelect(id, true)
      return
    }
    // Armed from the UI, a plain click behaves as a modifier-click would.
    onSelect(id, modifiers.multi || useCanvasStore.getState().multiSelectArmed)
  }, [navigableItems, navigableIndexMap, onSelect, onSelectRange])

  // O(1) lookup: node ID → flatTree index (for virtualizer.scrollToIndex)
  const nodeToFlatIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    flatTree.forEach((item, idx) => {
      if (!item.isSkeleton && !item.isSearchBox && !item.isFailed && !item.isLoadMore && !item.isSearchHit) {
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
  // Technical mode adds a second line to every FlatTreeItem row, so the
  // estimate has to grow with it — the estimate is all a row the virtualizer
  // has never mounted contributes to `getTotalSize()` and to every
  // `scrollToIndex` offset. The chrome rows below (search box, search hit,
  // skeleton, load-more, error) render no technical line and keep their size.
  // Minimal sets the identifier on the name's line, so its rows do not grow,
  // and with the IDs hidden in Display settings there is no line at all.
  const personaMode = usePersonaMode()
  const showEntityIds = usePreferencesStore(s => s.showCanvasEntityIds) ?? true
  const technicalExtra = personaMode === 'technical' && showEntityIds && density !== 'minimal' ? TECHNICAL_LINE_HEIGHT : 0
  const virtualizer = useVirtualizer({
    count: flatTree.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const item = flatTree[index]
      if (item.isSearchBox) return rowHeights.searchBox
      if (item.isSearchHit) return rowHeights.child
      if (item.isSkeleton) return rowHeights.skeleton
      if (item.isFailed) return rowHeights.failed
      if (item.isLoadMore) return rowHeights.loadMore
      return (item.depth === 0 ? rowHeights.root : rowHeights.child) + technicalExtra
    },
    overscan,
    // Room past the last row, so it can always scroll clear of what sits on
    // the column's foot: the edge scrims and trays (h-12), and the pills that
    // float over the bottom of the canvas.
    paddingEnd: LIST_PAD_END_PX,
    getItemKey: (index) => getItemKey(flatTree[index], index),
  })

  // Re-measure all virtualized rows when density, the persona or the IDs
  // switch flips so the cached measurements from the previous mode don't leave
  // the row stack pinned to stale heights. `itemSizeCache` survives unmount and
  // is read ahead of `estimateSize`, so without this a row first measured in
  // Business mode keeps its shorter height for the rest of the session.
  useEffect(() => {
    virtualizer.measure()
  }, [density, personaMode, showEntityIds, virtualizer])

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
    // Folded: the canvas opens a folded layer for a reveal into it. Spending
    // the pulse now would scroll a list that is not mounted, and the row
    // would never be reached once the column opened.
    if (isCollapsed) return
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
      // ``inline: 'center'`` is what brings the LayerColumn
      // horizontally on-screen. ``block`` must AGREE with the
      // virtualizer's ``align: 'center'`` above rather than defer to
      // it: ``'nearest'`` scrolls each ancestor the least amount that
      // makes the row visible, so against a smooth scroll still in
      // flight it parks the row flush against an edge — a hit landing
      // at y=953 of a 1000px viewport, on the fold, with nothing under
      // it. Two scrolls asking for the same thing land in the middle.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const row = document.getElementById(`layer-node-${targetId}`)
          if (row) {
            row.scrollIntoView({
              inline: 'center',
              block: 'center',
              behavior: 'smooth',
            })
          }
        })
      })
    }, 50)
    return () => clearTimeout(timer)
  }, [revealTarget, nodeToFlatIndexMap, virtualizer, isCollapsed])

  // Auto-scroll trace focus node into view — runs ONCE per focus change.
  // Without the ref guard the effect re-fires every time nodeToFlatIndexMap
  // re-memoizes (which happens during scroll-driven virtualizer reflows),
  // snapping the user back to the focus and preventing them from scrolling
  // up or down through the lineage. With the guard the focus is centered
  // when a trace starts; afterwards the user's scroll position is theirs.
  //
  // T24 F5 — "Trace from here" vertically centered the focus row inside
  // its OWN column via the virtualizer, but never brought the COLUMN
  // itself into the canvas's horizontal viewport — the same "3-click
  // reveal" gap `revealTarget`'s own effect (below) already closed for a
  // search hit. Chains the identical two-rAF horizontal scrollIntoView.
  const lastCenteredFocusRef = useRef<string | null>(null)
  useEffect(() => {
    if (!traceFocusId) {
      lastCenteredFocusRef.current = null
      return
    }
    if (lastCenteredFocusRef.current === traceFocusId) return
    // A BULK trace has no single focus to centre on. Centring the first seed
    // scrolled the canvas off every other one the user had just picked — so
    // when there are several, the viewport stays where they left it.
    if ((traceFocusIds?.size ?? 0) > 1) return
    const flatIndex = nodeToFlatIndexMap.get(traceFocusId)
    if (flatIndex === undefined) return
    // Folded: no list to centre in, and the id belongs to a fold anchor —
    // wait for the column to open rather than mark the focus centred.
    if (isCollapsed) return
    const targetId = traceFocusId
    const timer = setTimeout(() => {
      virtualizer.scrollToIndex(flatIndex, { align: 'center', behavior: 'smooth' })
      lastCenteredFocusRef.current = targetId
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
    }, 100)
    return () => clearTimeout(timer)
  }, [traceFocusId, traceFocusIds, nodeToFlatIndexMap, virtualizer, isCollapsed])

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
  //
  // A BULK expansion (a whole level opened at once — useExpandBelow) reveals
  // only its topmost row. Revealing each in turn scrolled the column to every
  // one of them, so it ended wherever the last page happened to land.
  const prevExpandedRef = useRef<Set<string>>(expandedNodes)
  const pendingExpandRevealRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    const prev = prevExpandedRef.current
    prevExpandedRef.current = expandedNodes
    const pending = pendingExpandRevealRef.current
    let topmost: string | null = null
    expandedNodes.forEach(id => {
      if (prev.has(id)) return
      const idx = nodeToFlatIndexMap.get(id)
      if (idx === undefined) return
      if (topmost === null || idx < nodeToFlatIndexMap.get(topmost)!) topmost = id
    })
    if (topmost !== null) pending.set(topmost, Date.now() + 2000)
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
    // ⌥↑ / ⌥↓ — keyboard reorder for any node of a custom-sorted draft layer
    // (roots AND children — the canvas nudge resolves the sibling set). The
    // accessible sibling of the drag bands; focus follows the moved node via
    // pendingFocusNodeIdRef once the re-sorted tree lands.
    if (e.altKey && reorderEnabled && onReorderNudge && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const item = navigableItems[focusIndex]
      if (item && !item.node.isLogical) {
        e.preventDefault()
        pendingFocusNodeIdRef.current = item.node.id
        onReorderNudge(item.node.id, e.key === 'ArrowUp' ? 'up' : 'down')
        return
      }
    }
    // Cmd/Ctrl+A selects every entity the layer shows, in one write — the
    // selection bar then offers to compare and edit them. Only on the column
    // itself. The canvas answers what "every" is, so this, the layer's menu and
    // an empty column's menu agree.
    if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.target === e.currentTarget) {
      if (onSelectAllInLayer) {
        e.preventDefault()
        e.stopPropagation()
        onSelectAllInLayer(layer.id)
        return
      }
      const ids = navigableItems.filter((item) => !item.node.isLogical).map((item) => item.node.id)
      if (ids.length > 0) {
        e.preventDefault()
        e.stopPropagation()
        onSelectRange(ids)
      }
      return
    }
    // Space or Cmd/Ctrl+Enter toggles the focused row in the selection — the
    // keyboard's Cmd-click. Only on the column itself: typed into a row's
    // search box or rename field, or on a focused button, the key is theirs.
    if ((e.key === ' ' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) && e.target === e.currentTarget) {
      const item = navigableItems[focusIndex]
      if (item) {
        e.preventDefault()
        onSelect(item.node.id, true)
      }
      return
    }
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
        if (item && e.shiftKey && onExpandBelow) onExpandBelow(item.node.id)
        else if (item && !expandedNodes.has(item.node.id)) onToggle(item.node.id)
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        const item = navigableItems[focusIndex]
        if (item && e.shiftKey && onCollapseInside) onCollapseInside(item.node.id)
        else if (item && expandedNodes.has(item.node.id)) onToggle(item.node.id)
        break
      }
      case 'Enter': {
        const item = navigableItems[focusIndex]
        if (!item) break
        // Enter on the row that is ALREADY selected is the canvas's documented
        // "Enter — Edit Selected": let it through. Swallowing every Enter left
        // keyboard users re-selecting the row they were on, forever.
        if (item.node.id === selectedNodeId) break
        // End the SELECTING keystroke at the React root. This scroller is a
        // plain div, so useCanvasKeyboard's document listener does not treat it
        // as an activatable control: without this, one Enter selected the row
        // here AND fired the canvas `onEdit` — on the node selected BEFORE this
        // keystroke, since React has not flushed onSelect by then.
        e.stopPropagation()
        onSelect(item.node.id)
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
  }, [navigableItems, focusIndex, expandedNodes, onToggle, onExpandBelow, onCollapseInside, onSelect, onSelectRange, onSelectAllInLayer, layer.id, selectedNodeId, reorderEnabled, onReorderNudge])

  // After a keyboard reorder, re-point focus at the moved node's new row
  // (its index shifts by the displaced neighbor's visible subtree size).
  const pendingFocusNodeIdRef = useRef<string | null>(null)
  useEffect(() => {
    const id = pendingFocusNodeIdRef.current
    if (!id) return
    const idx = navigableItems.findIndex(it => it.node.id === id)
    if (idx >= 0) {
      setFocusIndex(idx)
      pendingFocusNodeIdRef.current = null
    }
  }, [navigableItems])

  // Entity rows currently in the tree (expanded children included).
  // Auxiliary rows — search boxes, skeletons, load-more, failed
  // placeholders — are UI, not entities: counting them pushed the header
  // past the loaded total ("402 / 400"). Entity rows are a strict subset
  // of loaded entities, so X ≤ Y holds by construction. Group wrappers are not
  // entities either.
  const visibleCount = useMemo(
    () => flatTree.reduce((acc, it) =>
      acc + (it.isSkeleton || it.isSearchBox || it.isFailed || it.isLoadMore || it.isSearchHit || it.node.isLogical ? 0 : 1), 0),
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
    !it.isSkeleton && !it.isSearchBox && !it.isFailed && !it.isLoadMore && !it.isSearchHit
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

  // Periphery summary — flows from visible entities to partners beyond
  // THIS column's fold, computed by the edge overlay. Merged into the
  // "N above/below" chips so rows and lines read as one labeled statement
  // ("↑ 97 rows · 306 lines") instead of two unlabeled numbers in
  // different units floating near each other.
  const periphery = useColumnPeripheryStore(s => s.summaries[layer.id])
  // Anchor Rail — the focused entity's off-screen partners that live in THIS
  // column, docked as proxy chips the edge overlay anchors to. A store read,
  // so the rail following the pointer re-renders only the columns it moves in.
  const anchorProxies = useAnchorRailStore(s => s.groups.get(layer.id))
  // Trays, or a hint that opens one (Display > Lineage). A tray opened from
  // its hint, or folded into it (× or Esc), stays so for the entity it
  // lists, and follows the setting again when the focus moves on to another
  // — adjusted as the change arrives, not in an effect. A moment with no
  // rail at all (its partners on screen) is not the focus moving on.
  const showConnectedTrays = usePreferencesStore(s => s.showConnectedTrays) ?? true
  const railFocusId = useAnchorRailStore(s => s.focusId)
  const [railOverride, setRailOverride] = useState<{ up?: boolean; down?: boolean }>({})
  const [railFocusSeen, setRailFocusSeen] = useState(railFocusId)
  if (railFocusId !== null && railFocusSeen !== railFocusId) {
    setRailFocusSeen(railFocusId)
    if (railOverride.up !== undefined || railOverride.down !== undefined) setRailOverride({})
  }
  const trayOpen = (direction: 'up' | 'down') => railOverride[direction] ?? showConnectedTrays
  // Folding or opening hands keyboard focus to what took the tray's place:
  // the hint, or the tray's first entry.
  const railHandoffRef = useRef<{ direction: 'up' | 'down'; open: boolean } | null>(null)
  const setTrayOpen = (direction: 'up' | 'down', open: boolean) => {
    railHandoffRef.current = { direction, open }
    setRailOverride(prev => ({ ...prev, [direction]: open }))
  }
  // A tray and its hint are different places for the focused entity's lines
  // to dock, so opening one or switching trays draws those lines again.
  useEffect(() => {
    onAnimationComplete?.()
  }, [railOverride, showConnectedTrays, onAnimationComplete])
  useEffect(() => {
    const handoff = railHandoffRef.current
    if (!handoff) return
    railHandoffRef.current = null
    const to = handoff.open
      ? document.getElementById(`anchor-tray-${layer.id}-${handoff.direction}`)
        ?.querySelector<HTMLElement>('[id^="anchor-proxy-"]')
      : document.getElementById(`anchor-rail-${layer.id}-${handoff.direction}`)
    to?.focus()
  }, [railOverride, layer.id])
  // A reveal brings an entry's partner on screen, so the rail drops the
  // entry the reader pressed — or, with it the last, is on its way out:
  // keyboard focus goes to this column, not back to the page.
  const railRevealFromRef = useRef<Element | null>(null)
  useEffect(() => {
    const from = railRevealFromRef.current
    if (!from || (from.isConnected && anchorProxies)) return
    railRevealFromRef.current = null
    const active = document.activeElement
    if (!active || active === from || active === document.body) scrollContainerRef.current?.focus({ preventScroll: true })
  }, [anchorProxies])
  // Who the entries stand for, by name: the focused entity, and each entity
  // a line really reaches with what holds it — from the canvas, else one
  // batched lookup (a partner inside a collapsed card is not loaded).
  const railIds = useMemo(() => {
    if (!anchorProxies || !railFocusId) return NO_RAIL_IDS
    const ids = [railFocusId]
    for (const p of anchorProxies.proxies) {
      if (!p.realId) continue
      ids.push(p.realId)
      const parent = railPathOf?.(p.realId)[0]
      if (parent && parent !== p.nodeId) ids.push(parent)
    }
    return ids
  }, [anchorProxies, railFocusId, railPathOf])
  const railNames = useEndpoints(railIds, resolveNode)

  // ── End-reached sentinel (roots auto-paging) ─────────────────────────
  // Fires when the user scrolls this column to its true end. Guards, in
  // the order that killed the historical auto-load pump:
  // - only on columns that ACTUALLY scroll (a short column is always "at
  //   its end" and would otherwise drain every root page on load);
  // - latched per flatTree.length, re-armed only when content grows;
  // - 300ms dwell so momentum-scrolling through doesn't fire.
  const endFiredForLenRef = useRef(-1)
  useEffect(() => {
    if (!onEndReached) return
    if (flatTree.length === 0 || overflowCounts.below !== 0) return
    if (endFiredForLenRef.current === flatTree.length) return
    const el = scrollContainerRef.current
    if (!el || el.scrollHeight <= el.clientHeight + 10) return
    const t = setTimeout(() => {
      endFiredForLenRef.current = flatTree.length
      onEndReached()
    }, 300)
    return () => clearTimeout(t)
  }, [onEndReached, overflowCounts.below, flatTree.length])

  const scrollToFlatIndex = useCallback((index: number, align: 'start' | 'end') => {
    if (index < 0 || index >= flatTree.length) return
    virtualizer.scrollToIndex(index, { align, behavior: 'smooth' })
  }, [virtualizer, flatTree.length])

  // ── Density gutter buckets ────────────────────────────────────────────────
  // Heaviest in/out volume in THIS column — the reference for the ambient
  // hairline intensity (log-scaled) so median rows fade and hubs stand
  // out. Per-column and across ALL rows so intensity is stable regardless
  // of which rows are scrolled into view. 0 = no lineage / indicators off.
  const lineageLogMax = useMemo(() => {
    if (!showLineageIndicators || !lineagePorts || lineagePorts.size === 0) return 0
    let maxCount = 0
    for (const item of flatTree) {
      const p = lineagePorts.get(item.node.id)
      maxCount = Math.max(maxCount, sideVolume(p, 'left'), sideVolume(p, 'right'))
    }
    return Math.log2(1 + Math.max(1, maxCount))
  }, [showLineageIndicators, lineagePorts, flatTree])

  // Where does flow mass live across the WHOLE column (not just the
  // viewport)? Bucket the flat tree by index; each bucket sums the in+out
  // lineage counts of its rows. Normalized 0..1 for the heat strip.
  const densityBuckets = useMemo(() => {
    if (!showDensityGutter || !lineageCounts || lineageCounts.size === 0 || flatTree.length === 0) return null
    // Too few rows to have off-screen mass worth mapping.
    if (flatTree.length < 24) return null
    const n = Math.min(48, flatTree.length)
    const vals = new Array<number>(n).fill(0)
    flatTree.forEach((item, idx) => {
      if (item.isSkeleton || item.isSearchBox || item.isFailed || item.isLoadMore || item.isSearchHit) return
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

  // ── Fold anchors — where a FOLDED layer's lineage lands ────────────────
  // One per row with a line to an open layer (the canvas says which, as
  // `foldPorts`), at the height the row would have in the open column: the
  // virtualizer still knows every row's offset with nothing mounted. A list
  // taller than the spine is scaled down to it, so a small folded layer
  // keeps its lines level and a long one reads as a miniature of itself —
  // never a pile-up at the top.
  const foldAnchors = useMemo(() => {
    if (!isCollapsed || !foldPorts || foldPorts.size === 0) return []
    const listHeight = virtualizer.getTotalSize()  // also refreshes measurementsCache
    if (listHeight <= 0) return []
    const anchors: Array<{ id: string; name: string; offset: number; share: number; in: number; out: number }> = []
    foldPorts.forEach((port, id) => {
      const idx = nodeToFlatIndexMap.get(id)
      const m = idx === undefined ? undefined : virtualizer.measurementsCache[idx]
      if (idx === undefined || !m) return
      const offset = m.start + m.size / 2
      anchors.push({ id, name: flatTree[idx].node.name, offset, share: offset / listHeight, in: port.in, out: port.out })
    })
    return anchors
    // `flatTree` stands in for the virtualizer's row set: the instance is
    // stable, its measurements are not.
  }, [isCollapsed, foldPorts, nodeToFlatIndexMap, virtualizer, flatTree])
  const foldLines = useMemo(
    () => foldAnchors.reduce((lines, anchor) => lines + anchor.in + anchor.out, 0),
    [foldAnchors],
  )
  // The spine's icon tile shrinks with it, keeping 7px either side.
  const spineTile = Math.max(16, Math.min(32, spineWidth - 14))
  // Everything the spine speaks for: the lines drawn onto it, and those to
  // other folded layers that appear once one end opens.
  const spineLines = foldLines + foldUndrawnLines
  const spineLinesSaid = spineLines === 0 ? '' : [
    foldLines > 0 && `${foldLines.toLocaleString()} ${unitNoun(foldLines, 'lines')} from the open layers ${foldLines === 1 ? 'lands' : 'land'} here`,
    foldUndrawnLines > 0 && `${foldUndrawnLines.toLocaleString()} ${unitNoun(foldUndrawnLines, 'lines')} ${foldUndrawnLines === 1 ? 'runs' : 'run'} to other folded layers, drawn once one end opens`,
  ].filter(Boolean).join('; ')

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
    // Virtualizer offsets are from the top of the totalSize wrapper below:
    // its rows are absolutely positioned at `top: 0`, so its `py-2` padding
    // does not move them.
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
          top: rect.top + (m.start - el.scrollTop) * scale,
          height: m.size * scale,
          left: rect.left,
          right: rect.right,
        }
      },
      getListRect: () => scrollContainerRef.current?.getBoundingClientRect() ?? null,
    }
    geometryRegistry.set(layer.id, api)
    return () => { geometryRegistry.delete(layer.id) }
  }, [geometryRegistry, layer.id, virtualizer])

  // ── A column mapped to an entity takes a drop anywhere in its body ──────────
  // The column IS that entity, so an entity dropped on its body (not on a row — a row takes its
  // own drop) goes inside it: a DATA change, said as one while the drag hovers. The header keeps
  // its view-only meaning (show in this column).
  const { reparent, verdict } = useReparentNode()
  const anchorUrn = layer.anchorUrn && !anchorIssue ? layer.anchorUrn : null
  const anchorNode = useCanvasStore((s) => (anchorUrn ? nodeIndexOf(s.nodes).get(anchorUrn) : undefined))
  const [bodyHint, setBodyHint] = useState<(DropHintSpec & { top: number }) | null>(null)
  // The hint rides just above the pointer, so it never sits far from where the drop lands — moved
  // in place on each dragover rather than re-rendering the column.
  const bodyChipRef = useRef<HTMLDivElement>(null)
  const chipTop = (clientY: number, box: DOMRect) => Math.max(10, Math.min(clientY - box.top - 44, box.height - 40))
  const bodyHintFor = (): DropHintSpec | null => {
    if (!anchorNode) return null
    const dragged = draggedEntity()
    return moveHint(dragged ? verdict(dragged, anchorNode.id) : { kind: 'data', edgeType: null },
      resolveEntityName(anchorNode.data, personaMode, anchorNode.id))
  }
  /** A drag over a row — or over the end zone arranging this column's own rows — which answers
   *  for itself. */
  const overRow = (e: React.DragEvent) => {
    const at = e.target as Element | null
    return !!at?.closest?.('[id^="layer-node-"]') || (!!at?.closest?.('[data-end-zone]') && !forTheBody())
  }
  /** In a mapped column, a row dragged from elsewhere is for the body — not the end zone, which
   *  arranges this column's own rows. */
  const forTheBody = () => {
    const dragged = draggedEntity()
    return !!anchorNode && !!dragged && !nodes.some((n) => n.id === dragged)
  }
  // What kind of column this is — mapped to an entity, by type, or hand-picked — said by a mark
  // on its tile and in its name's card, in the reader's view.
  const kind = columnKind(layer, { resolved: !!anchorNode, issue: anchorIssue })
  const anchorName = anchorNode ? resolveEntityName(anchorNode.data, personaMode, anchorNode.id) : undefined
  const kindCopy = columnKindCopy(kind, {
    persona: personaMode,
    anchorName,
    anchorUrn: layer.anchorUrn,
    typeNames: (layer.entityTypes ?? []).map((id) => viewEntityTypes.find((t) => t.id === id)?.name ?? id),
    typePlurals: (layer.entityTypes ?? []).map((id) => {
      const t = viewEntityTypes.find((x) => x.id === id)
      return t?.pluralName ?? `${t?.name ?? id}s`
    }),
    typeIds: layer.entityTypes,
    ruleCount: layer.rules?.length,
    handPlaced,
  })
  // A row that can't hold what is dropped on it passes the drop to the entity the column is.
  const anchorId = anchorNode?.id
  const forwardTo = useMemo(() => (anchorId && anchorName ? { id: anchorId, name: anchorName } : undefined), [anchorId, anchorName])
  const openAnchor = kind === 'mapped' && anchorNode ? () => {
    const id = anchorNode.id
    useCanvasStore.getState().requestDrawerMove(() => {
      const st = useCanvasStore.getState()
      st.openNodeDrawer(id)
      st.selectNode(id)
    })
  } : undefined
  // Mapping it to an entity: map it (to another), show its entity as a row — or why not.
  const layerId = layer.id
  const mapping = useMemo((): { onMap?: () => void; onUnmap?: () => void; refused?: string } | undefined => {
    if (!mapOffer) return undefined
    if (mapOffer.kind === 'refused') return { refused: mapOffer.reason }
    return {
      onMap: onMapLayer ? () => onMapLayer(layerId) : undefined,
      onUnmap: mapOffer.kind === 'mapped' && mapOffer.canUnmap && onUnmapLayer ? () => onUnmapLayer(layerId) : undefined,
    }
  }, [mapOffer, onMapLayer, onUnmapLayer, layerId])
  // What the name's card offers for it.
  const mapLabel = layer.anchorUrn ? 'Map to another entity…' : 'Map this column to…'
  const cardMapping = useMemo((): CardMapping | undefined => {
    if (!mapping) return undefined
    if (mapping.refused) return { refused: mapping.refused, actions: [] }
    const actions: CardMapping['actions'] = []
    if (mapping.onUnmap && anchorName) actions.push({ label: `Show ${anchorName} as a row`, icon: LucideIcons.Rows3, onClick: mapping.onUnmap })
    if (mapping.onMap) actions.push({ label: mapLabel, icon: LucideIcons.Link2, onClick: mapping.onMap })
    return actions.length > 0 ? { actions } : undefined
  }, [mapping, anchorName, mapLabel])
  // An empty mapped column is its entity with nothing inside — never a column whose entity vanished.
  const anchorTypeName = useMemo(() => {
    const id = anchorNode?.data?.type as string | undefined
    return id ? viewEntityTypes.find((t) => t.id === id)?.name ?? id : undefined
  }, [anchorNode, viewEntityTypes])

  // dragleave fires on the element left, so a drag cancelled or dropped elsewhere clears it here.
  useEffect(() => {
    if (!bodyHint) return
    const clear = () => setBodyHint(null)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [bodyHint])

  // ── The header's actions tray ─────────────────────────────────────────────
  // Its controls besides the sort and ⋯, most wanted first. The Business view
  // keeps the header to the layer and its sort: adding, grouping, building and
  // deleting wait in the layer's menu (⋯), with its settings.
  const technical = personaMode === 'technical'
  const trayOptional = [
    technical && onAddToLayer && 'add',
    technical && onCreateGroup && 'group',
    technical && onBuildToLayer && 'build',
    onRenameLayer && 'rename',
    technical && onDeleteLayer && 'delete',
  ].filter((a): a is TrayAction => !!a)
  // How many controls the tray has room for: as many as leave the name
  // TITLE_PEEK_PX of itself while they show. Measured off the title's own box,
  // which is exactly the room the name has at rest — and as a count, not a
  // width, so a column resize re-renders the column only when the tray changes
  // shape, not on every frame of the drag. Room for all until measured: jsdom
  // never measures, and a browser does before the tray is first seen.
  const titleBoxRef = useRef<HTMLDivElement>(null)
  const [traySlots, setTraySlots] = useState(Infinity)
  useEffect(() => {
    const el = titleBoxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => {
      setTraySlots(Math.floor((entry.contentRect.width - TITLE_PEEK_PX - TRAY_FADE_PX) / TRAY_BUTTON_PX))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [isCollapsed])
  // The sort and ⋯ always show; the rest fill the room left, and what does not
  // fit waits in the layer's menu, which holds every one of them. With no menu
  // to hold them, the tray shows them all.
  const trayFixed = (onSetSortMode ? 1 : 0) + (onHeaderContextMenu ? 1 : 0)
  const trayShown = onHeaderContextMenu ? trayOptional.slice(0, Math.max(0, traySlots - trayFixed)) : trayOptional
  const trayHas = (action: TrayAction) => trayShown.includes(action)
  const trayCount = trayFixed + trayShown.length
  // How much of the name the tray covers while it shows, for the title's card.
  const trayWidth = trayCount > 0 ? trayCount * TRAY_BUTTON_PX + TRAY_FADE_PX : 0
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  // A sort menu unmounted open (the column folds, a rename starts) never says it closed.
  if (sortMenuOpen && (isCollapsed || isNamingGroup || isRenaming || !onSetSortMode)) setSortMenuOpen(false)
  // It stays out while something it opened is still open: the layer's menu
  // (from ⋯, a right-click or the Layer Strip), the sort menu, the delete confirm.
  const trayPinned = layerMenuOpen || sortMenuOpen || (confirmingDelete && trayHas('delete'))
  // A confirm nobody answers would hold the tray over the name: a click
  // anywhere else keeps the layer, as Escape does.
  const confirmRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!confirmingDelete) return
    const away = (e: PointerEvent) => {
      if (!confirmRef.current?.contains(e.target as Node)) setConfirmingDelete(false)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [confirmingDelete])
  const OverrideSortIcon = SORT_MODE_ICONS[sortMode]
  // Display › Header size: an open header's row, padding, icon and name — one
  // height for every column at a size (`layerHeaderTokens`).
  const canvasHeaderSize = usePreferencesStore(s => s.canvasHeaderSize) ?? 'comfortable'
  const header = layerHeaderTokens(canvasHeaderSize)
  // Display › Show off-screen markers: the "↑ N more · M lines" at the column's ends.
  const showOffscreenMarkers = usePreferencesStore(s => s.showOffscreenLineMarkers) ?? true
  // Display › Empty layers. A column whose anchor entity is gone, or held by
  // another column, is a problem with the data to fix, not an empty layer: it
  // says why whatever this is.
  const emptyLayerMessage = usePreferencesStore(s => s.emptyLayerMessage) ?? 'always'
  const showEmptyMessage = !!anchorIssue || kind === 'mapped'
    || !(emptyLayerMessage === 'never' || (emptyLayerMessage === 'tracing-hidden' && isTracing))
  // An empty column mapped to an entity: what is inside it — nothing, yet, or ever.
  const emptyInside = kind === 'mapped' && anchorName && !emptyText ? anchorName : null

  return (
    <motion.div
      data-layer-id={layer.id}
      data-folded={isCollapsed || undefined}
      className={cn(
        // pointer-events-auto re-establishes interactivity for all descendants.
        // The parent columns wrapper is pointer-events-none (so inter-column
        // gaps fall through to the edge hit-test layer); pointer-events is an
        // inherited CSS property, so without this explicit `auto` chevrons,
        // headers, and node cards would inherit `none` and become inert.
        "flex flex-col relative group/column transition-all duration-300 pointer-events-auto",
        isCollapsed ? "flex-none" : "flex-1"
      )}
      style={isCollapsed
        ? { width: spineWidth, minWidth: spineWidth, maxWidth: spineWidth }
        : { minWidth: effectiveWidth ?? 320, maxWidth: effectiveWidth ?? 480 }}
      layout
      initial={isNew ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      // Only the fade is timed here; the layout animation keeps its own default.
      transition={{ opacity: { duration: 0.22, ease: 'easeOut' }, y: { duration: 0.22, ease: 'easeOut' } }}
      // Measure for a layout animation only when the column's box can have
      // moved: its fold, width or place — or any other column's fold. Left
      // to itself framer measures after EVERY render, and the virtualizer
      // renders the column on every scroll frame: `measureScroll` alone was
      // ~120ms of a 3s column scroll, forcing layout each frame.
      layoutDependency={`${isCollapsed}|${spineWidth}|${effectiveWidth}|${layer.order}|${foldEpoch}`}
    >
      {/* Subtle column separator line with gradient fade */}
      <div className="absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-glass-border/50 to-transparent" />

      {/* ── Fold anchors — where a FOLDED layer's lineage lands. ──
          A folded layer renders no rows, so a line into it had nowhere to
          land and simply stopped being drawn. Each row with a line to an
          open layer gets an invisible anchor across the spine, carrying the
          row's own `layer-node-<id>`: the edge overlay finds it like any row
          and draws the line by the SAME path as every other — colour, arrow,
          hover and trace unchanged — ending at the spine's edge the way a
          line ends at a card's. The pins mark the spot: left for lines
          arriving, right for lines leaving. The anchors exist only while the
          column is folded, so an id is never mounted twice. */}
      {isCollapsed && foldAnchors.length > 0 && (
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-4 z-20 pointer-events-none"
          // Where an open column's first row starts: right below its header,
          // at the size it is drawn. A folded layer's lines land at the
          // heights its rows WOULD have, so a line does not jump when the
          // layer folds or unfolds.
          style={{ top: header.heightPx }}
        >
          {foldAnchors.map(({ id, name, offset, share, in: arriving, out: leaving }) => (
            <div
              key={id}
              id={`layer-node-${id}`}
              data-fold-anchor
              // The edge overlay's hover card names a line's two ends from
              // their rows; an anchor has no row text to read.
              data-label={name}
              className="absolute inset-x-0 h-px"
              style={{ top: `min(${offset}px, ${share * 100}%)` }}
            >
              {arriving > 0 && (
                <span className={cn(FOLD_PIN, 'left-0 -translate-x-1/2')} style={{ backgroundColor: layer.color }} />
              )}
              {leaving > 0 && (
                <span className={cn(FOLD_PIN, 'right-0 translate-x-1/2')} style={{ backgroundColor: layer.color }} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Resize handle — drag the column's right edge (260–560px);
          double-click resets to the default width. Width persists per
          layer across sessions. ── */}
      {!isCollapsed && (
        <div
          data-canvas-interactive
          onPointerDown={(e) => {
            e.preventDefault()
            const startX = e.clientX
            const startW = effectiveWidth ?? (e.currentTarget.parentElement?.getBoundingClientRect().width ?? 320)
            let latest = startW
            const onMove = (ev: PointerEvent) => {
              latest = Math.round(Math.min(560, Math.max(260, startW + ev.clientX - startX)))
              setCustomWidthState(latest)  // live visual only — persisted once, on release
            }
            const onUp = () => {
              window.removeEventListener('pointermove', onMove)
              window.removeEventListener('pointerup', onUp)
              const w = Math.round(latest)
              if (onResizeLayer) {
                // Draft: the width becomes part of the VIEW definition;
                // drop any personal override so the editor sees what
                // viewers will see.
                persistPersonalWidth(null)
                setCustomWidthState(null)
                onResizeLayer(layer.id, w)
              } else {
                persistPersonalWidth(w)
              }
            }
            window.addEventListener('pointermove', onMove)
            window.addEventListener('pointerup', onUp)
          }}
          onDoubleClick={() => {
            persistPersonalWidth(null)
            setCustomWidthState(null)
            onResizeLayer?.(layer.id, null)
          }}
          title="Drag to resize this layer · double-click to reset"
          className="absolute -right-1 top-0 bottom-0 w-2 z-30 cursor-col-resize opacity-0 group-hover/column:opacity-100 transition-opacity"
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[3px] rounded-full bg-accent-lineage/40" />
        </div>
      )}

      {/* ── Custom-width chip — visible (on column hover) whenever this
          layer has a resized width. Names the current width and offers
          the one-click reset, so the double-click gesture on the handle
          doesn't have to be discovered to get back to defaults. ── */}
      {!isCollapsed && effectiveWidth !== null && (
        <button
          type="button"
          data-canvas-interactive
          onClick={() => {
            persistPersonalWidth(null)
            setCustomWidthState(null)
            onResizeLayer?.(layer.id, null)
          }}
          title={`${customWidth !== null ? 'Your personal width' : "This view's authored width"} (${effectiveWidth}px). Click to reset to the default — or double-click the drag handle on the column edge.`}
          // On the header's bottom edge.
          style={{ top: header.heightPx - 9 }}
          className="absolute right-1.5 z-30 flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9.5px] font-semibold tracking-wide text-ink-muted/80 hover:text-ink bg-canvas-elevated/85 border border-white/10 shadow-sm opacity-0 group-hover/column:opacity-100 transition-opacity"
        >
          <LucideIcons.RotateCcw className="w-2.5 h-2.5" />
          Reset width · {effectiveWidth}px
        </button>
      )}

      {/* Layer Header - Glass morphism style + drag target (4.3).
          When folded, the header IS the spine: the only content in the
          column, stretched (`flex-1`) to its siblings' height, and one
          button — anywhere on it unfolds the layer. */}
      <div
        // Open, it is named for its layer — in full, whatever the clamp shows.
        role={isCollapsed ? 'button' : 'group'}
        tabIndex={isCollapsed ? 0 : undefined}
        aria-label={isCollapsed
          ? `Unfold ${layer.name}${spineLinesSaid ? ` — ${spineLinesSaid}` : ''}`
          : layer.name}
        title={isCollapsed ? `Unfold ${layer.name}` : undefined}
        onKeyDown={isCollapsed ? (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          requestFold(false)
        } : undefined}
        className={cn(
          "group/header sticky top-0 z-10 border-b transition-all duration-200",
          // Open and reorderable, the header is a handle: grab it to move the column.
          onReorderLayer && !isCollapsed && !isRenaming ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
          isCollapsed
            ? "flex-1 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-lineage/50"
            : cn("flex-shrink-0", header.paddingClass),
          isDragOver
            ? "border-white/30"
            : "border-white/[0.08] dark:border-white/[0.05]"
        )}
        style={{
          // Tint over an opaque elevated base: legibility over the rows that
          // scroll beneath comes from opacity, not a blurred backdrop (a sticky
          // blur surface inside a scroller ghosts as white strips on rows).
          background: `linear-gradient(135deg, ${layer.color}12 0%, ${layer.color}05 100%), var(--nx-bg-elevated)`,
          // A drop on the header only arranges this view: a dashed outline, as every view change is.
          outline: isDragOver ? `2px dashed ${layer.color ?? 'currentColor'}` : undefined,
          outlineOffset: isDragOver ? -3 : undefined,
        }}
        onClick={() => isCollapsed && requestFold(false)}
        onContextMenu={onHeaderContextMenu ? (e) => onHeaderContextMenu(e, layer.id) : undefined}
        // The whole header is the handle for reordering — not only its icon tile — except while its
        // name is being edited (a drag there selects text).
        draggable={!!onReorderLayer && !isRenaming}
        onDragStart={onReorderLayer && !isRenaming ? (e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/x-layer-id', layer.id)
          setDraggedLayer({ id: layer.id, order: layer.order })
        } : undefined}
        onDragEnd={onReorderLayer ? () => setDraggedLayer(null) : undefined}
        onDragOver={(e) => {
          const types = e.dataTransfer.types
          const isLayer = types.includes('text/x-layer-id')
          const isEntity = types.includes('text/x-entity-id')
          const isGroup = types.includes('text/x-group-id')
          // A column over its own header: nothing to do there.
          const from = isLayer ? draggedLayer() : null
          if (from && from.id === layer.id) return
          // Only accept a drag this column can actually handle (getData is unreadable in dragover, so
          // gate on the presence of the typed key + the matching handler).
          if ((isLayer && onReorderLayer) || (isEntity && onAssignToLayer) || (isGroup && groupActions)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setIsDragOver(true)
            setDragKind(isLayer ? 'layer' : isGroup ? 'group' : 'entity')
            if (isLayer) {
              const title = !from ? 'Drop to reorder here' : from.order < layer.order ? `Move after ${layer.name}` : `Move before ${layer.name}`
              if (title !== layerDropTitle) setLayerDropTitle(title)
            }
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) { setIsDragOver(false); setDragKind(null); setLayerDropTitle(null) }
        }}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragOver(false)
          setDragKind(null)
          setLayerDropTitle(null)
          const layerId = e.dataTransfer.getData('text/x-layer-id')
          if (layerId && onReorderLayer) { onReorderLayer(layerId, layer.id); return }
          const groupId = e.dataTransfer.getData('text/x-group-id')
          if (groupId && groupActions) {
            groupActions.receive(groupId, e.dataTransfer.getData('text/x-group-layer') || layer.id, null)
            return
          }
          const entityId = e.dataTransfer.getData('text/x-entity-id')
          if (entityId && onAssignToLayer) onAssignToLayer(entityId, layer.id)
        }}
      >
        {/* Insert a layer here — the "+" on the header's left edge sits in the gutter between this
            column and the one before it, so a layer goes exactly where the reader is looking, with
            no scrolling to the end. Revealed on hover (and on keyboard focus). */}
        {onInsertLayerBefore && !isCollapsed && (
          <HoverTip
            className="absolute -left-3 top-1/2 -translate-y-1/2 z-20"
            label="Insert a layer here"
            detail={`A new layer just before ${layer.name}`}
          >
            <button
              type="button"
              aria-label={`Insert a layer before ${layer.name}`}
              onClick={(e) => { e.stopPropagation(); onInsertLayerBefore(layer.id) }}
              className={cn(
                "w-6 h-6 rounded-full grid place-items-center",
                "bg-canvas-elevated text-ink-muted border border-glass-border shadow-sm",
                "opacity-0 group-hover/column:opacity-100 focus-visible:opacity-100",
                "hover:text-white hover:bg-accent-lineage hover:border-accent-lineage hover:scale-110",
                "transition-[opacity,transform,background-color,color] duration-150",
              )}
            >
              <LucideIcons.Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
            </button>
          </HoverTip>
        )}

        {/* Drop hint overlay */}
        {isDragOver && (
          <div
            // Over the header's own name and tile, which sit in positioned boxes of their own.
            className="absolute inset-0 z-[25] flex items-center justify-center rounded-sm pointer-events-none"
            style={{ backgroundColor: `${layer.color}15` }}
          >
            {/* A spine has no room for the sentence; the tint and the
                dashed outline carry it. */}
            {isCollapsed ? (
              <span className="grid place-items-center w-6 h-6 rounded-full bg-canvas-elevated border border-dashed border-ink-muted/60">
                <LucideIcons.Eye className="w-3.5 h-3.5 text-ink" aria-hidden />
              </span>
            ) : (
              <DropHint
                kind="view"
                title={dragKind === 'layer' ? layerDropTitle ?? 'Drop to reorder here' : dragKind === 'group' ? `Move group to ${layer.name}` : 'Show in this column'}
                detail="only this view"
                className="mx-2"
              />
            )}
          </div>
        )}
        <div
          className={cn(
            "flex items-center",
            isCollapsed ? "flex-col gap-2.5 h-full" : "relative gap-3"
          )}
          style={isCollapsed ? undefined : { height: header.rowPx }}
        >
          {/* Fold Toggle + Icon Container */}
          <div className="flex items-center gap-2">
            {!isCollapsed && onFoldChange && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  requestFold(true)
                }}
                className="p-1 rounded-lg hover:bg-white/[0.1] text-ink-muted hover:text-ink transition-all"
                title="Fold this layer"
              >
                <LucideIcons.PanelLeftClose className="w-4 h-4" />
              </button>
            )}
            <div
              title={onReorderLayer ? `Drag to reorder ${layer.name}` : undefined}
              className={cn(
                "relative flex items-center justify-center flex-shrink-0 shadow-sm transition-all duration-300",
                isCollapsed
                  ? (spineWidth < NARROW_SPINE_PX ? "rounded-md" : "rounded-lg")
                  : cn(header.tileClass, "group-hover/column:scale-105 group-hover/column:shadow-md"),
                onReorderLayer && "cursor-grab active:cursor-grabbing"
              )}
              style={{
                background: `linear-gradient(145deg, ${layer.color}25 0%, ${layer.color}15 100%)`,
                boxShadow: `0 2px 8px ${layer.color}20`,
                ...(isCollapsed ? { width: spineTile, height: spineTile } : null),
              }}
            >
              <DynamicIcon
                name={layer.icon ?? 'Layers'}
                className={cn(
                  "transition-transform duration-300",
                  isCollapsed
                    ? (spineWidth < NARROW_SPINE_PX ? "w-2.5 h-2.5" : "w-4 h-4")
                    : cn(header.glyphClass, "group-hover/column:scale-110")
                )}
                style={{ color: layer.color }}
              />
              {/* The column's kind, over the tile's corner: no width of its own. A narrow spine
                  has no corner to spare. */}
              {!(isCollapsed && spineWidth < NARROW_SPINE_PX) && (
                <ColumnKindMark kind={kind} copy={kindCopy} small={isCollapsed || canvasHeaderSize === 'compact'} />
              )}
            </div>
          </div>

          {/* Folded — the spine. Top to bottom: how many lines land here
              (the reason to look at a folded layer at all), the name, the
              entity count, and the unfold mark. `mt-auto` on the mark keeps
              it at the foot, so neighbouring spines line up whatever their
              names' lengths. A name longer than the spine ends in an
              ellipsis rather than running under the pins. */}
          {isCollapsed ? (
            <div className="flex flex-col items-center gap-2 flex-1 min-h-0 w-full">
              {/* The lineage mark — the Lineage toggle's own glyph over the
                  count, so it cannot be read as the entity count below.
                  Solid when lines land on this spine; hollow when all of
                  them run to other folded layers and none is drawn yet. */}
              {spineLines > 0 && (
                <span
                  className={cn(
                    "shrink-0 flex flex-col items-center gap-0.5 rounded-lg font-semibold tabular-nums leading-none border",
                    foldLines > 0
                      ? "text-accent-lineage bg-accent-lineage/15 border-accent-lineage/30"
                      : "text-ink-muted border-dashed border-black/15 dark:border-white/20",
                    spineWidth < NARROW_SPINE_PX ? "px-0.5 py-1 text-[9px]" : "px-1 py-1 text-[10px]",
                  )}
                  title={`${layer.name}: ${spineLinesSaid}. ${unitMeaning('lines')}`}
                >
                  <LucideIcons.GitBranch aria-hidden className="w-2.5 h-2.5" />
                  {compactCount.format(spineLines)}
                </span>
              )}
              <span
                className={cn(
                  "min-h-0 overflow-hidden text-ellipsis whitespace-nowrap font-semibold rotate-180",
                  spineWidth < NARROW_SPINE_PX ? "text-[10px]" : "text-[11px]",
                )}
                style={{ color: layer.color, writingMode: 'vertical-rl' }}
                title={layer.name}
              >
                {layer.name}
              </span>
              <div
                className={cn(
                  "relative shrink-0 rounded-full font-semibold tabular-nums",
                  spineWidth < NARROW_SPINE_PX ? "px-1 py-0.5 text-[9px]" : "px-1.5 py-1 text-[10px]",
                )}
                style={{ backgroundColor: `${layer.color}20`, color: layer.color }}
                title={isTracing
                  ? onLineageLabel
                  : sortIsOverride ? `Sorted: ${SORT_MODE_LABELS[sortMode]}` : undefined}
              >
                {isTracing ? onLineageCount : `${compactCount.format(layerTotal)}${totalIsFloor ? '+' : ''}`}
                {/* Sort-override indicator survives collapse, so a curated
                    arrangement doesn't silently vanish from view. */}
                {sortIsOverride && (
                  <span
                    className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ring-2 ring-canvas"
                    style={{ backgroundColor: layer.color }}
                  />
                )}
              </div>
              {/* A mark, not a button: the whole spine is the button, and a
                  control inside a control is one a screen reader cannot
                  reach cleanly. */}
              <LucideIcons.PanelLeftOpen
                aria-hidden
                className={cn(
                  "mt-auto shrink-0 text-ink-muted group-hover/column:text-ink transition-colors",
                  spineWidth < NARROW_SPINE_PX ? "w-3 h-3" : "w-4 h-4",
                )}
              />
            </div>
          ) : (
            <>
              {/* The title: the name, up to two lines and then an ellipsis, and at the row's
                  right end what must stay on screen at rest — the count and the order marks,
                  compact so the name keeps the width. It used to share one shrinking row with
                  the sort and every edit button, so a draft's name came down to "Transformat",
                  or to nothing at all; the actions wait in the tray now. One row, one height:
                  every column's header is the same, long name or short. */}
              <div ref={titleBoxRef} className="flex-1 min-w-0 flex items-center gap-2">
                {isNamingGroup && onCreateGroup ? (
                  <input
                    autoFocus
                    value={draftGroupName}
                    placeholder="New group name"
                    aria-label={`Name the new group in ${layer.name}`}
                    aria-invalid={headerNameTaken || undefined}
                    title={headerNameTaken ? `There's already a group called “${draftGroupName.trim()}” in ${layer.name}` : undefined}
                    onChange={(e) => setDraftGroupName(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      // A taken name is refused with a notice saying why; the field stays open to fix it.
                      if (e.key === 'Enter') { onCreateGroup(layer.id, draftGroupName); if (!headerNameTaken) setIsNamingGroup(false) }
                      if (e.key === 'Escape') setIsNamingGroup(false)
                    }}
                    onBlur={() => { if (draftGroupName.trim() && !headerNameTaken) onCreateGroup(layer.id, draftGroupName); setIsNamingGroup(false) }}
                    className={cn(
                      "flex-1 min-w-0 px-2 rounded-lg bg-canvas-overlay border font-semibold text-ink outline-none placeholder:text-ink-muted placeholder:font-normal",
                      header.inputClass,
                      headerNameTaken ? "border-red-400" : "border-violet-400/60",
                    )}
                  />
                ) : isRenaming && onRenameLayer ? (
                  <input
                    autoFocus
                    value={draftName}
                    aria-label={`Rename ${layer.name}`}
                    onChange={(e) => setDraftName(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') { commitRename(); setIsRenaming(false) }
                      if (e.key === 'Escape') { setDraftName(layer.name); setIsRenaming(false) }
                    }}
                    onBlur={() => { commitRename(); setIsRenaming(false) }}
                    className={cn("flex-1 min-w-0 px-2 rounded-lg bg-canvas-overlay border border-accent-lineage/60 font-semibold text-ink outline-none", header.inputClass)}
                  />
                ) : (
                  <LayerHeaderTitle
                    name={layer.name}
                    description={layer.description}
                    color={layer.color}
                    properties={layer.properties}
                    coverRight={trayWidth}
                    nameClass={header.nameClass}
                    kind={kind}
                    kindCopy={kindCopy}
                    onOpenAnchor={openAnchor}
                    anchorName={anchorName}
                    mapping={cardMapping}
                  />
                )}
                <div className="flex-shrink-0 flex items-center gap-1.5">
                  {/* Loading pill — replaces the entity-count pill while this
                      layer is hydrating with no entities yet. Premium spinner +
                      layer-tinted background makes the loading state legible at
                      a glance from anywhere on the canvas. */}
                  {shouldShowGhosts && flatTree.length === 0 ? (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.92 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.92 }}
                      className="flex items-center gap-1.5 px-1.5 py-px rounded-full border"
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
                      className="flex items-center gap-1 px-1.5 py-px rounded-full bg-white/[0.06] dark:bg-white/[0.04] border border-white/[0.08]"
                      title={isTracing
                        ? onLineageLabel
                        : subsetFeed
                          ? `${feedCountSentence(subsetFeed)} in this layer${subsetAsOf ? ` — ${subsetAsOf}, a fresh answer is on its way` : ''}`
                          : `${visibleCount.toLocaleString()} entit${visibleCount === 1 ? 'y' : 'ies'} in the tree · ${loadedCount.toLocaleString()} loaded · ${totalLabel} in this layer (with the children the server reports for loaded rows${totalIsFloor ? '; some types have no count yet' : ''})`}
                    >
                      {isTracing ? (
                        <span className="text-[10px] font-semibold text-ink" style={{ color: layer.color }}>
                          {onLineageCount}
                        </span>
                      ) : subsetFeed ? (
                        <>
                          <span className="text-[10px] font-semibold text-ink tabular-nums" style={{ color: layer.color }}>
                            {subsetFeed.delivered.toLocaleString()}{subsetShowsTotal ? '' : '+'}
                          </span>
                          {subsetShowsTotal && (
                            <>
                              <span className="text-[9px] text-ink-muted/60">/</span>
                              <span className="text-[10px] text-ink-muted/60 tabular-nums">{totalLabel}</span>
                            </>
                          )}
                          {subsetFeed.status === 'running' && (
                            <LucideIcons.Loader2 className="w-2.5 h-2.5 animate-spin text-ink-muted/60" aria-label="still counting" />
                          )}
                          {subsetAsOf && <LucideIcons.Clock3 className="w-2.5 h-2.5 text-ink-muted/60" aria-label={subsetAsOf} />}
                        </>
                      ) : (
                        <>
                          <span className="text-[10px] font-semibold text-ink" style={{ color: layer.color }}>
                            {loadedCount.toLocaleString()}
                          </span>
                          <span className="text-[9px] text-ink-muted/60">/</span>
                          <span className="text-[10px] text-ink-muted/60">{totalLabel}</span>
                        </>
                      )}
                    </div>
                  )}
                  {/* Curated-order signal — always visible (never hover-gated) so
                      read-only consumers know the arrangement is deliberate. A mark, not
                      a worded pill, so it takes none of the name's width. */}
                  {sortMode === 'custom' && (
                    <HoverTip label="Custom order" detail="Arranged by hand — this layer's own order, not the view default">
                      <span
                        role="img"
                        aria-label="Custom order"
                        className="grid place-items-center w-[18px] h-[18px] rounded-full"
                        style={{ backgroundColor: `${layer.color}1a`, color: layer.color }}
                      >
                        <LucideIcons.ListOrdered className="w-3 h-3" aria-hidden />
                      </span>
                    </HoverTip>
                  )}
                  {/* A sort of the layer's own. The sort control waits in the tray now,
                      so its at-rest mark (full strength, with a dot) is kept here. */}
                  {sortIsOverride && sortMode !== 'custom' && (
                    <HoverTip label={`Sorted ${SORT_MODE_LABELS[sortMode]}`} detail="This layer's own order, not the view default">
                      <span
                        role="img"
                        aria-label={`Sorted ${SORT_MODE_LABELS[sortMode]}`}
                        className="flex items-center"
                        style={{ color: layer.color }}
                      >
                        <OverrideSortIcon className="w-3 h-3" aria-hidden />
                      </span>
                    </HoverTip>
                  )}
                </div>
              </div>

              {/* The actions tray. Hidden at rest, so it never takes width from the name, it
                  rises over the right of the header on hover and while focus is in it — over an
                  opaque, tinted backing that fades in across the title (no backdrop-filter: inside
                  the column scroller a blurred surface ghosts as white strips). It stays out while
                  something it opened is open: the layer's menu, the sort menu, the delete confirm.
                  A device with no hover keeps the sort and ⋯ in the row at rest instead (the sort
                  is in no menu; the rest are all in the layer's). */}
              {!isNamingGroup && !isRenaming && trayCount > 0 && (
                <div
                  role="group"
                  aria-label={`${layer.name}: actions`}
                  data-header-tray
                  data-pinned={trayPinned || undefined}
                  className={cn(
                    "absolute inset-y-0 right-0 flex items-center gap-0.5 pl-6",
                    "[background:var(--tray-bg)] [mask-image:linear-gradient(to_right,transparent,#000_1.25rem)]",
                    "transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
                    trayPinned
                      ? "opacity-100"
                      : cn(
                        "opacity-0 translate-x-1 pointer-events-none",
                        "group-hover/header:opacity-100 group-hover/header:translate-x-0 group-hover/header:pointer-events-auto",
                        // Focus inside it, not only keyboard focus: a menu it opened hands focus back to
                        // its button on closing, and that button's tip must not point at a hidden tray.
                        "focus-within:opacity-100 focus-within:translate-x-0 focus-within:pointer-events-auto",
                      ),
                    "[@media(hover:none)]:static [@media(hover:none)]:flex-shrink-0 [@media(hover:none)]:pl-0 [@media(hover:none)]:[background:none] [@media(hover:none)]:[mask-image:none]",
                    "[@media(hover:none)]:opacity-100 [@media(hover:none)]:translate-x-0 [@media(hover:none)]:pointer-events-auto",
                  )}
                  style={{ '--tray-bg': `linear-gradient(${layer.color}08, ${layer.color}08), var(--nx-bg-elevated)` } as React.CSSProperties}
                >
                  {onSetSortMode && (
                    <LayerSortMenu
                      layerName={layer.name}
                      layerColor={layer.color}
                      mode={sortMode}
                      isOverride={sortIsOverride}
                      viewDefault={viewDefaultSortMode}
                      canPersist={canPersistSort}
                      onSelectMode={(mode) => onSetSortMode(layer.id, mode)}
                      onApplyToView={() => onApplySortToView?.(layer.id)}
                      onResetCustomOrder={onResetCustomOrder ? () => onResetCustomOrder(layer.id) : undefined}
                      onOpenChange={setSortMenuOpen}
                    />
                  )}
                  {trayHas('rename') && (
                    <TrayButton
                      label={`Rename ${layer.name}`}
                      onClick={() => { setDraftName(layer.name); setIsRenaming(true) }}
                      menuHasIt={!!onHeaderContextMenu}
                      className="text-ink-muted hover:text-ink hover:bg-black/[0.06] dark:hover:bg-white/[0.1]"
                    >
                      <LucideIcons.Pencil className="w-3.5 h-3.5" />
                    </TrayButton>
                  )}
                  {trayHas('add') && onAddToLayer && (
                    <TrayButton
                      label={addInsideName ? `Add inside ${addInsideName}` : `Add entity to ${layer.name}`}
                      onClick={() => onAddToLayer(layer.id)}
                      menuHasIt={!!onHeaderContextMenu}
                      className="bg-green-500/10 hover:bg-green-500/20 text-green-500 hover:scale-110 active:scale-95"
                    >
                      <LucideIcons.Plus className="w-3.5 h-3.5" />
                    </TrayButton>
                  )}
                  {trayHas('group') && (
                    <TrayButton
                      label={`New group in ${layer.name}`}
                      detail="Organise entities in this view — the data is unchanged"
                      onClick={() => { setDraftGroupName(''); setIsNamingGroup(true) }}
                      menuHasIt={!!onHeaderContextMenu}
                      className="bg-violet-500/10 hover:bg-violet-500/20 text-violet-500 hover:scale-110 active:scale-95"
                    >
                      <LucideIcons.FolderPlus className="w-3.5 h-3.5" />
                    </TrayButton>
                  )}
                  {trayHas('build') && onBuildToLayer && (
                    <TrayButton
                      label={`Build a lot at once in ${layer.name}`}
                      onClick={() => onBuildToLayer(layer.id)}
                      menuHasIt={!!onHeaderContextMenu}
                      className="bg-accent-lineage/10 hover:bg-accent-lineage/20 text-accent-lineage hover:scale-110 active:scale-95"
                    >
                      <LucideIcons.LayoutGrid className="w-3.5 h-3.5" />
                    </TrayButton>
                  )}
                  {/* Delete — trash → inline check/✗ confirm (the check's tip warns when the layer
                      has entities: hand-placed ones fall back to the default layer, rule-placed
                      ones become unassigned unless another layer claims their type). */}
                  {trayHas('delete') && onDeleteLayer && (
                    confirmingDelete ? (
                      <div
                        ref={confirmRef}
                        className="flex items-center gap-0.5"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setConfirmingDelete(false) } }}
                      >
                        <TrayButton
                          label={`Yes, delete ${layer.name}`}
                          detail={loadedCount > 0
                            ? `${loadedCount} ${loadedCount === 1 ? 'entity' : 'entities'} here: hand-placed ones move to the default layer; ones placed by this layer's type rules become unassigned unless another layer claims their type`
                            : undefined}
                          // The trash it replaces took the focus with it.
                          autoFocus
                          onClick={() => { onDeleteLayer(layer.id); setConfirmingDelete(false) }}
                          menuHasIt={!!onHeaderContextMenu}
                          className="bg-rose-500/15 text-rose-500 hover:bg-rose-500/25"
                        >
                          <LucideIcons.Check className="w-3.5 h-3.5" />
                        </TrayButton>
                        <TrayButton
                          label={`Keep ${layer.name}`}
                          onClick={() => setConfirmingDelete(false)}
                          menuHasIt={!!onHeaderContextMenu}
                          className="text-ink-muted hover:bg-black/[0.06] dark:hover:bg-white/10"
                        >
                          <LucideIcons.X className="w-3.5 h-3.5" />
                        </TrayButton>
                      </div>
                    ) : (
                      <TrayButton
                        label={`Delete ${layer.name}`}
                        onClick={() => setConfirmingDelete(true)}
                        menuHasIt={!!onHeaderContextMenu}
                        className="bg-rose-500/10 hover:bg-rose-500/20 text-rose-500"
                      >
                        <LucideIcons.Trash2 className="w-3.5 h-3.5" />
                      </TrayButton>
                    )
                  )}
                  {onHeaderContextMenu && (
                    <HoverTip
                      label="More for this layer"
                      detail={trayShown.length < trayOptional.length
                        ? 'Every action for it, with those this column has no room to show here'
                        : 'Its settings, colour and place — the menu a right-click opens'}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          // The menu drops from the button, clicked or pressed.
                          const r = e.currentTarget.getBoundingClientRect()
                          onHeaderContextMenu(Object.assign(e, { clientX: r.left, clientY: r.bottom + 4 }), layer.id)
                        }}
                        aria-label={`${layer.name}: layer actions`}
                        aria-haspopup="menu"
                        aria-expanded={layerMenuOpen}
                        data-canvas-menu-trigger
                        className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.06] dark:hover:bg-white/[0.1] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/50"
                      >
                        <LucideIcons.Ellipsis className="w-3.5 h-3.5" />
                      </button>
                    </HoverTip>
                  )}
                </div>
              )}
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
                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-black/[0.04] hover:bg-black/[0.08] border border-black/[0.08] dark:bg-white/[0.06] dark:hover:bg-white/[0.12] dark:border-white/[0.08] text-ink-muted hover:text-ink transition-all duration-200 flex-shrink-0"
                >
                  <LucideIcons.Home className="w-3 h-3" />
                  <span className="text-[10px] font-medium">Root</span>
                </button>
                {breadcrumb.map((node) => (
                  <React.Fragment key={node.id}>
                    <LucideIcons.ChevronRight className="w-3 h-3 text-ink-muted/40 flex-shrink-0" />
                    <button
                      onClick={() => handleBreadcrumbClick(node)}
                      className="px-2 py-1 rounded-lg bg-black/[0.03] hover:bg-black/[0.06] border border-black/[0.06] dark:bg-white/[0.04] dark:hover:bg-white/[0.08] dark:border-white/[0.06] text-ink-muted hover:text-ink transition-all duration-200 truncate max-w-[100px] flex-shrink-0 text-[10px] font-medium"
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
          {/* A drag over a mapped column's body: what dropping it here does, over the whole list. */}
          {bodyHint && (
            <div
              data-body-drop={bodyHint.kind}
              className={cn('pointer-events-none absolute inset-1 z-30 rounded-xl transition-shadow duration-150', dropSurfaceClass(bodyHint.kind))}
            >
              <div ref={bodyChipRef} className="absolute inset-x-0 flex justify-center px-2 transition-[top] duration-75" style={{ top: bodyHint.top }}>
                <DropHint kind={bodyHint.kind} title={bodyHint.title} detail={bodyHint.detail} />
              </div>
            </div>
          )}
          {/* Display › Show off-screen markers: off, neither scrim is drawn. */}
          {showOffscreenMarkers && <>
          {/* ── Periphery scrims — "content continues" affordances at the
              column edges. A gradient veil lets the boundary rows fade
              out beneath it (the veil IS the signal that more follows),
              and one compact centered label states exactly how much:
              "↑ N more · M lines". Scrims float, so scrolling
              never shifts layout, and unlike the old floating pill the
              occlusion reads as an intentional fade — never as chrome
              covering a card. Click scrolls the column. ── */}
          <AnimatePresence>
            {(overflowCounts.above > 0 || (periphery?.upEdges ?? 0) > 0) && (
              <motion.div
                key="periphery-top"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                className="absolute top-0 inset-x-0 z-20 pointer-events-none"
              >
                <div className="h-12 bg-gradient-to-b from-canvas via-canvas/70 to-transparent" />
                <InfoTooltip
                  side="bottom"
                  content={
                    <div>
                      <p className="font-semibold mb-1">
                        {overflowCounts.above.toLocaleString()} more row{overflowCounts.above === 1 ? '' : 's'} above
                      </p>
                      {(periphery?.upEdges ?? 0) > 0 && (
                        <>
                          <p className="text-ink-muted">
                            {periphery!.upEdges.toLocaleString()} {unitNoun(periphery!.upEdges, 'lines')} from
                            entities on screen lead up there:
                          </p>
                          <div className="mt-1">
                            {periphery!.upPartnerIds.map(id => (
                              <div key={id} className="flex items-center gap-1.5 min-w-0">
                                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: layer.color }} />
                                <span className="truncate text-ink-muted">{proxyLabel(id)}</span>
                              </div>
                            ))}
                            {periphery!.upEntities > periphery!.upPartnerIds.length && (
                              <p className="text-ink-muted/70 mt-0.5">
                                +{(periphery!.upEntities - periphery!.upPartnerIds.length).toLocaleString()} more entities
                              </p>
                            )}
                          </div>
                          <p className="mt-1 text-ink-muted/70">{unitMeaning('lines')}</p>
                        </>
                      )}
                      <p className="mt-1.5 text-ink-muted/60 italic">Click to scroll up</p>
                    </div>
                  }
                >
                  <button
                    type="button"
                    data-canvas-interactive
                    onClick={() => scrollToFlatIndex(0, 'start')}
                    className="pointer-events-auto absolute top-1.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[10.5px] font-semibold border border-black/10 dark:border-white/10 shadow-sm hover:scale-105 active:scale-95 transition-transform whitespace-nowrap"
                    style={{ color: layer.color, background: `linear-gradient(${layer.color}14, ${layer.color}14), var(--nx-bg-elevated)` }}
                  >
                    <LucideIcons.ChevronUp className="w-3 h-3" />
                    {overflowCounts.above > 0 && (
                      <span className="tabular-nums">{overflowCounts.above.toLocaleString()} more</span>
                    )}
                    {(periphery?.upEdges ?? 0) > 0 && (
                      <>
                        {overflowCounts.above > 0 && <span className="opacity-40">·</span>}
                        <span className="tabular-nums opacity-80">
                          {periphery!.upEdges.toLocaleString()} {unitNoun(periphery!.upEdges, 'lines')}
                        </span>
                      </>
                    )}
                  </button>
                </InfoTooltip>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Bottom periphery scrim — mirror of the top. */}
          <AnimatePresence>
            {(overflowCounts.below > 0 || (periphery?.downEdges ?? 0) > 0) && (
              <motion.div
                key="periphery-bottom"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                className="absolute bottom-0 inset-x-0 z-20 pointer-events-none"
              >
                <div className="h-12 bg-gradient-to-t from-canvas via-canvas/70 to-transparent" />
                <InfoTooltip
                  side="top"
                  content={
                    <div>
                      <p className="font-semibold mb-1">
                        {overflowCounts.below.toLocaleString()} more row{overflowCounts.below === 1 ? '' : 's'} below
                      </p>
                      {(periphery?.downEdges ?? 0) > 0 && (
                        <>
                          <p className="text-ink-muted">
                            {periphery!.downEdges.toLocaleString()} {unitNoun(periphery!.downEdges, 'lines')} from
                            entities on screen lead down there:
                          </p>
                          <div className="mt-1">
                            {periphery!.downPartnerIds.map(id => (
                              <div key={id} className="flex items-center gap-1.5 min-w-0">
                                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: layer.color }} />
                                <span className="truncate text-ink-muted">{proxyLabel(id)}</span>
                              </div>
                            ))}
                            {periphery!.downEntities > periphery!.downPartnerIds.length && (
                              <p className="text-ink-muted/70 mt-0.5">
                                +{(periphery!.downEntities - periphery!.downPartnerIds.length).toLocaleString()} more entities
                              </p>
                            )}
                          </div>
                          <p className="mt-1 text-ink-muted/70">{unitMeaning('lines')}</p>
                        </>
                      )}
                      <p className="mt-1.5 text-ink-muted/60 italic">Click to scroll down</p>
                    </div>
                  }
                >
                  <button
                    type="button"
                    data-canvas-interactive
                    onClick={() => scrollToFlatIndex(flatTree.length - 1, 'end')}
                    className="pointer-events-auto absolute bottom-1.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[10.5px] font-semibold border border-black/10 dark:border-white/10 shadow-sm hover:scale-105 active:scale-95 transition-transform whitespace-nowrap"
                    style={{ color: layer.color, background: `linear-gradient(${layer.color}14, ${layer.color}14), var(--nx-bg-elevated)` }}
                  >
                    <LucideIcons.ChevronDown className="w-3 h-3" />
                    {overflowCounts.below > 0 && (
                      <span className="tabular-nums">{overflowCounts.below.toLocaleString()} more</span>
                    )}
                    {(periphery?.downEdges ?? 0) > 0 && (
                      <>
                        {overflowCounts.below > 0 && <span className="opacity-40">·</span>}
                        <span className="tabular-nums opacity-80">
                          {periphery!.downEdges.toLocaleString()} {unitNoun(periphery!.downEdges, 'lines')}
                        </span>
                      </>
                    )}
                  </button>
                </InfoTooltip>
              </motion.div>
            )}
          </AnimatePresence>
          </>}

          {/* ── Anchor Rail — docked stand-ins for the SELECTED node's
              off-screen partners that live in this column. Real DOM
              chips: the edge overlay anchors focus edges to these rects,
              so "where does this go" always has a visible, named
              destination — never an estimated position. Click = reveal
              the partner on the canvas (the drawer's reveal); "+N more"
              routes to the Lineage Lens for the complete searchable
              list. Offset below/above the count chips so the two
              surfaces never collide. ── */}
          <AnimatePresence>
            {anchorProxies && anchorProxies.proxies.length > 0 && (() => {
              // The focused entity's partners scrolled out of THIS column,
              // gathered on one opaque tray at the edge they are beyond — its
              // lines dock to the entries. Chips once floated here one by one
              // on a background that painted nothing (`bg-canvas-elevated/95`
              // is alpha on a CSS-variable token), so the rows behind showed
              // through and their names ran into the chips' own.
              const upProxies = anchorProxies.proxies.filter(p => p.direction === 'up')
              const downProxies = anchorProxies.proxies.filter(p => p.direction === 'down')
              // Each entry says who (the entity the line really reaches, or
              // how many), which way (the drawer's words, in its colours) and
              // where it sits; a click reveals it — the card it sits in
              // opens down to it — and the selection stays.
              const focusEnd = railFocusId ? railNames.get(railFocusId) : undefined
              // A row here by its label; anywhere else by name, or what the
              // lookup shows while it answers — never a raw id.
              const focusName = railFocusId === null ? ''
                : !focusEnd?.known && nodeToFlatIndexMap.has(railFocusId) ? proxyLabel(railFocusId)
                : focusEnd?.name ?? ''
              const focusIsSelection = railFocusId !== null && railFocusId === selectedNodeId
              const revealProxy = (p: typeof anchorProxies.proxies[number]) => {
                const active = document.activeElement
                railRevealFromRef.current = active?.closest('[data-anchor-dock]') ? active : null
                if (p.realIds && onProxyRevealMany) onProxyRevealMany(p.realIds)
                else onProxyReveal?.(p.realId ?? p.nodeId)
              }
              const renderEntry = (p: typeof anchorProxies.proxies[number]) => {
                const many = (p.partners ?? 1) > 1
                const noun = p.flow === 'in' ? 'source' : p.flow === 'out' ? 'consumer' : 'partner'
                const real = p.realId ? railNames.get(p.realId) : undefined
                const who = p.isFocus ? focusName
                  : many ? `${p.partners!.toLocaleString()} ${noun}s`
                  : p.realId ? (real?.known ? real.name : `1 ${noun}`)
                  : proxyLabel(p.nodeId)
                const verb = p.flow === 'in' ? (many ? 'feed' : 'feeds')
                  : p.flow === 'out' ? 'fed by'
                  : many ? 'feed & fed by' : 'feeds & fed by'
                // Where: the card the entities sit in, down to the real one's
                // parent; a drawn partner's parent when it is a row here (two
                // base_pays, told apart by their tables).
                let place: string | null = null
                if (many) {
                  place = proxyLabel(p.nodeId)
                } else if (p.realId) {
                  const path = railPathOf?.(p.realId) ?? []
                  const k = path.indexOf(p.nodeId)
                  const parent = k > 0 ? railNames.get(path[0]) : undefined
                  place = proxyLabel(p.nodeId) + (parent?.known ? `${k === 1 ? ' › ' : ' › … › '}${parent.name}` : '')
                } else if (!p.isFocus) {
                  const parent = railPathOf?.(p.nodeId)[0]
                  if (parent && nodeToFlatIndexMap.has(parent)) place = proxyLabel(parent)
                }
                const flows = `${p.count.toLocaleString()} ${p.count === 1 ? 'flow' : 'flows'}`
                const end = lineEndOf(lineEnds, p.nodeId)
                const endSaid = end === 'from' ? ', from end' : end === 'to' ? ', to end' : end ? ', an end' : ''
                return (
                  <button
                    key={p.nodeId}
                    id={`anchor-proxy-${p.nodeId}`}
                    type="button"
                    data-canvas-interactive
                    onClick={(e) => { e.stopPropagation(); revealProxy(p) }}
                    aria-label={p.isFocus
                      ? `${focusName}${focusIsSelection ? ', selected' : ''}${endSaid}, ${formatUnitCount(p.count, 'flows')}. Back to it on canvas`
                      : `${who}${endSaid}, ${verb} ${focusName}${place ? `, in ${place}` : ''}, ${formatUnitCount(p.count, 'flows')}. Reveal on canvas`}
                    className="group/entry pointer-events-auto w-full flex items-stretch gap-2 pl-2 pr-1.5 py-1 rounded-lg text-left hover:bg-accent-lineage/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 transition-colors min-w-0"
                  >
                    <span className="w-1 self-stretch rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2 text-[11px] font-medium text-ink">
                        <span className="truncate">{who}</span>
                        {end && <LineEndTag end={end} className="flex-shrink-0" />}
                        <span className="ml-auto flex-shrink-0 tabular-nums text-ink-muted group-hover/entry:hidden group-focus-visible/entry:hidden">{flows}</span>
                        <span className="ml-auto flex-shrink-0 hidden text-accent-lineage group-hover/entry:inline group-focus-visible/entry:inline">Reveal</span>
                      </span>
                      <span className="block truncate text-[10px] text-ink-muted">
                        {p.isFocus
                          ? (focusIsSelection ? 'Selected · back to it' : 'Back to it')
                          : (
                            <>
                              <span className={p.flow === 'in' ? 'text-lineage-in' : p.flow === 'out' ? 'text-lineage-out' : 'text-accent-lineage'}>{verb}</span>
                              {' '}{focusName}{place && ` · in ${place}`}
                            </>
                          )}
                      </span>
                    </span>
                  </button>
                )
              }
              // What the rail's cap leaves out, in the tray on the side it lies.
              const moreOf = (direction: 'up' | 'down') =>
                onProxyMore ? (direction === 'up' ? anchorProxies.moreUp : anchorProxies.moreDown) : 0
              const moreEntry = (more: number) => more > 0 && (
                <button
                  key="anchor-more"
                  type="button"
                  data-canvas-interactive
                  onClick={(e) => { e.stopPropagation(); onProxyMore?.() }}
                  title="Every flow of the focused entity, grouped and searchable"
                  className="pointer-events-auto w-full flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium text-accent-lineage hover:bg-accent-lineage/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 transition-colors"
                >
                  <LucideIcons.Focus className="w-3 h-3 flex-shrink-0" />
                  {more.toLocaleString()} more in the lens
                </button>
              )
              const tray = (direction: 'up' | 'down', entries: typeof upProxies) => {
                const more = moreOf(direction)
                const where = direction === 'up' ? 'above' : 'below'
                // The selection itself, scrolled out of this column: its
                // partners still on screen dock to it here.
                const focusEntry = entries.find(p => p.isFocus)
                // Hint mode (Display > Lineage), or a tray folded by × or Esc:
                // one small pill at the edge, which the focused entity's lines
                // dock to, until a click opens the tray. The tray itself is the
                // default. The selection's own pill takes the reader back to it.
                if (!trayOpen(direction)) {
                  const count = entries.reduce((n, p) => n + (p.partners ?? 1), 0) + more
                  const label = focusEntry
                    ? `${focusName}${focusIsSelection ? ', selected' : ''}, off-screen ${where} — back to it`
                    : `${count.toLocaleString()} connected to ${focusName}, ${where} — show them`
                  // Its lines dock to the tray's width, not the pill's: they
                  // end in the column's gutter level with it, on the side
                  // they run down, never across the rows to the pill.
                  return (
                    <div
                      data-anchor-dock
                      className={cn('absolute left-2.5 right-2.5 z-30 flex pointer-events-none', direction === 'up' ? 'top-12' : 'bottom-12')}
                    >
                      <button
                        id={`anchor-rail-${layer.id}-${direction}`}
                        type="button"
                        data-canvas-interactive
                        onClick={(e) => {
                          e.stopPropagation()
                          if (focusEntry) revealProxy(focusEntry)
                          else setTrayOpen(direction, true)
                        }}
                        title={label}
                        aria-label={label}
                        aria-expanded={focusEntry ? undefined : false}
                        className={cn(
                          'pointer-events-auto inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full min-w-0',
                          'bg-canvas-elevated border border-accent-lineage/25 shadow-md',
                          'text-[10.5px] font-medium text-accent-lineage hover:bg-accent-lineage/10',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 transition-colors',
                        )}
                      >
                        {direction === 'up'
                          ? <LucideIcons.ArrowUp className="w-3 h-3 flex-shrink-0" />
                          : <LucideIcons.ArrowDown className="w-3 h-3 flex-shrink-0" />}
                        {focusEntry
                          ? <><span className="truncate">{focusName}</span>{focusIsSelection && <span className="flex-shrink-0">(selected)</span>}</>
                          : <><span className="tabular-nums">{count.toLocaleString()}</span> connected</>}
                      </button>
                    </div>
                  )
                }
                return (
                  <div
                    id={`anchor-tray-${layer.id}-${direction}`}
                    data-anchor-dock
                    role="group"
                    aria-label={focusEntry ? `${focusName}, off-screen ${where}` : `${focusName}'s lineage, off-screen ${where}`}
                    onKeyDown={(e) => {
                      if (e.key !== 'Escape') return
                      // The tray's, not the canvas's: the selection stays.
                      e.stopPropagation()
                      setTrayOpen(direction, false)
                    }}
                    className={cn(
                      'absolute left-2.5 right-2.5 z-30 pointer-events-auto p-1 rounded-xl',
                      'bg-canvas-elevated border border-accent-lineage/25',
                      'shadow-lg shadow-black/10 dark:shadow-black/40',
                      direction === 'up' ? 'top-12' : 'bottom-12',
                    )}
                  >
                    <p className="flex items-center gap-1 px-2 pt-0.5 pb-1 text-[10.5px] font-medium text-ink-muted">
                      {direction === 'up'
                        ? <LucideIcons.ArrowUp className="w-3 h-3" />
                        : <LucideIcons.ArrowDown className="w-3 h-3" />}
                      {direction === 'up' ? 'Off-screen above' : 'Off-screen below'}
                      <button
                        type="button"
                        data-canvas-interactive
                        onClick={(e) => { e.stopPropagation(); setTrayOpen(direction, false) }}
                        aria-label="Fold into the hint"
                        className="ml-auto p-0.5 rounded-md hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                      >
                        <LucideIcons.X className="w-3 h-3" />
                      </button>
                    </p>
                    {entries.map(renderEntry)}
                    {moreEntry(more)}
                  </div>
                )
              }
              return (
                <motion.div
                  key="anchor-rail"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                  className="pointer-events-none"
                >
                  {(upProxies.length > 0 || moreOf('up') > 0) && tray('up', upProxies)}
                  {(downProxies.length > 0 || moreOf('down') > 0) && tray('down', downProxies)}
                </motion.div>
              )
            })()}
          </AnimatePresence>

          {/* Density gutter — a slim heat strip on the column's right edge
              showing where flow mass lives across the FULL scroll
              range (the budget/stub modes summarize edges, this shows
              where the summarized mass is). Click a hot zone to jump. */}
          {densityBuckets && (
            <button
              type="button"
              data-canvas-interactive
              onClick={handleGutterClick}
              title="Flow density across this column — click to jump"
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
            onDragOver={(e) => {
              // Auto-scroll while an entity drag hovers near the column's
              // vertical edges. dragover only refreshes the pointer sample;
              // the rAF loop below applies smooth, distance-proportional
              // scrolling and self-terminates ~200ms after events stop
              // (drop, cancel, or the pointer leaving the column).
              // Deliberately does NOT preventDefault for entities — drop
              // acceptance stays with the row targets. A GROUP is taken
              // anywhere in the column (rows that aren't groups don't take it):
              // it moves to the top of this layer, lit up in the header.
              const isGroup = e.dataTransfer.types.includes('text/x-group-id') && !!groupActions
              if (isGroup) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (!isDragOver) setIsDragOver(true)
                if (dragKind !== 'group') setDragKind('group')
              }
              if (!e.dataTransfer.types.includes('text/x-entity-id') && !isGroup) return
              dragPointerRef.current = { y: e.clientY, t: performance.now() }
              if (dragScrollRafRef.current == null) {
                dragScrollRafRef.current = requestAnimationFrame(dragScrollStep)
              }
              // A mapped column's body: the drop goes inside the entity the column is.
              if (!isGroup && anchorNode && !overRow(e)) {
                const hint = bodyHintFor()
                if (hint) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                }
                const top = chipTop(e.clientY, e.currentTarget.getBoundingClientRect())
                if (!sameHint(hint, bodyHint)) setBodyHint(hint ? { ...hint, top } : null)
                else if (bodyChipRef.current) bodyChipRef.current.style.top = `${top}px`
              }
            }}
            // A row stops the drag reaching here; seen on the way down, its hint gives way to the row's.
            onDragOverCapture={(e) => { if (bodyHint && overRow(e)) setBodyHint(null) }}
            onDragLeave={(e) => {
              const left = !e.currentTarget.contains(e.relatedTarget as Node)
              if (dragKind === 'group' && left) { setIsDragOver(false); setDragKind(null) }
              if (bodyHint && left) setBodyHint(null)
            }}
            onDrop={(e) => {
              const groupId = e.dataTransfer.getData('text/x-group-id')
              if (groupId && groupActions) {
                e.preventDefault()
                setIsDragOver(false)
                setDragKind(null)
                groupActions.receive(groupId, e.dataTransfer.getData('text/x-group-layer') || layer.id, null)
                return
              }
              setBodyHint(null)
              const entityId = e.dataTransfer.getData('text/x-entity-id')
              if (!entityId || !anchorNode || overRow(e)) return
              e.preventDefault()
              reparent(entityId, anchorNode.id)
            }}
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
          {/* First-use guidance for custom order — a dismissible caption in the
              ghost-stack style, shown only while the layer is reorderable and
              until the user dismisses it (preferences-flagged, once ever). */}
          {reorderEnabled && !customOrderHintDismissed && flatTree.length > 0 && (
            <div
              className="flex items-center gap-2 px-3 py-2 mx-1 mt-2 mb-1 rounded-lg border"
              style={{ backgroundColor: `${layer.color}10`, borderColor: `${layer.color}25` }}
            >
              <LucideIcons.ListOrdered className="w-3.5 h-3.5 flex-shrink-0" style={{ color: layer.color }} />
              <span className="text-[11px] font-medium tracking-wide flex-1" style={{ color: layer.color }}>
                Drag cards to arrange · ⌥↑↓ to nudge
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); completeOnboardingStep('custom-order-hint') }}
                className="p-0.5 rounded text-ink-muted hover:text-ink transition-colors flex-shrink-0"
                title="Got it"
              >
                <LucideIcons.X className="w-3 h-3" />
              </button>
            </div>
          )}

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
                    className="flex items-center gap-2 px-3 py-2 mx-1 mb-1 rounded-lg border"
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
              ) : showEmptyMessage ? (
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
                    {anchorIssue === 'missing'
                      ? 'This column\u2019s entity is gone'
                      : anchorIssue === 'duplicate'
                        ? 'Another column holds this entity'
                        : emptyInside
                          ? (addInsideName ? `Nothing inside ${emptyInside} yet` : `Nothing inside ${emptyInside}`)
                          : emptyText ?? (isBlankModel ? 'No entities yet' : 'No assigned entities yet')}
                  </p>
                  {/* Plain token, not `/40`: an alpha suffix on a CSS-variable
                      token emits no CSS at all, so the neighbouring hint has been
                      rendering at full strength regardless. The smaller size
                      already carries the hierarchy. */}
                  {anchorIssue && (
                    <p className="text-xs text-ink-muted mt-1 text-center max-w-[220px]">
                      {anchorIssue === 'missing'
                        ? 'This source doesn’t hold it now, so there is nothing to show here. Map the column to another entity, keep it as a hand-picked column, or delete it.'
                        : 'Two columns are built around the same entity; only the first can show it. Delete this one, or map it to another entity.'}
                    </p>
                  )}
                  {anchorIssue && mapping?.onMap && (
                    <EmptyAction color={layer.color} icon={LucideIcons.Link2} label="Map to another entity…" onClick={mapping.onMap} />
                  )}
                  {/* Its entity gone, the column offers the other two ways on, wherever mapping is
                      offered (a draft that can change its layers). */}
                  {anchorIssue === 'missing' && mapping && !mapping.refused && (
                    <>
                      {onUnmapLayer && (
                        <EmptyAction color={layer.color} icon={LucideIcons.Pin} label="Show as a hand-picked column" onClick={() => onUnmapLayer(layer.id)} />
                      )}
                      {onDeleteWithUndo && (
                        <EmptyAction color={layer.color} icon={LucideIcons.Trash2} label="Delete the column" onClick={() => onDeleteWithUndo(layer.id)} />
                      )}
                    </>
                  )}
                  {emptyInside && (addInsideName ? (
                    onAddToLayer
                      ? <EmptyAction color={layer.color} icon={LucideIcons.Plus} label={`Add inside ${emptyInside}`} onClick={() => onAddToLayer(layer.id)} />
                      : <p className="text-xs text-ink-muted mt-1 text-center max-w-[220px]">What\u2019s added inside {emptyInside} shows here.</p>
                  ) : (
                    <>
                      <p className="text-xs text-ink-muted mt-1 text-center max-w-[220px]">
                        {`${/^[aeiou]/i.test(anchorTypeName ?? '') ? 'An' : 'A'} ${anchorTypeName ?? 'entity of this type'} holds nothing, so this column stays empty.`}
                      </p>
                      {mapping?.onUnmap && (
                        <EmptyAction color={layer.color} icon={LucideIcons.Rows3} label={`Show ${emptyInside} as a row`} onClick={mapping.onUnmap} />
                      )}
                    </>
                  ))}
                  {/* The hint follows the affordance. `onAddToLayer` is what renders the "+"
                      (see the header above), and the caller only passes it inside a draft — so
                      with editing unavailable (read-only, or version control switched off) there
                      is no "+" anywhere on screen, and telling someone to click one is just a
                      small lie in the corner of the page. */}
                  {onAddToLayer && !anchorIssue && !emptyInside && (
                    <p className="text-xs text-ink-muted/40 mt-1">
                      {addInsideName ? `Click + to add inside ${addInsideName}` : isBlankModel ? 'Click + to add entities' : 'Click + to assign entities'}
                    </p>
                  )}
                </motion.div>
              ) : null}
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
                          value={boxTextFor(item.node)}
                          onChange={(val) => {
                            // A box opened before the trace is still mounted
                            // during it, and the trace withdrew the affordance
                            // that opens one. It drives nothing from here.
                            if (isTracing) return
                            if (val.trim()) {
                              // Clamp the view's one search to this container.
                              // Nothing local is dropped: the children stay,
                              // filtered, and the hits arrive as their own rows.
                              rowSearch.setQuick({
                                text: val,
                                scope: { insideUrn: item.node.urn ?? item.node.id, label: item.node.name },
                              })
                            } else {
                              // Clearing the box unclamps the session. There is
                              // nothing to refetch — nothing was ever removed.
                              rowSearch.setQuick({ text: '' })
                              rowSearch.clearScope()
                            }
                          }}
                          isLoading={advancedView?.kind === 'running'}
                          layer={layer}
                        />
                      </div>
                    </div>
                  )
                }

                if (item.isSearchHit) {
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
                        <SearchHitInlineRow
                          depth={item.depth}
                          parentIsLast={item.parentIsLast}
                          layer={layer}
                          schema={schema}
                          hit={item.hit}
                          crumbs={item.crumbs}
                          overflow={item.overflow}
                          onReveal={onRevealSearchHit}
                          onOpenPanel={rowSearch.openPanel}
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
                        count={item.loadMoreCount ?? null}
                        {...(item.isFeedMore
                          // A type page's rows may render under parents in OTHER
                          // columns, so this row re-arms only when THIS column
                          // grows (latch on its row count) — never an unattended
                          // drain of the whole type.
                          ? {
                            isLoading: feedMore?.loading ?? false,
                            failed: (feedMore?.failed ?? false) && !(feedMore?.loading ?? false),
                            rearmKey: visibleCount,
                            onLoadMore: () => onFeedMore?.(layer.id),
                          }
                          : {
                            isLoading: loadingNodes?.has(item.node.id) ?? false,
                            // Re-arm only when THIS column grows: children placed in
                            // another column must not drain this parent unattended.
                            rearmKey: visibleCount,
                            failed: (failedNodes?.has(item.node.id) ?? false) && !(loadingNodes?.has(item.node.id) ?? false),
                            onLoadMore: (auto?: boolean) => handleLoadMore(item.node.id, auto),
                          })}
                        // One-page-ahead auto-load — OFF in Isolate/Hide
                        // filter modes, where freshly-loaded children are
                        // filtered out of the tree and the pinned row
                        // would drain the parent (the historical pump);
                        // and OFF for a level a reveal opened, which the
                        // reader was carried to rather than scrolled to.
                        // A narrowed canvas filters the same way: off there too.
                        autoLoad={(matchUrnSet.size === 0 || canvasFilterMode === 'highlight')
                          && !(narrow && !isTracing)
                          && !holdsOnlyRevealedChildren(item.node)}
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
                        placement={placedApart?.get(node.id)}
                        placedOut={placedOut?.get(node.id)}
                        onRevealPlacement={onRevealPlacement}
                        onReturnPlacement={onReturnPlacement}
                        groupActions={groupActions}
                        depth={depth}
                        isLast={isLast}
                        parentIsLast={parentIsLast}
                        layer={layer}
                        schema={schema}
                        isSelected={selectedNodeIds ? selectedNodeIds.has(node.id) : selectedNodeId === node.id}
                        isBulkSelected={(selectedNodeIds?.size ?? 0) > 1 && !!selectedNodeIds?.has(node.id)}
                        // A partner the selection's lines reach is part of what
                        // is being looked at: full strength, with its ring, as
                        // with one entity selected.
                        isDimmedBySelection={(selectedNodeIds?.size ?? 0) > 1 && !selectedNodeIds?.has(node.id)
                          && !(isHighlightActive && (highlightedNodes?.has(node.id) ?? false))}
                        isExpanded={expandedNodes.has(node.id)}
                        isLoading={loadingNodes?.has(node.id) ?? false}
                        isSearchResult={searchResults.has(node.id)}
                        isHighlighted={traceContextSet.has(node.id)}
                        isFocusNode={traceFocusIds ? traceFocusIds.has(node.id) : traceFocusId === node.id}
                        isTracing={isTracing}
                        isClickHighlighted={isHighlightActive && (highlightedNodes?.has(node.id) ?? false)}
                        isDimmedByHighlight={isHighlightActive && !(highlightedNodes?.has(node.id) ?? false)}
                        isFocused={focusIndex >= 0 && navIdx === focusIndex}
                        lineEnd={lineEndOf(lineEnds, node.id)}
                        onSelect={handleRowSelect}
                        onToggle={onToggle}
                        onContextMenu={onContextMenu}
                        onDoubleClick={onDoubleClick}
                        onAddChild={onAddChild}
                        onFocus={handleFocus}
                        onToggleSearch={toggleSearchNode}
                        isSearchVisible={activeSearchNodes.has(node.id)}
                        onBeginConnect={onBeginConnect}
                        reorderEnabled={reorderEnabled}
                        onReorderDrop={onReorderDrop}
                        reorderAccepts={reorderAccepts}
                        forwardTo={forwardTo}
                        moveEnabled={moveEnabled}
                        ports={showLineageIndicators ? lineagePorts?.get(node.id) : undefined}
                        portStrengthLeft={lineageLogMax > 0 ? Math.log2(1 + sideVolume(lineagePorts?.get(node.id), 'left')) / lineageLogMax : 0}
                        portStrengthRight={lineageLogMax > 0 ? Math.log2(1 + sideVolume(lineagePorts?.get(node.id), 'right')) / lineageLogMax : 0}
                        lineageTotals={showLineageIndicators ? lineageTotals?.get(node.id) : undefined}
                        lineageUnknown={showLineageIndicators && (lineageUnknown?.has(node.id) ?? false)}
                        lineageOutside={showLineageIndicators ? lineageOutside?.get(node.id) : undefined}
                        externalIn={showLineageIndicators ? (externalCue?.get(node.id)?.in ?? 0) : 0}
                        externalOut={showLineageIndicators ? (externalCue?.get(node.id)?.out ?? 0) : 0}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Drop-to-end zone — reaching the last row's bottom 30% band is a
              precision trap; any drop on the space below the list appends to
              the end of the custom arrangement instead of being dead. */}
          {reorderEnabled && flatTree.length > 0 && (
            <div
              data-end-zone
              className={cn(
                "mx-1 my-1 h-12 rounded-xl border border-dashed flex items-center justify-center transition-colors duration-150",
                endZoneHover ? "border-accent-lineage/60 bg-accent-lineage/5" : "border-transparent",
              )}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('text/x-entity-id') || forTheBody()) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (!endZoneHover) setEndZoneHover(true)
              }}
              onDragLeave={() => setEndZoneHover(false)}
              onDrop={(e) => {
                const draggedId = e.dataTransfer.getData('text/x-entity-id')
                setEndZoneHover(false)
                if (!draggedId || !onReorderDrop || forTheBody()) return
                e.preventDefault()
                e.stopPropagation()
                const lastRoot = [...nodes].reverse().find(n => !n.isLogical)
                if (lastRoot && lastRoot.id !== draggedId) onReorderDrop(draggedId, lastRoot.id, 'after')
              }}
            >
              {endZoneHover && <DropHint kind="view" title="Move to the end" detail="only this view" />}
            </div>
          )}

          {/* A capped subset layer: the canvas lists its first rows; the rest are
              found by searching in the layer, or exported. Not under a trace,
              which lists the rows its walk reached, not the layer's first ones. */}
          {subsetFeed?.capped && !isTracing && (
            <div className="mx-2 mt-1 mb-3 rounded-xl border border-glass-border/70 bg-black/[0.02] dark:bg-white/[0.03] px-3 py-2.5">
              <p className="text-[11.5px] font-semibold text-ink tabular-nums">{cappedText(subsetFeed.delivered, subsetFeed.total)}</p>
              <p className="mt-0.5 text-[11px] text-ink-muted leading-snug">The canvas lists the first {subsetFeed.delivered.toLocaleString()}. For the rest:</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {onSearchInLayer && (
                  <button type="button" onClick={() => onSearchInLayer(layer.id)}
                    className="h-7 px-2.5 rounded-lg inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-secondary border border-glass-border hover:text-ink hover:border-accent-lineage/40">
                    <LucideIcons.Search className="w-3 h-3" /> Search in this layer
                  </button>
                )}
                {onExportLayer && (
                  <button type="button" onClick={() => onExportLayer(layer.id)}
                    className="h-7 px-2.5 rounded-lg inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-secondary border border-glass-border hover:text-ink hover:border-accent-lineage/40">
                    <LucideIcons.Download className="w-3 h-3" /> Export
                  </button>
                )}
              </div>
            </div>
          )}

          </div>
        </div>
      )}
    </motion.div>
  )
})

/** A control in a layer header's actions tray: a glyph, named for what it does, with its tip. */
function TrayButton({ label, detail, onClick, menuHasIt, autoFocus, className, children }: {
  label: string
  detail?: string
  onClick: () => void
  /** The layer's menu offers it too, so a device with no hover leaves it to the ⋯. */
  menuHasIt: boolean
  autoFocus?: boolean
  className: string
  children: React.ReactNode
}) {
  return (
    <HoverTip label={label} detail={detail} className={menuHasIt ? '[@media(hover:none)]:hidden' : undefined}>
      <button
        type="button"
        aria-label={label}
        autoFocus={autoFocus}
        onClick={(e) => { e.stopPropagation(); onClick() }}
        className={cn(
          "p-1.5 rounded-lg transition-all duration-200",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/50",
          className,
        )}
      >
        {children}
      </button>
    </HoverTip>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// LayerHeaderTitle — the name of an expanded layer column.
//
// Wraps the title in a 2-line clamp so long names wrap legibly, and a hover
// popover that materialises when there is more to read: the name cut short
// (clamped, or under the header's actions tray), what KIND of column it is and
// what adding or dropping there does, the layer's description — which the
// header never prints, so every header is one height — or its properties. The
// popover (createPortal + framer-motion) mirrors LineageDisplayPopover's
// pattern so the two header surfaces feel like a matched set.
// ─────────────────────────────────────────────────────────────────────────────

const TITLE_HOVER_OPEN_DELAY_MS = 180
const TITLE_HOVER_CLOSE_DELAY_MS = 80
const TITLE_POPOVER_WIDTH = 320
/** A layer card lists this many properties; Layer settings has them all. */
const LAYER_CARD_PROPERTIES = 8

/** What a column's card offers for mapping it to an entity (a view change), or why it can't. */
interface CardMapping {
  actions: Array<{ label: string; icon: LucideIcons.LucideIcon; onClick: () => void }>
  refused?: string
}

/** One way on from an empty column: a soft pill in the column's colour. */
function EmptyAction({ color, icon: Icon, label, onClick }: {
  color?: string
  icon: LucideIcons.LucideIcon
  label: string
  onClick: () => void
}) {
  const tint = color ?? '#6366f1'
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className="mt-3 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
      style={{ color: tint, backgroundColor: `${tint}14`, borderColor: `${tint}33` }}
    >
      <Icon className="w-3.5 h-3.5" aria-hidden />
      {label}
    </button>
  )
}

function LayerHeaderTitle({
  name,
  description,
  color,
  properties,
  coverRight = 0,
  nameClass,
  kind,
  kindCopy,
  onOpenAnchor,
  anchorName,
  mapping,
}: {
  name: string
  description?: string
  color?: string
  /** The layer's own properties: an owner, a purpose, an SLA. Shown on its
   *  card, read at a glance — the header itself only says there are some. */
  properties?: Record<string, unknown>
  /** How much of the right of the row the title sits in the header's actions
   *  tray covers while it shows, px. */
  coverRight?: number
  /** The name's size and how many lines it may take (Display › Header size). */
  nameClass: string
  /** What kind of column this is, explained (see columnKind.ts). */
  kind?: ColumnKind
  kindCopy?: ColumnKindCopy
  /** A mapped column: open the details of the entity it is. */
  onOpenAnchor?: () => void
  anchorName?: string
  /** Mapping it to an entity: the ways it offers, or why not. */
  mapping?: CardMapping
}) {
  const resolvedColor = color ?? '#6b7280'
  const propertyEntries = Object.entries(properties ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
  const hasProperties = propertyEntries.length > 0
  const containerRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLHeadingElement>(null)
  const nameTextRef = useRef<HTMLSpanElement>(null)
  const coverRightRef = useRef(coverRight)
  const [isTruncated, setIsTruncated] = useState(false)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Is the name cut short? Clamped, or running on under the actions tray, which covers the end of a long name while the header is
  // hovered: hidden there as surely as past the clamp. Reads refs only. The
  // tray covers the right of the ROW; this box is only as wide as its words,
  // so the row's edge is read off the box it sits in.
  const measureCut = useCallback(() => {
    const nameOverflow = nameRef.current ? nameRef.current.scrollHeight > nameRef.current.clientHeight + 1 : false
    const box = containerRef.current?.parentElement?.getBoundingClientRect()
    const underTray = !!box && coverRightRef.current > 0
      && Array.from(nameTextRef.current?.getClientRects() ?? []).some((line) => line.right > box.right - coverRightRef.current)
    setIsTruncated(nameOverflow || underTray)
  }, [])

  // Detect overflow after layout / on every name change.
  useLayoutEffect(() => {
    coverRightRef.current = coverRight
    measureCut()
  }, [measureCut, name, coverRight, nameClass])

  // Re-check on container resize (column width can change as users open
  // the right-rail drawer or toggle adjacent layers) — and on the row's: a
  // short name keeps its own width as the column narrows under it.
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measureCut)
    ro.observe(el)
    if (el.parentElement) ro.observe(el.parentElement)
    return () => ro.disconnect()
  }, [measureCut])

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

  // A drag (the header is the handle for reordering) puts the card away: it would ride over the
  // columns the reader is dropping onto.
  useEffect(() => {
    const putAway = () => {
      clearTimeout(openTimerRef.current)
      setOpen(false)
    }
    window.addEventListener('dragstart', putAway)
    return () => window.removeEventListener('dragstart', putAway)
  }, [])

  const scheduleOpen = () => {
    // The card opens when the header cuts the name short — or there is more
    // to read: what kind of column it is, its description, its properties.
    if (!isTruncated && !kindCopy && !description && !hasProperties) return
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
      // The row's width, less the count at its end.
      className="flex-1 min-w-0 flex items-center gap-1.5"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={scheduleOpen}
      onBlur={scheduleClose}
    >
      <h3
        ref={nameRef}
        // A name with no spaces still breaks, inside its lines, rather than
        // running out of the box with no ellipsis.
        className={cn("min-w-0 font-semibold tracking-tight break-words", nameClass)}
        style={{ color: resolvedColor }}
        title={isTruncated || kindCopy || description || hasProperties ? undefined : name}
      >
        <span ref={nameTextRef}>{name}</span>
      </h3>
      {/* What the card holds besides the name. Beside the name, never inside
          its clamp, so a long name's ellipsis cannot take them away. */}
      {(description || hasProperties) && (
        <span className="flex-shrink-0 flex items-center gap-1.5 text-ink-muted">
          {description && (
            <LucideIcons.AlignLeft className="w-3 h-3" role="img" aria-label="Has a description" />
          )}
          {hasProperties && (
            <span
              className="inline-flex items-center gap-0.5 text-[10px] font-medium tabular-nums"
              role="img"
              aria-label={`${propertyEntries.length} ${propertyEntries.length === 1 ? 'property' : 'properties'}`}
            >
              <LucideIcons.Tags className="w-3 h-3" aria-hidden />
              {propertyEntries.length}
            </span>
          )}
        </span>
      )}
      {/* Read out after the name; seen in the card. */}
      {description && <p className="sr-only">{description}</p>}

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
              className="rounded-xl bg-canvas-elevated/95 border border-black/[0.10] dark:border-white/[0.08] shadow-2xl shadow-black/20 dark:shadow-black/40 overflow-hidden"
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
              {kind && kindCopy && (() => {
                const KindIcon = COLUMN_KIND_ICON[kind]
                return (
                  <div data-column-kind-card={kind} className="px-3 py-2.5 flex items-start gap-2.5 border-b border-black/[0.06] dark:border-white/[0.04]">
                    <span className="mt-px grid place-items-center w-6 h-6 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-ink-secondary shrink-0">
                      <KindIcon className="w-3.5 h-3.5" aria-hidden />
                    </span>
                    <div className="min-w-0 space-y-1">
                      <p className="text-[12px] font-semibold text-ink leading-snug">{kindCopy.label}</p>
                      <p className="text-[12px] text-ink/80 leading-relaxed">{kindCopy.detail}</p>
                      {kindCopy.technical && (
                        <p className="font-mono text-[10.5px] text-ink-muted break-all">{kindCopy.technical}</p>
                      )}
                      {onOpenAnchor && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setOpen(false); onOpenAnchor() }}
                          className="mt-0.5 inline-flex items-center gap-1 text-[12px] font-semibold text-accent-lineage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 rounded"
                        >
                          Open {anchorName ? `${anchorName}’s` : 'its'} details
                          <LucideIcons.ArrowUpRight className="w-3 h-3" aria-hidden />
                        </button>
                      )}
                      {mapping?.refused && (
                        <div data-column-mapping="refused" className="pt-1">
                          <DropHint compact kind="blocked" title="Can’t map this column to an entity" detail={mapping.refused} />
                        </div>
                      )}
                      {mapping && mapping.actions.length > 0 && (
                        <div data-column-mapping="offered" className="pt-1.5 space-y-1.5">
                          <div className="flex flex-wrap gap-1.5">
                            {mapping.actions.map(({ label, icon: Icon, onClick }) => (
                              <button
                                key={label}
                                type="button"
                                // Pressing it focused it, which asks the card to open again: it stays shut.
                                onClick={(e) => { e.stopPropagation(); clearTimeout(openTimerRef.current); setOpen(false); onClick() }}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-black/[0.10] dark:border-white/[0.10] bg-black/[0.03] dark:bg-white/[0.04] px-2 py-1 text-[12px] font-semibold text-ink hover:bg-accent-lineage/10 hover:text-accent-lineage hover:border-accent-lineage/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                              >
                                <Icon className="w-3.5 h-3.5" aria-hidden />
                                {label}
                              </button>
                            ))}
                          </div>
                          <ChangeKindTag kind="view" />
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}
              {description && (
                <div className="px-3 py-2.5 text-[12px] text-ink/85 leading-relaxed whitespace-pre-wrap">
                  {description}
                </div>
              )}
              {hasProperties && (
                <dl className="px-3 py-2.5 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-black/[0.06] dark:border-white/[0.04]">
                  {propertyEntries.slice(0, LAYER_CARD_PROPERTIES).map(([key, value]) => (
                    <React.Fragment key={key}>
                      <dt className="text-[11px] text-ink-muted truncate">{humanizeKey(key)}</dt>
                      <dd className="text-[12px] text-ink min-w-0 break-words"><ValueView value={value} keyHint={key} /></dd>
                    </React.Fragment>
                  ))}
                  {propertyEntries.length > LAYER_CARD_PROPERTIES && (
                    <dd className="col-span-2 text-[11px] text-ink-muted">
                      and {propertyEntries.length - LAYER_CARD_PROPERTIES} more — open Layer settings
                    </dd>
                  )}
                </dl>
              )}
            </motion.div>
          )}
        </>,
        document.body,
      )}
    </div>
  )
}
