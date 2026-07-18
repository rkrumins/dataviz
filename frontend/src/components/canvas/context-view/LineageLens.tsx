/**
 * LineageLens — ego-graph overlay for "click a node, see its immediate
 * links" regardless of canvas scale or scroll position.
 *
 * The focal entity sits centered; upstream neighbors (data sources) list
 * on the LEFT, downstream (data consumers) on the RIGHT, grouped by
 * entity type with counts. Clicking a neighbor re-centers the lens on it
 * (breadcrumb trail returns); per-row actions reveal the neighbor on the
 * canvas or open its details; the footer escalates to full Trace.
 *
 * Data comes from the same source as the drawer's LineageNeighbors
 * section (canvas visibleEdges with raw-edges fallback, via the shared
 * deriveNeighborRecords helper) so counts always agree with the canvas.
 *
 * Self-contained: glass modal over the canvas, lens-local ESC handling
 * (capture phase so canvas keyboard shortcuts don't fire underneath).
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useContainmentEdgeTypes } from '@/store/schema'
import { deriveNeighborRecords, type NeighborRecord } from '@/lib/lineage-neighbors'
import { generateColorFromType } from '@/lib/type-visuals'
import { cn } from '@/lib/utils'

const ROWS_CAP = 200

export interface LineageLensProps {
  /** Focal-node stack; last entry is the current focal. Empty = closed. */
  lensStack: string[]
  onRecenter: (nodeId: string) => void
  onBack: () => void
  onClose: () => void
  /** Reveal the node on the canvas (expand ancestors + scroll) without closing the lens. */
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  /** Open the entity drawer for a node. */
  onOpenDetails?: (nodeId: string) => void
  /** Reveal a set of neighbors and frame them on the canvas (closes the lens). */
  onLocateAll?: (nodeIds: string[]) => void | Promise<void>
  /** Escalate to a full server trace from the focal node (closes the lens). */
  onTrace?: (nodeId: string) => void
}

export function LineageLens({
  lensStack,
  onRecenter,
  onBack,
  onClose,
  onRevealOnCanvas,
  onOpenDetails,
  onLocateAll,
  onTrace,
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
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [nodeId, onClose])

  const nodeMap = useMemo(() => {
    const m = new Map<string, LineageNode>()
    for (const n of nodes) m.set(n.id, n)
    return m
  }, [nodes])

  const edges = visibleEdges.length > 0 ? visibleEdges : rawEdges
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
        className="fixed inset-0 z-[9990] flex items-center justify-center"
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
          onClick={onClose}
        />

        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 8 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="relative flex flex-col rounded-2xl border border-glass-border/80 bg-canvas-elevated/95 backdrop-blur-xl shadow-2xl shadow-black/50 overflow-hidden"
          style={{ width: 'min(1100px, 90vw)', height: 'min(70vh, 760px)' }}
          role="dialog"
          aria-label={`Connections of ${focalLabel}`}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-glass-border/60">
            <LucideIcons.Focus className="w-4 h-4 text-accent-lineage" />
            <h2 className="text-sm font-semibold text-ink">Focus on connections</h2>
            {lensStack.length > 1 && (
              <button
                type="button"
                onClick={onBack}
                className="ml-2 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-white/[0.06] transition-colors"
              >
                <LucideIcons.ArrowLeft className="w-3 h-3" />
                Back
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <LucideIcons.Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-muted/60" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter connections…"
                  className="w-48 pl-6 pr-2 py-1 rounded-md bg-white/[0.04] border border-glass-border/60 text-[11.5px] text-ink placeholder:text-ink-muted/50 outline-none focus:border-accent-lineage/50"
                />
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="w-7 h-7 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-white/[0.06] transition-colors"
              >
                <LucideIcons.X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Body: upstream | focal | downstream */}
          <div className="flex-1 grid grid-cols-[1fr_auto_1fr] gap-0 min-h-0">
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
            <div className="flex flex-col items-center justify-center px-6 border-x border-glass-border/40">
              <div
                className="w-56 rounded-xl border px-4 py-3 shadow-lg"
                style={{
                  borderColor: `${generateColorFromType(focalType)}66`,
                  background: `linear-gradient(135deg, ${generateColorFromType(focalType)}1a, transparent)`,
                  boxShadow: `0 8px 28px ${generateColorFromType(focalType)}22`,
                }}
              >
                <p className="text-[9.5px] font-semibold uppercase tracking-wider mb-1" style={{ color: generateColorFromType(focalType) }}>
                  {focalType}
                </p>
                <p className="text-sm font-semibold text-ink break-words">{focalLabel}</p>
                <div className="flex items-center gap-3 mt-2 text-[10.5px] text-ink-muted tabular-nums">
                  <span className="flex items-center gap-1">
                    <LucideIcons.ArrowDownLeft className="w-3 h-3 text-sky-400" />
                    {incomingRecords.length} in
                  </span>
                  <span className="flex items-center gap-1">
                    <LucideIcons.ArrowUpRight className="w-3 h-3 text-amber-400" />
                    {outgoingRecords.length} out
                  </span>
                </div>
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

          {/* Footer */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-t border-glass-border/60">
            <p className="text-[10.5px] text-ink-muted/70">
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
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-glass-border/70 text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-white/[0.06] transition-colors"
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
      const type = (r.neighborNode?.data?.type as string) ?? '· not loaded'
      const list = g.get(type) ?? []
      list.push(r)
      g.set(type, list)
    }
    return [...g.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [records])

  const isIn = direction === 'incoming'

  return (
    <div className="flex flex-col min-h-0">
      <div className="px-4 pt-3 pb-2 flex items-center gap-2">
        {isIn
          ? <LucideIcons.ArrowDownLeft className="w-3.5 h-3.5 text-sky-400" />
          : <LucideIcons.ArrowUpRight className="w-3.5 h-3.5 text-amber-400" />}
        <span className="text-[11px] font-semibold text-ink">{title}</span>
        <span className="text-[10px] text-ink-muted/70">{subtitle}</span>
        <span className="ml-auto text-[10.5px] tabular-nums text-ink-muted">{totalCount}</span>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar px-2 pb-3">
        {records.length === 0 && (
          <p className="px-2 py-6 text-center text-[11px] text-ink-muted/60">
            {totalCount === 0 ? `No ${isIn ? 'upstream' : 'downstream'} connections` : 'No matches'}
          </p>
        )}
        {groups.map(([type, rows]) => {
          const color = type === '· not loaded' ? '#94a3b8' : generateColorFromType(type)
          return (
            <div key={type} className="mb-2">
              <div className="flex items-center gap-1.5 px-2 py-1">
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                <span className="text-[9.5px] font-semibold uppercase tracking-wider text-ink-muted/70">{type}</span>
                <span className="text-[9.5px] tabular-nums text-ink-muted/50">{rows.length}</span>
              </div>
              {rows.map((r, i) => (
                <div
                  key={`${r.edge.id}-${i}`}
                  className={cn(
                    'group flex items-center gap-1.5 mx-1 px-2 py-1.5 rounded-lg cursor-pointer',
                    'hover:bg-white/[0.05] transition-colors min-w-0',
                  )}
                  onClick={() => onRecenter(r.neighborId)}
                  title={`Re-center on ${labelOf(r.neighborId, r.neighborNode)}`}
                >
                  {/* Connector cue toward the focal card */}
                  {!isIn && <span className="w-2 h-px flex-shrink-0" style={{ backgroundColor: `${color}88` }} />}
                  <span className="flex-1 truncate text-[11.5px] text-ink/90">
                    {labelOf(r.neighborId, r.neighborNode)}
                  </span>
                  {isIn && <span className="w-2 h-px flex-shrink-0" style={{ backgroundColor: `${color}88` }} />}
                  <span className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                    {onRevealOnCanvas && (
                      <button
                        type="button"
                        title="Reveal on canvas"
                        onClick={(e) => { e.stopPropagation(); void onRevealOnCanvas(r.neighborId) }}
                        className="w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-white/[0.08]"
                      >
                        <LucideIcons.Crosshair className="w-3 h-3" />
                      </button>
                    )}
                    {onOpenDetails && (
                      <button
                        type="button"
                        title="Open details"
                        onClick={(e) => { e.stopPropagation(); onOpenDetails(r.neighborId) }}
                        className="w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-white/[0.08]"
                      >
                        <LucideIcons.PanelRight className="w-3 h-3" />
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )
        })}
        {records.length > ROWS_CAP && (
          <p className="px-3 py-1.5 text-[10px] text-ink-muted/60">
            +{records.length - ROWS_CAP} more — use the filter to narrow
          </p>
        )}
      </div>
    </div>
  )
}
