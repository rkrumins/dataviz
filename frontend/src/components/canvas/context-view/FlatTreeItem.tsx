import React, { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import type { HierarchyNode } from './types'
import type { ViewLayerConfig } from '@/types/schema'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { generateIconFallback } from '@/lib/type-visuals'
import { useStagedChangesStore, stagedChangeColor } from '@/store/stagedChangesStore'
import { useDiffDecoration } from '@/features/versioning/canvas/useDiffDecoration'
import { usePreferencesStore } from '@/store/preferences'
import { densityRowTokens } from './density'
import { SearchMatchBadge } from '../search/SearchMatchBadge'
import { useSearchHighlight } from '../search/useSearchHighlight'
import { DisplayRuleTagChips } from '../property-manager/DisplayRuleTagChips'
import { NodeConnectionHandle } from './NodeConnectionHandle'

interface FlatTreeItemProps {
  node: HierarchyNode
  depth: number
  isLast: boolean
  parentIsLast: boolean[]
  layer: ViewLayerConfig
  schema: ReturnType<typeof useSchemaStore.getState>['schema']
  isSelected: boolean
  isExpanded: boolean
  isLoading?: boolean
  isSearchResult: boolean
  isHighlighted: boolean
  isFocusNode: boolean
  isClickHighlighted?: boolean
  isHoverHighlighted?: boolean
  isDimmedByHighlight?: boolean
  isFocused?: boolean
  isTracing?: boolean
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void
  onDoubleClick: (id: string, event?: React.MouseEvent) => void
  onAddChild?: (parentId: string) => void
  onFocus: (node: HierarchyNode) => void
  onToggleSearch?: (id: string) => void
  isSearchVisible?: boolean
  /** When set (draft/authoring mode), show the hover connection handle. */
  onBeginConnect?: (sourceId: string, start: { x: number; y: number }) => void
  /** Live connect drag context — drives valid-target ring / invalid-target dim. */
  connectContext?: { sourceId: string; validTypeIds: Set<string> } | null
  /** When true, this row edits its name inline (double-click rename). */
  isEditing?: boolean
  onRenameCommit?: (id: string, label: string) => void
  onRenameCancel?: () => void
}

export const FlatTreeItem = React.memo(function FlatTreeItem({
  node,
  depth,
  isLast,
  parentIsLast,
  layer,
  schema,
  isSelected,
  isExpanded,
  isLoading = false,
  isSearchResult,
  isHighlighted,
  isFocusNode,
  isClickHighlighted = false,
  isHoverHighlighted = false,
  isDimmedByHighlight = false,
  isFocused = false,
  isTracing = false,
  onSelect,
  onToggle,
  onContextMenu,
  onDoubleClick,
  onAddChild,
  onFocus,
  onToggleSearch,
  isSearchVisible = false,
  onBeginConnect,
  connectContext,
  isEditing = false,
  onRenameCommit,
  onRenameCancel,
}: FlatTreeItemProps) {
  const itemRef = useRef<HTMLDivElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const isLogical = node.isLogical === true

  // Connect-drag validity: while a connection is being drawn from another node,
  // a legal target gets a ring and an illegal one dims — so the user sees where
  // the edge may land before dropping (ontology, explained live).
  const isConnectSource = connectContext?.sourceId === node.id
  const isConnectValidTarget = !!connectContext && !isConnectSource && connectContext.validTypeIds.has(node.typeId)
  const isConnectInvalidTarget = !!connectContext && !isConnectSource && !isConnectValidTarget

  // Staged-change indicator: a *direct* match wins, but if any descendant is
  // staged the row also tints (lighter) so the user can spot pending work
  // anywhere in the tree without expanding every container.
  const directChange = useStagedChangesStore(s => {
    const matches = s.changes.filter(c => c.targetId === node.id || c.targetUrn === node.urn)
    return matches.length > 0 ? matches[matches.length - 1] : undefined
  })
  // Cascade detection — check if any descendant URN is staged.
  const hasDescendantChange = useStagedChangesStore(s => {
    if (directChange) return false
    if (!node.children || node.children.length === 0) return false
    const descendantIds = new Set<string>()
    const collect = (n: HierarchyNode) => {
      descendantIds.add(n.id)
      if (n.urn) descendantIds.add(n.urn)
      n.children?.forEach(collect)
    }
    node.children.forEach(collect)
    return s.changes.some(c => descendantIds.has(c.targetId) || (c.targetUrn ? descendantIds.has(c.targetUrn) : false))
  })

  // Pulse-on-arrival from a jump-to-node reveal. Backed by a Set so
  // multi-locate flows can pulse many nodes concurrently. Auto-clears
  // per-id via the store's setTimeout (~900ms).
  const isPulsing = useCanvasStore((s) => s.pulseNodeIds.has(node.id))

  const stagedColor = directChange ? stagedChangeColor(directChange.type) : (hasDescendantChange ? 'cascade' : null)
  // Branch-diff overlay: when "Review changes" is on, tint nodes that differ from
  // main using the same vocabulary. Uncommitted staged edits take precedence.
  const diffStatus = useDiffDecoration().statusForEntity(node.urn ?? node.id)
  const diffColor: 'green' | 'amber' | 'red' | null =
    diffStatus === 'added' ? 'green' : diffStatus === 'modified' ? 'amber' : diffStatus === 'removed' ? 'red' : null
  const reviewColor = stagedColor ?? diffColor
  const stagedSummary = directChange?.summary
    ?? (hasDescendantChange ? 'Contains staged changes' : undefined)
    ?? (diffStatus ? `${diffStatus} vs main` : undefined)

  // Strong, full-width background tint — the user wanted the ENTIRE row to
  // glow in the change color so the canvas reads as a heatmap of pending edits.
  // Direct changes get saturated tints; cascade indicates child changes with a
  // muted left-bar treatment so it's spottable but not overpowering.
  const stagedRowClass = (() => {
    switch (reviewColor) {
      case 'green':
        return 'bg-gradient-to-r from-green-500/25 via-green-500/15 to-green-500/5 ring-2 ring-green-400/70 shadow-lg shadow-green-500/20'
      case 'red':
        return 'bg-gradient-to-r from-rose-500/30 via-rose-500/20 to-rose-500/8 ring-2 ring-rose-400/80 shadow-lg shadow-rose-500/25 opacity-90'
      case 'amber':
        return 'bg-gradient-to-r from-orange-500/25 via-orange-500/15 to-orange-500/5 ring-2 ring-orange-400/70 shadow-lg shadow-orange-500/20'
      case 'cascade':
        // Indicate that a descendant has a staged change with a soft amber edge stripe.
        return 'border-l-[3px] border-l-amber-400/50'
      default:
        return ''
    }
  })()
  const entityType = schema?.entityTypes.find((et) => et.id === node.typeId)
  const visual = entityType?.visual
  const nodeColor = visual?.color ?? layer.color
  // Logical nodes use a folder/group icon instead of entity type icon
  const logicalIcon = isLogical
    ? (entityType?.visual?.icon ?? generateIconFallback(node.typeId))
    : undefined

  const childCount = (node.data.childCount as number) || (node.data._collapsedChildCount as number) || 0
  const hasChildren = node.children.length > 0 || childCount > 0

  // Advanced-search roll-up: number of matches sitting anywhere in this
  // node's subtree (N levels deep, deduped per hit). Drives the
  // "[N matches inside]" badge on collapsed ancestor rows so a user
  // can see, before expanding, that a domain contains 47 PII fields.
  //
  // W2.1: the row-decoration bundle is now produced by
  // ``useSearchHighlight`` so GraphCanvas + HierarchyCanvas can light
  // up identically with a single hook call.
  const urnOrId = node.urn ?? node.id
  // Note: FlatTreeItem receives ``isSearchResult`` from its parent
  // (ContextViewCanvas merges quick-search + advanced-search hits),
  // which already drives the pulse class — so we don't destructure
  // ``isDirectMatch`` here. Other canvases (GraphCanvas /
  // HierarchyCanvas) consume ``isDirectMatch`` directly because they
  // bind to the store, not the prop.
  const {
    ancestorMatchCount,
    ancestorBreakdown: ancestorMatchBreakdown,
    isSpotlightDim,
  } = useSearchHighlight(urnOrId, { isSelected })
  // In trace mode, useTraceFilteredHierarchy already prunes node.children to
  // the trace context, so children.length reflects what the user will see on
  // expand. The graph-wide childCount would mislead them with siblings the
  // trace filter immediately hides.
  const descendantCount = hasChildren && !isExpanded
    ? (isTracing ? node.children.length : (childCount || node.children.length))
    : 0

  // Density-aware sizing — driven by usePreferencesStore.canvasDensity. The
  // virtualizer in LayerColumn reads the same density via densityRowHeights()
  // so its size estimates stay in lockstep with the rendered row heights.
  // `?? default` covers users whose persisted state predates these fields.
  const density = usePreferencesStore(s => s.canvasDensity) ?? 'spacious'
  const showTypeBadge = usePreferencesStore(s => s.showCanvasTypeBadge) ?? true
  const subtleTreeLines = usePreferencesStore(s => s.subtleCanvasTreeLines) ?? false
  const isRoot = depth === 0
  const sizing = densityRowTokens(density, isRoot)
  const minRowHeightPx = isRoot ? sizing.rootHeight : sizing.childHeight
  const paddingClass = sizing.paddingClass
  const textClass = sizing.textClass
  const iconSize = sizing.iconSize
  const iconContainerSize = sizing.iconContainerSize

  // Dimming applies to (a) the click-highlight feature, and (b) the
  // advanced-search "spotlight" mode (sourced from useSearchHighlight
  // above): when any search has matches, every node that's NOT a
  // direct match AND NOT an ancestor of one fades to 40% so the
  // matched chain is visually unmissable. Selected rows stay bright
  // regardless so the user never loses their focus during search.
  // Trace mode used to dim non-traced nodes here, but
  // ContextViewCanvas's ``useTraceFilteredHierarchy`` removes them
  // from the render tree entirely — so anything that reaches
  // FlatTreeItem during trace IS in the trace context and should
  // render at full opacity.
  const isDimmed = isDimmedByHighlight || isSpotlightDim

  // Tree line indent - reduced to save horizontal space
  const indentWidth = depth * 16

  // 4.3 Drag-and-drop — only root-level nodes (depth === 0, no parentId) may
  // be re-assigned between layers. Children live inside their parent's
  // containment scope; moving a column without its table would break the
  // ontology. Attach native events via ref (avoids type conflict).
  const isLayerDraggable = depth === 0 && !node.parentId && !isLogical
  useEffect(() => {
    const el = itemRef.current
    if (!el) return

    if (!isLayerDraggable) {
      el.removeAttribute('draggable')
      return
    }

    el.setAttribute('draggable', 'true')

    const onDragStart = (e: DragEvent) => {
      if (!e.dataTransfer) return
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/x-entity-id', node.id)
      e.dataTransfer.setData('text/x-entity-name', node.name)
      e.dataTransfer.setDragImage(el, 20, 20)
    }
    const onDragEnd = () => {
      delete document.documentElement.dataset.hoveredNode
    }

    el.addEventListener('dragstart', onDragStart)
    el.addEventListener('dragend', onDragEnd)
    return () => {
      el.removeEventListener('dragstart', onDragStart)
      el.removeEventListener('dragend', onDragEnd)
    }
  }, [node.id, node.name, isLayerDraggable])

  return (
    <div
      ref={itemRef}
      id={`layer-node-${node.id}`}
      data-canvas-interactive
      data-trace-focus={isFocusNode ? 'true' : 'false'}
      className={cn(
        "flex items-center gap-2 mx-1 rounded-xl cursor-pointer transition-all duration-200 group/item relative z-[2]",
        paddingClass,
        // Subtle backdrop-blur on the card body — visually invisible
        // (matches the glassy translucent design) but blurs anything
        // painted behind so cross-column edges don't read as solid lines
        // bleeding through the node. Same technique the layer header uses
        // (`backdrop-blur-xl` at LayerColumn.tsx:508). The bg tint is kept
        // near-zero so the airy feel of the original cards is preserved;
        // hover / selected gradients below paint over this without conflict.
        "bg-canvas-elevated/10 backdrop-blur-sm",
        // Base hover state with gradient
        "hover:bg-gradient-to-r hover:from-white/[0.06] hover:to-transparent",
        // Selected state with accent glow
        isSelected && "bg-gradient-to-r from-accent-lineage/15 via-accent-lineage/10 to-transparent shadow-[inset_0_0_0_1px_rgba(var(--accent-lineage-rgb),0.3)]",
        // Search result highlight — direct match (advanced search or quick search)
        isSearchResult && !isSelected && cn(
            "bg-gradient-to-r from-amber-500/15 to-transparent",
            "shadow-[inset_0_0_0_1px_rgba(245,158,11,0.4),0_0_18px_-2px_rgba(245,158,11,0.45)]",
            "search-match-pulse",
        ),
        // Ancestor of a search match — softer amber treatment so the
        // user can scan the canvas top-down and see at a glance which
        // branches contain hits, without the row competing with direct
        // matches for attention. Applies whether the row is collapsed
        // (with a ✦N badge) or expanded (descendants then carry their
        // own stronger highlight). Suppressed when the row is itself a
        // direct match, selected, or part of a trace focus path.
        ancestorMatchCount > 0 && !isSearchResult && !isSelected && !isFocusNode && cn(
            "bg-gradient-to-r from-amber-500/[0.06] to-transparent",
            "shadow-[inset_0_0_0_1px_rgba(245,158,11,0.18)]",
        ),
        // Focus node (trace target)
        isFocusNode && "ring-2 ring-accent-lineage/60 ring-offset-1 ring-offset-canvas shadow-lg shadow-accent-lineage/20",
        // Highlighted in trace
        isHighlighted && !isFocusNode && "bg-gradient-to-r from-accent-lineage/10 to-transparent",
        // Click-highlight: subtle glow on connected nodes
        isClickHighlighted && !isSelected && "ring-1 ring-blue-400/40 bg-gradient-to-r from-blue-500/10 to-transparent",
        // Hover-highlight: lighter ephemeral glow on connected nodes
        isHoverHighlighted && !isSelected && !isClickHighlighted && "bg-gradient-to-r from-blue-500/[0.05] to-transparent ring-1 ring-blue-400/15 dark:from-blue-400/[0.06] dark:ring-blue-400/12",
        // Keyboard focus ring (4.5)
        isFocused && !isSelected && "ring-2 ring-accent-lineage/40 bg-gradient-to-r from-accent-lineage/[0.06] to-transparent",
        // Staged-change row treatment — full-row color tint per change type
        stagedRowClass,
        // Dimmed when not in trace path or not connected to highlighted node
        isDimmed && "opacity-40",
        // Connect-drag: legal target gets a green ring, illegal target dims.
        isConnectValidTarget && "ring-2 ring-success/70 ring-offset-1 ring-offset-canvas",
        isConnectInvalidTarget && "opacity-30",
        // Jump-to-node arrival pulse — one-shot ring animation
        isPulsing && "lineage-pulse"
      )}
      style={{
        paddingLeft: 12 + indentWidth,
        minHeight: minRowHeightPx,
        // Subtle left border accent for root items
        ...(depth === 0 && {
          borderLeft: `3px solid ${nodeColor}40`,
        }),
      }}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(node.id)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onDoubleClick(node.id, e)
      }}
      onContextMenu={(e) => onContextMenu(e, node.id)}
      onMouseEnter={() => {
        setIsHovered(true)
        document.documentElement.dataset.hoveredNode = node.id
      }}
      onMouseLeave={() => {
        setIsHovered(false)
        delete document.documentElement.dataset.hoveredNode
      }}
    >
      {/* Edge authoring: hover-reveal handle on the card's right edge. */}
      {onBeginConnect && (
        <NodeConnectionHandle
          visible={isHovered}
          onBeginConnect={(start) => onBeginConnect(node.id, start)}
        />
      )}

      {/* Modern Tree Lines with gradient effect.
          Subtle mode dims connectors + dot for a calmer look without
          removing them — orientation cues survive at lower contrast. */}
      <div className="flex items-center absolute left-3" style={{ width: indentWidth }}>
        {parentIsLast.map((pIsLast, idx) => (
          <div key={idx} className="w-5 h-full flex justify-center">
            {!pIsLast && (
              <div className={cn(
                "w-px h-full bg-gradient-to-b from-white/[0.08] via-white/[0.12] to-white/[0.08]",
                subtleTreeLines && "opacity-40"
              )} />
            )}
          </div>
        ))}
        {depth > 0 && (
          <div className={cn("w-5 h-full relative", subtleTreeLines && "opacity-50")}>
            {/* Vertical line with gradient */}
            <div className={cn(
              "absolute left-1/2 -translate-x-1/2 w-px",
              isLast ? "top-0 h-1/2" : "top-0 bottom-0"
            )} style={{ background: 'linear-gradient(to bottom, transparent, rgba(255,255,255,0.12), transparent)' }} />
            {/* Horizontal connector with dot */}
            <div className="absolute left-1/2 top-1/2 -translate-y-1/2 flex items-center">
              <div className="w-3 h-px bg-gradient-to-r from-white/[0.12] to-white/[0.06]" />
              <div
                className="w-1.5 h-1.5 rounded-full -ml-0.5"
                style={{ backgroundColor: `${nodeColor}40` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Expand/Collapse Toggle - Modern circular button with loading state */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onToggle(node.id)
        }}
        className={cn(
          "flex-shrink-0 rounded-lg transition-all duration-200",
          hasChildren
            ? "hover:bg-white/[0.1] hover:scale-110 active:scale-95"
            : "opacity-0 pointer-events-none",
          isRoot ? "w-7 h-7" : "w-6 h-6"
        )}
      >
        {hasChildren && (
          <AnimatePresence mode="wait">
            {isLoading ? (
              <motion.div
                key="spinner"
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.5 }}
                transition={{ duration: 0.15 }}
                className="w-full h-full flex items-center justify-center"
              >
                <LucideIcons.Loader2
                  className={cn(
                    "animate-spin",
                    isRoot ? "w-4 h-4" : "w-3.5 h-3.5"
                  )}
                  style={{ color: nodeColor }}
                />
              </motion.div>
            ) : (
              <motion.div
                key="chevron"
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1, rotate: isExpanded ? 90 : 0 }}
                exit={{ opacity: 0, scale: 0.5 }}
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                className="w-full h-full flex items-center justify-center"
              >
                <LucideIcons.ChevronRight
                  className={cn(
                    "transition-colors",
                    isHovered ? "text-ink" : "text-ink-muted/60",
                    isRoot ? "w-4 h-4" : "w-4 h-4"
                  )}
                />
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </button>

      {/* Entity Icon - Glass morphism container */}
      <div
        className={cn(
          "rounded-xl flex items-center justify-center flex-shrink-0 transition-all duration-200 shadow-sm relative",
          iconContainerSize,
          isSelected && "scale-110 shadow-md",
          isHovered && "scale-105"
        )}
        style={{
          background: `linear-gradient(135deg, ${nodeColor}25 0%, ${nodeColor}10 100%)`,
          boxShadow: isSelected ? `0 4px 12px ${nodeColor}30` : `0 2px 4px ${nodeColor}15`,
          ...(isLogical && { border: `1px dashed ${nodeColor}50` }),
        }}
      >
        <DynamicIcon
          name={logicalIcon ?? visual?.icon ?? 'Box'}
          className={cn(iconSize, "transition-transform duration-200")}
          style={{ color: nodeColor }}
        />
      </div>

      {/* Name + type — the text region IS the row's primary payload.
          ``min-w-0`` keeps the flex child from forcing the row to
          expand to fit a long word; ``break-words`` lets only
          genuinely-unbreakable identifiers wrap mid-character (the
          earlier ``break-all`` was too eager — it broke normal
          names like ``INTERMEDIATE_T1`` into ``IN``/``T..``).
          ``line-clamp-2`` caps height so the virtualizer's row
          estimate stays accurate. The action overlay uses a
          backdrop-blur gradient so text behind it stays legible
          without us having to re-flow the layout on hover (the
          previous ``pr-[120px]`` reflow shrank the text to
          unreadable widths). */}
      <div
        className="flex-1 min-w-0 flex flex-col justify-center"
        title={stagedSummary ?? node.name}
      >
        <span className={cn(
          "font-medium tracking-tight transition-colors duration-200",
          textClass,
          isHighlighted ? "text-accent-lineage" : isSelected ? "text-ink" : "text-ink/90",
          isHovered && !isSelected && "text-ink",
          // Strikethrough for pending-delete makes the destruction intent unmissable
          stagedColor === 'red' && "line-through decoration-rose-300/80 decoration-2",
          // 3-line cap + word-wrap. ``break-words`` triggers only
          // when a word genuinely cannot fit, so normal labels
          // stay on a single line. The 3-line ceiling handles
          // extra-long snake_case identifiers (e.g. the user's
          // ``INTERMEDIATE_T1a sfdasdfasdfasdfafaf`` test case)
          // without losing the tail to ellipsis. The virtualizer
          // re-measures rows dynamically so taller rows reflow
          // their successors without scroll-jump.
          "line-clamp-3 break-words"
        )}>
          {isEditing ? (
            <input
              data-canvas-interactive
              autoFocus
              defaultValue={node.name}
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') { e.preventDefault(); onRenameCommit?.(node.id, e.currentTarget.value) }
                else if (e.key === 'Escape') { e.preventDefault(); onRenameCancel?.() }
              }}
              onBlur={(e) => onRenameCommit?.(node.id, e.currentTarget.value)}
              className="w-full bg-canvas border border-accent-primary/60 rounded px-1 py-0.5 text-sm text-ink outline-none focus:ring-1 focus:ring-accent-primary/50"
            />
          ) : (
            node.name
          )}
        </span>
        {/* Type badge — gated by usePreferencesStore.showCanvasTypeBadge so
            users can reclaim vertical space in dense canvases. */}
        {showTypeBadge && (
          <span className={cn(
            "text-[10px] text-ink-muted/60 truncate mt-0.5 flex items-center gap-1",
            isRoot && "text-[11px]"
          )}>
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: nodeColor }}
            />
            {isLogical ? `${node.typeId.charAt(0).toUpperCase()}${node.typeId.slice(1)} (group)` : (entityType?.name ?? node.typeId)}
          </span>
        )}
        {/* Display-rule tags — shared chip cluster (premium chips +
            overflow popover) so all canvases render identically. */}
        <DisplayRuleTagChips urn={node.urn ?? node.id} size="xs" className="mt-1" />
      </div>

      {/* Right-side metadata cluster — descendant count + search
          badge. NO reserved slot: both items only occupy space when
          they have something to show, so a short name like ``Sales``
          on a dataset with no matches gets the entire row width.

          The cluster STAYS VISIBLE on hover so the user can scan
          + hover the SearchMatchBadge to open its premium
          breakdown tooltip — that hover affordance is the whole
          reason the badge exists. Only the ``+N`` descendant pill
          fades, because it overlaps the action overlay's slot.
          The action overlay positions itself with
          ``right-[3.125rem]`` when a badge is present so it lands
          to the LEFT of the badge, never on top of it. */}
      <div className="flex items-center gap-1.5 flex-shrink-0 relative z-[5]">
        {descendantCount > 0 && (
          <span className={cn(
            "text-[11px] px-2 py-1 rounded-lg flex-shrink-0",
            "bg-white/[0.06] border border-white/[0.08]",
            "text-ink-muted font-semibold tabular-nums",
            "transition-opacity duration-150",
            isHovered && "opacity-0 pointer-events-none",
          )}>
            +{descendantCount}
          </span>
        )}

        {/* Search-match badge — shows even when the row itself is a
            direct match. A search for "account" against a dataset
            called ``account_details`` whose columns are
            ``account_number`` etc. needs to tell the user that
            expanding surfaces more matches; suppressing the badge on
            direct-match rows hid that signal. (GraphCanvas +
            HierarchyCanvas already render it unconditionally — this
            keeps ContextView aligned.) */}
        {ancestorMatchCount > 0 && !isExpanded && hasChildren && (
          <SearchMatchBadge
            count={ancestorMatchCount}
            breakdown={ancestorMatchBreakdown}
            schema={schema}
          />
        )}
      </div>

      {/* Action buttons — absolute overlay anchored to the row's
          right edge. Right offset is DYNAMIC so the overlay never
          covers the SearchMatchBadge:
            - When a badge is present, sit at ``right-[3.125rem]``
              (50px) so the badge column stays interactive (the
              user can still hover the badge for the breakdown
              tooltip).
            - When no badge, sit at ``right-2`` (8px) so the
              overlay uses the row's full trailing edge.

          Backdrop strategy — when text wraps to 2 lines the row
          height grows, so the overlay now sits on top of the
          SECOND line of text too. The previous
          ``from-X via-X/92 to-transparent`` gradient kept the
          leftmost ~50% of the overlay transparent, which exposed
          the wrapped text behind the buttons (buttons read as
          "invisible" because their semi-transparent bgs mixed with
          the text below). The fix:
            1. Push the solid-to-transparent fade into the
               leftmost ~25% only (``via-75%``) so the entire button
               column sits on a fully opaque canvas-elevated bg.
            2. Bump blur from ``backdrop-blur-md`` to
               ``backdrop-blur-xl`` so even the fade zone obscures
               any text it overlaps. */}
      <motion.div
        initial={false}
        animate={{ opacity: isHovered ? 1 : 0, x: isHovered ? 0 : 8 }}
        transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
        className={cn(
          "absolute inset-y-0 flex items-center gap-1 pl-8 pr-1 rounded-l-xl z-[4]",
          (ancestorMatchCount > 0 && !isExpanded && hasChildren)
            ? "right-[3.125rem]"
            : "right-2",
          isHovered && cn(
            "backdrop-blur-xl",
            "bg-gradient-to-l from-canvas-elevated via-canvas-elevated via-75% to-transparent",
            "dark:from-canvas-elevated dark:via-canvas-elevated dark:to-transparent",
          ),
          !isHovered && "pointer-events-none"
        )}
      >
        {/* Focus/Drill button */}
        {hasChildren && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onFocus(node)
            }}
            className="flex items-center justify-center p-1.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 hover:text-blue-300 transition-all duration-200 hover:scale-110 active:scale-95 leading-none"
            title="Focus on this subtree"
          >
            <LucideIcons.Maximize2 className="w-3 h-3 block" />
          </button>
        )}

        {/* Search children button */}
        {hasChildren && onToggleSearch && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggleSearch(node.id)
            }}
            className={cn(
              "flex items-center justify-center p-1.5 rounded-lg transition-all duration-200 hover:scale-110 active:scale-95 leading-none",
              isSearchVisible
                ? "bg-amber-500/20 text-amber-400"
                : "bg-white/[0.06] hover:bg-white/[0.12] text-ink-muted/80 hover:text-ink-muted"
            )}
            title="Search children"
          >
            <LucideIcons.Search className="w-3 h-3 block" />
          </button>
        )}

        {/* Add child button */}
        {entityType?.hierarchy?.canContain && entityType.hierarchy.canContain.length > 0 && onAddChild && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onAddChild(node.id)
            }}
            className="flex items-center justify-center p-1.5 rounded-lg bg-green-500/10 hover:bg-green-500/20 text-green-400 hover:text-green-300 transition-all duration-200 hover:scale-110 active:scale-95 leading-none"
            title="Add child entity"
          >
            <LucideIcons.Plus className="w-3 h-3 block" />
          </button>
        )}
      </motion.div>

      {/* Hover indicator line */}
      <motion.div
        className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full"
        style={{ backgroundColor: nodeColor }}
        initial={false}
        animate={{
          height: isSelected ? '70%' : isHovered ? '50%' : '0%',
          opacity: isSelected ? 1 : isHovered ? 0.6 : 0
        }}
        transition={{ duration: 0.2 }}
      />
    </div>
  )
})


// `formatBreakdown` + `pluralize` moved into ./SearchMatchBadge.tsx
// alongside the tooltip rendering that consumes them.
