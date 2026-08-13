/**
 * LensGraphView — the Lens's interactive graph body.
 *
 * A React Flow instance of its own (separate from the canvas) rendering
 * what buildLensLayout produced: focal + partner cards in hop columns,
 * containment frames (React Flow subflows) that nest without limit, and
 * direction-tinted edges with readable relationship labels.
 *
 * Gestures, uniformly on every card at every depth:
 *   ⊕ per direction   fetch that entity's next hop of lineage;
 *   chevron           open what's inside it (paged, "load more");
 *   ×N edge chip      drill a rolled-up connection to constituents;
 *   click             inspect (detail strip);
 *   double-click      re-center the lens (recorded in history).
 *
 * All data flows in through useLensSession's state; this component owns
 * only presentation state (selection, page indices). Mount it with
 * key={focal} so paging and selection reset per focal by construction.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  MarkerType,
} from '@xyflow/react'
// The lens owns its own React Flow instance, so it must load the flow
// stylesheet itself — the canvas's import lives in GraphCanvas, which a
// reference view never mounts. Without it, node wrappers lose absolute
// positioning and the board collapses into document flow.
import '@xyflow/react/dist/style.css'
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  CornerUpLeft,
  Eye,
  HelpCircle,
  ImageDown,
  Loader2,
  Plus,
  SidebarOpen,
} from 'lucide-react'
import { useViewEntityTypeHierarchyMap, useViewRelationshipTypes } from '@/hooks/useViewSchema'
import { usePreferencesStore } from '@/store/preferences'
import { useEntityVisual } from '@/hooks/useEntityVisual'
import { DynamicIcon } from '@/lib/viewUtils'
import { relationshipLabel } from '@/lib/relationshipLabel'
import type { LensSessionApi } from './useLensSession'
import { expansionKeyOf, type LensDirection } from './lensGraph'
import {
  buildLensLayout,
  lensCardId,
  lensColumnKey,
  LENS_COLUMN_W,
  LENS_COL_GAP,
  LENS_FRAME_PAD,
  LENS_FRAME_STRIP_H,
  type LensBanner,
  type LensCard,
  type LensChevron,
  type LensFrame,
  type LensLayout,
  type LensPill,
} from './buildLensLayout'
import { useFrameCamera } from './useFrameCamera'

export interface LensGraphViewProps {
  session: LensSessionApi
  /** Re-center the lens on an entity (recorded in the walk history). */
  onFocus: (urn: string) => void
  onRevealOnCanvas?: (urn: string) => void
  onOpenDetails?: (urn: string) => void
  /** Frames that open in connected-only mode (share replay seed). */
  initialConnectedFrames?: ReadonlySet<string>
}

// ── Interaction context (kept off node data to avoid re-serializing) ──

interface LensInteractions {
  expandLineage: (dir: LensDirection, urn: string) => void
  retryExpansion: (dir: LensDirection, urn: string) => void
  /** The chevron travels with the gesture: routing (connected expand vs
   *  plain open vs fold) reads the builder's own summary of this card. */
  toggleChildren: (urn: string, chevron: LensChevron) => void
  loadMoreChildren: (urn: string) => void
  drillRecords: (recordIds: string[]) => void
  toggleFrameMode: (urn: string, mode: 'connected' | 'all') => void
  select: (urn: string) => void
  focus: (urn: string) => void
  framePage: (frameId: string, delta: number) => void
  hover: (urn: string | null) => void
}

// React Flow node/edge `data` must be serializable-ish objects; we pass
// the layout structs plus a stable ref to the interactions. Anything a
// node needs DURING RENDER (like selection) travels in data — the ref
// is strictly for event handlers.
type CardNodeData = { card: LensCard; selected: boolean; dimmed: boolean; io: { current: LensInteractions } }
type FrameNodeData = { frame: LensFrame; entityType: string; io: { current: LensInteractions } }
type BandNodeData = { band: { title: string; counts?: string; side: 'up' | 'down' | 'none' } }

/** Direction palette — the same reading the original design used:
 *  everything feeding the focal is cool, everything fed by it is warm. */
const UPSTREAM_TINT = '#0ea5e9'
const DOWNSTREAM_TINT = '#f59e0b'
const NEUTRAL_TINT = '#94a3b8'
type LensEdgeData = {
  label: string
  also: string[]
  bundledCount: number
  drillable: boolean
  drillState?: string
  recordIds: string[]
  emphasized: boolean
  io: { current: LensInteractions }
}

// ── Pills, chevrons ────────────────────────────────────────────────────

function PillButton({ pill, urn, io }: { pill: LensPill; urn: string; io: { current: LensInteractions } }) {
  const dirLabel = pill.dir === 'up' ? 'upstream' : 'downstream'
  if (pill.state === 'loading') {
    return (
      <span className="lens-pill inline-flex items-center gap-0.5 rounded-full border border-black/10 dark:border-white/10 bg-canvas px-1.5 py-0.5 text-2xs text-ink-muted">
        <Loader2 size={10} className="animate-spin" aria-hidden />
      </span>
    )
  }
  if (pill.state === 'error') {
    return (
      <button
        type="button"
        onClick={e => { e.stopPropagation(); io.current.retryExpansion(pill.dir, urn) }}
        className="lens-pill inline-flex items-center gap-0.5 rounded-full border border-red-500/40 bg-canvas px-1.5 py-0.5 text-2xs text-red-500 hover:bg-red-500/10"
        title={`Loading ${dirLabel} lineage failed — retry`}
      >
        <AlertCircle size={10} aria-hidden /> retry
      </button>
    )
  }
  if (pill.exhausted) {
    return (
      <span
        className="lens-pill inline-flex items-center rounded-full px-1.5 py-0.5 text-2xs text-ink-muted/50"
        title={`No further ${dirLabel} lineage in the data source`}
      >
        ·
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); io.current.expandLineage(pill.dir, urn) }}
      className="lens-pill inline-flex items-center gap-0.5 rounded-full border border-black/15 dark:border-white/15 bg-canvas px-1.5 py-0.5 text-2xs text-ink hover:border-accent-lineage hover:text-accent-lineage"
      title={
        pill.hint !== undefined
          ? `Show ${dirLabel} lineage (${pill.hint} more measured)`
          : `Show ${dirLabel} lineage`
      }
      aria-label={`Expand ${dirLabel} lineage of ${urn}`}
    >
      <Plus size={10} aria-hidden />
      {pill.hint !== undefined && pill.hint > 0 ? <span>{pill.hint}</span> : null}
    </button>
  )
}

function ChevronButton({ chevron, urn, io }: { chevron: LensChevron; urn: string; io: { current: LensInteractions } }) {
  if (!chevron.offered && chevron.state === 'idle' && chevron.connectedCandidates === 0 && !chevron.connectedState) {
    return null
  }
  const loading = chevron.state === 'loading' || chevron.connectedState === 'loading'
  const errored = chevron.state === 'error' || chevron.connectedState === 'error'
  const open = chevron.state === 'done' || chevron.connectedState === 'done' || loading
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); io.current.toggleChildren(urn, chevron) }}
      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-2xs text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
      title={
        errored
          ? 'Loading contents failed — retry'
          : open
            ? `Contents (${chevron.shown}${chevron.count !== undefined ? ` of ${chevron.count}` : ''} shown)`
            : chevron.connectedCandidates > 0
              ? `Show what connects inside${chevron.count !== undefined ? ` (${chevron.count} total)` : ''}`
              : `Open contents${chevron.count !== undefined ? ` (${chevron.count})` : ''}`
      }
      aria-label={`Open contents of ${urn}`}
    >
      {loading ? (
        <Loader2 size={11} className="animate-spin" aria-hidden />
      ) : errored ? (
        <AlertCircle size={11} className="text-red-500" aria-hidden />
      ) : open ? (
        <ChevronDown size={11} aria-hidden />
      ) : (
        <ChevronRight size={11} aria-hidden />
      )}
      {chevron.count !== undefined && !open ? <span>{chevron.count}</span> : null}
    </button>
  )
}

// ── Node renderers ─────────────────────────────────────────────────────

function CardNode({ data }: NodeProps<Node<CardNodeData>>) {
  const { card, selected, dimmed, io } = data
  const visual = useEntityVisual(card.entityType || 'entity')
  const accent = visual.color
  const tooltip = [card.qualifiedName || card.urn, card.description].filter(Boolean).join('\n')
  const gestures = (
    <span className="flex shrink-0 items-center gap-1">
      <PillButton pill={card.pills.up} urn={card.urn} io={io} />
      <ChevronButton chevron={card.chevron} urn={card.urn} io={io} />
      <PillButton pill={card.pills.down} urn={card.urn} io={io} />
    </span>
  )
  const handles = (
    <>
      {/* Wires attach here: data flows left → right. Invisible — the
          card edge is the visual, the handle is just the anchor. */}
      <Handle type="target" position={Position.Left} className="!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent" />
      <Handle type="source" position={Position.Right} className="!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent" />
    </>
  )

  // ── Focal: the anchor card — bigger, gradient, in/out tally ──
  if (card.isFocal) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => io.current.select(card.urn)}
        onKeyDown={e => { if (e.key === 'Enter') io.current.select(card.urn) }}
        onMouseEnter={() => io.current.hover(card.urn)}
        onMouseLeave={() => io.current.hover(null)}
        style={{
          borderColor: accent,
          background: `linear-gradient(150deg, ${accent}24, ${accent}08 60%)`,
          boxShadow: selected ? `0 10px 34px ${accent}55` : `0 10px 34px ${accent}33`,
        }}
        className={`group relative h-full w-full cursor-pointer rounded-xl border-2 bg-canvas-elevated px-3.5 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 ${
          selected ? 'ring-2 ring-accent-lineage ring-offset-1 ring-offset-canvas-elevated' : ''
        } ${dimmed ? 'opacity-30' : ''}`}
        data-lens-card={card.urn}
      >
        {handles}
        <div className="flex items-center gap-1.5">
          <span style={{ color: accent }} aria-hidden>
            <DynamicIcon name={visual.icon} className="h-3.5 w-3.5" />
          </span>
          <p className="truncate text-[9.5px] font-bold uppercase tracking-[0.12em]" style={{ color: accent }}>
            {card.entityType || 'entity'}
          </p>
        </div>
        <p className="truncate text-[13.5px] font-semibold leading-snug text-ink" title={tooltip || card.label}>
          {card.label}
        </p>
        <div className="flex items-center gap-1 truncate text-[9.5px] leading-snug text-ink-muted">
          <span aria-hidden>⇡</span>
          {card.breadcrumb.length > 0 ? (
            card.breadcrumb.map((b, i) => (
              <span key={b.urn} className="flex min-w-0 items-center gap-1">
                {i > 0 ? <span aria-hidden>›</span> : null}
                <button
                  type="button"
                  className="nodrag truncate hover:text-accent-lineage hover:underline"
                  onClick={e => { e.stopPropagation(); io.current.focus(b.urn) }}
                  title={`Focus ${b.label}`}
                >
                  {b.label}
                </button>
              </span>
            ))
          ) : (
            <span className="truncate">top level</span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2.5 border-t border-black/[0.07] pt-1 text-[10.5px] font-medium tabular-nums dark:border-white/[0.08]">
          {card.degrees ? (
            <>
              <span className="flex items-center gap-1 text-sky-600 dark:text-sky-400" title="Measured incoming lineage edges">
                ↙ {card.degrees.in} in
              </span>
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400" title="Measured outgoing lineage edges">
                ↗ {card.degrees.out} out
              </span>
            </>
          ) : null}
          {card.reach ? (
            <span
              className="min-w-0 truncate text-[9px] font-normal text-ink-muted"
              title="Distinct entities reached transitively (bounded measurement; + marks a floor)"
            >
              reaches {card.reach.up}
              {card.reach.truncated ? '+' : ''} upstream · {card.reach.down}
              {card.reach.truncated ? '+' : ''} downstream
            </span>
          ) : null}
          <span className="ml-auto">{gestures}</span>
        </div>
      </div>
    )
  }

  // ── Entity card: one connection partner (or child row) ──
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => io.current.select(card.urn)}
      onDoubleClick={() => io.current.focus(card.urn)}
      onKeyDown={e => { if (e.key === 'Enter') io.current.select(card.urn) }}
      onMouseEnter={() => io.current.hover(card.urn)}
      onMouseLeave={() => io.current.hover(null)}
      title={`${card.label}${card.description ? ` — ${card.description}` : ''} · click to inspect, double-click to focus`}
      style={{ borderLeftWidth: 3, borderLeftColor: accent }}
      className={`group relative flex h-full w-full cursor-pointer items-center gap-2 rounded-lg border bg-canvas-elevated px-2.5 transition-colors hover:border-accent-lineage/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 ${
        selected ? 'ring-2 ring-accent-lineage border-black/[0.07] dark:border-white/[0.08]' : 'border-black/[0.07] dark:border-white/[0.08]'
      } ${dimmed ? 'opacity-30' : card.connected === false ? 'opacity-45' : ''}`}
      data-lens-card={card.urn}
      {...(card.connected === false ? { 'data-lens-quiet': true } : {})}
    >
      {handles}
      <div
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
        style={{ backgroundColor: `${accent}1f`, color: accent }}
        aria-hidden
      >
        <DynamicIcon name={visual.icon} className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium leading-snug text-ink">
          <span className="truncate" title={tooltip || card.label}>{card.label}</span>
        </p>
        <p className="flex min-w-0 items-center gap-1 text-[9.5px] leading-snug text-ink-muted/70">
          <span className="truncate">{card.entityType || 'entity'}</span>
          {card.parentLabel ? (
            <>
              <span className="text-ink-muted/40">·</span>
              <span className="truncate" title={`Inside ${card.parentLabel}`}>{card.parentLabel}</span>
            </>
          ) : null}
          {card.degrees ? (
            <span
              className="flex-shrink-0 font-semibold tabular-nums text-ink-muted"
              title={`Measured lineage: ${card.degrees.in} in, ${card.degrees.out} out`}
            >
              {card.degrees.in}↑ {card.degrees.out}↓
            </span>
          ) : null}
        </p>
      </div>
      {gestures}
    </div>
  )
}

/** Column context above each hop: which side, which hop, how many. */
function BandNode({ data }: NodeProps<Node<BandNodeData>>) {
  const { band } = data
  if (band.side === 'none') {
    return (
      <div className="pointer-events-none flex h-full w-full items-end pb-1 text-[10.5px] italic leading-snug text-ink-muted/60">
        {band.title}
      </div>
    )
  }
  return (
    <div className="pointer-events-none flex h-full w-full items-baseline justify-start gap-1.5 whitespace-nowrap pb-1">
      <span
        className="self-center text-[11px]"
        style={{ color: band.side === 'up' ? UPSTREAM_TINT : DOWNSTREAM_TINT }}
        aria-hidden
      >
        {band.side === 'up' ? '↙' : '↗'}
      </span>
      <span className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-ink-muted/70">{band.title}</span>
      {band.counts ? <span className="text-[9px] tabular-nums text-ink-muted/50">{band.counts}</span> : null}
    </div>
  )
}

function FrameNode({ data }: NodeProps<Node<FrameNodeData>>) {
  const { frame, entityType, io } = data
  const { color } = useEntityVisual(entityType || 'entity')
  const paged = frame.pageCount > 1
  return (
    <div
      className="h-full w-full rounded-xl border-2 border-dashed bg-black/[0.02] dark:bg-white/[0.03]"
      style={{ borderColor: `${color}55` }}
      data-lens-frame={frame.urn}
    >
      {!frame.headerCardId ? (
        <div className="flex h-[34px] items-center gap-1.5 px-2.5">
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
            style={{ backgroundColor: `${color}1f`, color }}
            aria-hidden
          >
            <DynamicIcon name="Box" className="h-3 w-3" />
          </span>
          <button
            type="button"
            className="nodrag min-w-0 truncate text-[11.5px] font-semibold leading-tight text-ink hover:text-accent-lineage hover:underline"
            onClick={() => io.current.focus(frame.urn)}
            title={`Focus ${frame.label}`}
          >
            {frame.label}
          </button>
          <span className="ml-auto shrink-0 text-[9.5px] text-ink-muted/70">
            {frame.totalMembers} connected inside
          </span>
        </div>
      ) : null}
      {frame.mode && frame.stripY !== undefined ? (
        /* Connected-context strip: honest counts, the Connected|All
           toggle, and the walked pass-through path. */
        <div
          className="absolute flex items-center gap-1.5 overflow-hidden whitespace-nowrap px-1.5 text-[9px] leading-none text-ink-muted"
          style={{
            top: frame.stripY - frame.y,
            left: LENS_FRAME_PAD,
            width: frame.w - 2 * LENS_FRAME_PAD,
            height: LENS_FRAME_STRIP_H,
          }}
          data-lens-strip={frame.urn}
        >
          {frame.walkPath && frame.walkPath.length > 0 ? (
            <span
              className="min-w-0 truncate font-medium"
              title={`Walked through ${frame.walkPath.join(' › ')} — single connected path`}
            >
              {frame.walkCapped ? '⋯ › ' : '› '}
              {frame.walkPath.join(' › ')}
            </span>
          ) : null}
          <span className="shrink-0 tabular-nums">
            {frame.mode === 'connected'
              ? `${frame.connectedCount ?? 0} connected`
              : `${frame.totalMembers} inside · ${frame.connectedCount ?? 0} connected`}
          </span>
          <button
            type="button"
            className="nodrag ml-auto shrink-0 rounded-full border border-black/15 dark:border-white/15 px-1.5 py-px text-[9px] text-ink hover:border-accent-lineage hover:text-accent-lineage"
            onClick={e => {
              e.stopPropagation()
              io.current.toggleFrameMode(frame.urn, frame.mode === 'connected' ? 'all' : 'connected')
            }}
            title={
              frame.mode === 'connected'
                ? 'Show everything inside (connected stay highlighted)'
                : 'Show only what the lineage reaches'
            }
          >
            {frame.mode === 'connected'
              ? `Show all${frame.containedTotal !== undefined ? ` (${frame.containedTotal})` : ''}`
              : 'Connected only'}
          </button>
        </div>
      ) : null}
      {paged ? (
        <div
          className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 pb-1 text-2xs text-ink-muted"
          data-lens-frame-pager={frame.id}
        >
          <button
            type="button"
            className="rounded px-1 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30"
            disabled={frame.page === 0}
            onClick={e => { e.stopPropagation(); io.current.framePage(frame.id, -1) }}
          >
            ‹
          </button>
          <span>
            page {frame.page + 1} of {frame.pageCount} · {frame.shownMembers} of {frame.totalMembers}
          </span>
          <button
            type="button"
            className="rounded px-1 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30"
            disabled={frame.page >= frame.pageCount - 1}
            onClick={e => { e.stopPropagation(); io.current.framePage(frame.id, 1) }}
          >
            ›
          </button>
        </div>
      ) : null}
    </div>
  )
}

// ── Edge renderer ──────────────────────────────────────────────────────

function LensEdgeComponent(props: EdgeProps<Edge<LensEdgeData>>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, style } = props
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  if (!data) return <BaseEdge id={id} path={path} markerEnd={markerEnd} />
  const showChip = data.bundledCount > 1 || data.drillable
  // The wire stays quiet: the relationship name appears on hover
  // (emphasized), while the ×N drill affordance is always present.
  const showLabel = data.emphasized
  if (!showChip && !showLabel) return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className="pointer-events-auto absolute flex items-center gap-1 rounded bg-canvas-elevated/90 px-1 py-0.5 text-2xs text-ink-muted shadow-sm"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {showLabel ? (
            <span title={data.also.length > 0 ? `Also: ${data.also.join(', ')}` : undefined}>{data.label}</span>
          ) : null}
          {showChip ? (
            data.drillState === 'loading' ? (
              <Loader2 size={10} className="animate-spin" aria-hidden />
            ) : data.drillable ? (
              <button
                type="button"
                className="rounded-full border border-black/15 dark:border-white/15 px-1 hover:border-accent-lineage hover:text-accent-lineage"
                onClick={() => data.io.current.drillRecords(data.recordIds)}
                title={`${data.label} — rolled-up connection standing for ${data.bundledCount} underlying; click to show constituents`}
              >
                ×{data.bundledCount}
              </button>
            ) : (
              <span
                title={
                  data.drillState === 'done'
                    ? `${data.label} — no further breakdown recorded`
                    : `${data.label} — ${data.bundledCount} underlying connections`
                }
              >
                ×{data.bundledCount}
              </span>
            )
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

const nodeTypes = { lensCard: CardNode, lensFrame: FrameNode, lensBand: BandNode }
const edgeTypes = { lensEdge: LensEdgeComponent }

// ── Banners ────────────────────────────────────────────────────────────

function Banners({ banners, labelFor, onFocus, onRetry }: {
  banners: LensBanner[]
  labelFor: (urn: string) => string
  onFocus: (urn: string) => void
  onRetry: (key: string) => void
}) {
  if (banners.length === 0) return null
  return (
    <div className="pointer-events-auto absolute left-1/2 top-2 z-10 flex max-w-[90%] -translate-x-1/2 flex-col items-center gap-1">
      {banners.map(b => (
        <div
          key={`${b.kind}:${b.key}`}
          className="flex items-center gap-2 rounded-full border border-black/10 dark:border-white/10 bg-canvas-elevated/95 px-3 py-1 text-2xs text-ink-muted shadow-sm"
        >
          {b.kind === 'inherited' ? (
            <>
              <span>
                No lineage of its own at this grain — nearest ancestor with lineage:{' '}
                <strong className="text-ink">{labelFor(b.detail)}</strong>
              </span>
              <button
                type="button"
                className="rounded-full border border-black/15 dark:border-white/15 px-2 py-0.5 text-ink hover:border-accent-lineage hover:text-accent-lineage"
                onClick={() => onFocus(b.detail)}
              >
                Focus it
              </button>
            </>
          ) : b.kind === 'truncated' ? (
            <span>
              Partial picture: <strong className="text-ink">{b.detail === 'fetch_limit' ? 'direct-edge fetch hit its cap' : b.detail}</strong> — counts are floors, not totals
            </span>
          ) : (
            <>
              <AlertCircle size={11} className="text-red-500" aria-hidden />
              <span>A fetch failed</span>
              <button
                type="button"
                className="rounded-full border border-black/15 dark:border-white/15 px-2 py-0.5 text-ink hover:border-accent-lineage hover:text-accent-lineage"
                onClick={() => onRetry(b.key)}
              >
                Retry
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Detail strip ───────────────────────────────────────────────────────

function DetailStrip({ urn, session, onFocus, onRevealOnCanvas, onOpenDetails, onClose }: {
  urn: string
  session: LensSessionApi
  onFocus: (urn: string) => void
  onRevealOnCanvas?: (urn: string) => void
  onOpenDetails?: (urn: string) => void
  onClose: () => void
}) {
  const node = session.state.nodes.get(urn)
  const degree = session.state.degrees.get(urn)
  const label = node?.displayName || urn
  return (
    <div className="pointer-events-auto absolute inset-x-2 bottom-2 z-10 flex items-center gap-3 rounded-lg border border-black/10 dark:border-white/10 bg-canvas-elevated/95 px-3 py-2 shadow-md">
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold text-ink" title={urn}>{label}</div>
        <div className="truncate text-2xs text-ink-muted">
          {node?.entityType ?? 'entity'}
          {degree ? ` · ${degree.in} in / ${degree.out} out` : ''}
          {node?.description ? ` — ${node.description}` : ''}
        </div>
      </div>
      {urn !== session.state.focal ? (
        <button
          type="button"
          className="shrink-0 rounded border border-accent-lineage/60 px-2 py-1 text-2xs font-medium text-accent-lineage hover:bg-accent-lineage/10"
          onClick={() => onFocus(urn)}
        >
          Focus here
        </button>
      ) : null}
      {onRevealOnCanvas ? (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded border border-black/15 dark:border-white/15 px-2 py-1 text-2xs text-ink hover:border-black/30 dark:hover:border-white/30"
          onClick={() => onRevealOnCanvas(urn)}
        >
          <Eye size={11} aria-hidden /> Reveal on canvas
        </button>
      ) : null}
      {onOpenDetails ? (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded border border-black/15 dark:border-white/15 px-2 py-1 text-2xs text-ink hover:border-black/30 dark:hover:border-white/30"
          onClick={() => onOpenDetails(urn)}
        >
          <SidebarOpen size={11} aria-hidden /> Details
        </button>
      ) : null}
      <button
        type="button"
        className="shrink-0 rounded px-1 text-2xs text-ink-muted hover:text-ink"
        onClick={onClose}
        aria-label="Close details"
      >
        ✕
      </button>
    </div>
  )
}

// ── The view ───────────────────────────────────────────────────────────

/** Bottom-right corner controls: camera, gesture guide, PNG export. */
function CornerControls({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const rf = useReactFlow()
  const [guideOpen, setGuideOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const exportPng = useCallback(async () => {
    const el = containerRef.current?.querySelector<HTMLElement>('.react-flow')
    if (!el || exporting) return
    setExporting(true)
    try {
      // Rasterizer loaded lazily — a PNG button must not weigh on the
      // lens's open path.
      const { toPng } = await import('html-to-image')
      const url = await toPng(el, { pixelRatio: 2 })
      const a = document.createElement('a')
      a.href = url
      a.download = 'lineage-lens.png'
      a.click()
    } catch {
      // Export is a convenience; failing quietly beats breaking the lens.
    } finally {
      setExporting(false)
    }
  }, [containerRef, exporting])
  return (
    <div className="pointer-events-auto absolute bottom-2 right-2 z-10 flex items-center gap-1">
      {guideOpen ? (
        <div className="mr-1 w-64 rounded-lg border border-black/10 dark:border-white/10 bg-canvas-elevated/95 p-2 text-2xs text-ink-muted shadow-md">
          <div className="mb-1 font-semibold text-ink">Reading the graph</div>
          <ul className="space-y-1">
            <li><strong className="text-ink">⊕</strong> — fetch that entity's next hop of lineage (per direction; numbers are measured, never guessed).</li>
            <li><strong className="text-ink">›</strong> — open what's inside it. On a rolled-up partner this opens <em>connected only</em> — exactly the contents the wires reach, walking straight through single-child levels; the frame header toggles to everything inside.</li>
            <li><strong className="text-ink">×N</strong> on a wire — a rolled-up connection; click to see its constituents.</li>
            <li><strong className="text-ink">Click</strong> inspects · <strong className="text-ink">double-click</strong> re-centers (Back/Forward retrace).</li>
            <li>Dashed wires are rollups; frames group entities inside their parent.</li>
          </ul>
        </div>
      ) : null}
      <div className="flex items-center overflow-hidden rounded-full border border-black/10 dark:border-white/10 bg-canvas-elevated/95 shadow-sm">
        <button
          type="button"
          className="p-1.5 text-ink-muted hover:text-ink"
          onClick={() => void rf.zoomOut({ duration: 150 })}
          title="Zoom out"
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          className="p-1.5 text-ink-muted hover:text-ink"
          onClick={() => void rf.fitView({ padding: 0.15, duration: 200, maxZoom: 1.5 })}
          title="Fit the whole picture"
          aria-label="Fit view"
        >
          ▣
        </button>
        <button
          type="button"
          className="p-1.5 text-ink-muted hover:text-ink"
          onClick={() => void rf.zoomIn({ duration: 150 })}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
      </div>
      <button
        type="button"
        className={`rounded-full border border-black/10 dark:border-white/10 bg-canvas-elevated/95 p-1.5 shadow-sm hover:text-ink ${guideOpen ? 'text-ink' : 'text-ink-muted'}`}
        onClick={() => setGuideOpen(o => !o)}
        title="How to read this graph"
        aria-label="Gesture guide"
      >
        <HelpCircle size={13} />
      </button>
      <button
        type="button"
        className="rounded-full border border-black/10 dark:border-white/10 bg-canvas-elevated/95 p-1.5 text-ink-muted shadow-sm hover:text-ink disabled:opacity-40"
        onClick={() => void exportPng()}
        disabled={exporting}
        title="Download the graph as a PNG"
        aria-label="Export as image"
      >
        {exporting ? <Loader2 size={13} className="animate-spin" /> : <ImageDown size={13} />}
      </button>
    </div>
  )
}

function LensGraphViewInner({ session, onFocus, onRevealOnCanvas, onOpenDetails, initialConnectedFrames }: LensGraphViewProps) {
  // The camera drives the LIVE instance from useReactFlow(); onInit is
  // only the readiness signal. Two dead ends documented so they are
  // never retried: an instance CAPTURED in onInit can be a zombie bound
  // to a torn-down internal store (StrictMode re-mount) — its fitView
  // mutates a dead store and the screen never moves; and
  // useNodesInitialized never flips for this flow, so gating on it
  // leaves every camera path dead and React Flow's own initial fit —
  // taken while only the focal was mounted — as the viewport's final
  // state.
  const rfLive = useReactFlow()
  const [flowReady, setFlowReady] = useState(false)
  const rf: ReactFlowInstance | null = flowReady ? rfLive : null
  const containerRef = useRef<HTMLDivElement | null>(null)
  const reducedMotion = usePreferencesStore(s => s.reducedMotion)
  const hierarchyMap = useViewEntityTypeHierarchyMap()
  const relationshipTypes = useViewRelationshipTypes()
  const [pages, setPages] = useState<ReadonlyMap<string, number>>(new Map())
  const [collapsedChildren, setCollapsedChildren] = useState<ReadonlySet<string>>(new Set())
  const [connectedFrames, setConnectedFrames] = useState<ReadonlySet<string>>(
    () => initialConnectedFrames ?? new Set(),
  )
  const [walkCapped, setWalkCapped] = useState<ReadonlySet<string>>(new Set())
  const [selectedUrn, setSelectedUrn] = useState<string | null>(null)
  const [hoveredUrn, setHoveredUrn] = useState<string | null>(null)

  const edgeLabelFor = useCallback(
    (norm: string): string => {
      const match = relationshipTypes.find(rt => rt.id.toUpperCase() === norm)
      if (norm === 'AGGREGATED') return 'Rolled up'
      return match?.name || relationshipLabel(norm)
    },
    [relationshipTypes],
  )

  const canHaveChildren = useCallback(
    (entityType: string): boolean => {
      const h = hierarchyMap[entityType]
      return h ? h.canContain.length > 0 : true
    },
    [hierarchyMap],
  )

  const layout: LensLayout = useMemo(
    () => buildLensLayout(session.state, { pages, canHaveChildren, collapsedChildren, connectedFrames, walkCapped }),
    [session.state, pages, canHaveChildren, collapsedChildren, connectedFrames, walkCapped],
  )

  // Interactions live behind a ref so node data stays referentially
  // stable across renders that only change handlers. The ref is written
  // in an effect (never during render) and read only in event handlers.
  const ioRef = useRef<LensInteractions>({
    expandLineage: () => {},
    retryExpansion: () => {},
    toggleChildren: () => {},
    loadMoreChildren: () => {},
    drillRecords: () => {},
    toggleFrameMode: () => {},
    select: () => {},
    focus: () => {},
    framePage: () => {},
    hover: () => {},
  })
  useEffect(() => {
    const toggleFold = (urn: string) => {
      setCollapsedChildren(prev => {
        const next = new Set(prev)
        if (next.has(urn)) next.delete(urn)
        else next.add(urn)
        return next
      })
    }
    // The connected expand is never a dead click: zero mapped records
    // falls back to the plain contents open in "everything inside" mode.
    const runConnectedExpand = async (urn: string) => {
      setConnectedFrames(prev => new Set(prev).add(urn))
      const { records, capped } = await session.connectedExpand(urn)
      if (capped) setWalkCapped(prev => new Set(prev).add(urn))
      if (records === 0) {
        setConnectedFrames(prev => {
          const next = new Set(prev)
          next.delete(urn)
          return next
        })
        session.openChildren(urn)
      }
    }
    ioRef.current = {
      expandLineage: session.expandLineage,
      retryExpansion: session.retryExpansion,
      toggleChildren: (urn: string, chevron: LensChevron) => {
        // Routing, in order: in-flight waits; failures re-fire; open
        // contents fold/unfold (data stays — a folded child that is a
        // lineage partner in its own right stays on the board); rollup
        // partners open CONNECTED (drill what the wires stand for);
        // everything else opens its plain contents.
        if (chevron.state === 'loading' || chevron.connectedState === 'loading') return
        if (chevron.connectedState === 'error') {
          void runConnectedExpand(urn)
          return
        }
        if (chevron.state === 'error') {
          session.retryChildren(urn)
          return
        }
        if (chevron.connectedState === 'done' || session.state.children.has(urn)) {
          toggleFold(urn)
          return
        }
        if (chevron.connectedCandidates > 0) {
          void runConnectedExpand(urn)
          return
        }
        session.openChildren(urn)
      },
      loadMoreChildren: session.loadMoreChildren,
      drillRecords: (recordIds: string[]) => {
        for (const recordId of recordIds) {
          const record = session.state.records.get(recordId)
          if (!record?.rollupEdge) continue
          // The side being OPENED is the endpoint farther from the focal —
          // drilling an app→platform rollup means "open the platform".
          const sourceHop = Math.abs(session.state.hops.get(record.source) ?? 0)
          const targetHop = Math.abs(session.state.hops.get(record.target) ?? 0)
          const anchor = targetHop >= sourceHop ? record.rollupEdge.targetUrn : record.rollupEdge.sourceUrn
          session.drillRollup(recordId, anchor)
        }
      },
      toggleFrameMode: (urn: string, mode: 'connected' | 'all') => {
        if (mode === 'all' && !session.state.children.has(urn)) session.openChildren(urn)
        setConnectedFrames(prev => {
          const next = new Set(prev)
          if (mode === 'connected') next.add(urn)
          else next.delete(urn)
          return next
        })
      },
      select: (urn: string) => setSelectedUrn(prev => (prev === urn ? null : urn)),
      focus: onFocus,
      framePage: (frameId: string, delta: number) => {
        setPages(prev => {
          const next = new Map(prev)
          next.set(frameId, Math.max(0, (prev.get(frameId) ?? 0) + delta))
          return next
        })
      },
      hover: setHoveredUrn,
    }
  }, [session, onFocus])

  // Hover adjacency: the hovered card, its edge partners and the focal
  // stay bright; everything else dims. Card ids ↔ urns are 1:1.
  const hoverContext = useMemo(() => {
    if (!hoveredUrn) return null
    const hoveredCardId = lensCardId(hoveredUrn)
    const bright = new Set<string>([hoveredCardId, lensCardId(session.state.focal)])
    const incident = new Set<string>()
    for (const e of layout.edges) {
      if (e.sourceCardId === hoveredCardId || e.targetCardId === hoveredCardId) {
        incident.add(e.id)
        bright.add(e.sourceCardId)
        bright.add(e.targetCardId)
      }
    }
    return { bright, incident }
  }, [hoveredUrn, layout, session.state.focal])

  const nodes: Node[] = useMemo(() => {
    // The builder emits ABSOLUTE geometry, so every node is flat — no
    // React Flow subflow parenting (dragging is off, so parenting would
    // buy nothing and costs positioning quirks). Explicit width/height
    // on the node itself means fitView has real dimensions immediately,
    // before any DOM measurement.
    const bandNodes: Node[] = layout.columns
      .filter(col => col.hop !== 0)
      .map(col => {
        const side: 'up' | 'down' = col.hop < 0 ? 'up' : 'down'
        const title =
          col.hop === -1 ? 'Data sources' : col.hop === 1 ? 'Data consumers' : `${side === 'up' ? 'Upstream' : 'Downstream'} · hop ${Math.abs(col.hop)}`
        const cards = col.shownRoots < col.totalRoots ? `${col.shownRoots} of ${col.totalRoots}` : `${col.totalRoots}`
        const counts = `${cards} · ${col.connections} connection${col.connections === 1 ? '' : 's'}`
        return {
          id: `band:${col.hop}`,
          type: 'lensBand',
          position: { x: col.x, y: -44 },
          width: col.w,
          height: 36,
          data: { band: { title, counts, side } } satisfies BandNodeData,
          draggable: false,
          selectable: false,
          zIndex: 0,
        }
      })
    // Honest empty-direction whispers live IN board space, one slot
    // beyond the outermost real column — they can never overlap content
    // even when a grown column shifted the geometry.
    const emptySides: Node[] = []
    const upDone = session.state.expansions.get(expansionKeyOf('up', session.state.focal))?.state === 'done'
    const downDone = session.state.expansions.get(expansionKeyOf('down', session.state.focal))?.state === 'done'
    const hasUpCol = layout.columns.some(c => c.hop < 0)
    const hasDownCol = layout.columns.some(c => c.hop > 0)
    const leftmostX = layout.columns.length > 0 ? Math.min(...layout.columns.map(c => c.x)) : 0
    const rightmostEdge = layout.columns.length > 0 ? Math.max(...layout.columns.map(c => c.x + c.w)) : 0
    if (upDone && !hasUpCol) {
      emptySides.push({
        id: 'band:empty-up',
        type: 'lensBand',
        position: { x: leftmostX - LENS_COL_GAP - LENS_COLUMN_W, y: -44 },
        width: LENS_COLUMN_W,
        height: 36,
        data: { band: { title: 'No upstream lineage in the data source', side: 'none' } } satisfies BandNodeData,
        draggable: false,
        selectable: false,
        zIndex: 0,
      })
    }
    if (downDone && !hasDownCol) {
      emptySides.push({
        id: 'band:empty-down',
        type: 'lensBand',
        position: { x: rightmostEdge + LENS_COL_GAP, y: -44 },
        width: LENS_COLUMN_W,
        height: 36,
        data: { band: { title: 'No downstream lineage in the data source', side: 'none' } } satisfies BandNodeData,
        draggable: false,
        selectable: false,
        zIndex: 0,
      })
    }
    bandNodes.push(...emptySides)
    const frameNodes: Node[] = layout.frames.map(frame => ({
      id: frame.id,
      type: 'lensFrame',
      position: { x: frame.x, y: frame.y },
      width: frame.w,
      height: frame.h,
      data: {
        frame,
        entityType: session.state.nodes.get(frame.urn)?.entityType ?? '',
        io: ioRef,
      } satisfies FrameNodeData,
      draggable: false,
      selectable: false,
      zIndex: 0,
    }))
    const cardNodes: Node[] = layout.cards.map(card => ({
      id: card.id,
      type: 'lensCard',
      position: { x: card.x, y: card.y },
      width: card.w,
      height: card.h,
      data: {
        card,
        selected: selectedUrn === card.urn,
        dimmed: Boolean(hoverContext && !hoverContext.bright.has(card.id)),
        io: ioRef,
      } satisfies CardNodeData,
      draggable: false,
      zIndex: 1,
    }))
    // Frames render before cards so cards paint above their frame.
    return [...bandNodes, ...frameNodes, ...cardNodes]
  }, [layout, selectedUrn, hoverContext, session])

  const edges: Edge[] = useMemo(() => {
    // Direction tint: everything on the feeding side of the focal is
    // cool, everything on the consuming side is warm — the reading the
    // whole room shares. A cross-side wire (cycle) stays neutral.
    const hopByCardId = new Map<string, number>()
    for (const c of layout.cards) hopByCardId.set(c.id, c.hop)
    return layout.edges.map(e => {
      const emphasized = hoverContext?.incident.has(e.id) ?? false
      const muted = Boolean(hoverContext) && !emphasized
      const hs = hopByCardId.get(e.sourceCardId) ?? 0
      const ht = hopByCardId.get(e.targetCardId) ?? 0
      const stroke =
        hs <= 0 && ht <= 0 ? UPSTREAM_TINT : hs >= 0 && ht >= 0 ? DOWNSTREAM_TINT : NEUTRAL_TINT
      return {
        id: e.id,
        source: e.sourceCardId,
        target: e.targetCardId,
        type: 'lensEdge',
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: stroke },
        style: {
          stroke,
          strokeWidth: emphasized ? 2.5 : 1.5,
          opacity: muted ? 0.2 : 0.85,
          ...(e.edgeTypeNorm === 'AGGREGATED' ? { strokeDasharray: '6 3' } : {}),
        },
        data: {
          label: edgeLabelFor(e.edgeTypeNorm),
          also: e.alsoTypes.map(edgeLabelFor),
          bundledCount: e.bundledCount,
          drillable: e.drillable,
          ...(e.drillState ? { drillState: e.drillState } : {}),
          recordIds: e.recordIds,
          emphasized,
          io: ioRef,
        } satisfies LensEdgeData,
      }
    })
  }, [layout, edgeLabelFor, hoverContext])

  useFrameCamera(
    rf,
    lensCardId(session.state.focal),
    useMemo(
      () => [
        // Band headers are part of the picture the camera frames — a fit
        // that crops the column titles reads as a bug.
        ...layout.columns.filter(c => c.hop !== 0).map(c => ({ id: `band:${c.hop}` })),
        ...layout.frames.map(f => ({ id: f.id, ...(f.parentFrameId ? { parentFrameId: f.parentFrameId } : {}) })),
        ...layout.cards.map(c => ({ id: c.id, ...(c.parentFrameId ? { parentFrameId: c.parentFrameId } : {}) })),
      ],
      [layout],
    ),
    useMemo(() => layout.edges.map(e => ({ sourceCardId: e.sourceCardId, targetCardId: e.targetCardId })), [layout]),
    reducedMotion,
  )

  const retryFromBanner = useCallback(
    (key: string) => {
      const sep = key.indexOf(':')
      if (sep <= 0) return
      const dir = key.slice(0, sep) as LensDirection
      session.retryExpansion(dir, key.slice(sep + 1))
    },
    [session],
  )

  const labelFor = useCallback(
    (urn: string) => session.state.nodes.get(urn)?.displayName || urn,
    [session],
  )

  // Column-page controls for crowded hops ("+N more" as pages).
  const pagedColumns = layout.columns.filter(c => c.pageCount > 1)

  // Empty-direction whispers render as board-space band nodes (above);
  // the overlay only reports the initial load.
  const upState = session.state.expansions.get(expansionKeyOf('up', session.state.focal))
  const downState = session.state.expansions.get(expansionKeyOf('down', session.state.focal))
  const loading = upState?.state === 'loading' || downState?.state === 'loading'

  // One guaranteed full fit once the first paint has actually landed.
  // The incremental eases fire while the modal and fonts are still
  // settling, so their arithmetic can bake in a half-laid-out pane;
  // this final pass runs against the settled geometry exactly once.
  const settledRef = useRef(false)
  useEffect(() => {
    if (!rf || loading || settledRef.current) return
    const t = window.setTimeout(() => {
      // Stamped only once the move actually happens — stamping when it
      // is merely SCHEDULED means a cancelled run (StrictMode double-
      // invocation, any rapid re-render) marks the picture settled while
      // its timer was cleared, and the fit never fires.
      settledRef.current = true
      void rf.fitView({ padding: 0.15, duration: reducedMotion ? 0 : 240, maxZoom: 1.5 })
    }, 120)
    return () => window.clearTimeout(t)
  }, [rf, loading, reducedMotion])

  return (
    <div ref={containerRef} className="relative h-full w-full" data-lens-graph>
      {/* The flow mounts only once the first paint has landed, so React
          Flow's own initial fitView — the one camera move that is
          reliable in every environment, headless included — frames the
          COMPLETE first picture, never a half-loaded board. */}
      {loading ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <span className="flex items-center gap-2 rounded-full bg-canvas-elevated/90 px-3 py-1.5 text-xs text-ink-muted shadow">
            <Loader2 size={13} className="animate-spin" aria-hidden /> Loading lineage…
          </span>
        </div>
      ) : (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onInit={() => setFlowReady(true)}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1.5 }}
          nodesConnectable={false}
          nodesDraggable={false}
          zoomOnDoubleClick={false}
          panOnScroll
          minZoom={0.05}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          onPaneClick={() => setSelectedUrn(null)}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} className="opacity-40" />
        </ReactFlow>
      )}

      <Banners banners={layout.banners} labelFor={labelFor} onFocus={onFocus} onRetry={retryFromBanner} />
      {!selectedUrn && !loading ? <CornerControls containerRef={containerRef} /> : null}

      {pagedColumns.length > 0 ? (
        <div className="pointer-events-auto absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full border border-black/10 dark:border-white/10 bg-canvas-elevated/95 px-3 py-1 text-2xs text-ink-muted shadow-sm">
          {pagedColumns.map(col => (
            <span key={col.hop} className="flex items-center gap-1">
              <span>
                {col.hop < 0 ? `↑${-col.hop}` : `↓${col.hop}`} · {col.shownRoots} of {col.totalRoots}
              </span>
              <button
                type="button"
                className="rounded px-1 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30"
                disabled={col.page === 0}
                onClick={() => ioRef.current.framePage(lensColumnKey(col.hop), -1)}
                aria-label={`Previous page of hop ${col.hop}`}
              >
                ‹
              </button>
              <span>
                {col.page + 1}/{col.pageCount}
              </span>
              <button
                type="button"
                className="rounded px-1 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30"
                disabled={col.page >= col.pageCount - 1}
                onClick={() => ioRef.current.framePage(lensColumnKey(col.hop), 1)}
                aria-label={`Next page of hop ${col.hop}`}
              >
                ›
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {selectedUrn ? (
        <DetailStrip
          urn={selectedUrn}
          session={session}
          onFocus={onFocus}
          {...(onRevealOnCanvas ? { onRevealOnCanvas } : {})}
          {...(onOpenDetails ? { onOpenDetails } : {})}
          onClose={() => setSelectedUrn(null)}
        />
      ) : null}

      {/* Load-more affordance for open frames with more server pages. */}
      {[...session.state.children.entries()]
        .filter(([, kids]) => kids.state === 'done' && kids.hasMore)
        .slice(0, 1)
        .map(([urn, kids]) => (
          <div
            key={urn}
            className="pointer-events-auto absolute right-2 top-2 z-10 flex items-center gap-2 rounded-full border border-black/10 dark:border-white/10 bg-canvas-elevated/95 px-3 py-1 text-2xs text-ink-muted shadow-sm"
          >
            <CornerUpLeft size={10} aria-hidden />
            <span>
              {labelFor(urn)}: {kids.urns.length}
              {kids.total !== undefined ? ` of ${kids.total}` : ''} loaded
            </span>
            <button
              type="button"
              className="rounded-full border border-black/15 dark:border-white/15 px-2 py-0.5 text-ink hover:border-accent-lineage hover:text-accent-lineage"
              onClick={() => session.loadMoreChildren(urn)}
            >
              Load more
            </button>
          </div>
        ))}
    </div>
  )
}

export function LensGraphView(props: LensGraphViewProps) {
  return (
    <ReactFlowProvider>
      <LensGraphViewInner {...props} />
    </ReactFlowProvider>
  )
}
