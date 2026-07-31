/**
 * LineageLens — ego-graph overlay for "click a node, see its immediate
 * links" regardless of canvas scale or scroll position.
 *
 * The focal entity sits centered; upstream neighbors (data sources) list
 * on the LEFT, downstream (data consumers) on the RIGHT, grouped by
 * entity type with counts. Data flow reads left → right throughout:
 * every connector arrow points toward the consumer side. Re-centering
 * on a neighbor is a WALK recorded in a browser-style focus history
 * (Back/Forward buttons, ←/→ keys, clickable Path trail — moving the
 * cursor never drops a hop); the SAME body renders at every depth, so
 * a walk never flips the layout. Per-row actions reveal the neighbor
 * on the canvas or open its details; the footer escalates to full
 * Trace.
 *
 * Data comes from the canvas store (visibleEdges with raw-edges
 * fallback, via the shared deriveNeighborRecords helper) MERGED with
 * on-demand fetched lineage for every visited focal node (see
 * useLensLineage): the lens tells the truth about the DATA SOURCE, not
 * just about what happens to be hydrated on the canvas. Fetched edges
 * that the store already represents — same id, same endpoint pair, or
 * rolled up into an aggregate touching the same endpoint — are deduped
 * so counts stay truthful at one granularity.
 *
 * Styling is dual-theme (black/* light + white/* dark overlay pairs) on
 * a SOLID elevated surface — translucent glass over a busy canvas read
 * as washed-out, especially in light mode. Panel height adapts to
 * content so small neighborhoods don't get a cavernous empty grid.
 * Lens-local ESC handling runs in the capture phase so canvas keyboard
 * shortcuts don't fire underneath.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { useCanvasStore, type LineageNode, type LineageEdge } from '@/store/canvas'
import { useContainmentEdgeTypes, normalizeEdgeType, isContainmentEdgeType, useEntityTypeHierarchyMap } from '@/store/schema'
import {
  deriveNeighborRecords,
  mergeSupplementalEdges,
  buildCanContainClosure,
  isCoarserGrain,
  type NeighborRecord,
} from '@/lib/lineage-neighbors'
import { EDGE_FETCH_LIMIT } from '@/hooks/useLensLineage'
import { generateColorFromType, generateEdgeColorFromType } from '@/lib/type-visuals'
import { cn } from '@/lib/utils'
import { InfoTooltip } from '../search/panel/builder-atoms/InfoTooltip'
import { lensFocalOf, type LensHistory } from './lens/lensHistory'

const ROWS_CAP = 200
const EMPTY_TYPE_SET: ReadonlySet<string> = new Set()

export interface LineageLensProps {
  /** Focus history; entries[cursor] is the current focal. Empty = closed. */
  history: LensHistory
  onRecenter: (nodeId: string) => void
  /** Step the focus history back one hop (non-destructive). */
  onBack: () => void
  /** Step the focus history forward one hop (non-destructive). */
  onForward: () => void
  /** Move the history cursor to entry i without dropping the trail. */
  onJumpTo?: (index: number) => void
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
  /** On-demand fetched lineage for visited focal nodes (useLensLineage).
   *  Lens-local only — never part of the canvas store. */
  supplementalEdges?: LineageEdge[]
  supplementalNodes?: Map<string, LineageNode>
  /** Per-focal fetch status; absent id = no fetch attempted. */
  fetchStatus?: Map<string, 'loading' | 'done' | 'error'>
  /** Focal nodes whose fetch hit the per-direction edge cap. */
  fetchTruncatedIds?: Set<string>
  onRetryFetch?: (nodeId: string) => void
  /** Underlying edges fetched per drilled aggregate (aggregate edge id). */
  drillEdges?: Map<string, LineageEdge[]>
  drillStatus?: Map<string, 'loading' | 'done' | 'error'>
  /** Fetch an aggregated row's underlying connections on drill. */
  onDrillFetch?: (edge: LineageEdge) => void
}

export function LineageLens({
  history,
  onRecenter,
  onBack,
  onForward,
  onJumpTo,
  onShowPathOnCanvas,
  onClose,
  onRevealOnCanvas,
  onOpenDetails,
  onLocateAll,
  onTrace,
  externalPreview,
  supplementalEdges,
  supplementalNodes,
  fetchStatus,
  fetchTruncatedIds,
  onRetryFetch,
  drillEdges,
  drillStatus,
  onDrillFetch,
}: LineageLensProps) {
  const { entries, cursor } = history
  const nodeId = lensFocalOf(history)
  const canBack = cursor > 0
  const canForward = cursor < entries.length - 1

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
      // Keyboard walking: ← back one hop, → forward one hop — browser
      // history semantics (never while typing in the filter input).
      if ((e.key === 'ArrowLeft' && canBack) || (e.key === 'ArrowRight' && canForward)) {
        const t = e.target as HTMLElement | null
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'ArrowLeft') onBack()
        else onForward()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [nodeId, onClose, canBack, canForward, onBack, onForward])

  // Open gate for every canvas-scale memo below: this component is
  // always mounted, and a closed lens must cost nothing when the
  // (potentially very large) node/edge sets churn.
  const lensOpen = entries.length > 0

  const nodeMap = useMemo(() => {
    const m = new Map<string, LineageNode>()
    if (!lensOpen) return m
    // Fetched partners first; store nodes win (they carry full canvas data).
    if (supplementalNodes) for (const [id, n] of supplementalNodes) m.set(id, n)
    for (const n of nodes) m.set(n.id, n)
    return m
  }, [nodes, supplementalNodes, lensOpen])

  // Store edges (canvas truth) merged with on-demand fetched edges
  // (data-source truth). A fetched edge is redundant — and skipped —
  // when the store already represents that connection: identical id,
  // identical (source, target, edgeType) pair, or rolled up into an
  // aggregate that shares an endpoint with it (the aggregate row shows
  // it at coarser granularity, and the drill below resolves it). An
  // aggregate between two OTHER nodes does NOT cover it — that's
  // exactly the invisible-lineage case this merge exists to fix.
  const edges = useMemo(() => {
    const base = visibleEdges.length > 0 ? visibleEdges : rawEdges
    if (!supplementalEdges || supplementalEdges.length === 0) return base
    return mergeSupplementalEdges(base, supplementalEdges)
  }, [visibleEdges, rawEdges, supplementalEdges])

  // Endpoint index — one O(E) pass per edge-set change so everything
  // downstream (hop columns, trail metadata, the classic body) works in
  // O(degree of the node), not O(all edges) per hop. At canvas scale
  // (100k+ edges, multi-hop walks) the naive full-array scan per hop is
  // the difference between instant and seconds. The open gate is a
  // boolean, so opening builds once and walking doesn't rebuild.
  const edgesByEndpoint = useMemo(() => {
    const m = new Map<string, LineageEdge[]>()
    if (!lensOpen) return m
    const add = (k: string, e: LineageEdge) => {
      const list = m.get(k)
      if (list) list.push(e)
      else m.set(k, [e])
    }
    for (const e of edges) {
      add(e.source, e)
      if (e.target !== e.source) add(e.target, e)
    }
    return m
  }, [edges, lensOpen])

  // Hop metadata — direction + edge type for each trail transition,
  // derived from loaded edges. Lets the trail read as a sentence
  // ("acct_num FEEDS System A") instead of a bare list. Trail length is
  // small; recomputed only when the walk or edge set changes. null =
  // connecting edge not loaded (fall back to a neutral separator).
  const hopMeta = useMemo(() => {
    const meta: Array<{ downstream: boolean; edgeType: string } | null> = []
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]
      const curr = entries[i]
      let found: { downstream: boolean; edgeType: string } | null = null
      for (const e of edgesByEndpoint.get(curr) ?? []) {
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
  }, [entries, edgesByEndpoint])

  // Deep walks middle-truncate so the cursor's neighborhood (the part
  // people care about) stays visible; the gap chips expand the full trail.
  const [showFullTrail, setShowFullTrail] = useState(false)
  const TRAIL_CAP = 6
  const collapseTrail = entries.length > TRAIL_CAP && !showFullTrail

  // Containment children of the focal — a container's relationships
  // often live at CHILD level, so focusing one would dead-end on flow
  // edges alone. Children (containment edges are parent → child) render
  // as a walkable "Contains" group; O(degree) via the endpoint index.
  const focalChildren = useMemo(() => {
    if (!nodeId) return []
    const children: string[] = []
    const seen = new Set<string>()
    for (const e of edgesByEndpoint.get(nodeId) ?? []) {
      if (!isContainmentEdgeType(normalizeEdgeType(e), containmentEdgeTypes)) continue
      if (e.source === nodeId && e.target !== nodeId && !seen.has(e.target)) {
        seen.add(e.target)
        children.push(e.target)
      }
    }
    return children
  }, [nodeId, edgesByEndpoint, containmentEdgeTypes])

  // ── Grain machinery — data-driven from the schema's entity-type
  // hierarchy. closure(T) = every type T can transitively contain; a
  // partner is a COARSER-grain rollup relative to a base node when the
  // partner's type can contain the base's type (e.g. CONTAINER and
  // DATAPLATFORM vs a DATASET focal). Case-insensitive like the other
  // schema helpers. Tiny input (schema type list), computed once.
  const hierarchyMap = useEntityTypeHierarchyMap()
  const canContainClosure = useMemo(() => buildCanContainClosure(hierarchyMap), [hierarchyMap])
  const isCoarserThan = useCallback(
    (partnerType: string | undefined, baseType: string): boolean =>
      isCoarserGrain(canContainClosure, partnerType, baseType),
    [canContainClosure],
  )

  // Containment parent of a node, when known — fetched or loaded
  // containment edge pointing at it, else the canvas's own assignment.
  const resolveParent = useCallback((id: string): string | null => {
    for (const e of edgesByEndpoint.get(id) ?? []) {
      if (e.target === id && e.source !== id
        && isContainmentEdgeType(normalizeEdgeType(e), containmentEdgeTypes)) return e.source
    }
    return (nodeMap.get(id)?.data?.parentId as string | undefined) ?? null
  }, [edgesByEndpoint, containmentEdgeTypes, nodeMap])

  // Type-filter chips — lens-local, keyed to the focal (like the text
  // filter) so re-centering starts clean. Shared across both columns.
  const [hiddenTypesState, setHiddenTypesState] = useState<{ nodeId: string | null; types: ReadonlySet<string> }>({ nodeId: null, types: EMPTY_TYPE_SET })
  const hiddenTypes = hiddenTypesState.nodeId === nodeId ? hiddenTypesState.types : EMPTY_TYPE_SET
  const toggleHiddenType = (t: string) => setHiddenTypesState(prev => {
    const base = prev.nodeId === nodeId ? prev.types : EMPTY_TYPE_SET
    const next = new Set(base)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    return { nodeId, types: next }
  })

  // Parent-group collapse — per-group TOGGLES against a per-column
  // default (3+ parent groups → start collapsed: dataset-level overview
  // first), stored as XOR so the default can vary without migrating
  // state. Keyed to the focal like the other lens-local state.
  const [collapseState, setCollapseState] = useState<{ nodeId: string | null; keys: ReadonlySet<string> }>({ nodeId: null, keys: EMPTY_TYPE_SET })
  const collapseToggles = collapseState.nodeId === nodeId ? collapseState.keys : EMPTY_TYPE_SET
  const toggleCollapse = (k: string) => setCollapseState(prev => {
    const base = prev.nodeId === nodeId ? prev.keys : EMPTY_TYPE_SET
    const next = new Set(base)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    return { nodeId, keys: next }
  })

  // ── Containment drill — refine an aggregated row to its constituent
  // endpoints, resolved LOCALLY from the raw edges the aggregate rolls
  // up (`data.sourceEdges`). Honest by construction: constituents that
  // aren't loaded are reported as "+M more", never invented.
  const rawEdgeById = useMemo(() => {
    const m = new Map<string, LineageEdge>()
    for (const e of rawEdges) m.set(e.id, e)
    // Fetched edges resolve drill constituents the canvas never loaded.
    if (supplementalEdges) for (const e of supplementalEdges) { if (!m.has(e.id)) m.set(e.id, e) }
    return m
  }, [rawEdges, supplementalEdges])
  const [drilledRows, setDrilledRows] = useState<Set<string>>(() => new Set())
  const toggleDrill = (key: string) => setDrilledRows(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  // Opening a drill with incomplete local coverage fetches the
  // underlying edges on demand (idempotent per aggregate). Shared by
  // the walk columns and the classic-mode cards.
  const toggleDrillWithFetch = (key: string, edge: LineageEdge) => {
    const aggData = edge.data as { sourceEdgeCount?: number; sourceEdges?: string[] } | undefined
    if (!drilledRows.has(key) && onDrillFetch && !drillEdges?.has(edge.id)) {
      let localCount = 0
      for (const eid of aggData?.sourceEdges ?? []) {
        if (rawEdgeById.has(eid)) localCount++
      }
      if (localCount < (aggData?.sourceEdgeCount ?? 0)) onDrillFetch(edge)
    }
    toggleDrill(key)
  }

  const { incomingRecords, outgoingRecords } = useMemo(
    () => (nodeId
      ? deriveNeighborRecords(nodeId, edgesByEndpoint.get(nodeId) ?? [], nodeMap, containmentEdgeTypes)
      : { incomingRecords: [], outgoingRecords: [] }),
    [nodeId, edgesByEndpoint, nodeMap, containmentEdgeTypes],
  )

  if (!nodeId) return null

  const focalNode = nodeMap.get(nodeId)
  const focalLabel = labelOf(nodeId, focalNode)
  const focalType = (focalNode?.data?.type as string) ?? 'entity'
  const focalColor = generateColorFromType(focalType)
  const focalFetch = fetchStatus?.get(nodeId)
  const focalChildTotal = Math.max(
    focalChildren.length,
    (focalNode?.data?.childCount as number | undefined) ?? 0,
  )
  // Containment parent of the focal — breadcrumb context ("ticket_key
  // in fact_support"). Header display suppresses it when the PREVIOUS
  // hop already is the parent (saying it twice reads as noise).
  const focalParentId = resolveParent(nodeId)
  const focalParentLabel = focalParentId ? labelOf(focalParentId, nodeMap.get(focalParentId)) : null
  const focalParentInHeader = focalParentId && focalParentId !== entries[cursor - 1]
    ? focalParentLabel
    : null

  // Headline counts split by grain so units never mix: direct (finer/
  // peer) connections vs coarser rolled-up summaries of those flows.
  let focalRollupTotal = 0
  for (const r of incomingRecords) if (isCoarserThan(r.neighborNode?.data?.type as string | undefined, focalType)) focalRollupTotal++
  for (const r of outgoingRecords) if (isCoarserThan(r.neighborNode?.data?.type as string | undefined, focalType)) focalRollupTotal++
  const focalDirectTotal = incomingRecords.length + outgoingRecords.length - focalRollupTotal

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
              <div className="flex items-baseline gap-1.5 min-w-0">
                <h2 className="text-sm font-semibold text-ink leading-tight truncate">{focalLabel}</h2>
                {focalParentInHeader && (
                  <span className="flex-shrink-0 max-w-[160px] truncate text-[10px] text-ink-muted/70">
                    in {focalParentInHeader}
                  </span>
                )}
              </div>
              <p className="flex items-center gap-1.5 text-[10.5px] text-ink-muted leading-tight">
                <span>
                  {`${focalDirectTotal} direct connection${focalDirectTotal === 1 ? '' : 's'}${focalRollupTotal > 0 ? ` · ${focalRollupTotal} rolled-up` : ''}${focalChildTotal > 0 ? ` · contains ${focalChildTotal}` : ''}`}
                </span>
                {focalFetch === 'loading' && (
                  <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-accent-lineage/70" aria-label="Fetching lineage from the data source" />
                )}
              </p>
            </div>
            {/* History navigation — browser semantics: Back/Forward move
                the cursor along the walked path without dropping hops.
                Forward appears only when there is a forward side. */}
            {canBack && (
              <button
                type="button"
                onClick={onBack}
                title="Step back one hop (←)"
                className="ml-2 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-ink-muted border border-black/10 dark:border-white/10 hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
              >
                <LucideIcons.ArrowLeft className="w-3 h-3" />
                Back
              </button>
            )}
            {canForward && (
              <button
                type="button"
                onClick={onForward}
                title="Step forward one hop (→)"
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-ink-muted border border-black/10 dark:border-white/10 hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                  canBack ? 'ml-1' : 'ml-2',
                )}
              >
                Forward
                <LucideIcons.ArrowRight className="w-3 h-3" />
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <LucideIcons.Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-muted/70" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter connections…"
                  className="w-48 pl-6 pr-7 py-1.5 rounded-md bg-black/[0.04] dark:bg-white/[0.05] border border-black/10 dark:border-white/10 text-[11.5px] text-ink placeholder:text-ink-muted/60 outline-none focus:border-accent-lineage/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label="Clear filter"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-4 h-4 rounded flex items-center justify-center text-ink-muted/70 hover:text-ink hover:bg-black/[0.06] dark:hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                  >
                    <LucideIcons.X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="w-7 h-7 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
              >
                <LucideIcons.X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* ── Path trail — the focus history as a visible, clickable
              path. Every visited hop is a chip; the cursor's chip is
              highlighted and hops AHEAD of the cursor stay visible
              (dimmed) — clicking any chip moves the cursor there
              without dropping the trail (browser history, not a
              destructive stack). ── */}
          {entries.length > 1 && onJumpTo && (
            <div className="flex items-center gap-1 px-4 py-2 border-b border-black/[0.06] dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.02] overflow-x-auto custom-scrollbar whitespace-nowrap">
              <span className="flex-shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-ink-muted/60 mr-1">
                Path
              </span>
              {(() => {
                // Middle-truncation window anchored on the CURSOR (not
                // the tail — after Back the tail is the forward side).
                let visible: number[]
                if (!collapseTrail) {
                  visible = entries.map((_, i) => i)
                } else {
                  const start = Math.max(1, cursor - 3)
                  const end = Math.min(entries.length - 1, cursor + 1)
                  visible = [0]
                  if (start > 1) visible.push(-1)
                  for (let i = start; i <= end; i++) visible.push(i)
                  if (end < entries.length - 1) visible.push(-2)
                }
                return visible.map((i, pos) => {
                  if (i === -1 || i === -2) {
                    const hidden = i === -1
                      ? entries.slice(1, Math.max(1, cursor - 3))
                      : entries.slice(Math.min(entries.length - 1, cursor + 1) + 1)
                    return (
                      <div key={i === -1 ? 'trail-gap' : 'trail-gap-fwd'} className="flex items-center gap-1 flex-shrink-0">
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
                  const id = entries[i]
                  const isCurrent = i === cursor
                  const isForward = i > cursor
                  const label = labelOf(id, nodeMap.get(id))
                  const chipColor = generateColorFromType((nodeMap.get(id)?.data?.type as string) ?? 'entity')
                  const meta = i > 0 ? hopMeta[i - 1] : null
                  // Direction arrows only between ADJACENT hops — after a
                  // gap chip the transition shown isn't the real one.
                  const adjacent = pos > 0 && visible[pos - 1] === i - 1
                  // Parent context — "ticket_key · fact_support" — except
                  // when the previous hop already IS the parent.
                  const chipParent = resolveParent(id)
                  const chipParentLabel = chipParent && chipParent !== entries[i - 1]
                    ? labelOf(chipParent, nodeMap.get(chipParent))
                    : null
                  return (
                    <div key={`${id}-${i}`} className="flex items-center gap-1 flex-shrink-0">
                      {i > 0 && (
                        meta && adjacent ? (
                          <span
                            className="flex items-center"
                            title={`${meta.edgeType || 'connection'} — walked ${meta.downstream ? 'downstream' : 'upstream'}`}
                          >
                            {meta.downstream
                              ? <LucideIcons.MoveRight className={cn('w-3.5 h-3.5 text-accent-lineage/70', isForward && 'opacity-50')} />
                              : <LucideIcons.MoveLeft className={cn('w-3.5 h-3.5 text-amber-500/80', isForward && 'opacity-50')} />}
                          </span>
                        ) : (
                          <LucideIcons.ChevronRight className="w-3 h-3 text-ink-muted/40" />
                        )
                      )}
                      <button
                        type="button"
                        disabled={isCurrent}
                        onClick={() => onJumpTo(i)}
                        title={`${isCurrent ? label : `Jump to ${label}`}${chipParentLabel ? ` — in ${chipParentLabel}` : ''}`}
                        className={cn(
                          isCurrent
                            ? 'flex items-center gap-1.5 max-w-[230px] px-2 py-0.5 rounded-md text-[11px] font-semibold text-accent-lineage bg-accent-lineage/12 border border-accent-lineage/30'
                            : 'flex items-center gap-1.5 max-w-[210px] px-2 py-0.5 rounded-md text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] border border-transparent transition-colors',
                          // The forward side of the history — where
                          // Forward leads — dimmed but fully clickable.
                          isForward && 'opacity-55 hover:opacity-100',
                        )}
                      >
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: chipColor }} />
                        <span className="truncate">{label}</span>
                        {chipParentLabel && (
                          <span className="flex-shrink min-w-0 max-w-[90px] truncate text-[9px] font-normal text-ink-muted/60">
                            · {chipParentLabel}
                          </span>
                        )}
                      </button>
                    </div>
                  )
                })
              })()}
              {/* The walked path (up to the cursor) as a deliverable:
                  present it on the canvas, or copy it as text. */}
              <div className="ml-auto flex items-center gap-1 pl-2 flex-shrink-0">
                {onShowPathOnCanvas && (
                  <button
                    type="button"
                    onClick={() => { onClose(); onShowPathOnCanvas(entries.slice(0, cursor + 1)) }}
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
                    // Parent-qualified hops (fact_support.ticket_key) so a
                    // pasted path carries full context; the qualifier is
                    // dropped when the previous hop already is the parent.
                    void navigator.clipboard?.writeText(
                      entries.slice(0, cursor + 1).map((id, idx, path) => {
                        const p = resolveParent(id)
                        const qualified = p && p !== path[idx - 1]
                        return qualified
                          ? `${labelOf(p, nodeMap.get(p))}.${labelOf(id, nodeMap.get(id))}`
                          : labelOf(id, nodeMap.get(id))
                      }).join(' → '),
                    )
                  }}
                  title="Copy this path as text (fact_support.ticket_key → System A → …)"
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                >
                  <LucideIcons.Copy className="w-3 h-3" />
                  Copy path
                </button>
              </div>
            </div>
          )}

          {/* ── Fetch narration — the lens fetches each visited node's
              lineage from the data source on demand; a failed or capped
              fetch is SAID, never silently rendered as "no connections". ── */}
          {focalFetch === 'error' && (
            <div className="flex items-center gap-2 px-4 py-1.5 border-b border-amber-500/25 bg-amber-500/[0.06] text-[10.5px] text-amber-700 dark:text-amber-400">
              <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0" />
              <span>Couldn&apos;t fetch this entity&apos;s lineage from the data source — showing only what&apos;s already loaded on the canvas.</span>
              {onRetryFetch && (
                <button
                  type="button"
                  onClick={() => onRetryFetch(nodeId)}
                  className="ml-auto flex-shrink-0 font-semibold hover:underline"
                >
                  Retry
                </button>
              )}
            </div>
          )}
          {focalFetch === 'done' && fetchTruncatedIds?.has(nodeId) && (
            <div className="flex items-center gap-2 px-4 py-1.5 border-b border-black/[0.06] dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.02] text-[10.5px] text-ink-muted">
              <LucideIcons.Info className="w-3 h-3 flex-shrink-0" />
              <span>Large neighborhood — showing the first {EDGE_FETCH_LIMIT} connections per direction from the data source. Use the filter to narrow.</span>
            </div>
          )}

          {/* ── Body — the SAME layout at every depth: re-centering
              swaps the focal in place instead of flipping to a
              different presentation (the old Miller-columns walk body
              was the #1 reported confusion).
              minmax(0,1fr): a bare `1fr` track keeps min-width:auto, so
              a long unbroken field name blows the track past the dialog
              edge (no scroll → unusable). minmax(0,…) lets the track
              shrink and the rows' `truncate` take over. ── */}
          <div className="flex-1 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] min-h-0">
            <NeighborColumn
              title="Data Sources"
              subtitle="Upstream"
              records={incomingRecords.filter(filterFn)}
              totalCount={incomingRecords.length}
              direction="incoming"
              fetchState={focalFetch}
              nodeMap={nodeMap}
              resolveParent={resolveParent}
              isCoarser={(t) => isCoarserThan(t, focalType)}
              hiddenTypes={hiddenTypes}
              onToggleType={toggleHiddenType}
              collapseToggles={collapseToggles}
              onToggleCollapse={toggleCollapse}
              searching={q !== ''}
              rawEdgeById={rawEdgeById}
              drilledRows={drilledRows}
              onToggleDrill={toggleDrillWithFetch}
              drillEdges={drillEdges}
              drillStatus={drillStatus}
              onDrillFetch={onDrillFetch}
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
                  {/* overflow-wrap:anywhere — `break-words` won't break an
                      unbroken run like a long snake_case field name, so it
                      would overflow the fixed-width card. */}
                  <p className="text-[15px] font-semibold text-ink [overflow-wrap:anywhere] leading-snug">{focalLabel}</p>
                  {/* Parent breadcrumb — where this entity LIVES; click
                      steps the lens up into the parent. */}
                  {focalParentId && (
                    <button
                      type="button"
                      onClick={() => onRecenter(focalParentId)}
                      title={`Re-center on ${focalParentLabel}`}
                      className="mt-0.5 flex items-center gap-1 max-w-full text-[10px] text-ink-muted hover:text-accent-lineage transition-colors"
                    >
                      <LucideIcons.CornerLeftUp className="w-2.5 h-2.5 flex-shrink-0" />
                      <span className="truncate">in {focalParentLabel}</span>
                    </button>
                  )}
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

              {/* Contained entities — the descent that keeps exploration
                  alive when a container's relationships live at child
                  level. Clicking steps the walk INTO the child. */}
              {focalChildren.length > 0 && (
                <div className="w-60 mt-4 min-h-0">
                  <div className="flex items-center gap-1.5 mb-1">
                    <LucideIcons.FolderTree className="w-3 h-3 text-ink-muted/60" />
                    <span className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-ink-muted/70">Contains</span>
                    <span className="text-[9.5px] tabular-nums text-ink-muted/60">{focalChildTotal}</span>
                  </div>
                  <div className="max-h-36 overflow-y-auto custom-scrollbar flex flex-col">
                    {focalChildren.slice(0, 50).map(cid => {
                      const cColor = generateColorFromType((nodeMap.get(cid)?.data?.type as string) ?? 'entity')
                      return (
                        <button
                          key={`focal-child-${cid}`}
                          type="button"
                          onClick={() => onRecenter(cid)}
                          title={`Step into ${labelOf(cid, nodeMap.get(cid))} — walk its lineage`}
                          className="w-full min-w-0 flex items-center gap-1.5 px-2 py-1.5 rounded-md text-left text-[11.5px] text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.05] transition-colors"
                        >
                          <LucideIcons.CornerDownRight className="w-3 h-3 flex-shrink-0 text-ink-muted/50" />
                          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: cColor }} />
                          <span className="truncate">{labelOf(cid, nodeMap.get(cid))}</span>
                          <LucideIcons.ChevronRight className="ml-auto w-3 h-3 flex-shrink-0 text-ink-muted/30" />
                        </button>
                      )
                    })}
                    {focalChildTotal > Math.min(focalChildren.length, 50) && (
                      <p className="px-2 py-0.5 text-[10px] text-ink-muted/60">
                        +{(focalChildTotal - Math.min(focalChildren.length, 50)).toLocaleString()} more contained
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            <NeighborColumn
              title="Data Consumers"
              subtitle="Downstream"
              records={outgoingRecords.filter(filterFn)}
              totalCount={outgoingRecords.length}
              direction="outgoing"
              fetchState={focalFetch}
              nodeMap={nodeMap}
              resolveParent={resolveParent}
              isCoarser={(t) => isCoarserThan(t, focalType)}
              hiddenTypes={hiddenTypes}
              onToggleType={toggleHiddenType}
              collapseToggles={collapseToggles}
              onToggleCollapse={toggleCollapse}
              searching={q !== ''}
              rawEdgeById={rawEdgeById}
              drilledRows={drilledRows}
              onToggleDrill={toggleDrillWithFetch}
              drillEdges={drillEdges}
              drillStatus={drillStatus}
              onDrillFetch={onDrillFetch}
              onRecenter={onRecenter}
              onRevealOnCanvas={onRevealOnCanvas}
              onOpenDetails={onOpenDetails}
            />
          </div>

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
                        <InfoTooltip side="top" content={`Trace lineage from ${r.label} — brings its lineage onto the canvas`}>
                          <button
                            type="button"
                            onClick={() => { onClose(); onTrace(r.urn) }}
                            className="ml-auto flex-shrink-0 rounded text-[10px] font-semibold text-accent-lineage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                          >
                            Trace
                          </button>
                        </InfoTooltip>
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
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-black/10 dark:border-white/10 text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                >
                  <LucideIcons.Frame className="w-3 h-3" />
                  Reveal all on canvas
                </button>
              )}
              {onTrace && (
                <button
                  type="button"
                  onClick={() => { onClose(); onTrace(nodeId) }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-accent-lineage/15 border border-accent-lineage/40 text-[11px] font-semibold text-accent-lineage hover:bg-accent-lineage/25 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
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
    // URN-derived fallback for an as-yet-unresolved neighbor. Split on
    // structural punctuation too (`,` `(` `)`) so nested URNs like
    // `urn:…:(…,field_name)` yield `field_name`, never a stray `)` or a
    // comma-joined blob.
    ?? id.split(/[:/.,()]/).filter(Boolean).pop()
    ?? id
}

/** Entity-type filter chips — shared by the classic columns and the
 *  walk frontier. An OFF chip goes ghost (dashed border, dimmed, EyeOff)
 *  but keeps its count: filtering is an explicit, visible, reversible
 *  choice — never a strikethrough that reads as broken, never silent
 *  loss. */
function TypeChips({
  chips,
  hiddenTypes,
  onToggle,
  className,
}: {
  chips: Array<[string, number]>
  hiddenTypes: ReadonlySet<string>
  onToggle: (type: string) => void
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {chips.map(([t, n]) => {
        const off = hiddenTypes.has(t)
        const chipColor = t === 'not loaded' ? '#94a3b8' : generateColorFromType(t)
        return (
          <button
            key={t}
            type="button"
            onClick={() => onToggle(t)}
            title={off
              ? `${t} hidden — click to show these ${n} connection${n === 1 ? '' : 's'} again`
              : `Click to hide ${t} connections (${n})`}
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[9px] font-semibold uppercase tracking-wide transition-all',
              off
                ? 'border-dashed border-ink-muted/30 text-ink-muted/45 hover:text-ink-muted hover:border-ink-muted/50'
                : 'border-black/10 dark:border-white/10 text-ink-muted hover:text-ink bg-black/[0.03] dark:bg-white/[0.04]',
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: chipColor, opacity: off ? 0.3 : 1 }} />
            <span className="max-w-[90px] truncate">{t}</span>
            <span className="tabular-nums">{n}</span>
            {off && <LucideIcons.EyeOff className="w-2.5 h-2.5 flex-shrink-0" />}
          </button>
        )
      })}
    </div>
  )
}

/** Drill payload for an aggregated (×N) row — computed by the column,
 *  rendered by the row. Same refine semantics as the walk columns. */
interface NeighborRowDrill {
  drilled: boolean
  onToggle: () => void
  /** Locally loaded ∪ on-demand fetched underlying edges, deduped. */
  constituents: LineageEdge[]
  missing: number
  state?: 'loading' | 'done' | 'error'
  onRetry?: () => void
}

/** One neighbor row — shared by parent groups, type groups, and the
 *  rollup tier so the interaction contract stays identical everywhere. */
function NeighborRow({
  r,
  isIn,
  accentColor,
  rollup,
  drill,
  nodeMap,
  onRecenter,
  onRevealOnCanvas,
  onOpenDetails,
}: {
  r: NeighborRecord
  isIn: boolean
  accentColor: string
  /** Coarser-grain summary row — muted, badged, never counted as more data. */
  rollup?: boolean
  /** Present when the row is a drillable aggregate. */
  drill?: NeighborRowDrill
  nodeMap: Map<string, LineageNode>
  onRecenter: (nodeId: string) => void
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  onOpenDetails?: (nodeId: string) => void
}) {
  const edgeColor = generateEdgeColorFromType(r.edgeTypeNorm)
  const aggCount = (r.edge.data as { sourceEdgeCount?: number } | undefined)?.sourceEdgeCount
  const bundleCount = (r.edge as { edgeCount?: number }).edgeCount
    ?? (r.edge.data as { edgeCount?: number } | undefined)?.edgeCount
    ?? aggCount
  const unloaded = !r.neighborNode
  return (
    <div className="min-w-0">
    <div
      role="button"
      tabIndex={0}
      className={cn(
        // content-visibility skips layout+paint for offscreen rows —
        // lightweight virtualization; columns can hold 200 cards.
        // transition-colors (not -all): animating every property makes
        // hover sweeps during scroll recompute layout per row.
        'group relative flex items-center gap-2 rounded-lg border px-2.5 py-2 cursor-pointer transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_58px] border-black/[0.07] dark:border-white/[0.08] hover:border-accent-lineage/50 hover:shadow-sm bg-black/[0.015] dark:bg-white/[0.02] hover:bg-black/[0.035] dark:hover:bg-white/[0.05] min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
        rollup && 'opacity-75 hover:opacity-100',
      )}
      style={{ borderLeftWidth: 3, borderLeftColor: accentColor }}
      onClick={() => onRecenter(r.neighborId)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRecenter(r.neighborId) } }}
      title={`Re-center on ${labelOf(r.neighborId, r.neighborNode)}`}
    >
      <div className="flex-1 min-w-0">
        <p className="flex items-center gap-1.5 min-w-0 text-[12px] font-medium text-ink leading-snug">
          <span className="truncate">{labelOf(r.neighborId, r.neighborNode)}</span>
          {rollup && (
            <span
              className="flex-shrink-0 flex items-center gap-0.5 px-1 py-px rounded bg-black/[0.05] dark:bg-white/[0.07] text-[8.5px] font-semibold uppercase tracking-wide text-ink-muted/70"
              title="A coarser-grain summary of finer flows — not an additional connection"
            >
              <LucideIcons.Layers className="w-2.5 h-2.5" />
              rollup
            </span>
          )}
        </p>
        <p className="flex items-center gap-1 text-[9.5px] text-ink-muted/70 leading-snug">
          <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ backgroundColor: edgeColor }} />
          <span className="truncate uppercase tracking-wide">{r.edgeTypeNorm || 'relationship'}</span>
          {drill ? (
            // The ×N badge IS the drill toggle — same refine gesture as
            // the walk columns (stopPropagation: card click re-centers).
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); drill.onToggle() }}
              title={drill.drilled
                ? 'Collapse back to the rolled-up connection'
                : `Refine — see the ${(aggCount ?? bundleCount ?? 0).toLocaleString()} underlying connection${(aggCount ?? bundleCount ?? 0) === 1 ? '' : 's'} this rolls up`}
              className="flex items-center gap-0.5 tabular-nums font-semibold text-ink-muted hover:text-accent-lineage transition-colors"
            >
              ×{(bundleCount ?? 0).toLocaleString()}
              <LucideIcons.ChevronDown className={cn('w-2.5 h-2.5 transition-transform', !drill.drilled && '-rotate-90')} />
            </button>
          ) : (
            bundleCount != null && bundleCount > 1 && (
              <span className="tabular-nums font-semibold text-ink-muted">×{bundleCount.toLocaleString()}</span>
            )
          )}
          {unloaded && <span className="italic">· not on canvas</span>}
        </p>
      </div>
      {/* Flow direction cue: data always travels left → right. Hover
          actions ALWAYS dock on the right (docking them left covered
          the label/chevron); only the right-side chevron (incoming
          rows) swaps out for them — the left chevron keeps its place. */}
      <LucideIcons.ChevronRight
        className={cn('w-3.5 h-3.5 flex-shrink-0', isIn ? 'order-last group-hover:hidden' : 'order-first')}
        style={{ color: `${edgeColor}99` }}
      />
      <span className={cn(
        'hidden group-hover:flex flex-shrink-0 order-last items-center gap-0.5 rounded-md bg-canvas-elevated border border-black/10 dark:border-white/10 shadow-sm px-0.5 py-0.5',
      )}>
        {onRevealOnCanvas && (
          <InfoTooltip side="top" content="Reveal on canvas">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); void onRevealOnCanvas(r.neighborId) }}
              className="w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.05] dark:hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
            >
              <LucideIcons.Crosshair className="w-3 h-3" />
            </button>
          </InfoTooltip>
        )}
        {onOpenDetails && (
          <InfoTooltip side="top" content="Open details">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenDetails(r.neighborId) }}
              className="w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.05] dark:hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
            >
              <LucideIcons.PanelRight className="w-3 h-3" />
            </button>
          </InfoTooltip>
        )}
      </span>
    </div>
    {/* Refined constituents — the aggregate's real endpoints, local ∪
        fetched, mirroring the walk-column drill exactly. */}
    {drill?.drilled && (
      <div className="ml-4 mt-0.5 pl-2 border-l border-dashed border-black/[0.10] dark:border-white/[0.12] pb-1">
        {drill.constituents.map(e => {
          const otherId = isIn ? e.source : e.target
          const oColor = generateColorFromType((nodeMap.get(otherId)?.data?.type as string) ?? 'entity')
          return (
            <div
              key={e.id}
              className="flex items-center gap-1.5 px-2 py-1 min-w-0 text-[10.5px] text-ink/90"
              title={`${labelOf(e.source, nodeMap.get(e.source))} → ${labelOf(e.target, nodeMap.get(e.target))}${(e.data?.edgeType as string) ? ` (${e.data?.edgeType as string})` : ''}`}
            >
              <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ backgroundColor: oColor }} />
              <span className="truncate">{labelOf(otherId, nodeMap.get(otherId))}</span>
            </div>
          )
        })}
        {drill.state === 'loading' && (
          <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-ink-muted/70">
            <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-accent-lineage/70" />
            Fetching underlying connections…
          </div>
        )}
        {drill.state === 'error' && (
          <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-400">
            <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0" />
            <span>Couldn&apos;t fetch the underlying connections.</span>
            {drill.onRetry && (
              <button type="button" onClick={drill.onRetry} className="font-semibold hover:underline">
                Retry
              </button>
            )}
          </div>
        )}
        {drill.constituents.length === 0 && drill.state !== 'loading' && drill.state !== 'error' && (
          <p className="px-2 py-1 text-[10px] text-ink-muted/70 italic leading-snug">
            {drill.state === 'done'
              ? 'No underlying connections found between these entities.'
              : 'Constituent connections aren’t loaded — drill this edge on the canvas to fetch them.'}
          </p>
        )}
        {drill.missing > 0 && drill.constituents.length > 0 && drill.state !== 'loading' && (
          <p className="px-2 py-0.5 text-[10px] text-ink-muted/60">
            +{drill.missing.toLocaleString()} more (showing the first {drill.constituents.length})
          </p>
        )}
      </div>
    )}
    </div>
  )
}

function NeighborColumn({
  title,
  subtitle,
  records,
  totalCount,
  direction,
  fetchState,
  nodeMap,
  resolveParent,
  isCoarser,
  hiddenTypes,
  onToggleType,
  collapseToggles,
  onToggleCollapse,
  searching,
  rawEdgeById,
  drilledRows,
  onToggleDrill,
  drillEdges,
  drillStatus,
  onDrillFetch,
  onRecenter,
  onRevealOnCanvas,
  onOpenDetails,
}: {
  title: string
  subtitle: string
  records: NeighborRecord[]
  totalCount: number
  direction: 'incoming' | 'outgoing'
  /** On-demand fetch status for the focal node — keeps an in-flight
   *  fetch from reading as "no connections". */
  fetchState?: 'loading' | 'done' | 'error'
  nodeMap: Map<string, LineageNode>
  /** Containment parent of a node, when known (fetched or loaded). */
  resolveParent: (id: string) => string | null
  /** True when the given entity type is a COARSER grain than the focal
   *  (its type can transitively contain the focal's type) — those rows
   *  are summaries of finer flows, demoted to the rollup tier. */
  isCoarser: (type: string | undefined) => boolean
  hiddenTypes: ReadonlySet<string>
  onToggleType: (type: string) => void
  /** Per-group collapse toggles (XOR against the column default). */
  collapseToggles: ReadonlySet<string>
  onToggleCollapse: (key: string) => void
  /** Text filter active — auto-expand every group so matches can't
   *  hide inside a collapsed one (that would be silent loss). */
  searching: boolean
  /** Drill machinery — same refine semantics as the walk columns. */
  rawEdgeById: Map<string, LineageEdge>
  drilledRows: Set<string>
  onToggleDrill: (key: string, edge: LineageEdge) => void
  drillEdges?: Map<string, LineageEdge[]>
  drillStatus?: Map<string, 'loading' | 'done' | 'error'>
  onDrillFetch?: (edge: LineageEdge) => void
  onRecenter: (nodeId: string) => void
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  onOpenDetails?: (nodeId: string) => void
}) {
  // Three-way organization, replacing the flat by-type grouping:
  //  1. finer/peer rows grouped by their PARENT dataset when known —
  //     the column reads "which datasets feed me, via which fields";
  //  2. rows with no known parent grouped by entity type (as before);
  //  3. coarser-grain rows demoted to a labeled Rollups tier — visible
  //     (never silently dropped) but muted and explained, because they
  //     summarize the finer flows above rather than add connections.
  const { typeChips, groups, rollups, hiddenCount } = useMemo(() => {
    const typeCounts = new Map<string, number>()
    for (const r of records) {
      const t = (r.neighborNode?.data?.type as string) ?? 'not loaded'
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1)
    }
    const typeChips = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])
    let hiddenCount = 0
    const shown: NeighborRecord[] = []
    for (const r of records) {
      const t = (r.neighborNode?.data?.type as string) ?? 'not loaded'
      if (hiddenTypes.has(t)) { hiddenCount++; continue }
      if (shown.length < ROWS_CAP) shown.push(r)
    }
    const rollups: NeighborRecord[] = []
    const finer: NeighborRecord[] = []
    for (const r of shown) {
      if (isCoarser(r.neighborNode?.data?.type as string | undefined)) rollups.push(r)
      else finer.push(r)
    }
    const groupMap = new Map<string, { kind: 'parent' | 'type'; key: string; rows: NeighborRecord[] }>()
    for (const r of finer) {
      const parent = resolveParent(r.neighborId)
      const mapKey = parent ? `p:${parent}` : `t:${(r.neighborNode?.data?.type as string) ?? 'not loaded'}`
      let g = groupMap.get(mapKey)
      if (!g) {
        g = {
          kind: parent ? 'parent' : 'type',
          key: parent ?? ((r.neighborNode?.data?.type as string) ?? 'not loaded'),
          rows: [],
        }
        groupMap.set(mapKey, g)
      }
      g.rows.push(r)
    }
    const groups = [...groupMap.values()].sort((a, b) => b.rows.length - a.rows.length)
    return { typeChips, groups, rollups, hiddenCount }
  }, [records, hiddenTypes, isCoarser, resolveParent])

  const isIn = direction === 'incoming'
  const allFilteredOff = records.length > 0 && groups.length === 0 && rollups.length === 0

  // Drill payload for an aggregated row — local raw edges ∪ on-demand
  // fetched, mirroring the walk-column computation exactly.
  const buildDrill = (r: NeighborRecord): NeighborRowDrill | undefined => {
    const aggData = r.edge.data as { isAggregated?: boolean; sourceEdgeCount?: number; sourceEdges?: string[] } | undefined
    const canDrill = !!aggData?.isAggregated
      && ((aggData.sourceEdges?.length ?? 0) > 0 || (aggData.sourceEdgeCount ?? 0) > 1)
    if (!canDrill) return undefined
    const key = `c:${direction}:${r.edge.id}`
    const drilled = drilledRows.has(key)
    let constituents: LineageEdge[] = []
    let missing = 0
    if (drilled) {
      const local = (aggData.sourceEdges ?? [])
        .map(eid => rawEdgeById.get(eid))
        .filter((e): e is LineageEdge => !!e)
      const seenConstituent = new Set(local.map(e => e.id))
      const fetched = (drillEdges?.get(r.edge.id) ?? []).filter(e => !seenConstituent.has(e.id))
      const all = [...local, ...fetched]
      constituents = all.slice(0, 50)
      missing = Math.max(0, Math.max(aggData.sourceEdgeCount ?? 0, all.length) - constituents.length)
    }
    return {
      drilled,
      onToggle: () => onToggleDrill(key, r.edge),
      constituents,
      missing,
      state: drilled ? drillStatus?.get(r.edge.id) : undefined,
      onRetry: onDrillFetch ? () => onDrillFetch(r.edge) : undefined,
    }
  }

  return (
    <div className={cn(
      // min-w-0: allow the grid track to shrink so long labels truncate
      // instead of forcing the column (and dialog) wider than the viewport.
      'flex flex-col min-h-0 min-w-0',
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
      {/* Grain/type chips — one per entity type present, click to
          toggle. An off chip stays visible with its count (explicit
          user choice, not silent loss). */}
      {typeChips.length > 1 && (
        <TypeChips chips={typeChips} hiddenTypes={hiddenTypes} onToggle={onToggleType} className="px-3 pb-1.5 flex-shrink-0" />
      )}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-2.5 pb-3">
        {allFilteredOff && (
          <p className="px-2 py-6 text-center text-[11px] text-ink-muted/70 leading-snug">
            All {totalCount} connection{totalCount === 1 ? '' : 's'} hidden by the type chips above.
          </p>
        )}
        {records.length === 0 && (
          totalCount === 0 && fetchState === 'loading' ? (
            <div className="flex flex-col items-center gap-2 px-2 py-10 text-center">
              <LucideIcons.Loader2 className="w-5 h-5 animate-spin text-accent-lineage/60" />
              <p className="text-[11px] text-ink-muted/70 leading-snug">
                Fetching {isIn ? 'upstream sources' : 'downstream consumers'} from the data source…
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 px-2 py-10 text-center">
              <LucideIcons.CircleSlash className="w-5 h-5 text-ink-muted/40" />
              <p className="text-[11px] text-ink-muted/70 leading-snug">
                {totalCount === 0
                  // Post-fetch this is a data-source claim, not a canvas one.
                  ? fetchState === 'done'
                    ? `No ${isIn ? 'upstream sources' : 'downstream consumers'} in the data source`
                    : `No ${isIn ? 'upstream sources' : 'downstream consumers'} on this canvas`
                  : 'No matches for this filter'}
              </p>
            </div>
          )
        )}
        {groups.map((g, _gi, allGroups) => {
          if (g.kind === 'parent') {
            const parentLabel = labelOf(g.key, nodeMap.get(g.key))
            const parentColor = generateColorFromType((nodeMap.get(g.key)?.data?.type as string) ?? 'entity')
            // 3+ parent groups → start collapsed (dataset-level overview
            // first); toggles XOR the default. Searching expands all.
            const defaultCollapsed = allGroups.filter(gr => gr.kind === 'parent').length >= 3
            const collapseKey = `${direction}:p:${g.key}`
            const collapsed = !searching && (defaultCollapsed !== collapseToggles.has(collapseKey))
            return (
              <div key={`p-${g.key}`} className="mb-2.5">
                {/* Parent-dataset header — the structural story ("which
                    datasets feed me, via which fields"). The WHOLE row
                    toggles collapse (a 20px chevron alone was unusable);
                    navigation lives on the dedicated re-center button. */}
                <div className="flex items-center gap-1 mb-1 min-w-0">
                  <button
                    type="button"
                    onClick={() => onToggleCollapse(collapseKey)}
                    title={collapsed ? `Expand ${g.rows.length} connection${g.rows.length === 1 ? '' : 's'}` : 'Collapse group'}
                    className="flex-1 min-w-0 flex items-center gap-2 px-2 py-2 rounded-lg text-left bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.07] transition-colors"
                  >
                    <LucideIcons.ChevronDown className={cn('w-4 h-4 flex-shrink-0 text-ink-muted transition-transform', collapsed && '-rotate-90')} />
                    <LucideIcons.FolderTree className="w-3.5 h-3.5 flex-shrink-0 text-ink-muted/70" />
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: parentColor }} />
                    <span className="min-w-0 truncate text-[12px] font-semibold text-ink">{parentLabel}</span>
                    <span className="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07] text-[10px] font-semibold tabular-nums text-ink-muted">
                      {g.rows.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRecenter(g.key)}
                    title={`Re-center on ${parentLabel}`}
                    className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:text-accent-lineage hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors"
                  >
                    <LucideIcons.Crosshair className="w-3.5 h-3.5" />
                  </button>
                </div>
                {!collapsed && (
                  <div className="flex flex-col gap-1">
                    {g.rows.map((r, i) => (
                      <NeighborRow
                        key={`${r.edge.id}-${i}`}
                        r={r}
                        isIn={isIn}
                        accentColor={r.neighborNode ? generateColorFromType((r.neighborNode.data?.type as string) ?? 'entity') : '#94a3b8'}
                        drill={buildDrill(r)}
                        nodeMap={nodeMap}
                        onRecenter={onRecenter}
                        onRevealOnCanvas={onRevealOnCanvas}
                        onOpenDetails={onOpenDetails}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          }
          const unloaded = g.key === 'not loaded'
          const typeColor = unloaded ? '#94a3b8' : generateColorFromType(g.key)
          return (
            <div key={`t-${g.key}`} className="mb-2.5">
              <div
                className="flex items-center gap-1.5 px-1.5 py-1"
                title={unloaded
                  ? 'Referenced by lineage, but the entity details couldn’t be resolved from the data source.'
                  : undefined}
              >
                {unloaded
                  ? <LucideIcons.HelpCircle className="w-3 h-3 flex-shrink-0 text-ink-muted/50" />
                  : <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: typeColor }} />}
                <span className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-ink-muted/80">
                  {unloaded ? 'Unresolved' : g.key}
                </span>
                <span className="text-[9.5px] tabular-nums text-ink-muted/60">{g.rows.length}</span>
              </div>
              <div className="flex flex-col gap-1">
                {g.rows.map((r, i) => (
                  <NeighborRow
                    key={`${r.edge.id}-${i}`}
                    r={r}
                    isIn={isIn}
                    accentColor={typeColor}
                    drill={buildDrill(r)}
                    nodeMap={nodeMap}
                    onRecenter={onRecenter}
                    onRevealOnCanvas={onRevealOnCanvas}
                    onOpenDetails={onOpenDetails}
                  />
                ))}
              </div>
            </div>
          )
        })}
        {/* Rollup tier — coarser-grain summaries (containers, platforms)
            of the flows above. Visible and labeled, never silently
            dropped — but demoted so they can't read as extra data. */}
        {rollups.length > 0 && (
          <div className="mt-1 pt-1.5 border-t border-dashed border-black/[0.08] dark:border-white/[0.10]">
            <div
              className="flex items-center gap-1.5 px-1.5 py-1"
              title="Coarser-grain summaries (containers, platforms) of the flows above — not additional connections"
            >
              <LucideIcons.Layers className="w-3 h-3 text-ink-muted/50" />
              <span className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-ink-muted/60">Rollups</span>
              <span className="text-[9.5px] tabular-nums text-ink-muted/50">{rollups.length}</span>
            </div>
            <div className="flex flex-col gap-1">
              {rollups.map((r, i) => (
                <NeighborRow
                  key={`${r.edge.id}-${i}`}
                  r={r}
                  isIn={isIn}
                  accentColor={r.neighborNode ? generateColorFromType((r.neighborNode.data?.type as string) ?? 'entity') : '#94a3b8'}
                  rollup
                  drill={buildDrill(r)}
                  nodeMap={nodeMap}
                  onRecenter={onRecenter}
                  onRevealOnCanvas={onRevealOnCanvas}
                  onOpenDetails={onOpenDetails}
                />
              ))}
            </div>
          </div>
        )}
        {hiddenCount > 0 && !allFilteredOff && (
          <p className="px-2 py-1.5 text-[10px] text-ink-muted/60">
            {hiddenCount} connection{hiddenCount === 1 ? '' : 's'} hidden by the type chips
          </p>
        )}
        {records.length > ROWS_CAP && (
          <p className="px-2 py-1.5 text-[10px] text-ink-muted/70">
            +{records.length - ROWS_CAP} more — use the filter to narrow
          </p>
        )}
      </div>
    </div>
  )
}
