/**
 * FocusGraphView — the Lens's interactive Graph mode renderer.
 *
 * A self-contained React Flow instance (own provider — never shares
 * viewport state with GraphCanvas) that renders the pure focus-graph
 * build as rich entity cards in hop bands. All semantics live in
 * focus-graph.ts; this file is presentation and gestures only:
 *   single click  = select (detail strip)     double click = focus
 *   group header  = expand/collapse           pane click   = deselect
 *   hover a card  = light up its connections
 *   drag a card   = rearrange it; a frame carries its children
 *   ⊕ pill        = open this card — a coarse container reveals what
 *                   is inside it that connects to the focal; anything
 *                   else reveals its own next hop
 *
 * Positions come pre-baked from the builder, so React Flow does no
 * layout of its own — card ids are stable across rebuilds and a CSS
 * transform transition (killed under .reduce-motion) makes shared
 * cards glide when the focal changes. Anything the user drags is held
 * in a per-focal overlay ON TOP of that layout, so an arriving fetch
 * grows the picture without discarding the arrangement; "Tidy up" in
 * the corner controls drops the overlay. Frame children ride along as
 * React Flow child nodes (parentId), which is what makes a frame move
 * as one piece and its edges re-route themselves.
 *
 * PERF CONTRACT — the graph must stay snappy while browsing, so no
 * frequent interaction may rebuild the node or edge arrays:
 *   • hover   → HoverContext; the edges array keeps its identity and
 *               only the SVG paths re-render.
 *   • impact  → ImpactContext; a resolving measurement re-renders the
 *               focal card alone, not all N nodes.
 *   • select  → React Flow's own `selected` flag, node identity kept
 *               for every unaffected card.
 *   • rebuild → cards memo on card CONTENT, not on the freshly-built
 *               object's identity, so an arriving fetch re-renders only
 *               the cards that actually changed.
 *   • visuals → resolved once per schema, O(1) per card, no per-card
 *               store subscription.
 *   • drag    → React Flow moves the card during the gesture; only the
 *               FINAL position is committed, so a drag costs one state
 *               update rather than one per animation frame.
 * The viewport re-frames on FOCAL change only: expanding grows the
 * picture in place instead of yanking it away from what you opened.
 */
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Panel,
  Position,
  getBezierPath,
  getNodesBounds,
  getViewportForBounds,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type XYPosition,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import * as LucideIcons from 'lucide-react'
import { IMPACT_DEPTH, type LensImpact } from '@/hooks/useLensImpact'
import { useSchemaStore } from '@/store/schema'
import { getEntityVisual } from '@/hooks/useEntityVisual'
import { generateEdgeColorFromType } from '@/lib/type-visuals'
import { cn } from '@/lib/utils'
import { CARD_W, BAND_GAP, FRAME_FOOTER_H, framePager, edgeLabelFor, type EdgeTypeInfoMap, type FocusCard, type FocusGraph } from './focus-graph'

/** Direction tints — the house semantics: upstream = sky, downstream
 *  = amber (matches the list columns and the canvas). */
const TINT_UP = '#0ea5e9'
const TINT_DOWN = '#f59e0b'
const TINT_CONTAIN = '#94a3b8'

/**
 * Live interaction values delivered by CONTEXT rather than through node
 * data — the difference between a snappy graph and a sluggish one.
 *
 * Hover emphasis and the focal's impact line both change often and
 * matter to a tiny slice of the graph, but folding them into node/edge
 * data made every change rebuild the whole nodes or edges array, which
 * React Flow then reconciled element by element. Routed through
 * context, a hover re-renders only the edge paths, and an impact result
 * re-renders only the focal card. The arrays keep their identity.
 */
const HoverContext = createContext<string | null>(null)
const ImpactContext = createContext<{ impact?: LensImpact | null; loading?: boolean }>({})

/** Shared empty overlay — a fresh Map would churn the nodes memo. */
const EMPTY_POSITIONS: ReadonlyMap<string, XYPosition> = new Map()

interface CardCtx {
  edgeTypeInfo?: EdgeTypeInfoMap
  /** type id → {color, icon}, resolved ONCE for the whole graph. Cards
   *  used to each subscribe to the schema store and linear-scan the
   *  entity-type list, so every card paid for every schema touch. */
  visualFor: (typeId: string) => { color: string; Icon: LucideIcons.LucideIcon }
  onSelect: (nodeId: string | null) => void
  onFocus: (nodeId: string) => void
  onToggleGroup: (expandKey: string) => void
  /** Open / close a coarse container into the entities inside it that
   *  connect to `partnerId` — the card's own partner in the picture,
   *  which is the focal only at the first hop. */
  onOpenContainer: (openKey: string, nodeId: string, entityType: string, partnerId: string | null) => void
  onExpandFrontier: (expandKey: string, nodeId: string) => void
  /** Open / close a contains-stack row into what IT holds. Pure
   *  containment — no partner, no lineage question. */
  onToggleContains: (nodeId: string) => void
  /** Re-ask for a contains row's children after a failed fetch, without
   *  toggling the row shut. */
  onRetryContains: (nodeId: string) => void
  onShowMore: (bandKey: string) => void
  /** Move a frame's fixed page window to `page` (0-based), fetching the
   *  next server page when the window runs past what has loaded. */
  onSetFramePage: (openKey: string, page: number) => void
  onFrameQuery: (openKey: string, q: string) => void
  /** Current text typed into a frame's own filter. */
  frameQueryFor?: (openKey: string) => string
  /** Flip one frame between "only what connects" and "everything inside". */
  onToggleFrameAll?: (openKey: string) => void
  /** Re-kick a failed "everything inside" fetch. */
  onRetryFrameAll?: (openKey: string) => void
  onRetryOpen?: (openKey: string, nodeId: string, entityType: string, partnerId: string | null) => void
  onRetryFetch?: (nodeId: string) => void
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  onOpenDetails?: (nodeId: string) => void
}

interface FocusGraphViewProps {
  graph: FocusGraph
  focalId: string
  /** Focal in/out tallies (record counts — groups don't hide them). */
  focalStats: { in: number; out: number }
  /** Focal fetch state — drives the empty-direction whispers. */
  focalFetch?: 'loading' | 'done' | 'error'
  /** Transitive reach of the focal (useLensImpact); null = unknown. */
  focalImpact?: LensImpact | null
  focalImpactLoading?: boolean
  /** Filename stem for the PNG export. */
  exportName?: string
  selectedId: string | null
  reducedMotion: boolean
  edgeTypeInfo?: EdgeTypeInfoMap
  onSelect: (nodeId: string | null) => void
  onFocus: (nodeId: string) => void
  onToggleGroup: (expandKey: string) => void
  onOpenContainer: (openKey: string, nodeId: string, entityType: string, partnerId: string | null) => void
  onExpandFrontier: (expandKey: string, nodeId: string) => void
  onToggleContains: (nodeId: string) => void
  onRetryContains: (nodeId: string) => void
  onShowMore: (bandKey: string) => void
  onSetFramePage: (openKey: string, page: number) => void
  onFrameQuery: (openKey: string, q: string) => void
  frameQueryFor?: (openKey: string) => string
  onToggleFrameAll?: (openKey: string) => void
  onRetryFrameAll?: (openKey: string) => void
  onRetryOpen?: (openKey: string, nodeId: string, entityType: string, partnerId: string | null) => void
  onRetryFetch?: (nodeId: string) => void
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  onOpenDetails?: (nodeId: string) => void
}

const iconByName = (name: string): LucideIcons.LucideIcon =>
  (LucideIcons as unknown as Record<string, LucideIcons.LucideIcon>)[name] ?? LucideIcons.Box

/** Flat equality over a built card. Every field is a primitive or a
 *  frozen string array, so this is exact and cheap enough to run per
 *  card per rebuild. */
function sameCard(a: FocusCard, b: FocusCard): boolean {
  if (a === b) return true
  const keys = Object.keys(a) as Array<keyof FocusCard>
  if (keys.length !== Object.keys(b).length) return false
  for (const k of keys) {
    if (k === 'frameBreadcrumb' || k === 'previewLabels' || k === 'partnerIds') {
      const x = a[k], y = b[k]
      if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false
      continue
    }
    if (a[k] !== b[k]) return false
  }
  return true
}

// ── Card node ────────────────────────────────────────────────────────

function TypeIcon({ ctx, typeId, color, className }: { ctx: CardCtx; typeId: string; color: string; className?: string }) {
  const Icon = ctx.visualFor(typeId).Icon
  return <Icon className={className} style={{ color }} />
}

/** The tiny colored connection dots edges anchor to: incoming on the
 *  left (sky), outgoing on the right (amber). */
function PortHandles({ focal }: { focal?: boolean }) {
  const dot = '!w-1.5 !h-1.5 !border-0 !min-w-0 !min-h-0 rounded-full'
  return (
    <>
      <Handle type="target" position={Position.Left} className={dot} style={{ backgroundColor: `${TINT_UP}99` }} />
      <Handle type="source" position={Position.Right} className={dot} style={{ backgroundColor: `${TINT_DOWN}99` }} />
      {focal && (
        <Handle
          type="source"
          id="contains"
          position={Position.Bottom}
          className={dot}
          style={{ backgroundColor: `${TINT_CONTAIN}99` }}
        />
      )}
    </>
  )
}

/** Hover action cluster shared by entity-ish cards. */
function CardActions({ card, ctx }: { card: FocusCard; ctx: CardCtx }) {
  if (!card.nodeId) return null
  const id = card.nodeId
  const btn = 'w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.05] dark:hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'
  return (
    <span className="nodrag absolute -top-2.5 right-1.5 hidden group-hover:flex items-center gap-0.5 rounded-md bg-canvas-elevated border border-black/10 dark:border-white/10 shadow-sm px-0.5 py-0.5 z-10">
      <button
        type="button"
        title="Focus here — re-center the lens on this entity"
        onClick={(e) => { e.stopPropagation(); ctx.onFocus(id) }}
        className={btn}
      >
        <LucideIcons.Focus className="w-3 h-3" />
      </button>
      {ctx.onRevealOnCanvas && (
        <button
          type="button"
          title="Reveal on canvas"
          onClick={(e) => { e.stopPropagation(); void ctx.onRevealOnCanvas?.(id) }}
          className={btn}
        >
          <LucideIcons.Crosshair className="w-3 h-3" />
        </button>
      )}
      {ctx.onOpenDetails && (
        <button
          type="button"
          title="Open details"
          onClick={(e) => { e.stopPropagation(); ctx.onOpenDetails?.(id) }}
          className={btn}
        >
          <LucideIcons.PanelRight className="w-3 h-3" />
        </button>
      )}
    </span>
  )
}

/** "What's inside this?" — the containment gesture, on the card body.
 *
 *  Deliberately a different control in a different place from the
 *  FrontierPill, which answers the other question ("what connects to
 *  this next?"). They used to share one ⊕ whose meaning flipped with
 *  the card's grain, so an ordinary neighbour's columns were simply
 *  unreachable. A card may now offer both, and each means one thing.
 *
 *  Offered from the ontology — whether the TYPE can contain anything —
 *  not from `childCount`, which most read paths strip. An open that
 *  comes back empty says so; a hidden control cannot. */
function ContentsChevron({ card, ctx }: { card: FocusCard; ctx: CardCtx }) {
  if (!card.canOpenChildren || !card.nodeId || !card.expandKey) return null
  // `kids:` is pure containment (the focal's own stack, at any depth);
  // everything else asks what inside it connects to a partner.
  const pureContainment = card.expandKey.startsWith('kids:')
  const Icon = card.fetch === 'loading' ? LucideIcons.Loader2
    : card.childrenOpen ? LucideIcons.ChevronDown : LucideIcons.ChevronRight
  return (
    <button
      type="button"
      className="nodrag flex-shrink-0 -ml-1 w-4 h-full flex items-center justify-center text-ink-muted/50 hover:text-accent-lineage focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 rounded"
      title={card.childrenOpen
        ? `Hide what's inside ${card.label}`
        : `Show what's inside ${card.label}`}
      onClick={(e) => {
        e.stopPropagation()
        if (pureContainment) ctx.onToggleContains(card.nodeId!)
        else ctx.onOpenContainer(card.expandKey!, card.nodeId!, card.type, card.partnerIds[0] ?? null)
      }}
    >
      <Icon className={cn('w-3 h-3', card.fetch === 'loading' && 'animate-spin')} />
    </button>
  )
}

/** The one expand pill on a card's outward side. What it opens depends
 *  on the card: a rolled-up connection resolves into the constituent
 *  entities that actually carry lineage to the focal ('drill'), while a
 *  plain entity fetches its own next hop ('hop'). Never invents a
 *  number — the count renders only when the backend reported a real
 *  degree — and a completed-empty hop becomes an end-of-lineage mark. */
function FrontierPill({ card, ctx }: { card: FocusCard; ctx: CardCtx }) {
  if (!card.nodeId || !card.expandKey || (!card.frontier && !card.frontierExpanded)) return null
  const outLeft = card.band < 0
  const hint = card.degreeHint ? (outLeft ? card.degreeHint.in : card.degreeHint.out) : null
  const pos = outLeft ? 'right-full mr-1.5' : 'left-full ml-1.5'
  if (card.fetch === 'loading') {
    return (
      <span className={cn('absolute top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-canvas-elevated border border-accent-lineage/40', pos)}>
        <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-accent-lineage" aria-label="Fetching lineage from the data source" />
      </span>
    )
  }
  if (card.fetch === 'error') {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); ctx.onRetryFetch?.(card.nodeId!) }}
        title="Couldn't fetch this entity's lineage — click to retry"
        className={cn('absolute top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-canvas-elevated border border-amber-500/60 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10', pos)}
      >
        <LucideIcons.AlertTriangle className="w-3 h-3" />
      </button>
    )
  }
  if (card.deadEnd) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); ctx.onExpandFrontier(card.expandKey!, card.nodeId!) }}
        title={`No further ${outLeft ? 'upstream' : 'downstream'} lineage in the data source — the walk ends here (click to collapse)`}
        className={cn('absolute top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-canvas-elevated border border-black/10 dark:border-white/15 text-ink-muted/50 hover:text-ink-muted', pos)}
      >
        <LucideIcons.CircleSlash className="w-3 h-3" />
      </button>
    )
  }
  const expanded = card.frontierExpanded
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); ctx.onExpandFrontier(card.expandKey!, card.nodeId!) }}
      title={expanded
        ? `Collapse ${outLeft ? 'upstream of' : 'downstream of'} ${card.label}`
        : `Expand the next hop ${outLeft ? 'upstream' : 'downstream'} of ${card.label}${hint != null ? ` (${hint.toLocaleString()} known)` : ''}`}
      className={cn(
        'absolute top-1/2 -translate-y-1/2 flex items-center justify-center gap-0.5 h-5 rounded-full border text-[9.5px] font-semibold tabular-nums transition-colors',
        hint != null && !expanded ? 'px-1.5' : 'w-5',
        expanded
          ? 'bg-accent-lineage/15 border-accent-lineage/50 text-accent-lineage hover:bg-accent-lineage/25'
          : 'bg-canvas-elevated border-black/15 dark:border-white/20 text-ink-muted hover:text-accent-lineage hover:border-accent-lineage/50',
        pos,
      )}
    >
      {(() => {
        if (expanded) return <LucideIcons.Minus className="w-3 h-3" />
        // A hop only knows a degree when the backend reported one.
        if (hint == null) return <LucideIcons.Plus className="w-3 h-3" />
        return <>{outLeft && <LucideIcons.Plus className="w-2.5 h-2.5" />}{hint.toLocaleString()}{!outLeft && <LucideIcons.Plus className="w-2.5 h-2.5" />}</>
      })()}
    </button>
  )
}

function FocusGraphCard({ data, selected }: NodeProps) {
  const { card, ctx, focalStats } = data as unknown as {
    card: FocusCard
    ctx: CardCtx
    focalStats?: { in: number; out: number }
  }
  // Impact arrives via context so a resolving measurement re-renders
  // ONLY this card — it used to invalidate every node in the graph.
  const { impact: focalImpact, loading: focalImpactLoading } = useContext(ImpactContext)
  const accent = card.type === 'not loaded' ? '#94a3b8' : ctx.visualFor(card.type).color

  const activate = () => {
    if (card.kind === 'overflow') {
      // A 'focus' overflow is the door at the end of the contains stack:
      // it re-centers rather than paging a column that cannot page.
      if (card.expandKind === 'focus' && card.parentId) ctx.onFocus(card.parentId)
      else if (card.expandKind === 'retry' && card.parentId) ctx.onRetryContains(card.parentId)
      else if (card.expandKey) ctx.onShowMore(card.expandKey)
      return
    }
    if (card.kind === 'group') { if (card.expandKey) ctx.onToggleGroup(card.expandKey); return }
    ctx.onSelect(card.nodeId)
  }
  const keyActivate = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); activate() }
  }

  // ── Overflow: the honest "+N more" card ──
  if (card.kind === 'overflow') {
    const toFocus = card.expandKind === 'focus'
    const toRetry = card.expandKind === 'retry'
    // A card with nothing to do is a STATEMENT, not a button — an
    // "Nothing inside X" row that looked clickable and did nothing was
    // the thing this whole pass is removing.
    const inert = !toFocus && !toRetry && !card.expandKey
    const Icon = toFocus ? LucideIcons.Focus
      : toRetry ? LucideIcons.RotateCw
      : LucideIcons.ChevronDown
    if (inert) {
      return (
        <p
          style={{ width: card.w, height: card.h }}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-ink-muted/25 text-[11px] italic text-ink-muted/70"
        >
          {card.label}
        </p>
      )
    }
    return (
      <button
        type="button"
        onClick={activate}
        title={toFocus
          ? `Focus ${card.label.replace(/ — focus it$/, '')} — its contents become the top level`
          : toRetry
            ? 'Ask the data source again'
            : `Show more (${card.overflowCount.toLocaleString()} not shown)`}
        style={{ width: card.w, height: card.h }}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-ink-muted/35 text-[11px] font-medium text-ink-muted hover:text-ink hover:border-ink-muted/60 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
      >
        <Icon className="w-3.5 h-3.5" />
        {card.label}
      </button>
    )
  }

  // ── Focal: the anchor card — bigger, gradient, in/out tally ──
  if (card.kind === 'focal') {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={activate}
        onKeyDown={keyActivate}
        style={{
          width: card.w,
          height: card.h,
          borderColor: accent,
          background: `linear-gradient(150deg, ${accent}24, ${accent}08 60%)`,
          boxShadow: selected ? `0 10px 34px ${accent}55` : `0 10px 34px ${accent}33`,
        }}
        className={cn(
          'group relative rounded-xl border-2 px-3.5 py-2.5 bg-canvas-elevated cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
          selected && 'ring-2 ring-accent-lineage ring-offset-1 ring-offset-canvas-elevated',
          card.dimmed && 'opacity-30',
        )}
      >
        <PortHandles focal />
        <div className="flex items-center gap-1.5">
          <TypeIcon ctx={ctx} typeId={card.type} color={accent} className="w-3.5 h-3.5" />
          <p className="text-[9.5px] font-bold uppercase tracking-[0.12em] truncate" style={{ color: accent }}>
            {card.type}
          </p>
          {card.fetch === 'loading' && (
            <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-accent-lineage/70" aria-label="Fetching lineage from the data source" />
          )}
        </div>
        <p
          className="text-[13.5px] font-semibold text-ink truncate leading-snug"
          title={`${card.label}${card.description ? ` — ${card.description}` : ''}`}
        >
          {card.label}
        </p>
        {card.parentId && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); ctx.onFocus(card.parentId!) }}
            title={`Focus ${card.parentLabel}`}
            className="flex items-center gap-1 max-w-full text-[9.5px] text-ink-muted hover:text-accent-lineage transition-colors"
          >
            <LucideIcons.CornerLeftUp className="w-2.5 h-2.5 flex-shrink-0" />
            <span className="truncate">in {card.parentLabel}</span>
          </button>
        )}
        {focalStats && (
          <div className="flex items-center gap-2.5 mt-1 pt-1 border-t border-black/[0.07] dark:border-white/[0.08] text-[10.5px] font-medium tabular-nums">
            <span className="flex items-center gap-1 text-sky-600 dark:text-sky-400">
              <LucideIcons.ArrowDownLeft className="w-3 h-3" />
              {focalStats.in} in
            </span>
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <LucideIcons.ArrowUpRight className="w-3 h-3" />
              {focalStats.out} out
            </span>
          </div>
        )}
        {/* Transitive reach — the question Focus mode gets opened to
            answer. Truncated = floors ("47+"); unknown = nothing. */}
        {focalImpactLoading && (
          <p className="flex items-center gap-1 mt-0.5 text-[9px] text-ink-muted/70">
            <LucideIcons.Loader2 className="w-2.5 h-2.5 animate-spin text-accent-lineage/60" />
            Measuring reach…
          </p>
        )}
        {focalImpact && (
          <p
            className="flex items-center gap-1 mt-0.5 text-[9px] text-ink-muted tabular-nums truncate"
            title={`Distinct entities connected within ${IMPACT_DEPTH} hops, at this entity's level${focalImpact.truncated ? ' — measurement capped, true totals may be higher' : ''}`}
          >
            <LucideIcons.Radar className="w-2.5 h-2.5 flex-shrink-0 text-accent-lineage/70" />
            <span className="truncate">
              Reaches {focalImpact.up.toLocaleString()}{focalImpact.truncated ? '+' : ''} upstream
              {' · '}{focalImpact.down.toLocaleString()}{focalImpact.truncated ? '+' : ''} downstream
            </span>
          </p>
        )}
      </div>
    )
  }

  // ── Group: collapsed rollup card / expanded slim header ──
  if (card.kind === 'group') {
    if (card.expanded) {
      return (
        <div
          style={{ width: card.w, height: card.h }}
          className={cn(
            'group relative flex items-center gap-1.5 rounded-lg px-2 bg-black/[0.03] dark:bg-white/[0.04] border border-black/[0.07] dark:border-white/[0.08]',
            card.dimmed && 'opacity-30',
          )}
        >
          <PortHandles />
          <button
            type="button"
            onClick={activate}
            title="Collapse group"
            className="flex-1 min-w-0 flex items-center gap-1.5 text-left focus-visible:outline-none"
          >
            <LucideIcons.ChevronDown className="w-3.5 h-3.5 flex-shrink-0 text-ink-muted" />
            <LucideIcons.FolderTree className="w-3 h-3 flex-shrink-0 text-ink-muted/70" />
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: accent }} />
            <span className="min-w-0 truncate text-[11px] font-semibold text-ink">{card.label}</span>
            <span className="flex-shrink-0 text-[9.5px] tabular-nums text-ink-muted">{card.count}</span>
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (card.nodeId) ctx.onFocus(card.nodeId) }}
            title={`Focus ${card.label}`}
            className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            <LucideIcons.Focus className="w-3 h-3" />
          </button>
        </div>
      )
    }
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={activate}
        onKeyDown={keyActivate}
        onDoubleClick={(e) => { e.stopPropagation(); if (card.nodeId) ctx.onFocus(card.nodeId) }}
        title={`${card.label} — ${card.count} connected entities · click to expand`}
        style={{ width: card.w, height: card.h, borderLeftWidth: 3, borderLeftColor: accent }}
        className={cn(
          'group relative flex items-center gap-2 rounded-lg border border-black/[0.07] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] px-2.5 cursor-pointer transition-colors hover:border-accent-lineage/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
          card.dimmed && 'opacity-30',
        )}
      >
        <PortHandles />
        <div
          className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${accent}1f` }}
        >
          <LucideIcons.FolderTree className="w-3.5 h-3.5" style={{ color: accent }} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink leading-snug">
            <span className="truncate">{card.label}</span>
          </p>
          <p className="flex items-center gap-1.5 text-[9.5px] text-ink-muted/80 leading-snug">
            <span className="px-1 rounded bg-black/[0.05] dark:bg-white/[0.07] font-semibold tabular-nums">
              {card.count} connected
            </span>
            {card.sumCount > card.count && (
              <span className="tabular-nums">×{card.sumCount.toLocaleString()}</span>
            )}
            {card.matchesInside > 0 && (
              <span className="px-1 rounded bg-accent-lineage/15 text-accent-lineage font-semibold tabular-nums">
                {card.matchesInside} match{card.matchesInside === 1 ? '' : 'es'}
              </span>
            )}
          </p>
          {card.previewLabels.length > 0 && (
            <p className="truncate text-[9px] text-ink-muted/60 leading-snug" title={card.previewLabels.join(', ')}>
              {card.previewLabels.join(', ')}
              {card.count > card.previewLabels.length && ` +${card.count - card.previewLabels.length}`}
            </p>
          )}
        </div>
        <LucideIcons.ChevronRight className="w-3.5 h-3.5 flex-shrink-0 text-ink-muted/40 group-hover:hidden" />
        <span className="hidden group-hover:flex flex-shrink-0 items-center">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (card.nodeId) ctx.onFocus(card.nodeId) }}
            title={`Focus ${card.label}`}
            className="w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            <LucideIcons.Focus className="w-3 h-3" />
          </button>
        </span>
      </div>
    )
  }

  // ── Contains: compact child row under the focal ──
  if (card.kind === 'contains') {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={activate}
        onKeyDown={keyActivate}
        onDoubleClick={(e) => { e.stopPropagation(); if (card.nodeId) ctx.onFocus(card.nodeId) }}
        title={`${card.label}${card.description ? ` — ${card.description}` : ''} — contained by the focal entity · double-click to focus`}
        style={{ width: card.w, height: card.h }}
        className={cn(
          'group relative flex items-center gap-1.5 rounded-lg border border-black/[0.06] dark:border-white/[0.07] bg-black/[0.015] dark:bg-white/[0.02] px-2.5 cursor-pointer transition-colors hover:border-accent-lineage/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
          selected && 'ring-2 ring-accent-lineage',
          card.dimmed && 'opacity-30',
        )}
      >
        <PortHandles />
        <ContentsChevron card={card} ctx={ctx} />
        {card.expandKind === 'focus' && card.nodeId && (
          <button
            type="button"
            title={`${card.label} holds more — focus it to make its contents the top level`}
            onClick={(e) => { e.stopPropagation(); ctx.onFocus(card.nodeId!) }}
            className="nodrag flex-shrink-0 -ml-1 w-4 h-full flex items-center justify-center text-ink-muted/50 hover:text-accent-lineage focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 rounded"
          >
            <LucideIcons.Focus className="w-3 h-3" />
          </button>
        )}
        <LucideIcons.CornerDownRight className="w-3 h-3 flex-shrink-0 text-ink-muted/50" />
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: accent }} />
        <span className="min-w-0 truncate text-[11px] text-ink">{card.label}</span>
        <CardActions card={card} ctx={ctx} />
      </div>
    )
  }

  // ── Inside a frame, with no lineage to the focal ──
  // Shown only in "everything inside" mode. Deliberately quiet: it is
  // context, not an answer, and it must never look like a connection.
  if (card.frameId && !card.connected) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={activate}
        onKeyDown={keyActivate}
        onDoubleClick={(e) => { e.stopPropagation(); if (card.nodeId) ctx.onFocus(card.nodeId) }}
        title={`${card.label}${card.description ? ` — ${card.description}` : ''} — inside this, but no lineage with the focused entity · double-click to focus`}
        style={{ width: card.w, height: card.h }}
        className={cn(
          'group relative flex items-center gap-1.5 rounded-lg border border-dashed border-black/[0.08] dark:border-white/[0.09] bg-transparent px-2.5 cursor-pointer transition-colors hover:border-accent-lineage/40 hover:bg-black/[0.02] dark:hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
          selected && 'ring-2 ring-accent-lineage',
          card.dimmed ? 'opacity-20' : 'opacity-60 hover:opacity-100',
        )}
      >
        <PortHandles />
        <TypeIcon ctx={ctx} typeId={card.type} color={accent} className="w-3 h-3 flex-shrink-0 opacity-60" />
        <span className="min-w-0 truncate text-[11px] text-ink-secondary">{card.label}</span>
        <span className="flex-shrink-0 ml-auto text-[9px] text-ink-muted/50 group-hover:hidden">no lineage</span>
        <CardActions card={card} ctx={ctx} />
      </div>
    )
  }

  // ── Entity: the rich neighbor card ──
  const isConstituent = card.id.startsWith('x:')
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={activate}
      onKeyDown={keyActivate}
      onDoubleClick={(e) => { e.stopPropagation(); if (card.nodeId) ctx.onFocus(card.nodeId) }}
      title={`${card.label}${card.description ? ` — ${card.description}` : ''} · click to inspect, double-click to focus`}
      style={{ width: card.w, height: card.h, borderLeftWidth: 3, borderLeftColor: accent }}
      className={cn(
        'group relative flex items-center gap-2 rounded-lg border px-2.5 cursor-pointer transition-colors bg-black/[0.015] dark:bg-white/[0.02] hover:bg-black/[0.035] dark:hover:bg-white/[0.05] hover:border-accent-lineage/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
      card.rollup
          ? 'border-dashed border-black/[0.12] dark:border-white/[0.14] opacity-75 hover:opacity-100'
          : 'border-black/[0.07] dark:border-white/[0.08]',
        selected && 'ring-2 ring-accent-lineage',
        card.dimmed && 'opacity-30',
      )}
    >
      <PortHandles />
      <ContentsChevron card={card} ctx={ctx} />
      {!isConstituent && (
        <div
          className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${accent}1f` }}
        >
          <TypeIcon ctx={ctx} typeId={card.type} color={accent} className="w-3.5 h-3.5" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="flex items-center gap-1.5 min-w-0 text-[12px] font-medium text-ink leading-snug">
          <span className="truncate">{card.label}</span>
          {card.rollup && (
            <span
              className="flex-shrink-0 flex items-center"
              title="Stands for finer flows beneath it — not an additional connection"
            >
              <LucideIcons.Layers className="w-2.5 h-2.5 text-ink-muted/50" />
            </span>
          )}
        </p>
        <p className="flex items-center gap-1 text-[9.5px] text-ink-muted/70 leading-snug min-w-0">
          {card.parentLabel && (
            <>
              <LucideIcons.FolderTree className="w-2.5 h-2.5 flex-shrink-0 text-ink-muted/50" />
              <span className="truncate max-w-[80px]">{card.parentLabel}</span>
              <span className="text-ink-muted/40">·</span>
            </>
          )}
          {card.edgeTypeNorm && (
            <>
              <span
                className="w-1 h-1 rounded-full flex-shrink-0"
                style={{ backgroundColor: generateEdgeColorFromType(card.edgeTypeNorm) }}
              />
              <span
                className="truncate uppercase tracking-wide"
                title={ctx.edgeTypeInfo?.get(card.edgeTypeNorm)?.description}
              >
                {edgeLabelFor(card.edgeTypeNorm, ctx.edgeTypeInfo)}
              </span>
            </>
          )}
          {card.count > 1 && (
            <span
              className="tabular-nums font-semibold text-ink-muted flex-shrink-0"
              title={`${card.count.toLocaleString()} connections to this entity`}
            >
              ×{card.count.toLocaleString()}
            </span>
          )}
          {card.unresolved && <span className="italic flex-shrink-0">· not on canvas</span>}
        </p>
        {/* Name a few of the things a closed container stands for, so
            you can often skip opening it. Cached data only. */}
        {card.previewLabels.length > 0 && (
          <p className="truncate text-[9px] text-ink-muted/60 leading-snug" title={card.previewLabels.join(', ')}>
            {card.previewLabels.join(', ')}
          </p>
        )}
      </div>
      <CardActions card={card} ctx={ctx} />
      <FrontierPill card={card} ctx={ctx} />
    </div>
  )
}

/**
 * Content-based memo boundary. The builder returns fresh card objects
 * on every rebuild, so a reference-equality memo never held and one
 * arriving fetch re-rendered the whole board. Comparing the card's
 * fields instead means only genuinely-changed cards re-render — and it
 * does so without caching anything across renders. This component
 * reads exactly `data` and `selected`; React Flow applies position
 * itself, so nothing else can affect the output.
 */
/**
 * A container opened into what's inside it that connects to the focal.
 * Rendered BEHIND its children (see zIndex where nodes are built), with
 * a header that stays interactive while the body lets clicks through to
 * the child cards sitting on top.
 */
function FocusFrameNode({ data }: NodeProps) {
  const { card, ctx } = data as unknown as { card: FocusCard; ctx: CardCtx }
  const accent = ctx.visualFor(card.type).color
  const q = ctx.frameQueryFor?.(card.expandKey ?? '') ?? ''
  // A total is a claim: state it only when the last page has landed (or
  // the container reported its own count). Otherwise say "at least".
  const pager = framePager(card)
  const total = pager.exact ? pager.rows.toLocaleString() : `${pager.rows.toLocaleString()}+`
  // Name what the open actually matched against. At the first hop that
  // is the focused entity and the plain wording reads better; further
  // out it is the card's own partner, and saying "this entity" there
  // would claim something the server was never asked.
  const to = card.partnerLabel ? ` to ${card.partnerLabel}` : ''
  // Say which rows are on screen, not just how many exist — "showing
  // 21–40 of 428" is the sentence a 428-column table needs.
  const range = pager.paged ? `showing ${pager.from.toLocaleString()}–${pager.to.toLocaleString()} of ${total}` : null
  // In "everything inside" the search runs on the SERVER, so the counts
  // describe the matches, not the container — say which.
  const searching = card.frameShowingAll && q.trim().length > 0
  const inside = card.frameShowingAll
    ? `${card.frameConnectedCount.toLocaleString()} connected${to} · ${range ?? `${card.frameLoaded.toLocaleString()} of ${total} shown`}${searching ? ` matching "${q.trim()}"` : ''}`
    : `${card.count.toLocaleString()}${card.frameTruncated ? '+' : ''} connected${to || ' inside'}${range ? ` · ${range}` : ''}`
  return (
    <div
      style={{ width: card.w, height: card.h, borderColor: `${accent}55` }}
      className="relative rounded-xl border-2 border-dashed bg-black/[0.02] dark:bg-white/[0.03] pointer-events-none"
    >
      <PortHandles />
      {/* Header — the only interactive part; the body is click-through
          so the child cards above stay reachable. */}
      <div className="pointer-events-auto absolute inset-x-0 top-0 h-[46px] px-2.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); if (card.nodeId) ctx.onOpenContainer(card.expandKey!, card.nodeId, card.type, card.partnerIds[0] ?? null) }}
          title={`Close ${card.label}`}
          className="nodrag flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
        >
          <LucideIcons.ChevronDown className="w-3.5 h-3.5" />
        </button>
        <TypeIcon ctx={ctx} typeId={card.type} color={accent} className="w-3.5 h-3.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11.5px] font-semibold text-ink leading-tight" title={card.label}>
            {card.label}
          </p>
          <p className="flex items-center gap-1 text-[9px] text-ink-muted/80 leading-tight truncate">
            {card.frameBreadcrumb.length > 0 && (
              <span className="truncate" title={`Opened through ${card.frameBreadcrumb.join(' › ')}`}>
                {card.frameBreadcrumb.join(' › ')} ·{' '}
              </span>
            )}
            {card.fetch === 'loading'
              ? 'Looking inside…'
              : card.frameEmpty && !card.frameShowingAll
                ? `nothing connected${to || ' inside'}`
                : inside}
          </p>
        </div>
        {/* Connected ⇄ All. The default answers "what in here touches my
            entity"; All answers "what else is in here", with lineage
            still drawn wherever it exists. */}
        {ctx.onToggleFrameAll && (
          <div
            role="group"
            aria-label={`What to show inside ${card.label}`}
            className="nodrag flex-shrink-0 flex items-center rounded-md border border-black/10 dark:border-white/10 p-0.5"
          >
            {([
              { all: false, Icon: LucideIcons.Link2, label: `Only what connects to ${card.partnerLabel ?? 'this entity'}` },
              { all: true, Icon: LucideIcons.Rows3, label: 'Everything inside, lineage marked' },
            ] as const).map(({ all, Icon, label }) => (
              <button
                key={String(all)}
                type="button"
                disabled={card.fetch === 'loading'}
                onClick={(e) => {
                  e.stopPropagation()
                  if (all !== card.frameShowingAll) ctx.onToggleFrameAll?.(card.expandKey ?? '')
                }}
                title={card.fetch === 'loading' ? 'Looking inside…' : label}
                aria-label={label}
                aria-pressed={card.frameShowingAll === all}
                className={cn(
                  'p-0.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                  card.frameShowingAll === all
                    ? 'bg-accent-lineage/12 text-accent-lineage'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                <Icon className="w-3 h-3" />
              </button>
            ))}
          </div>
        )}
        {/* Find one by name without reading everything. */}
        {Math.max(card.count, card.frameLoaded) > 4 && (
          <input
            value={q}
            onChange={(e) => ctx.onFrameQuery(card.expandKey ?? '', e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="Find…"
            title={card.frameShowingAll
              ? `Search every entity inside ${card.label}, not only the page on screen`
              : 'Filter what is inside'}
            className="nodrag flex-shrink-0 w-16 px-1.5 py-0.5 rounded bg-black/[0.04] dark:bg-white/[0.06] border border-black/10 dark:border-white/10 text-[10px] text-ink placeholder:text-ink-muted/60 outline-none focus:border-accent-lineage/60"
          />
        )}
        {/* The lineage hop, kept in the header rather than as a
            FrontierPill: the frame's `fetch` tracks the LOOK-INSIDE
            request, so the pill's loading state would report the wrong
            fetch. Looking inside something must never end the walk. */}
        {(card.frontier || card.frontierExpanded) && card.nodeId && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); ctx.onExpandFrontier(card.expandKey!, card.nodeId!) }}
            title={card.frontierExpanded
              ? `Collapse ${card.band < 0 ? 'upstream of' : 'downstream of'} ${card.label}`
              : `Expand the next hop ${card.band < 0 ? 'upstream' : 'downstream'} of ${card.label}`}
            className={cn(
              'nodrag flex-shrink-0 w-5 h-5 rounded flex items-center justify-center hover:bg-black/[0.06] dark:hover:bg-white/[0.08]',
              card.frontierExpanded ? 'text-accent-lineage' : 'text-ink-muted hover:text-accent-lineage',
            )}
          >
            {card.frontierExpanded
              ? <LucideIcons.Minus className="w-3 h-3" />
              : <LucideIcons.Plus className="w-3 h-3" />}
          </button>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); if (card.nodeId) ctx.onFocus(card.nodeId) }}
          title={`Focus ${card.label}`}
          className="nodrag flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
        >
          <LucideIcons.Focus className="w-3 h-3" />
        </button>
      </div>

      {card.fetch === 'loading' && (
        <div className="absolute inset-x-2.5 top-[52px] space-y-1.5">
          {[0, 1].map(i => (
            <div key={i} className="h-8 rounded-lg bg-black/[0.05] dark:bg-white/[0.06] animate-pulse" />
          ))}
        </div>
      )}
      {card.fetch === 'error' && (
        <div className="pointer-events-auto absolute inset-x-2.5 top-[52px] flex items-center gap-1.5 text-[10px] text-amber-700 dark:text-amber-400">
          <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">Couldn&apos;t look inside.</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              // Two fetches back this frame; re-kick whichever failed.
              if (card.frameShowingAll) ctx.onRetryFrameAll?.(card.expandKey ?? '')
              else if (card.nodeId) ctx.onRetryOpen?.(card.expandKey!, card.nodeId, card.type, card.partnerIds[0] ?? null)
            }}
            className="font-semibold hover:underline"
          >
            Retry
          </button>
        </div>
      )}
      {card.frameEmpty && card.frameLoaded === 0 && card.fetch === null && (
        <p className="absolute inset-x-2.5 top-[52px] text-[10px] text-ink-muted/70 italic leading-snug">
          Nothing inside {card.label} connects to {card.partnerLabel ?? 'this entity'}.
          {ctx.onToggleFrameAll && ' Show everything inside to see what it holds.'}
        </p>
      )}
      {/* Fixed-window pager. The frame keeps its size as you move
          through it, so a 500-column table sits on the board like any
          other card. Next past the fetched set asks the server for one
          more page and holds this one until it lands. */}
      {pager.paged && (
        <div
          className="pointer-events-auto absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 px-2.5"
          style={{ height: FRAME_FOOTER_H }}
        >
          <button
            type="button"
            disabled={!pager.canPrev}
            onClick={(e) => { e.stopPropagation(); ctx.onSetFramePage(card.expandKey ?? '', card.framePage - 1) }}
            title="Previous page"
            className="nodrag w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.06] dark:hover:bg-white/[0.08] disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
          >
            <LucideIcons.ChevronLeft className="w-3 h-3" />
          </button>
          <span className="text-[9.5px] tabular-nums text-ink-muted/80">
            {card.fetch === 'loading'
              ? 'loading…'
              : `page ${(card.framePage + 1).toLocaleString()} of ${pager.pageCount.toLocaleString()}${pager.exact ? '' : '+'}`}
          </span>
          <button
            type="button"
            disabled={!pager.canNext || card.fetch === 'loading'}
            onClick={(e) => { e.stopPropagation(); ctx.onSetFramePage(card.expandKey ?? '', card.framePage + 1) }}
            title="Next page"
            className="nodrag w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.06] dark:hover:bg-white/[0.08] disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
          >
            <LucideIcons.ChevronRight className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  )
}

const MemoFocusFrameNode = memo(FocusFrameNode, (prev, next) => {
  const a = prev.data as unknown as { card: FocusCard; ctx: CardCtx }
  const b = next.data as unknown as { card: FocusCard; ctx: CardCtx }
  return a.ctx === b.ctx && sameCard(a.card, b.card)
})

const MemoFocusGraphCard = memo(FocusGraphCard, (prev, next) => {
  if (prev.selected !== next.selected) return false
  const a = prev.data as unknown as { card: FocusCard; ctx: CardCtx; focalStats?: { in: number; out: number } }
  const b = next.data as unknown as { card: FocusCard; ctx: CardCtx; focalStats?: { in: number; out: number } }
  return a.ctx === b.ctx
    && a.focalStats?.in === b.focalStats?.in
    && a.focalStats?.out === b.focalStats?.out
    && sameCard(a.card, b.card)
})

// ── Band labels ──────────────────────────────────────────────────────

/** Non-interactive header floating above each hop band ("Data Sources
 *  · 30 of 45"), or an italic whisper for an empty direction. */
function BandLabelNode({ data }: NodeProps) {
  const d = data as unknown as { band?: number; sub?: string; whisper?: string }
  if (d.whisper) {
    return (
      <div style={{ width: CARD_W }} className="pointer-events-none text-[10.5px] italic text-ink-muted/60 leading-snug">
        {d.whisper}
      </div>
    )
  }
  const band = d.band ?? 1
  const isUp = band < 0
  const hop = Math.abs(band)
  return (
    <div style={{ width: CARD_W }} className="pointer-events-none flex items-baseline gap-1.5 whitespace-nowrap">
      {isUp
        ? <LucideIcons.ArrowDownLeft className="w-3 h-3 self-center text-sky-500" />
        : <LucideIcons.ArrowUpRight className="w-3 h-3 self-center text-amber-500" />}
      <span className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-ink-muted/70">
        {isUp
          ? hop === 1 ? 'Data Sources' : `Sources · hop ${hop}`
          : hop === 1 ? 'Data Consumers' : `Consumers · hop ${hop}`}
      </span>
      {d.sub && <span className="text-[9px] tabular-nums text-ink-muted/50">{d.sub}</span>}
    </div>
  )
}

const NODE_TYPES = { focusCard: MemoFocusGraphCard, focusFrame: MemoFocusFrameNode, bandLabel: BandLabelNode }

// ── Edge ─────────────────────────────────────────────────────────────

function FocusGraphEdgeComp({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps) {
  const d = data as unknown as {
    count: number
    aggregated: boolean
    containment: boolean
    dimmed: boolean
    tint: string
  }
  // Hover emphasis is derived here from context: the edges ARRAY stays
  // identity-stable, so sweeping the pointer never rebuilds it (nor
  // makes React Flow reconcile every edge).
  const hoveredId = useContext(HoverContext)
  const hoverActive = hoveredId != null
  const emphasized = hoverActive && (source === hoveredId || target === hoveredId)
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  // Hovering a card lights up ITS connections and quiets the rest —
  // the read-your-neighborhood gesture.
  const opacity = d.dimmed ? 0.12
    : emphasized ? 1
      : hoverActive ? 0.2
        : d.containment ? 0.45 : 0.7
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: d.tint,
          strokeWidth: emphasized ? (d.aggregated ? 3 : 2.5) : d.aggregated ? 2 : 1.5,
          strokeDasharray: d.containment ? '4 4' : undefined,
          opacity,
          transition: 'opacity 120ms, stroke-width 120ms',
        }}
      />
      {d.count > 1 && !d.dimmed && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, opacity: hoverActive && !emphasized ? 0.3 : 1 }}
            className="absolute pointer-events-none px-1 py-px rounded-full bg-canvas-elevated border border-black/10 dark:border-white/10 text-[8.5px] font-semibold tabular-nums text-ink-muted shadow-sm"
          >
            ×{d.count.toLocaleString()}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const EDGE_TYPES = { focusEdge: FocusGraphEdgeComp }

// ── Controls ─────────────────────────────────────────────────────────

/** House-styled zoom cluster (React Flow's default chrome doesn't
 *  match the lens). Must render inside <ReactFlow> for useReactFlow. */
function GraphControls({ reducedMotion, exportName, onResetLayout }: {
  reducedMotion: boolean
  exportName?: string
  /** Present only once something has been dragged. */
  onResetLayout?: () => void
}) {
  const rf = useReactFlow()
  const [exporting, setExporting] = useState(false)
  const dur = reducedMotion ? 0 : 200
  const btn = 'w-7 h-7 flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'

  // PNG export: re-project the whole graph into a fixed frame and
  // rasterize the viewport pane (the standard React Flow recipe).
  // The rasterizer is imported LAZILY — it is only needed when someone
  // actually exports, it keeps ~30KB out of the initial chunk, and a
  // missing/not-yet-installed module degrades to "this one button
  // doesn't work" instead of taking the whole lens down.
  const exportPng = async (e: React.MouseEvent) => {
    const viewport = (e.currentTarget as HTMLElement)
      .closest('.react-flow')
      ?.querySelector<HTMLElement>('.react-flow__viewport')
    if (!viewport || exporting) return
    setExporting(true)
    try {
      const { toPng } = await import('html-to-image')
      // Frame children are positioned RELATIVE to their frame, so
      // feeding them to getNodesBounds would drag the box toward the
      // origin. They always sit inside their frame's rect anyway, so
      // the frames already account for them.
      const bounds = getNodesBounds(rf.getNodes().filter(n => !n.parentId))
      const width = Math.min(Math.ceil(bounds.width) + 160, 3200)
      const height = Math.min(Math.ceil(bounds.height) + 160, 2400)
      const vp = getViewportForBounds(bounds, width, height, 0.25, 2, 0.08)
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--nx-bg-elevated').trim() || '#ffffff'
      const dataUrl = await toPng(viewport, {
        backgroundColor: bg,
        width,
        height,
        pixelRatio: 2,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
        },
      })
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `lineage-${(exportName ?? 'focus').replace(/[^\p{L}\p{N}_-]+/gu, '-')}.png`
      a.click()
    } catch {
      // Rasterization can fail on exotic content (e.g. blocked images);
      // the graph itself is unaffected — just release the button.
    } finally {
      setExporting(false)
    }
  }

  return (
    <Panel position="bottom-right" className="!m-3">
      <div className="flex flex-col rounded-lg border border-black/10 dark:border-white/10 bg-canvas-elevated shadow-md overflow-hidden divide-y divide-black/[0.06] dark:divide-white/[0.06]">
        <button type="button" title="Zoom in" onClick={() => void rf.zoomIn({ duration: dur })} className={btn}>
          <LucideIcons.Plus className="w-3.5 h-3.5" />
        </button>
        <button type="button" title="Zoom out" onClick={() => void rf.zoomOut({ duration: dur })} className={btn}>
          <LucideIcons.Minus className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          title="Fit the lineage in view"
          onClick={() => void rf.fitView({ padding: 0.15, duration: reducedMotion ? 0 : 240, maxZoom: 1 })}
          className={btn}
        >
          <LucideIcons.Maximize2 className="w-3.5 h-3.5" />
        </button>
        {/* Only offered once there is an arrangement to undo. */}
        {onResetLayout && (
          <button
            type="button"
            title="Tidy up — put every card back where the lens placed it"
            aria-label="Reset layout"
            onClick={() => {
              onResetLayout()
              window.setTimeout(
                () => void rf.fitView({ padding: 0.15, duration: reducedMotion ? 0 : 240, maxZoom: 1 }),
                reducedMotion ? 0 : 60,
              )
            }}
            className={cn(btn, 'text-accent-lineage hover:text-accent-lineage')}
          >
            <LucideIcons.LayoutGrid className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          title="Download this lineage as an image (for decks and docs)"
          onClick={(e) => void exportPng(e)}
          className={btn}
          disabled={exporting}
        >
          {exporting
            ? <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin text-accent-lineage/70" />
            : <LucideIcons.ImageDown className="w-3.5 h-3.5" />}
        </button>
      </div>
    </Panel>
  )
}


// ── View ─────────────────────────────────────────────────────────────

export function FocusGraphView({
  graph,
  focalId,
  focalStats,
  focalFetch,
  focalImpact,
  focalImpactLoading,
  exportName,
  selectedId,
  reducedMotion,
  edgeTypeInfo,
  onSelect,
  onFocus,
  onToggleGroup,
  onOpenContainer,
  onExpandFrontier,
  onToggleContains,
  onRetryContains,
  onShowMore,
  onSetFramePage,
  onFrameQuery,
  frameQueryFor,
  onToggleFrameAll,
  onRetryFrameAll,
  onRetryOpen,
  onRetryFetch,
  onRevealOnCanvas,
  onOpenDetails,
}: FocusGraphViewProps) {
  // Type visuals resolved ONCE per schema for the whole graph. Cards
  // used to each subscribe to the schema store and linear-scan the
  // entity-type list, so every card paid for every schema touch; now
  // it's a single O(1) lookup built eagerly here.
  const schema = useSchemaStore((s) => s.schema)
  const visualFor = useMemo(() => {
    const known = new Map<string, { color: string; Icon: LucideIcons.LucideIcon }>()
    for (const et of schema?.entityTypes ?? []) {
      // `visual` is absent for types an ontology hasn't styled — those
      // fall through to the deterministic generator below rather than
      // taking the graph down.
      if (et?.visual) known.set(et.id, { color: et.visual.color, Icon: iconByName(et.visual.icon) })
    }
    return (typeId: string) => {
      const key = typeId === 'not loaded' ? 'entity' : typeId
      const hit = known.get(key)
      if (hit) return hit
      // Type the ontology doesn't define — deterministic fallback.
      const v = getEntityVisual(schema ? { schema } : null, key)
      return { color: v.color, Icon: iconByName(v.icon) }
    }
  }, [schema])

  const ctx = useMemo<CardCtx>(() => ({
    edgeTypeInfo,
    visualFor,
    onSelect,
    onFocus,
    onToggleGroup,
    onOpenContainer,
    onExpandFrontier,
    onToggleContains,
    onRetryContains,
    onShowMore,
    onSetFramePage,
    onFrameQuery,
    frameQueryFor,
    onToggleFrameAll,
    onRetryFrameAll,
    onRetryOpen,
    onRetryFetch,
    onRevealOnCanvas,
    onOpenDetails,
  }), [edgeTypeInfo, visualFor, onSelect, onFocus, onToggleGroup, onOpenContainer, onExpandFrontier, onToggleContains, onRetryContains, onShowMore, onSetFramePage, onFrameQuery, frameQueryFor, onToggleFrameAll, onRetryFrameAll, onRetryOpen, onRetryFetch, onRevealOnCanvas, onOpenDetails])

  const focalIn = focalStats.in
  const focalOut = focalStats.out


  const baseNodes = useMemo((): Node[] => {
    const minYByBand = new Map<number, number>()
    for (const c of graph.cards) {
      const cur = minYByBand.get(c.band)
      if (cur === undefined || c.y < cur) minYByBand.set(c.band, c.y)
    }
    // A frame's children ride along as React Flow child nodes, so
    // dragging the frame carries its whole contents — positions become
    // relative to it, and their edges re-route themselves.
    const frameById = new Map(graph.cards.filter(c => c.kind === 'frame').map(c => [c.id, c]))
    // Frames nest, so a fixed frame-behind-cards pair of z-indices is not
    // enough: an inner frame has to sit ABOVE its host's backdrop while
    // still sitting below its own children.
    const depthOf = (card: FocusCard) => {
      let d = 0
      let host = card.frameId
      while (host && d < 32) { d++; host = frameById.get(host)?.frameId ?? null }
      return d
    }
    const nodes: Node[] = graph.cards.map((card) => {
      const parent = card.frameId ? frameById.get(card.frameId) : undefined
      return {
        id: card.id,
        type: card.kind === 'frame' ? 'focusFrame' : 'focusCard',
        zIndex: depthOf(card) * 2 + (card.kind === 'frame' ? 0 : 1),
        ...(parent ? { parentId: parent.id } : {}),
        position: parent
          ? { x: card.x - parent.x, y: card.y - parent.y }
          : { x: card.x, y: card.y },
        // Rearrange the picture freely; a frame's children move with it
        // rather than out of it, so a table never sheds its columns.
        draggable: parent === undefined,
        selectable: false,
        focusable: false,
        data: card.kind === 'focal'
          ? { card, ctx, focalStats: { in: focalIn, out: focalOut } }
          : { card, ctx },
      }
    })
    // Hop-band headers with honest shown/total counts.
    for (const [band, minY] of minYByBand) {
      if (band === 0) continue
      const totals = graph.bandTotals.get(`band:${band < 0 ? 'in' : 'out'}:${Math.abs(band)}`)
      const sub = totals
        ? totals.total > totals.shown ? `${totals.shown} of ${totals.total}` : `${totals.total}`
        : undefined
      nodes.push({
        id: `bl:${band}`,
        type: 'bandLabel',
        position: { x: band * (CARD_W + BAND_GAP), y: minY - 34 },
        draggable: false,
        selectable: false,
        focusable: false,
        data: { band, sub },
      })
    }
    // A COMPLETED fetch with an empty direction is a data-source claim
    // — whisper it where the band would be, instead of blank space.
    if (focalFetch === 'done') {
      if (!minYByBand.has(-1)) {
        nodes.push({
          id: 'blw:in', type: 'bandLabel', position: { x: -(CARD_W + BAND_GAP), y: -10 },
          draggable: false, selectable: false, focusable: false,
          data: { whisper: 'No upstream sources in the data source' },
        })
      }
      if (!minYByBand.has(1)) {
        nodes.push({
          id: 'blw:out', type: 'bandLabel', position: { x: CARD_W + BAND_GAP, y: -10 },
          draggable: false, selectable: false, focusable: false,
          data: { whisper: 'No downstream consumers in the data source' },
        })
      }
    }
    return nodes
  }, [graph.cards, graph.bandTotals, ctx, focalIn, focalOut, focalFetch])

  /**
   * Cards the user has dragged, by card id. The builder keeps producing
   * its tidy baked layout; this overlays whatever was moved on top, so
   * an arriving fetch or a newly opened container grows the picture
   * without throwing away the arrangement someone just made.
   *
   * Only the final position is committed (onNodeDragStop) — React Flow
   * moves the node itself during the gesture, so a drag costs exactly
   * one state update rather than one per frame.
   */
  // Stamped with the focal it belongs to and read through, rather than
  // cleared by an effect: a different focal is a different picture, and
  // its arrangement should never leak into the next one.
  const [movedState, setMovedState] = useState<{ focalId: string; positions: ReadonlyMap<string, XYPosition> }>(
    () => ({ focalId, positions: EMPTY_POSITIONS }),
  )
  const moved = movedState.focalId === focalId ? movedState.positions : EMPTY_POSITIONS
  const commitDrag = useCallback((_: unknown, node: Node) => {
    setMovedState(prev => {
      const base = prev.focalId === focalId ? prev.positions : EMPTY_POSITIONS
      const positions = new Map(base)
      positions.set(node.id, { x: node.position.x, y: node.position.y })
      return { focalId, positions }
    })
  }, [focalId])
  const resetLayout = useCallback(() => setMovedState({ focalId, positions: EMPTY_POSITIONS }), [focalId])

  // Selection rides React Flow's own `selected` flag so changing it
  // re-renders exactly the affected memoized cards.
  const nodes = useMemo(() => baseNodes.map((n) => {
    const cardNodeId = (n.data as { card?: FocusCard }).card?.nodeId ?? null
    const sel = cardNodeId != null && cardNodeId === selectedId
    const pos = moved.get(n.id)
    if (sel === !!n.selected && !pos) return n
    return { ...n, selected: sel, ...(pos ? { position: pos } : {}) }
  }), [baseNodes, selectedId, moved])

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const edges = useMemo((): Edge[] => {
    const bandById = new Map(graph.cards.map(c => [c.id, c.band]))
    return graph.edges.map((e) => {
      const tint = e.containment
        ? TINT_CONTAIN
        : Math.max(bandById.get(e.source) ?? 0, bandById.get(e.target) ?? 0) <= 0
          ? TINT_UP
          : TINT_DOWN
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.containment ? 'contains' : undefined,
        type: 'focusEdge',
        // Business users shouldn't infer direction from layout
        // convention alone — flow edges carry an explicit arrowhead.
        markerEnd: e.containment
          ? undefined
          : { type: MarkerType.ArrowClosed, color: tint, width: 14, height: 14 },
        data: { count: e.count, aggregated: e.aggregated, containment: e.containment, dimmed: e.dimmed, tint },
      }
    })
  }, [graph.cards, graph.edges])

  const impactValue = useMemo(
    () => ({ impact: focalImpact, loading: focalImpactLoading }),
    [focalImpact, focalImpactLoading],
  )

  const [rf, setRf] = useState<ReactFlowInstance | null>(null)
  // Re-frame on focal swaps and expansion changes — the graph's shape
  // changed, so bring it back into view (instant under reduced motion).
  useEffect(() => {
    if (!rf) return
    const t = window.setTimeout(() => {
      void rf.fitView({ padding: 0.15, duration: reducedMotion ? 0 : 240, maxZoom: 1 })
    }, 30)
    return () => window.clearTimeout(t)
    // Deliberately NOT keyed on card count: expanding a card must grow
    // the picture in place rather than yank the viewport off what you
    // just opened (and re-frame-per-expansion was pure animation churn).
  }, [rf, focalId, reducedMotion])

  return (
    <div
      className={cn(
        'relative h-full w-full min-h-0 text-black/[0.16] dark:text-white/[0.14]',
        // Baked positions + stable card ids: a CSS transform transition
        // makes shared cards glide when the focal changes. The card
        // being dragged opts out — an eased transform lags the pointer.
        !reducedMotion && '[&_.react-flow__node]:transition-transform [&_.react-flow__node]:duration-300 [&_.react-flow__node.dragging]:transition-none',
      )}
    >
      <ImpactContext.Provider value={impactValue}>
      <HoverContext.Provider value={hoveredId}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onInit={setRf}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          minZoom={0.25}
          maxZoom={1.4}
          panOnDrag
          zoomOnScroll
          zoomOnDoubleClick={false}
          // Rearrange the picture to suit how you read it. Edges are
          // anchored to card ids, so every connection re-routes and
          // nothing about the lineage changes — only where it sits.
          nodesDraggable
          // Small movements stay clicks, so dragging never eats the
          // click-to-inspect / double-click-to-focus gestures.
          nodeDragThreshold={4}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          onNodeDragStop={commitDrag}
          onPaneClick={() => onSelect(null)}
          onNodeMouseEnter={(_, n) => { if (n.type === 'focusCard') setHoveredId(n.id) }}
          onNodeMouseLeave={() => setHoveredId(null)}
          proOptions={{ hideAttribution: true }}
          style={{ background: 'transparent' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={26} size={1.25} color="currentColor" />
          <GraphControls
            reducedMotion={reducedMotion}
            exportName={exportName}
            onResetLayout={moved.size > 0 ? resetLayout : undefined}
          />
        </ReactFlow>
      </ReactFlowProvider>
      </HoverContext.Provider>
      </ImpactContext.Provider>
    </div>
  )
}
