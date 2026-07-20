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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

const ROWS_CAP = 200
const EMPTY_TYPE_SET: ReadonlySet<string> = new Set()

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
  supplementalEdges,
  supplementalNodes,
  fetchStatus,
  fetchTruncatedIds,
  onRetryFetch,
  drillEdges,
  drillStatus,
  onDrillFetch,
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

  // Open gate for every canvas-scale memo below: this component is
  // always mounted, and a closed lens must cost nothing when the
  // (potentially very large) node/edge sets churn.
  const lensOpen = lensStack.length > 0

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
    for (let i = 1; i < lensStack.length; i++) {
      const prev = lensStack[i - 1]
      const curr = lensStack[i]
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
  }, [lensStack, edgesByEndpoint])

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
    // Indexed: each hop scans only its own incident edges, not the
    // whole edge set (deriveNeighborRecords filters by endpoint anyway).
    () => lensStack.map(id => deriveNeighborRecords(id, edgesByEndpoint.get(id) ?? [], nodeMap, containmentEdgeTypes)),
    [lensStack, edgesByEndpoint, nodeMap, containmentEdgeTypes],
  )

  // Containment per hop — a container's relationships often live at
  // CHILD level, so a walk into one would dead-end on flow edges alone.
  // Children (containment edges are parent → child) render as a
  // walkable "Contains" group; O(degree) via the endpoint index.
  const containmentByHop = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const id of lensStack) {
      if (m.has(id)) continue
      const children: string[] = []
      const seen = new Set<string>()
      for (const e of edgesByEndpoint.get(id) ?? []) {
        if (!isContainmentEdgeType(normalizeEdgeType(e), containmentEdgeTypes)) continue
        if (e.source === id && e.target !== id && !seen.has(e.target)) {
          seen.add(e.target)
          children.push(e.target)
        }
      }
      m.set(id, children)
    }
    return m
  }, [lensStack, edgesByEndpoint, containmentEdgeTypes])

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

  // Auto-advance: when a hop is pushed, glide the column strip to the
  // frontier so the newest column is always in view.
  const walkStripRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = walkStripRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' }))
    return () => cancelAnimationFrame(raf)
  }, [lensStack.length])

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
  const focalChildren = containmentByHop.get(nodeId) ?? []
  const focalChildTotal = Math.max(
    focalChildren.length,
    (focalNode?.data?.childCount as number | undefined) ?? 0,
  )
  // Containment parent of the focal — breadcrumb context ("ticket_key
  // in fact_support"). Header display suppresses it when the PREVIOUS
  // hop already is the parent (saying it twice reads as noise).
  const focalParentId = resolveParent(nodeId)
  const focalParentLabel = focalParentId ? labelOf(focalParentId, nodeMap.get(focalParentId)) : null
  const focalParentInHeader = focalParentId && focalParentId !== lensStack[lensStack.length - 2]
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
                  {lensStack.length > 1
                    ? `Walking ${walkDirection === 'outgoing' ? 'downstream' : 'upstream'} · ${lensStack.length - 1} hop${lensStack.length === 2 ? '' : 's'} · ${(walkDirection === 'outgoing' ? outgoingRecords : incomingRecords).length} at the frontier`
                    : `${focalDirectTotal} direct connection${focalDirectTotal === 1 ? '' : 's'}${focalRollupTotal > 0 ? ` · ${focalRollupTotal} rolled-up` : ''}${focalChildTotal > 0 ? ` · contains ${focalChildTotal}` : ''}`}
                </span>
                {focalFetch === 'loading' && (
                  <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-accent-lineage/70" aria-label="Fetching lineage from the data source" />
                )}
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
                // Parent context — "ticket_key · fact_support" — except
                // when the previous hop already IS the parent.
                const chipParent = resolveParent(id)
                const chipParentLabel = chipParent && chipParent !== lensStack[i - 1]
                  ? labelOf(chipParent, nodeMap.get(chipParent))
                  : null
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
                      title={`${isCurrent ? label : `Jump back to ${label}`}${chipParentLabel ? ` — in ${chipParentLabel}` : ''}`}
                      className={
                        isCurrent
                          ? 'flex items-center gap-1.5 max-w-[230px] px-2 py-0.5 rounded-md text-[11px] font-semibold text-accent-lineage bg-accent-lineage/12 border border-accent-lineage/30'
                          : 'flex items-center gap-1.5 max-w-[210px] px-2 py-0.5 rounded-md text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] border border-transparent transition-colors'
                      }
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
                    // Parent-qualified hops (fact_support.ticket_key) so a
                    // pasted path carries full context; the qualifier is
                    // dropped when the previous hop already is the parent.
                    void navigator.clipboard?.writeText(
                      lensStack.map((id, idx) => {
                        const p = resolveParent(id)
                        const qualified = p && p !== lensStack[idx - 1]
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

          {/* ── Walk body (Miller columns) — one column per hop, oldest
              on the left, the current frontier widest on the right. Each
              column lists its hop's frontier in the LOCKED direction;
              the row you walked into is highlighted, and clicking a row
              in an earlier column BRANCHES the walk from that hop.
              Complexity stays constant: path + frontier, never a tree. ── */}
          {lensStack.length > 1 && onWalkTo ? (
            <div ref={walkStripRef} className="flex-1 flex min-h-0 overflow-x-auto custom-scrollbar divide-x divide-black/[0.06] dark:divide-white/[0.06]">
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
                const hopType = (nodeMap.get(hopId)?.data?.type as string) ?? 'entity'
                // Finer/peer rows first; coarser-grain rollups demoted to
                // the end (visible, badged — never silently dropped).
                const rowsFiner: Array<{ rec: NeighborRecord; n: number; coarser: boolean }> = []
                const rowsCoarser: Array<{ rec: NeighborRecord; n: number; coarser: boolean }> = []
                for (const { rec, n } of byNeighbor.values()) {
                  if (isLast && !filterFn(rec)) continue
                  const coarser = isCoarserThan(rec.neighborNode?.data?.type as string | undefined, hopType)
                  ;(coarser ? rowsCoarser : rowsFiner).push({ rec, n, coarser })
                }
                const rows = [...rowsFiner, ...rowsCoarser].slice(0, 200)
                // Grain chips (frontier column) + lens-global hidden-type
                // filter, and the same parent-dataset grouping the classic
                // columns use — the frontier reads "which datasets, via
                // which fields", not a wall of bare names.
                const typeCounts = new Map<string, number>()
                for (const { rec } of byNeighbor.values()) {
                  const t = (rec.neighborNode?.data?.type as string) ?? 'not loaded'
                  typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1)
                }
                const hopChips: Array<[string, number]> = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])
                let hopHiddenCount = 0
                const shownRows: typeof rows = []
                for (const it of rows) {
                  const t = (it.rec.neighborNode?.data?.type as string) ?? 'not loaded'
                  if (hiddenTypes.has(t)) { hopHiddenCount++; continue }
                  shownRows.push(it)
                }
                const walkGroupMap = new Map<string, { kind: 'parent' | 'type'; key: string; rows: typeof rows }>()
                const rollupRows: typeof rows = []
                for (const it of shownRows) {
                  if (it.coarser) { rollupRows.push(it); continue }
                  const p = resolveParent(it.rec.neighborId)
                  const useParent = !!p && p !== hopId
                  const mk = useParent ? `p:${p}` : `t:${(it.rec.neighborNode?.data?.type as string) ?? 'not loaded'}`
                  let g = walkGroupMap.get(mk)
                  if (!g) {
                    g = {
                      kind: useParent ? 'parent' : 'type',
                      key: useParent ? (p as string) : ((it.rec.neighborNode?.data?.type as string) ?? 'not loaded'),
                      rows: [],
                    }
                    walkGroupMap.set(mk, g)
                  }
                  g.rows.push(it)
                }
                const hopGroups = [...walkGroupMap.values()].sort((a, b) => b.rows.length - a.rows.length)
                const hopLabel = labelOf(hopId, nodeMap.get(hopId))
                const hopColor = generateColorFromType((nodeMap.get(hopId)?.data?.type as string) ?? 'entity')
                const hopFetch = fetchStatus?.get(hopId)
                const hopChildren = (containmentByHop.get(hopId) ?? [])
                  .filter(cid => !isLast || q === '' || labelOf(cid, nodeMap.get(cid)).toLowerCase().includes(q))
                const hopChildTotal = Math.max(
                  hopChildren.length,
                  (nodeMap.get(hopId)?.data?.childCount as number | undefined) ?? 0,
                )
                return (
                  <motion.div
                    key={`walk-col-${hopId}-${i}`}
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                    className={isLast
                      ? 'flex-1 min-w-[300px] flex flex-col min-h-0 bg-accent-lineage/[0.03]'
                      : 'w-[230px] flex-shrink-0 flex flex-col min-h-0'}
                  >
                    <div className="flex items-center gap-1.5 px-3 py-2 border-b border-black/[0.06] dark:border-white/[0.06]">
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: hopColor }} />
                      <span className="truncate text-[11.5px] font-semibold text-ink">{hopLabel}</span>
                      {(() => {
                        const hp = resolveParent(hopId)
                        return hp && hp !== lensStack[i - 1] ? (
                          <span className="flex-shrink min-w-0 max-w-[40%] truncate text-[9.5px] text-ink-muted/60">
                            · {labelOf(hp, nodeMap.get(hp))}
                          </span>
                        ) : null
                      })()}
                      <span className="ml-auto flex-shrink-0 flex items-center gap-1 text-[10px] tabular-nums text-ink-muted/70">
                        {hopFetch === 'loading' && (
                          <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-accent-lineage/70" aria-label="Fetching lineage from the data source" />
                        )}
                        {byNeighbor.size}
                      </span>
                    </div>
                    <div className="flex-1 overflow-y-auto custom-scrollbar py-1">
                      {/* IIFE so the row renderer can be shared by the
                          parent groups, type groups, and rollup tier
                          without hoisting its many closures into props. */}
                      {(() => {
                      const renderWalkRow = ({ rec, n, coarser }: { rec: NeighborRecord; n: number; coarser: boolean }, showParentHint: boolean) => {
                        const rid = rec.neighborId
                        const active = rid === walkedInto
                        const rowColor = generateColorFromType((rec.neighborNode?.data?.type as string) ?? 'entity')
                        // Parent breadcrumb — a bare field name isn't
                        // identifying; say which dataset it belongs to.
                        // Omitted inside parent groups (the header says it)
                        // and when the parent IS this hop.
                        const rowParent = showParentHint ? resolveParent(rid) : null
                        const rowParentLabel = rowParent && rowParent !== hopId
                          ? labelOf(rowParent, nodeMap.get(rowParent))
                          : null
                        const aggData = rec.edge.data as { isAggregated?: boolean; sourceEdgeCount?: number; sourceEdges?: string[] } | undefined
                        const drillKey = `${i}:${rid}`
                        const canDrill = !!aggData?.isAggregated
                          && ((aggData.sourceEdges?.length ?? 0) > 0 || (aggData.sourceEdgeCount ?? 0) > 1)
                        const drilled = canDrill && drilledRows.has(drillKey)
                        // Constituents = locally loaded raw edges ∪ edges
                        // fetched on demand for this drill, deduped by id.
                        const drillState = drilled ? drillStatus?.get(rec.edge.id) : undefined
                        let constituents: LineageEdge[] = []
                        let missing = 0
                        if (drilled) {
                          const local = (aggData?.sourceEdges ?? [])
                            .map(eid => rawEdgeById.get(eid))
                            .filter((e): e is LineageEdge => !!e)
                          const seenConstituent = new Set(local.map(e => e.id))
                          const fetched = (drillEdges?.get(rec.edge.id) ?? []).filter(e => !seenConstituent.has(e.id))
                          const all = [...local, ...fetched]
                          constituents = all.slice(0, 50)
                          missing = Math.max(0, Math.max(aggData?.sourceEdgeCount ?? 0, all.length) - constituents.length)
                        }
                        return (
                          // content-visibility: offscreen walk rows skip
                          // layout+paint (frontiers can reach 200 rows).
                          <div key={rid} className="[content-visibility:auto] [contain-intrinsic-size:auto_30px]">
                            <div className="flex items-stretch">
                              <button
                                type="button"
                                onClick={() => (isLast ? onRecenter(rid) : onWalkTo(i, rid))}
                                title={isLast
                                  ? `Walk into ${labelOf(rid, rec.neighborNode)}`
                                  : `Branch the walk here — continue from ${labelOf(rid, rec.neighborNode)}`}
                                className={
                                  active
                                    ? 'flex-1 min-w-0 flex items-center gap-1.5 px-3 py-1.5 text-left text-[11.5px] font-semibold text-accent-lineage bg-accent-lineage/10 border-l-2 border-accent-lineage'
                                    : `flex-1 min-w-0 flex items-center gap-1.5 px-3 py-1.5 text-left text-[11.5px] text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.05] border-l-2 border-transparent transition-colors${coarser ? ' opacity-70 hover:opacity-100' : ''}`
                                }
                              >
                                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: rowColor }} />
                                <span className="truncate">{labelOf(rid, rec.neighborNode)}</span>
                                {rowParentLabel && (
                                  <span className="flex-shrink min-w-0 max-w-[45%] truncate text-[9px] text-ink-muted/50">
                                    · {rowParentLabel}
                                  </span>
                                )}
                                {n > 1 && <span className="flex-shrink-0 text-[9.5px] tabular-nums text-ink-muted/60">×{n}</span>}
                                {coarser && (
                                  <span
                                    className="flex-shrink-0 flex items-center"
                                    title="A coarser-grain summary of finer flows — not an additional connection"
                                  >
                                    <LucideIcons.Layers className="w-2.5 h-2.5 text-ink-muted/40" />
                                  </span>
                                )}
                                <LucideIcons.ChevronRight className={`ml-auto w-3 h-3 flex-shrink-0 ${active ? 'text-accent-lineage' : 'text-ink-muted/30'}`} />
                              </button>
                              {canDrill && (
                                <button
                                  type="button"
                                  onClick={() => toggleDrillWithFetch(drillKey, rec.edge)}
                                  title={drilled
                                    ? 'Collapse back to the rolled-up connection'
                                    : `Refine — see the ${(aggData?.sourceEdgeCount ?? 0).toLocaleString()} underlying connection${(aggData?.sourceEdgeCount ?? 0) === 1 ? '' : 's'} this rolls up`}
                                  className="flex-shrink-0 px-1.5 flex items-center text-ink-muted/50 hover:text-ink transition-colors"
                                >
                                  <LucideIcons.ChevronDown className={`w-3 h-3 transition-transform ${drilled ? '' : '-rotate-90'}`} />
                                </button>
                              )}
                            </div>
                            {/* Refined constituents — the aggregate's real
                                endpoints, resolved from loaded raw edges.
                                Unloaded remainder reported, never invented. */}
                            {drilled && (
                              <div className="ml-4 pl-2 border-l border-dashed border-black/[0.10] dark:border-white/[0.12] pb-1">
                                {constituents.map(e => {
                                  const otherId = walkDirection === 'outgoing' ? e.target : e.source
                                  const nearId = walkDirection === 'outgoing' ? e.source : e.target
                                  const oColor = generateColorFromType((nodeMap.get(otherId)?.data?.type as string) ?? 'entity')
                                  return (
                                    <div
                                      key={e.id}
                                      className="flex items-center gap-1.5 px-2 py-1 min-w-0 text-[10.5px] text-ink/90"
                                      title={`${labelOf(nearId, nodeMap.get(nearId))} → ${labelOf(otherId, nodeMap.get(otherId))}${(e.data?.edgeType as string) ? ` (${e.data?.edgeType as string})` : ''}`}
                                    >
                                      <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ backgroundColor: oColor }} />
                                      <span className="truncate">{labelOf(otherId, nodeMap.get(otherId))}</span>
                                    </div>
                                  )
                                })}
                                {drillState === 'loading' && (
                                  <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-ink-muted/70">
                                    <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-accent-lineage/70" />
                                    Fetching underlying connections…
                                  </div>
                                )}
                                {drillState === 'error' && (
                                  <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-400">
                                    <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0" />
                                    <span>Couldn&apos;t fetch the underlying connections.</span>
                                    {onDrillFetch && (
                                      <button
                                        type="button"
                                        onClick={() => onDrillFetch(rec.edge)}
                                        className="font-semibold hover:underline"
                                      >
                                        Retry
                                      </button>
                                    )}
                                  </div>
                                )}
                                {constituents.length === 0 && drillState !== 'loading' && drillState !== 'error' && (
                                  <p className="px-2 py-1 text-[10px] text-ink-muted/70 italic leading-snug">
                                    {drillState === 'done'
                                      ? 'No underlying connections found between these entities.'
                                      : 'Constituent connections aren’t loaded — drill this edge on the canvas to fetch them.'}
                                  </p>
                                )}
                                {missing > 0 && constituents.length > 0 && drillState !== 'loading' && (
                                  <p className="px-2 py-0.5 text-[10px] text-ink-muted/60">
                                    +{missing.toLocaleString()} more (showing the first {constituents.length})
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      }
                      return (
                        <>
                          {isLast && hopChips.length > 1 && (
                            <TypeChips chips={hopChips} hiddenTypes={hiddenTypes} onToggle={toggleHiddenType} className="px-3 pb-1.5 pt-0.5" />
                          )}
                          {hopGroups.map(g => {
                            if (g.kind === 'parent') {
                              const pLabel = labelOf(g.key, nodeMap.get(g.key))
                              const pColor = generateColorFromType((nodeMap.get(g.key)?.data?.type as string) ?? 'entity')
                              const headerActive = g.key === walkedInto
                              // Same collapse rule as the classic columns:
                              // 3+ parent groups start collapsed, searching
                              // (frontier filter) force-expands, and the
                              // group holding the hop you walked into stays
                              // open so the trail never hides itself.
                              const defaultCollapsed = hopGroups.filter(gr => gr.kind === 'parent').length >= 3
                              const collapseKey = `w${i}:p:${g.key}`
                              const holdsWalkedInto = !!walkedInto && g.rows.some(it => it.rec.neighborId === walkedInto)
                              const collapsed = !(isLast && q !== '') && !holdsWalkedInto
                                && (defaultCollapsed !== collapseToggles.has(collapseKey))
                              return (
                                <div key={`pg-${g.key}`} className="mb-0.5">
                                  {/* The WHOLE row toggles collapse (big
                                      target); walking into the parent lives
                                      on the dedicated arrow button. */}
                                  <div className="flex items-center gap-1 px-1.5 mb-0.5 min-w-0">
                                    <button
                                      type="button"
                                      onClick={() => toggleCollapse(collapseKey)}
                                      title={collapsed ? `Expand ${g.rows.length} connection${g.rows.length === 1 ? '' : 's'}` : 'Collapse group'}
                                      className={cn(
                                        'flex-1 min-w-0 flex items-center gap-1.5 px-1.5 py-1.5 rounded-md text-left transition-colors bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.07]',
                                        headerActive && 'bg-accent-lineage/[0.08]',
                                      )}
                                    >
                                      <LucideIcons.ChevronDown className={cn('w-4 h-4 flex-shrink-0 text-ink-muted transition-transform', collapsed && '-rotate-90')} />
                                      <LucideIcons.FolderTree className="w-3 h-3 flex-shrink-0 text-ink-muted/70" />
                                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: pColor }} />
                                      <span className={cn('min-w-0 truncate text-[11.5px] font-semibold', headerActive ? 'text-accent-lineage' : 'text-ink')}>
                                        {pLabel}
                                      </span>
                                      <span className="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07] text-[9.5px] font-semibold tabular-nums text-ink-muted">
                                        {g.rows.length}
                                      </span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => (isLast ? onRecenter(g.key) : onWalkTo(i, g.key))}
                                      title={`Walk into ${pLabel}`}
                                      className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-ink-muted hover:text-accent-lineage hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors"
                                    >
                                      <LucideIcons.ArrowRight className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                  {!collapsed && g.rows.map(it => renderWalkRow(it, false))}
                                </div>
                              )
                            }
                            return (
                              <div key={`tg-${g.key}`} className="mb-0.5">
                                <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-0.5">
                                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: g.key === 'not loaded' ? '#94a3b8' : generateColorFromType(g.key) }} />
                                  <span className="text-[9px] font-bold uppercase tracking-[0.1em] text-ink-muted/70">{g.key}</span>
                                  <span className="text-[9.5px] tabular-nums text-ink-muted/50">{g.rows.length}</span>
                                </div>
                                {g.rows.map(it => renderWalkRow(it, true))}
                              </div>
                            )
                          })}
                          {rollupRows.length > 0 && (
                            <div className="mt-1 pt-1 border-t border-dashed border-black/[0.08] dark:border-white/[0.10]">
                              <div
                                className="flex items-center gap-1.5 px-3 py-1"
                                title="Coarser-grain summaries (containers, platforms) of the flows above — not additional connections"
                              >
                                <LucideIcons.Layers className="w-3 h-3 text-ink-muted/50" />
                                <span className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-ink-muted/60">Rollups</span>
                                <span className="text-[9.5px] tabular-nums text-ink-muted/50">{rollupRows.length}</span>
                              </div>
                              {rollupRows.map(it => renderWalkRow(it, true))}
                            </div>
                          )}
                          {hopHiddenCount > 0 && (
                            <p className="px-3 py-1 text-[10px] text-ink-muted/60">
                              {hopHiddenCount} hidden by the type chips
                            </p>
                          )}
                        </>
                      )
                      })()}
                      {/* Contained entities — the containment descent that
                          keeps a walk alive when a container carries its
                          relationships at child level. Stepping into a
                          child is a normal walk hop (trail + branch). */}
                      {hopChildren.length > 0 && (
                        <div className={byNeighbor.size > 0 ? 'mt-1 pt-1 border-t border-black/[0.05] dark:border-white/[0.05]' : ''}>
                          <div className="flex items-center gap-1.5 px-3 py-1">
                            <LucideIcons.FolderTree className="w-3 h-3 text-ink-muted/60" />
                            <span className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-ink-muted/70">Contains</span>
                            <span className="text-[9.5px] tabular-nums text-ink-muted/60">{hopChildTotal}</span>
                          </div>
                          {hopChildren.slice(0, 100).map(cid => {
                            const active = cid === walkedInto
                            const cColor = generateColorFromType((nodeMap.get(cid)?.data?.type as string) ?? 'entity')
                            return (
                              <button
                                key={`child-${cid}`}
                                type="button"
                                onClick={() => (isLast ? onRecenter(cid) : onWalkTo(i, cid))}
                                title={`Step into ${labelOf(cid, nodeMap.get(cid))} — walk its lineage`}
                                className={
                                  active
                                    ? 'w-full min-w-0 flex items-center gap-1.5 px-3 py-1.5 text-left text-[11.5px] font-semibold text-accent-lineage bg-accent-lineage/10 border-l-2 border-accent-lineage [content-visibility:auto] [contain-intrinsic-size:auto_30px]'
                                    : 'w-full min-w-0 flex items-center gap-1.5 px-3 py-1.5 text-left text-[11.5px] text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.05] border-l-2 border-transparent transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_30px]'
                                }
                              >
                                <LucideIcons.CornerDownRight className="w-3 h-3 flex-shrink-0 text-ink-muted/50" />
                                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: cColor }} />
                                <span className="truncate">{labelOf(cid, nodeMap.get(cid))}</span>
                                <LucideIcons.ChevronRight className={`ml-auto w-3 h-3 flex-shrink-0 ${active ? 'text-accent-lineage' : 'text-ink-muted/30'}`} />
                              </button>
                            )
                          })}
                          {hopChildTotal > Math.min(hopChildren.length, 100) && (
                            <p className="px-3 py-0.5 text-[10px] text-ink-muted/60">
                              +{(hopChildTotal - Math.min(hopChildren.length, 100)).toLocaleString()} more contained
                            </p>
                          )}
                        </div>
                      )}
                      {byNeighbor.size === 0 && hopChildren.length > 0 && hopFetch !== 'loading' && (
                        <p className="px-3 pt-2 pb-1 text-[10.5px] text-ink-muted/60 italic leading-snug">
                          No direct {walkDirection === 'outgoing' ? 'downstream' : 'upstream'} connections —
                          step into a contained entity to keep walking, or flip the direction.
                        </p>
                      )}
                      {byNeighbor.size === 0 && hopChildren.length === 0 && (
                        hopFetch === 'loading' ? (
                          <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-ink-muted/70">
                            <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin text-accent-lineage/70" />
                            Fetching lineage…
                          </div>
                        ) : (
                          <p className="px-3 py-3 text-[11px] text-ink-muted/70 italic leading-snug">
                            {hopFetch === 'done'
                              // A completed fetch makes this a claim about the
                              // data source, not about what happens to be loaded.
                              ? <>No {walkDirection === 'outgoing' ? 'downstream' : 'upstream'} connections in the data source — the walk ends here, or flip the direction.</>
                              : <>No {walkDirection === 'outgoing' ? 'downstream' : 'upstream'} connections loaded here — the walk ends, or flip the direction.</>}
                          </p>
                        )
                      )}
                    </div>
                  </motion.div>
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
                  <p className="text-[15px] font-semibold text-ink break-words leading-snug">{focalLabel}</p>
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
    <div>
    <div
      className={cn(
        // content-visibility skips layout+paint for offscreen rows —
        // lightweight virtualization; columns can hold 200 cards.
        // transition-colors (not -all): animating every property makes
        // hover sweeps during scroll recompute layout per row.
        'group relative flex items-center gap-2 rounded-lg border px-2.5 py-2 cursor-pointer transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_58px] border-black/[0.07] dark:border-white/[0.08] hover:border-accent-lineage/50 hover:shadow-sm bg-black/[0.015] dark:bg-white/[0.02] hover:bg-black/[0.035] dark:hover:bg-white/[0.05] min-w-0',
        rollup && 'opacity-75 hover:opacity-100',
      )}
      style={{ borderLeftWidth: 3, borderLeftColor: accentColor }}
      onClick={() => onRecenter(r.neighborId)}
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
              <div className="flex items-center gap-1.5 px-1.5 py-1">
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: typeColor }} />
                <span className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-ink-muted/80">{g.key}</span>
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
