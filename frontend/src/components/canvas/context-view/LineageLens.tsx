/**
 * LineageLens — ego-graph overlay for "click a node, see its immediate
 * links" regardless of canvas scale or scroll position.
 *
 * The focal entity sits centered; upstream neighbors (data sources) list
 * on the LEFT, downstream (data consumers) on the RIGHT, grouped by
 * entity type with counts. Data flow reads left → right throughout:
 * every connector arrow points toward the consumer side. Clicking a
 * neighbor re-centers the lens on it (breadcrumb trail returns);
 * per-row actions reveal the neighbor on the canvas or open its
 * details; the footer escalates to full Trace.
 *
 * Data comes from the same source as the drawer's LineageNeighbors
 * section (canvas visibleEdges with raw-edges fallback, via the shared
 * deriveNeighborRecords helper) so counts always agree with the canvas.
 *
 * Styling is dual-theme (black/* light + white/* dark overlay pairs) on
 * a SOLID elevated surface — translucent glass over a busy canvas read
 * as washed-out, especially in light mode. Panel height adapts to
 * content so small neighborhoods don't get a cavernous empty grid.
 * Lens-local ESC handling runs in the capture phase so canvas keyboard
 * shortcuts don't fire underneath.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useContainmentEdgeTypes } from '@/store/schema'
import { deriveNeighborRecords, type NeighborRecord } from '@/lib/lineage-neighbors'
import { generateColorFromType, generateEdgeColorFromType } from '@/lib/type-visuals'
import { cn } from '@/lib/utils'

const ROWS_CAP = 200

export interface LineageLensProps {
  /** Focal-node stack; last entry is the current focal. Empty = closed. */
  lensStack: string[]
  onRecenter: (nodeId: string) => void
  onBack: () => void
  /** Jump the walk back to stack index i (truncates the trail there). */
  onJumpTo?: (index: number) => void
  /** Branch the walk: truncate to hop i, then step into nodeId — lets
   *  any earlier column change route without restarting the walk. */
  onWalkTo?: (index: number, nodeId: string) => void
  /** Frame the walked path on the canvas (closes the lens). */
  onShowPathOnCanvas?: (ids: string[]) => void
  onClose: () => void
  /** Reveal the node on the canvas (expand ancestors + scroll) without closing the lens. */
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  /** Open the entity drawer for a node. */
  onOpenDetails?: (nodeId: string) => void
  /** Reveal a set of neighbors and frame them on the canvas (closes the lens). */
  onLocateAll?: (nodeIds: string[]) => void | Promise<void>
  /** Escalate to a full server trace from the focal node (closes the lens). */
  onTrace?: (nodeId: string) => void
  /** Feature-flagged out-of-view preview for the focal node: partners
   *  that exist in the data source but are outside this view's scope.
   *  Advisory only — never part of the canvas. */
  externalPreview?: {
    loading: boolean
    records: Array<{ urn: string; label: string; direction: 'in' | 'out'; edgeType: string }>
  } | null
}

export function LineageLens({
  lensStack,
  onRecenter,
  onBack,
  onJumpTo,
  onWalkTo,
  onShowPathOnCanvas,
  onClose,
  onRevealOnCanvas,
  onOpenDetails,
  onLocateAll,
  onTrace,
  externalPreview,
}: LineageLensProps) {
  const nodeId = lensStack[lensStack.length - 1] ?? null

  const rawEdges = useCanvasStore((s) => s.edges)
  const visibleEdges = useCanvasStore((s) => s.visibleEdges)
  const nodes = useCanvasStore((s) => s.nodes)
  const containmentEdgeTypes = useContainmentEdgeTypes()

  // Query is keyed to the focal node — re-centering starts with a fresh
  // filter without needing a reset effect.
  const [queryState, setQueryState] = useState<{ nodeId: string | null; q: string }>({ nodeId: null, q: '' })
  const query = queryState.nodeId === nodeId ? queryState.q : ''
  const setQuery = (q: string) => setQueryState({ nodeId, q })

  // Lens-local ESC: capture phase so the canvas's document-level keyboard
  // handler never sees it while the lens is open.
  useEffect(() => {
    if (!nodeId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      // Keyboard walking: ← steps the walk back one hop (never while
      // typing in the filter input).
      if (e.key === 'ArrowLeft' && lensStack.length > 1) {
        const t = e.target as HTMLElement | null
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
        e.preventDefault()
        e.stopPropagation()
        onBack()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [nodeId, onClose, lensStack.length, onBack])

  const nodeMap = useMemo(() => {
    const m = new Map<string, LineageNode>()
    for (const n of nodes) m.set(n.id, n)
    return m
  }, [nodes])

  const edges = visibleEdges.length > 0 ? visibleEdges : rawEdges

  // Hop metadata — direction + edge type for each trail transition,
  // derived from loaded edges. Lets the trail read as a sentence
  // ("acct_num FEEDS System A") instead of a bare list. Trail length is
  // small; recomputed only when the walk or edge set changes. null =
  // connecting edge not loaded (fall back to a neutral separator).
  const hopMeta = useMemo(() => {
    const meta: Array<{ downstream: boolean; edgeType: string } | null> = []
    for (let i = 1; i < lensStack.length; i++) {
      const prev = lensStack[i - 1]
      const curr = lensStack[i]
      let found: { downstream: boolean; edgeType: string } | null = null
      for (const e of edges) {
        if (e.source === prev && e.target === curr) {
          found = { downstream: true, edgeType: (e.data?.edgeType as string) || '' }
          break
        }
        if (e.source === curr && e.target === prev) {
          found = { downstream: false, edgeType: (e.data?.edgeType as string) || '' }
          break
        }
      }
      meta.push(found)
    }
    return meta
  }, [lensStack, edges])

  // Deep walks middle-truncate so the endpoints (the part people care
  // about) stay visible; the gap chip expands the full trail.
  const [showFullTrail, setShowFullTrail] = useState(false)
  const TRAIL_CAP = 6
  const collapseTrail = lensStack.length > TRAIL_CAP && !showFullTrail

  // ── Miller-walk state ──────────────────────────────────────────────
  // Direction LOCK: a walk follows one flow direction (mixing
  // directions mid-path makes the trail ambiguous). Locked to the
  // first hop's direction, overridable via the flip control.
  const [directionOverride, setDirectionOverride] = useState<'incoming' | 'outgoing' | null>(null)
  const walkDirection: 'incoming' | 'outgoing' =
    directionOverride ?? (hopMeta[0] ? (hopMeta[0].downstream ? 'outgoing' : 'incoming') : 'outgoing')

  // Frontier records per hop — the columns' contents. Walk length is
  // short and this recomputes only when the walk or edge set changes.
  const hopRecords = useMemo(
    () => lensStack.map(id => deriveNeighborRecords(id, edges, nodeMap, containmentEdgeTypes)),
    [lensStack, edges, nodeMap, containmentEdgeTypes],
  )

  const { incomingRecords, outgoingRecords } = useMemo(
    () => (nodeId
      ? deriveNeighborRecords(nodeId, edges, nodeMap, containmentEdgeTypes)
      : { incomingRecords: [], outgoingRecords: [] }),
    [nodeId, edges, nodeMap, containmentEdgeTypes],
  )

  if (!nodeId) return null

  const focalNode = nodeMap.get(nodeId)
  const focalLabel = labelOf(nodeId, focalNode)
  const focalType = (focalNode?.data?.type as string) ?? 'entity'
  const focalColor = generateColorFromType(focalType)

  const q = query.trim().toLowerCase()
  const filterFn = (r: NeighborRecord) =>
    q === '' || labelOf(r.neighborId, r.neighborNode).toLowerCase().includes(q)

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="lineage-lens"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[9990] flex items-center justify-center p-6"
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          onClick={onClose}
        />

        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 8 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="relative flex flex-col rounded-2xl border border-black/10 dark:border-white/10 bg-canvas-elevated shadow-2xl shadow-black/40 overflow-hidden"
          style={{ width: 'min(1000px, 92vw)', maxHeight: 'min(72vh, 780px)', minHeight: 380 }}
          role="dialog"
          aria-label={`Connections of ${focalLabel}`}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-black/[0.08] dark:border-white/[0.08]">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: `${focalColor}1f` }}
            >
              <LucideIcons.Focus className="w-4 h-4" style={{ color: focalColor }} />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink leading-tight truncate">{focalLabel}</h2>
              <p className="text-[10.5px] text-ink-muted leading-tight">
                {incomingRecords.length + outgoingRecords.length} direct connection{incomingRecords.length + outgoingRecords.length === 1 ? '' : 's'}
              </p>
            </div>
            {lensStack.length > 1 && (
              <button
                type="button"
                onClick={onBack}
                className="ml-2 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-ink-muted border border-black/10 dark:border-white/10 hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
              >
                <LucideIcons.ArrowLeft className="w-3 h-3" />
                Back
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <LucideIcons.Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-muted/70" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter connections…"
                  className="w-48 pl-6 pr-2 py-1.5 rounded-md bg-black/[0.04] dark:bg-white/[0.05] border border-black/10 dark:border-white/10 text-[11.5px] text-ink placeholder:text-ink-muted/60 outline-none focus:border-accent-lineage/60"
                />
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="w-7 h-7 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
              >
                <LucideIcons.X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* ── Walk trail — the lens stack as a visible, clickable path.
              Re-centering is a WALK; this makes the walked route a
              first-class object: every hop is a chip, clicking an
              earlier hop jumps the walk back to that point (the spatial
              generalization of Back). Increment 1 of the Miller-column
              walk — the current frontier renders below as today's
              single-focal body. ── */}
          {lensStack.length > 1 && onJumpTo && (
            <div className="flex items-center gap-1 px-4 py-2 border-b border-black/[0.06] dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.02] overflow-x-auto custom-scrollbar whitespace-nowrap">
              <span className="flex-shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-ink-muted/60 mr-1">
                Walk
              </span>
              {(collapseTrail
                ? [0, -1, ...Array.from({ length: 4 }, (_, k) => lensStack.length - 4 + k)]
                : lensStack.map((_, i) => i)
              ).map((i, pos) => {
                if (i === -1) {
                  const hidden = lensStack.slice(1, lensStack.length - 4)
                  return (
                    <div key="trail-gap" className="flex items-center gap-1 flex-shrink-0">
                      <LucideIcons.ChevronRight className="w-3 h-3 text-ink-muted/40" />
                      <button
                        type="button"
                        onClick={() => setShowFullTrail(true)}
                        title={`Show ${hidden.length} hidden hop${hidden.length === 1 ? '' : 's'}: ${hidden.map(id => labelOf(id, nodeMap.get(id))).join(' → ')}`}
                        className="px-2 py-0.5 rounded-md text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] border border-dashed border-ink-muted/30 transition-colors"
                      >
                        … {hidden.length} hop{hidden.length === 1 ? '' : 's'}
                      </button>
                    </div>
                  )
                }
                const id = lensStack[i]
                const isCurrent = i === lensStack.length - 1
                const label = labelOf(id, nodeMap.get(id))
                const chipColor = generateColorFromType((nodeMap.get(id)?.data?.type as string) ?? 'entity')
                const meta = i > 0 ? hopMeta[i - 1] : null
                const afterGap = collapseTrail && pos === 2
                return (
                  <div key={`${id}-${i}`} className="flex items-center gap-1 flex-shrink-0">
                    {i > 0 && (
                      meta && !afterGap ? (
                        <span
                          className="flex items-center"
                          title={`${meta.edgeType || 'connection'} — walked ${meta.downstream ? 'downstream' : 'upstream'}`}
                        >
                          {meta.downstream
                            ? <LucideIcons.MoveRight className="w-3.5 h-3.5 text-accent-lineage/70" />
                            : <LucideIcons.MoveLeft className="w-3.5 h-3.5 text-amber-500/80" />}
                        </span>
                      ) : (
                        <LucideIcons.ChevronRight className="w-3 h-3 text-ink-muted/40" />
                      )
                    )}
                    <button
                      type="button"
                      disabled={isCurrent}
                      onClick={() => onJumpTo(i)}
                      title={isCurrent ? label : `Jump back to ${label}`}
                      className={
                        isCurrent
                          ? 'flex items-center gap-1.5 max-w-[180px] px-2 py-0.5 rounded-md text-[11px] font-semibold text-accent-lineage bg-accent-lineage/12 border border-accent-lineage/30'
                          : 'flex items-center gap-1.5 max-w-[160px] px-2 py-0.5 rounded-md text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] border border-transparent transition-colors'
                      }
                    >
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: chipColor }} />
                      <span className="truncate">{label}</span>
                    </button>
                  </div>
                )
              })}
              {/* The walk as a deliverable: present it on the canvas, or
                  copy it as text for a ticket/finding. */}
              <div className="ml-auto flex items-center gap-1 pl-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setDirectionOverride(walkDirection === 'outgoing' ? 'incoming' : 'outgoing')}
                  title={`Walking ${walkDirection === 'outgoing' ? 'downstream (data consumers)' : 'upstream (data sources)'} — click to flip the walk direction`}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-semibold border transition-colors border-black/10 dark:border-white/10 text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                >
                  {walkDirection === 'outgoing'
                    ? <LucideIcons.MoveRight className="w-3 h-3 text-accent-lineage" />
                    : <LucideIcons.MoveLeft className="w-3 h-3 text-amber-500" />}
                  {walkDirection === 'outgoing' ? 'Downstream' : 'Upstream'}
                </button>
                {onShowPathOnCanvas && (
                  <button
                    type="button"
                    onClick={() => { onClose(); onShowPathOnCanvas(lensStack) }}
                    title="Frame this walked path on the canvas"
                    className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-semibold text-accent-lineage hover:bg-accent-lineage/10 transition-colors"
                  >
                    <LucideIcons.Frame className="w-3 h-3" />
                    Show on canvas
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(
                      lensStack.map(id => labelOf(id, nodeMap.get(id))).join(' → '),
                    )
                  }}
                  title="Copy this path as text (acct_num → System A → …)"
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                >
                  <LucideIcons.Copy className="w-3 h-3" />
                  Copy path
                </button>
              </div>
            </div>
          )}

          {/* ── Walk body (Miller columns) — one column per hop, oldest
              on the left, the current frontier widest on the right. Each
              column lists its hop's frontier in the LOCKED direction;
              the row you walked into is highlighted, and clicking a row
              in an earlier column BRANCHES the walk from that hop.
              Complexity stays constant: path + frontier, never a tree. ── */}
          {lensStack.length > 1 && onWalkTo ? (
            <div className="flex-1 flex min-h-0 overflow-x-auto custom-scrollbar divide-x divide-black/[0.06] dark:divide-white/[0.06]">
              {lensStack.map((hopId, i) => {
                const recsAll = walkDirection === 'outgoing'
                  ? hopRecords[i].outgoingRecords
                  : hopRecords[i].incomingRecords
                // Dedupe per neighbor (multiple edge types bundle to ×N).
                const byNeighbor = new Map<string, { rec: NeighborRecord; n: number }>()
                for (const r of recsAll) {
                  const cur = byNeighbor.get(r.neighborId)
                  if (cur) cur.n += 1
                  else byNeighbor.set(r.neighborId, { rec: r, n: 1 })
                }
                const isLast = i === lensStack.length - 1
                const walkedInto = !isLast ? lensStack[i + 1] : null
                const rows = [...byNeighbor.values()]
                  .filter(({ rec }) => !isLast || filterFn(rec))
                  .slice(0, 200)
                const hopLabel = labelOf(hopId, nodeMap.get(hopId))
                const hopColor = generateColorFromType((nodeMap.get(hopId)?.data?.type as string) ?? 'entity')
                return (
                  <div
                    key={`walk-col-${hopId}-${i}`}
                    className={isLast
                      ? 'flex-1 min-w-[300px] flex flex-col min-h-0 bg-accent-lineage/[0.03]'
                      : 'w-[230px] flex-shrink-0 flex flex-col min-h-0'}
                  >
                    <div className="flex items-center gap-1.5 px-3 py-2 border-b border-black/[0.06] dark:border-white/[0.06]">
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: hopColor }} />
                      <span className="truncate text-[11.5px] font-semibold text-ink">{hopLabel}</span>
                      <span className="ml-auto flex-shrink-0 text-[10px] tabular-nums text-ink-muted/70">
                        {byNeighbor.size}
                      </span>
                    </div>
                    <div className="flex-1 overflow-y-auto custom-scrollbar py-1">
                      {rows.map(({ rec, n }) => {
                        const rid = rec.neighborId
                        const active = rid === walkedInto
                        const rowColor = generateColorFromType((rec.neighborNode?.data?.type as string) ?? 'entity')
                        return (
                          <button
                            key={rid}
                            type="button"
                            onClick={() => (isLast ? onRecenter(rid) : onWalkTo(i, rid))}
                            title={isLast
                              ? `Walk into ${labelOf(rid, rec.neighborNode)}`
                              : `Branch the walk here — continue from ${labelOf(rid, rec.neighborNode)}`}
                            className={
                              active
                                ? 'w-full flex items-center gap-1.5 px-3 py-1.5 text-left text-[11.5px] font-semibold text-accent-lineage bg-accent-lineage/10 border-l-2 border-accent-lineage'
                                : 'w-full flex items-center gap-1.5 px-3 py-1.5 text-left text-[11.5px] text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.05] border-l-2 border-transparent transition-colors'
                            }
                          >
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: rowColor }} />
                            <span className="truncate">{labelOf(rid, rec.neighborNode)}</span>
                            {n > 1 && <span className="flex-shrink-0 text-[9.5px] tabular-nums text-ink-muted/60">×{n}</span>}
                            <LucideIcons.ChevronRight className={`ml-auto w-3 h-3 flex-shrink-0 ${active ? 'text-accent-lineage' : 'text-ink-muted/30'}`} />
                          </button>
                        )
                      })}
                      {byNeighbor.size === 0 && (
                        <p className="px-3 py-3 text-[11px] text-ink-muted/70 italic leading-snug">
                          No {walkDirection === 'outgoing' ? 'downstream' : 'upstream'} connections loaded here —
                          the walk ends, or flip the direction.
                        </p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
          <div className="flex-1 grid grid-cols-[1fr_auto_1fr] min-h-0">
            <NeighborColumn
              title="Data Sources"
              subtitle="Upstream"
              records={incomingRecords.filter(filterFn)}
              totalCount={incomingRecords.length}
              direction="incoming"
              onRecenter={onRecenter}
              onRevealOnCanvas={onRevealOnCanvas}
              onOpenDetails={onOpenDetails}
            />

            {/* Focal card */}
            <div className="flex flex-col items-center justify-center px-5 py-6">
              <div className="flex items-center">
                <FlowRail color={focalColor} active={incomingRecords.length > 0} />
                <div
                  className="w-60 rounded-xl border-2 px-4 py-3.5 bg-canvas-elevated"
                  style={{
                    borderColor: focalColor,
                    background: `linear-gradient(150deg, ${focalColor}24, ${focalColor}08 60%)`,
                    boxShadow: `0 10px 34px ${focalColor}33`,
                  }}
                >
                  <p className="text-[9.5px] font-bold uppercase tracking-[0.12em] mb-1" style={{ color: focalColor }}>
                    {focalType}
                  </p>
                  <p className="text-[15px] font-semibold text-ink break-words leading-snug">{focalLabel}</p>
                  <div className="flex items-center gap-3 mt-2.5 pt-2 border-t border-black/[0.07] dark:border-white/[0.08] text-[11px] font-medium tabular-nums">
                    <span className="flex items-center gap-1 text-sky-600 dark:text-sky-400">
                      <LucideIcons.ArrowDownLeft className="w-3.5 h-3.5" />
                      {incomingRecords.length} in
                    </span>
                    <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <LucideIcons.ArrowUpRight className="w-3.5 h-3.5" />
                      {outgoingRecords.length} out
                    </span>
                  </div>
                </div>
                <FlowRail color={focalColor} active={outgoingRecords.length > 0} />
              </div>
            </div>

            <NeighborColumn
              title="Data Consumers"
              subtitle="Downstream"
              records={outgoingRecords.filter(filterFn)}
              totalCount={outgoingRecords.length}
              direction="outgoing"
              onRecenter={onRecenter}
              onRevealOnCanvas={onRevealOnCanvas}
              onOpenDetails={onOpenDetails}
            />
          </div>
          )}

          {/* ── Outside this view (feature-flagged preview) — partners
              that exist in the data source but are beyond this view's
              scope. The story is told explicitly: expected, not missing
              data, and NOT part of the canvas. Per-row CTA escalates to
              a Trace, the sanctioned way to pull external lineage in. ── */}
          {externalPreview && (externalPreview.loading || externalPreview.records.length > 0) && (
            <div className="px-4 py-2.5 border-t border-dashed border-sky-400/40 bg-sky-500/[0.05]">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.1em] uppercase text-sky-600 dark:text-sky-300">
                <LucideIcons.Unlink className="w-3 h-3" />
                <span>Outside this view</span>
                {externalPreview.loading ? (
                  <LucideIcons.Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <span className="tabular-nums normal-case tracking-normal text-sky-600/80 dark:text-sky-300/80">
                    {externalPreview.records.length} entit{externalPreview.records.length === 1 ? 'y' : 'ies'}
                  </span>
                )}
              </div>
              {!externalPreview.loading && (
                <div className="mt-1.5 grid grid-cols-2 gap-x-5 gap-y-1 max-h-36 overflow-y-auto custom-scrollbar">
                  {externalPreview.records.map(r => (
                    <div key={`${r.direction}-${r.urn}`} className="flex items-center gap-1.5 min-w-0 text-[11.5px]">
                      {r.direction === 'in'
                        ? <LucideIcons.ArrowDownLeft className="w-3 h-3 flex-shrink-0 text-sky-500/80" />
                        : <LucideIcons.ArrowUpRight className="w-3 h-3 flex-shrink-0 text-sky-500/80" />}
                      <span className="truncate text-ink">{r.label}</span>
                      {r.edgeType && (
                        <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-ink-muted/50">{r.edgeType}</span>
                      )}
                      {onTrace && (
                        <button
                          type="button"
                          onClick={() => { onClose(); onTrace(r.urn) }}
                          title={`Trace lineage from ${r.label} — brings its lineage onto the canvas`}
                          className="ml-auto flex-shrink-0 text-[10px] font-semibold text-accent-lineage hover:underline"
                        >
                          Trace
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-1.5 text-[10px] text-ink-muted/60 italic leading-snug">
                These connections exist in the data source but their entities aren&apos;t part of this
                view — expected for a curated subset, not missing data. This is a preview; nothing has
                been added to the canvas.
              </p>
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-t border-black/[0.08] dark:border-white/[0.08]">
            <p className="text-[10.5px] text-ink-muted/80">
              Click a connection to re-center · Esc to close
            </p>
            <div className="ml-auto flex items-center gap-2">
              {onLocateAll && (
                <button
                  type="button"
                  onClick={() => {
                    const ids = [...new Set([...incomingRecords, ...outgoingRecords].map(r => r.neighborId))]
                    onClose()
                    void onLocateAll(ids)
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-black/10 dark:border-white/10 text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                >
                  <LucideIcons.Frame className="w-3 h-3" />
                  Reveal all on canvas
                </button>
              )}
              {onTrace && (
                <button
                  type="button"
                  onClick={() => { onClose(); onTrace(nodeId) }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-accent-lineage/15 border border-accent-lineage/40 text-[11px] font-semibold text-accent-lineage hover:bg-accent-lineage/25 transition-colors"
                >
                  <LucideIcons.GitBranch className="w-3 h-3" />
                  Trace from here
                </button>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}

/** Short horizontal flow rail flanking the focal card — reads as the
 *  edge entering / leaving the focal entity. */
function FlowRail({ color, active }: { color: string; active: boolean }) {
  if (!active) return <div className="w-6" />
  return (
    <div className="flex items-center w-6">
      <div className="h-[2px] flex-1 rounded-full" style={{ background: `linear-gradient(to right, ${color}22, ${color}aa)` }} />
      <LucideIcons.ChevronRight className="w-3 h-3 -ml-1 flex-shrink-0" style={{ color }} />
    </div>
  )
}

function labelOf(id: string, node: LineageNode | undefined): string {
  const data = node?.data as Record<string, unknown> | undefined
  return (data?.label as string)
    ?? (data?.businessLabel as string)
    // URN-derived fallback for neighbors not loaded on the canvas.
    ?? id.split(/[:/.]/).filter(Boolean).pop()
    ?? id
}

function NeighborColumn({
  title,
  subtitle,
  records,
  totalCount,
  direction,
  onRecenter,
  onRevealOnCanvas,
  onOpenDetails,
}: {
  title: string
  subtitle: string
  records: NeighborRecord[]
  totalCount: number
  direction: 'incoming' | 'outgoing'
  onRecenter: (nodeId: string) => void
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  onOpenDetails?: (nodeId: string) => void
}) {
  // Group by entity type (unknown/unloaded neighbors grouped under "Not loaded").
  const groups = useMemo(() => {
    const g = new Map<string, NeighborRecord[]>()
    for (const r of records.slice(0, ROWS_CAP)) {
      const type = (r.neighborNode?.data?.type as string) ?? 'not loaded'
      const list = g.get(type) ?? []
      list.push(r)
      g.set(type, list)
    }
    return [...g.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [records])

  const isIn = direction === 'incoming'

  return (
    <div className={cn(
      'flex flex-col min-h-0',
      isIn
        ? 'border-r border-black/[0.07] dark:border-white/[0.07]'
        : 'border-l border-black/[0.07] dark:border-white/[0.07]',
    )}>
      <div className="px-4 pt-3 pb-2 flex items-center gap-2 flex-shrink-0">
        {isIn
          ? <LucideIcons.ArrowDownLeft className="w-3.5 h-3.5 text-sky-500" />
          : <LucideIcons.ArrowUpRight className="w-3.5 h-3.5 text-amber-500" />}
        <span className="text-[11.5px] font-semibold text-ink">{title}</span>
        <span className="text-[10px] text-ink-muted">{subtitle}</span>
        <span className={cn(
          'ml-auto px-1.5 py-0.5 rounded-full text-[10px] font-semibold tabular-nums',
          isIn
            ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
        )}>
          {totalCount}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar px-2.5 pb-3">
        {records.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-2 py-10 text-center">
            <LucideIcons.CircleSlash className="w-5 h-5 text-ink-muted/40" />
            <p className="text-[11px] text-ink-muted/70 leading-snug">
              {totalCount === 0
                ? `No ${isIn ? 'upstream sources' : 'downstream consumers'} on this canvas`
                : 'No matches for this filter'}
            </p>
          </div>
        )}
        {groups.map(([type, rows]) => {
          const unloaded = type === 'not loaded'
          const typeColor = unloaded ? '#94a3b8' : generateColorFromType(type)
          return (
            <div key={type} className="mb-2.5">
              <div className="flex items-center gap-1.5 px-1.5 py-1">
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: typeColor }} />
                <span className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-ink-muted/80">{type}</span>
                <span className="text-[9.5px] tabular-nums text-ink-muted/60">{rows.length}</span>
              </div>
              <div className="flex flex-col gap-1">
                {rows.map((r, i) => {
                  const edgeColor = generateEdgeColorFromType(r.edgeTypeNorm)
                  const bundleCount = (r.edge as { edgeCount?: number }).edgeCount
                    ?? (r.edge.data as { edgeCount?: number } | undefined)?.edgeCount
                  return (
                    <div
                      key={`${r.edge.id}-${i}`}
                      className="group relative flex items-center gap-2 rounded-lg border px-2.5 py-2 cursor-pointer transition-all border-black/[0.07] dark:border-white/[0.08] hover:border-accent-lineage/50 hover:shadow-sm bg-black/[0.015] dark:bg-white/[0.02] hover:bg-black/[0.035] dark:hover:bg-white/[0.05] min-w-0"
                      style={{ borderLeftWidth: 3, borderLeftColor: typeColor }}
                      onClick={() => onRecenter(r.neighborId)}
                      title={`Re-center on ${labelOf(r.neighborId, r.neighborNode)}`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-[12px] font-medium text-ink leading-snug">
                          {labelOf(r.neighborId, r.neighborNode)}
                        </p>
                        <p className="flex items-center gap-1 text-[9.5px] text-ink-muted/70 leading-snug">
                          <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ backgroundColor: edgeColor }} />
                          <span className="truncate uppercase tracking-wide">{r.edgeTypeNorm || 'relationship'}</span>
                          {bundleCount != null && bundleCount > 1 && (
                            <span className="tabular-nums font-semibold text-ink-muted">×{bundleCount.toLocaleString()}</span>
                          )}
                          {unloaded && <span className="italic">· not on canvas</span>}
                        </p>
                      </div>
                      {/* Flow direction cue: data always travels left → right */}
                      <LucideIcons.ChevronRight
                        className={cn('w-3.5 h-3.5 flex-shrink-0 group-hover:opacity-0 transition-opacity', isIn ? 'order-last' : 'order-first')}
                        style={{ color: `${edgeColor}99` }}
                      />
                      <span className={cn(
                        'absolute top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-0.5 rounded-md bg-canvas-elevated border border-black/10 dark:border-white/10 shadow-sm px-0.5 py-0.5',
                        isIn ? 'right-1.5' : 'left-1.5',
                      )}>
                        {onRevealOnCanvas && (
                          <button
                            type="button"
                            title="Reveal on canvas"
                            onClick={(e) => { e.stopPropagation(); void onRevealOnCanvas(r.neighborId) }}
                            className="w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                          >
                            <LucideIcons.Crosshair className="w-3 h-3" />
                          </button>
                        )}
                        {onOpenDetails && (
                          <button
                            type="button"
                            title="Open details"
                            onClick={(e) => { e.stopPropagation(); onOpenDetails(r.neighborId) }}
                            className="w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                          >
                            <LucideIcons.PanelRight className="w-3 h-3" />
                          </button>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
        {records.length > ROWS_CAP && (
          <p className="px-2 py-1.5 text-[10px] text-ink-muted/70">
            +{records.length - ROWS_CAP} more — use the filter to narrow
          </p>
        )}
      </div>
    </div>
  )
}
