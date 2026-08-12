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
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  MarkerType,
} from '@xyflow/react'
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  CornerUpLeft,
  Eye,
  Loader2,
  Plus,
  SidebarOpen,
} from 'lucide-react'
import { useViewEntityTypeHierarchyMap, useViewRelationshipTypes } from '@/hooks/useViewSchema'
import { usePreferencesStore } from '@/store/preferences'
import { generateColorFromType } from '@/lib/type-visuals'
import { relationshipLabel } from '@/lib/relationshipLabel'
import type { LensSessionApi } from './useLensSession'
import { expansionKeyOf, type LensDirection } from './lensGraph'
import {
  buildLensLayout,
  lensCardId,
  lensColumnKey,
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
}

// ── Interaction context (kept off node data to avoid re-serializing) ──

interface LensInteractions {
  expandLineage: (dir: LensDirection, urn: string) => void
  retryExpansion: (dir: LensDirection, urn: string) => void
  toggleChildren: (urn: string) => void
  loadMoreChildren: (urn: string) => void
  drillRecord: (recordId: string) => void
  select: (urn: string) => void
  focus: (urn: string) => void
  framePage: (frameId: string, delta: number) => void
}

// React Flow node/edge `data` must be serializable-ish objects; we pass
// the layout structs plus a stable ref to the interactions. Anything a
// node needs DURING RENDER (like selection) travels in data — the ref
// is strictly for event handlers.
type CardNodeData = { card: LensCard; selected: boolean; io: { current: LensInteractions } }
type FrameNodeData = { frame: LensFrame; io: { current: LensInteractions } }
type LensEdgeData = {
  label: string
  also: string[]
  bundledCount: number
  drillable: boolean
  drillState?: string
  recordId: string
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
  if (!chevron.offered && chevron.state === 'idle') return null
  const open = chevron.state === 'done' || chevron.state === 'loading'
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); io.current.toggleChildren(urn) }}
      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-2xs text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
      title={
        chevron.state === 'error'
          ? 'Loading contents failed — retry'
          : open
            ? `Contents (${chevron.shown}${chevron.count !== undefined ? ` of ${chevron.count}` : ''} shown)`
            : `Open contents${chevron.count !== undefined ? ` (${chevron.count})` : ''}`
      }
      aria-label={`Open contents of ${urn}`}
    >
      {chevron.state === 'loading' ? (
        <Loader2 size={11} className="animate-spin" aria-hidden />
      ) : chevron.state === 'error' ? (
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
  const { card, selected, io } = data
  const color = generateColorFromType(card.entityType || 'entity')
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => io.current.select(card.urn)}
      onDoubleClick={() => io.current.focus(card.urn)}
      onKeyDown={e => { if (e.key === 'Enter') io.current.select(card.urn) }}
      className={`flex h-full w-full flex-col justify-center rounded-lg border bg-canvas-elevated px-2 py-1 text-left shadow-sm transition-colors ${
        selected
          ? 'border-accent-lineage ring-1 ring-accent-lineage'
          : card.isFocal
            ? 'border-accent-lineage/70'
            : 'border-black/10 dark:border-white/10 hover:border-black/25 dark:hover:border-white/25'
      }`}
      data-lens-card={card.urn}
    >
      {card.isFocal && card.breadcrumb.length > 0 ? (
        <div className="mb-0.5 flex items-center gap-0.5 truncate text-2xs text-ink-muted">
          {card.breadcrumb.map((b, i) => (
            <span key={b.urn} className="flex min-w-0 items-center gap-0.5">
              {i > 0 ? <span aria-hidden>›</span> : null}
              <button
                type="button"
                className="truncate hover:text-accent-lineage hover:underline"
                onClick={e => { e.stopPropagation(); io.current.focus(b.urn) }}
                title={`Focus ${b.label}`}
              >
                {b.label}
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <span className={`truncate text-xs ${card.isFocal ? 'font-semibold' : 'font-medium'} text-ink`} title={card.label}>
          {card.label}
        </span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-1">
        <span className="truncate text-2xs text-ink-muted">
          {card.entityType || 'entity'}
          {card.parentLabel ? <span title={`Inside ${card.parentLabel}`}> · {card.parentLabel}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <PillButton pill={card.pills.up} urn={card.urn} io={io} />
          <ChevronButton chevron={card.chevron} urn={card.urn} io={io} />
          <PillButton pill={card.pills.down} urn={card.urn} io={io} />
        </span>
      </div>
    </div>
  )
}

function FrameNode({ data }: NodeProps<Node<FrameNodeData>>) {
  const { frame, io } = data
  const paged = frame.pageCount > 1
  return (
    <div className="h-full w-full rounded-xl border border-dashed border-black/20 dark:border-white/20 bg-black/[0.02] dark:bg-white/[0.03]">
      {!frame.headerCardId ? (
        <div className="flex items-center justify-between gap-1 px-2 pt-1.5 text-2xs text-ink-muted">
          <button
            type="button"
            className="truncate font-medium text-ink-muted hover:text-accent-lineage hover:underline"
            onClick={() => io.current.focus(frame.urn)}
            title={`Focus ${frame.label}`}
          >
            {frame.label}
          </button>
          <span className="shrink-0">{frame.totalMembers}</span>
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
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } = props
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  if (!data) return <BaseEdge id={id} path={path} markerEnd={markerEnd} />
  const showChip = data.bundledCount > 1 || data.drillable
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke: 'var(--lens-edge, #94a3b8)', strokeWidth: 1.25 }} />
      <EdgeLabelRenderer>
        <div
          className="pointer-events-auto absolute flex items-center gap-1 rounded bg-canvas-elevated/90 px-1 py-0.5 text-2xs text-ink-muted shadow-sm"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <span title={data.also.length > 0 ? `Also: ${data.also.join(', ')}` : undefined}>{data.label}</span>
          {showChip ? (
            data.drillState === 'loading' ? (
              <Loader2 size={10} className="animate-spin" aria-hidden />
            ) : data.drillable ? (
              <button
                type="button"
                className="rounded-full border border-black/15 dark:border-white/15 px-1 hover:border-accent-lineage hover:text-accent-lineage"
                onClick={() => data.io.current.drillRecord(data.recordId)}
                title={`Rolled-up connection standing for ${data.bundledCount} underlying — show constituents`}
              >
                ×{data.bundledCount}
              </button>
            ) : (
              <span title={`${data.bundledCount} underlying connections`}>×{data.bundledCount}</span>
            )
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

const nodeTypes = { lensCard: CardNode, lensFrame: FrameNode }
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

function LensGraphViewInner({ session, onFocus, onRevealOnCanvas, onOpenDetails }: LensGraphViewProps) {
  const rf = useReactFlow()
  const reducedMotion = usePreferencesStore(s => s.reducedMotion)
  const hierarchyMap = useViewEntityTypeHierarchyMap()
  const relationshipTypes = useViewRelationshipTypes()
  const [pages, setPages] = useState<ReadonlyMap<string, number>>(new Map())
  const [collapsedChildren, setCollapsedChildren] = useState<ReadonlySet<string>>(new Set())
  const [selectedUrn, setSelectedUrn] = useState<string | null>(null)

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
    () => buildLensLayout(session.state, { pages, canHaveChildren, collapsedChildren }),
    [session.state, pages, canHaveChildren, collapsedChildren],
  )

  // Interactions live behind a ref so node data stays referentially
  // stable across renders that only change handlers. The ref is written
  // in an effect (never during render) and read only in event handlers.
  const ioRef = useRef<LensInteractions>({
    expandLineage: () => {},
    retryExpansion: () => {},
    toggleChildren: () => {},
    loadMoreChildren: () => {},
    drillRecord: () => {},
    select: () => {},
    focus: () => {},
    framePage: () => {},
  })
  useEffect(() => {
    ioRef.current = {
      expandLineage: session.expandLineage,
      retryExpansion: session.retryExpansion,
      toggleChildren: (urn: string) => {
        const kids = session.state.children.get(urn)
        if (!kids) {
          session.openChildren(urn)
          return
        }
        if (kids.state === 'error') {
          session.retryChildren(urn)
          return
        }
        // Loaded: the chevron folds the frame away and back — the data
        // stays; a folded child that is a lineage partner in its own
        // right stays on the board.
        setCollapsedChildren(prev => {
          const next = new Set(prev)
          if (next.has(urn)) next.delete(urn)
          else next.add(urn)
          return next
        })
      },
      loadMoreChildren: session.loadMoreChildren,
      drillRecord: (recordId: string) => {
        const record = session.state.records.get(recordId)
        if (!record?.rollupEdge) return
        // The side being OPENED is the endpoint farther from the focal —
        // drilling an app→platform rollup means "open the platform".
        const sourceHop = Math.abs(session.state.hops.get(record.source) ?? 0)
        const targetHop = Math.abs(session.state.hops.get(record.target) ?? 0)
        const anchor = targetHop >= sourceHop ? record.rollupEdge.targetUrn : record.rollupEdge.sourceUrn
        session.drillRollup(recordId, anchor)
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
    }
  })

  const nodes: Node[] = useMemo(() => {
    const frameNodes: Node[] = layout.frames.map(frame => ({
      id: frame.id,
      type: 'lensFrame',
      position: { x: frame.x, y: frame.y },
      ...(frame.parentFrameId ? { parentId: frame.parentFrameId } : {}),
      data: { frame, io: ioRef } satisfies FrameNodeData,
      style: { width: frame.w, height: frame.h },
      draggable: false,
      selectable: false,
      zIndex: 0,
    }))
    const cardNodes: Node[] = layout.cards.map(card => ({
      id: card.id,
      type: 'lensCard',
      position: { x: card.x, y: card.y },
      ...(card.parentFrameId ? { parentId: card.parentFrameId } : {}),
      data: { card, selected: selectedUrn === card.urn, io: ioRef } satisfies CardNodeData,
      style: { width: card.w, height: card.h },
      draggable: false,
      zIndex: 1,
    }))
    // Parents must precede children in React Flow's node array; frames
    // are emitted in placement order (outer before inner) and cards
    // never parent anything.
    return [...frameNodes, ...cardNodes]
  }, [layout, selectedUrn])

  const edges: Edge[] = useMemo(
    () =>
      layout.edges.map(e => ({
        id: e.id,
        source: e.sourceCardId,
        target: e.targetCardId,
        type: 'lensEdge',
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        data: {
          label: edgeLabelFor(e.edgeTypeNorm),
          also: e.alsoTypes.map(edgeLabelFor),
          bundledCount: e.bundledCount,
          drillable: e.drillable,
          ...(e.drillState ? { drillState: e.drillState } : {}),
          recordId: e.recordId,
          io: ioRef,
        } satisfies LensEdgeData,
      })),
    [layout, edgeLabelFor],
  )

  useFrameCamera(
    rf,
    lensCardId(session.state.focal),
    useMemo(
      () => [
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

  // Honest empty-direction whispers, only once both sides are known.
  const upState = session.state.expansions.get(expansionKeyOf('up', session.state.focal))
  const downState = session.state.expansions.get(expansionKeyOf('down', session.state.focal))
  const hasUp = layout.columns.some(c => c.hop < 0)
  const hasDown = layout.columns.some(c => c.hop > 0)
  const loading = upState?.state === 'loading' || downState?.state === 'loading'

  return (
    <div className="relative h-full w-full" data-lens-graph>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
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

      <Banners banners={layout.banners} labelFor={labelFor} onFocus={onFocus} onRetry={retryFromBanner} />

      {loading ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <span className="flex items-center gap-2 rounded-full bg-canvas-elevated/90 px-3 py-1.5 text-xs text-ink-muted shadow">
            <Loader2 size={13} className="animate-spin" aria-hidden /> Loading lineage…
          </span>
        </div>
      ) : (
        <>
          {!hasUp && upState?.state === 'done' ? (
            <div className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-2xs text-ink-muted/70">
              No upstream lineage in the data source
            </div>
          ) : null}
          {!hasDown && downState?.state === 'done' ? (
            <div className="pointer-events-none absolute right-3 top-1/2 z-10 -translate-y-1/2 text-2xs text-ink-muted/70">
              No downstream lineage in the data source
            </div>
          ) : null}
        </>
      )}

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
