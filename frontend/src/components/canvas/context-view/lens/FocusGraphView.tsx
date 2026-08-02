/**
 * FocusGraphView — the Lens's interactive Graph mode renderer.
 *
 * A self-contained React Flow instance (own provider — never shares
 * viewport state with GraphCanvas) that renders the pure focus-graph
 * build as rich entity cards in hop bands. All semantics live in
 * focus-graph.ts; this file is presentation and gestures only:
 *   single click  = select (detail strip)     double click = focus
 *   group header  = expand/collapse           ⊕ pill       = next hop
 *   ×N badge      = drill the aggregate       pane click   = deselect
 *   hover a card  = light up its connections
 *
 * Positions come pre-baked from the builder, so React Flow does no
 * layout of its own — card ids are stable across rebuilds and a CSS
 * transform transition (killed under .reduce-motion) makes shared
 * cards glide when the focal changes.
 *
 * Perf contract: the card context is identity-stable across selection
 * and hover, selection is stamped through React Flow's own `selected`
 * flag, and hover touches only the (small) edge array — so selecting
 * or sweeping the pointer re-renders a couple of memoized cards, never
 * the whole board.
 */
import { memo, useEffect, useMemo, useState } from 'react'
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
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import * as LucideIcons from 'lucide-react'
import type { LineageEdge } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { getEntityVisual } from '@/hooks/useEntityVisual'
import { generateEdgeColorFromType } from '@/lib/type-visuals'
import { cn } from '@/lib/utils'
import { CARD_W, BAND_GAP, edgeLabelFor, type EdgeTypeInfoMap, type FocusCard, type FocusGraph } from './focus-graph'

/** Direction tints — the house semantics: upstream = sky, downstream
 *  = amber (matches the list columns and the canvas). */
const TINT_UP = '#0ea5e9'
const TINT_DOWN = '#f59e0b'
const TINT_CONTAIN = '#94a3b8'

interface CardCtx {
  edgeTypeInfo?: EdgeTypeInfoMap
  onSelect: (nodeId: string | null) => void
  onFocus: (nodeId: string) => void
  onToggleGroup: (expandKey: string) => void
  onToggleDrill: (drillKey: string, edge: LineageEdge) => void
  onExpandFrontier: (expandKey: string, nodeId: string) => void
  onShowMore: (bandKey: string) => void
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
  selectedId: string | null
  reducedMotion: boolean
  edgeTypeInfo?: EdgeTypeInfoMap
  onSelect: (nodeId: string | null) => void
  onFocus: (nodeId: string) => void
  onToggleGroup: (expandKey: string) => void
  onToggleDrill: (drillKey: string, edge: LineageEdge) => void
  onExpandFrontier: (expandKey: string, nodeId: string) => void
  onShowMore: (bandKey: string) => void
  onRetryFetch?: (nodeId: string) => void
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  onOpenDetails?: (nodeId: string) => void
}

// ── Card node ────────────────────────────────────────────────────────

function TypeIcon({ typeId, color, className }: { typeId: string; color: string; className?: string }) {
  const schema = useSchemaStore((s) => s.schema)
  const visual = useMemo(() => getEntityVisual(schema ? { schema } : null, typeId), [schema, typeId])
  const Icon = (LucideIcons as unknown as Record<string, LucideIcons.LucideIcon>)[visual.icon] ?? LucideIcons.Box
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
    <span className="absolute -top-2.5 right-1.5 hidden group-hover:flex items-center gap-0.5 rounded-md bg-canvas-elevated border border-black/10 dark:border-white/10 shadow-sm px-0.5 py-0.5 z-10">
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

/** The ⊕ / +N pill on a frontier card's outward side — fetches and
 *  reveals that entity's own next hop. Never invents a number: the
 *  count renders only when the backend reported a real degree; a
 *  completed-empty expansion becomes an explicit end-of-lineage mark. */
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
      {expanded
        ? <LucideIcons.Minus className="w-3 h-3" />
        : hint != null
          ? <>{outLeft && <LucideIcons.Plus className="w-2.5 h-2.5" />}{hint.toLocaleString()}{!outLeft && <LucideIcons.Plus className="w-2.5 h-2.5" />}</>
          : <LucideIcons.Plus className="w-3 h-3" />}
    </button>
  )
}

function FocusGraphCard({ data, selected }: NodeProps) {
  const { card, ctx, focalStats } = data as unknown as {
    card: FocusCard
    ctx: CardCtx
    focalStats?: { in: number; out: number }
  }
  const schema = useSchemaStore((s) => s.schema)
  const visual = useMemo(
    () => getEntityVisual(schema ? { schema } : null, card.type === 'not loaded' ? 'entity' : card.type),
    [schema, card.type],
  )
  const accent = card.type === 'not loaded' ? '#94a3b8' : visual.color

  const activate = () => {
    if (card.kind === 'overflow') { if (card.expandKey) ctx.onShowMore(card.expandKey); return }
    if (card.kind === 'group') { if (card.expandKey) ctx.onToggleGroup(card.expandKey); return }
    ctx.onSelect(card.nodeId)
  }
  const keyActivate = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); activate() }
  }

  // ── Overflow: the honest "+N more" card ──
  if (card.kind === 'overflow') {
    return (
      <button
        type="button"
        onClick={activate}
        title={`Show more (${card.overflowCount.toLocaleString()} not shown)`}
        style={{ width: card.w, height: card.h }}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-ink-muted/35 text-[11px] font-medium text-ink-muted hover:text-ink hover:border-ink-muted/60 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
      >
        <LucideIcons.ChevronDown className="w-3.5 h-3.5" />
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
          <TypeIcon typeId={card.type} color={accent} className="w-3.5 h-3.5" />
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
        <LucideIcons.CornerDownRight className="w-3 h-3 flex-shrink-0 text-ink-muted/50" />
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: accent }} />
        <span className="min-w-0 truncate text-[11px] text-ink">{card.label}</span>
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
      {!isConstituent && (
        <div
          className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${accent}1f` }}
        >
          <TypeIcon typeId={card.type} color={accent} className="w-3.5 h-3.5" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="flex items-center gap-1.5 min-w-0 text-[12px] font-medium text-ink leading-snug">
          <span className="truncate">{card.label}</span>
          {card.rollup && (
            <span
              className="flex-shrink-0 flex items-center gap-0.5 px-1 py-px rounded bg-black/[0.05] dark:bg-white/[0.07] text-[8.5px] font-semibold uppercase tracking-wide text-ink-muted/70"
              title="A coarser-grain summary of finer flows — not an additional connection"
            >
              <LucideIcons.Layers className="w-2.5 h-2.5" />
              rollup
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
          {card.drillKey && card.aggregateEdge ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); ctx.onToggleDrill(card.drillKey!, card.aggregateEdge!) }}
              title={`Refine — see the ${card.count.toLocaleString()} underlying connection${card.count === 1 ? '' : 's'} this rolls up`}
              className="flex items-center gap-0.5 tabular-nums font-semibold text-ink-muted hover:text-accent-lineage transition-colors"
            >
              ×{card.count.toLocaleString()}
              <LucideIcons.ChevronDown className={cn('w-2.5 h-2.5 transition-transform', !card.drilled && '-rotate-90')} />
            </button>
          ) : (
            card.count > 1 && <span className="tabular-nums font-semibold text-ink-muted flex-shrink-0">×{card.count.toLocaleString()}</span>
          )}
          {card.unresolved && <span className="italic flex-shrink-0">· not on canvas</span>}
        </p>
        {card.missingConstituents > 0 && (
          <p className="text-[8.5px] text-ink-muted/60 leading-none">
            +{card.missingConstituents.toLocaleString()} more not loaded
          </p>
        )}
      </div>
      <CardActions card={card} ctx={ctx} />
      <FrontierPill card={card} ctx={ctx} />
    </div>
  )
}

const MemoFocusGraphCard = memo(FocusGraphCard)

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

const NODE_TYPES = { focusCard: MemoFocusGraphCard, bandLabel: BandLabelNode }

// ── Edge ─────────────────────────────────────────────────────────────

function FocusGraphEdgeComp({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps) {
  const d = data as unknown as {
    count: number
    aggregated: boolean
    containment: boolean
    dimmed: boolean
    tint: string
    emphasized: boolean
    hoverActive: boolean
  }
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  // Hovering a card lights up ITS connections and quiets the rest —
  // the read-your-neighborhood gesture.
  const opacity = d.dimmed ? 0.12
    : d.emphasized ? 1
      : d.hoverActive ? 0.2
        : d.containment ? 0.45 : 0.7
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: d.tint,
          strokeWidth: d.emphasized ? (d.aggregated ? 3 : 2.5) : d.aggregated ? 2 : 1.5,
          strokeDasharray: d.containment ? '4 4' : undefined,
          opacity,
          transition: 'opacity 120ms, stroke-width 120ms',
        }}
      />
      {d.count > 1 && !d.dimmed && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, opacity: d.hoverActive && !d.emphasized ? 0.3 : 1 }}
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
function GraphControls({ reducedMotion }: { reducedMotion: boolean }) {
  const rf = useReactFlow()
  const dur = reducedMotion ? 0 : 200
  const btn = 'w-7 h-7 flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'
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
  selectedId,
  reducedMotion,
  edgeTypeInfo,
  onSelect,
  onFocus,
  onToggleGroup,
  onToggleDrill,
  onExpandFrontier,
  onShowMore,
  onRetryFetch,
  onRevealOnCanvas,
  onOpenDetails,
}: FocusGraphViewProps) {
  // Identity-stable across selection & hover — see the perf contract
  // in the file header.
  const ctx = useMemo<CardCtx>(() => ({
    edgeTypeInfo,
    onSelect,
    onFocus,
    onToggleGroup,
    onToggleDrill,
    onExpandFrontier,
    onShowMore,
    onRetryFetch,
    onRevealOnCanvas,
    onOpenDetails,
  }), [edgeTypeInfo, onSelect, onFocus, onToggleGroup, onToggleDrill, onExpandFrontier, onShowMore, onRetryFetch, onRevealOnCanvas, onOpenDetails])

  const focalIn = focalStats.in
  const focalOut = focalStats.out

  const baseNodes = useMemo((): Node[] => {
    const minYByBand = new Map<number, number>()
    for (const c of graph.cards) {
      const cur = minYByBand.get(c.band)
      if (cur === undefined || c.y < cur) minYByBand.set(c.band, c.y)
    }
    const nodes: Node[] = graph.cards.map((card) => ({
      id: card.id,
      type: 'focusCard',
      position: { x: card.x, y: card.y },
      draggable: false,
      selectable: false,
      focusable: false,
      data: card.kind === 'focal'
        ? { card, ctx, focalStats: { in: focalIn, out: focalOut } }
        : { card, ctx },
    }))
    // Hop-band headers with honest shown/total counts.
    for (const [band, minY] of minYByBand) {
      if (band === 0) continue
      const totals = graph.bandTotals.get(`${band < 0 ? 'in' : 'out'}:${Math.abs(band)}`)
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

  // Selection rides React Flow's own `selected` flag so changing it
  // re-renders exactly the affected memoized cards.
  const nodes = useMemo(() => baseNodes.map((n) => {
    const cardNodeId = (n.data as { card?: FocusCard }).card?.nodeId ?? null
    const sel = cardNodeId != null && cardNodeId === selectedId
    return sel === !!n.selected ? n : { ...n, selected: sel }
  }), [baseNodes, selectedId])

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
        data: {
          count: e.count,
          aggregated: e.aggregated,
          containment: e.containment,
          dimmed: e.dimmed,
          tint,
          emphasized: hoveredId != null && (e.source === hoveredId || e.target === hoveredId),
          hoverActive: hoveredId != null,
        },
      }
    })
  }, [graph.cards, graph.edges, hoveredId])

  const [rf, setRf] = useState<ReactFlowInstance | null>(null)
  // Re-frame on focal swaps and expansion changes — the graph's shape
  // changed, so bring it back into view (instant under reduced motion).
  useEffect(() => {
    if (!rf) return
    const t = window.setTimeout(() => {
      void rf.fitView({ padding: 0.15, duration: reducedMotion ? 0 : 240, maxZoom: 1 })
    }, 30)
    return () => window.clearTimeout(t)
  }, [rf, focalId, graph.cards.length, reducedMotion])

  return (
    <div
      className={cn(
        'relative h-full w-full min-h-0 text-black/[0.16] dark:text-white/[0.14]',
        // Baked positions + stable card ids: a CSS transform transition
        // makes shared cards glide when the focal changes. The canvas
        // pans via the viewport pane, so this never fights dragging.
        !reducedMotion && '[&_.react-flow__node]:transition-transform [&_.react-flow__node]:duration-300',
      )}
    >
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
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          onPaneClick={() => onSelect(null)}
          onNodeMouseEnter={(_, n) => { if (n.type === 'focusCard') setHoveredId(n.id) }}
          onNodeMouseLeave={() => setHoveredId(null)}
          proOptions={{ hideAttribution: true }}
          style={{ background: 'transparent' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={26} size={1.25} color="currentColor" />
          <GraphControls reducedMotion={reducedMotion} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
