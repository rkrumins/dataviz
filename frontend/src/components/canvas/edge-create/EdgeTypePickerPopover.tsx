/**
 * EdgeTypePickerPopover — after a connection resolves a (source, target) pair,
 * this floats at the drop point and offers ONLY the drawable raw lineage edge
 * types valid for that pair (per the resolved ontology). AGGREGATED and
 * containment/metadata types never appear. A type that fails the ontology is
 * shown disabled with the reason, so the choice is always explained.
 */
import { useMemo, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import { useRelationshipTypes, useContainmentEdgeTypes } from '@/store/schema'
import { deriveConnectableEdges, connectedEdgeTypes } from '@/services/ontologyPreflightService'

export interface EdgeTypePickerPopoverProps {
  sourceId: string
  targetId: string
  /** Drop point in viewport coordinates. */
  position: { x: number; y: number }
  onPick: (edgeType: string) => void
  onCancel: () => void
}

export function EdgeTypePickerPopover({ sourceId, targetId, position, onPick, onCancel }: EdgeTypePickerPopoverProps) {
  const nodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)
  const relationshipTypes = useRelationshipTypes()
  const containmentEdgeTypes = useContainmentEdgeTypes()
  const ref = useRef<HTMLDivElement>(null)

  const nodeType = (id: string) => {
    const n = nodes.find((x) => x.id === id || (x.data?.urn as string) === id)
    return (n?.data?.type as string) || null
  }
  const sourceLabel = useMemo(() => {
    const n = nodes.find((x) => x.id === sourceId || (x.data?.urn as string) === sourceId)
    return (n?.data?.label as string) || sourceId
  }, [nodes, sourceId])
  const targetLabel = useMemo(() => {
    const n = nodes.find((x) => x.id === targetId || (x.data?.urn as string) === targetId)
    return (n?.data?.label as string) || targetId
  }, [nodes, targetId])

  const options = useMemo(
    () => {
      // Disable types that already connect this exact source→target so the user can't draw a duplicate.
      const connected = connectedEdgeTypes(edges, sourceId, targetId)
      return deriveConnectableEdges(nodeType(sourceId), nodeType(targetId), relationshipTypes, containmentEdgeTypes)
        .map((o) =>
          connected.has(o.edgeType.toUpperCase())
            ? { ...o, allowed: false, reason: 'Already connected by this relationship.' }
            : o,
        )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, edges, sourceId, targetId, relationshipTypes, containmentEdgeTypes],
  )

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onCancel() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onCancel])

  // Keep the popover on-screen near the drop point.
  const left = Math.min(position.x, window.innerWidth - 300)
  const top = Math.min(position.y, window.innerHeight - 320)

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12 }}
      className="fixed z-[210] w-[280px] bg-canvas-elevated/98 backdrop-blur-xl border border-glass-border rounded-2xl shadow-lg overflow-hidden"
      style={{ left, top }}
    >
      <div className="px-4 py-3 border-b border-glass-border">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-accent-lineage/10 flex items-center justify-center">
            <LucideIcons.Spline className="w-4 h-4 text-accent-lineage" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-ink">Connect</h3>
            <p className="text-[10px] text-ink-muted truncate">{sourceLabel} → {targetLabel}</p>
          </div>
        </div>
      </div>

      <div className="max-h-[260px] overflow-y-auto custom-scrollbar p-2 space-y-1">
        {options.length === 0 && (
          // Explain WHY nothing is offered: with both endpoint types known, this is an
          // ontology rule (no relationship defined between the two types), not missing data.
          <div className="text-center py-6 px-3 text-ink-muted text-xs">
            {nodeType(sourceId) && nodeType(targetId) ? (
              <>
                Your ontology doesn&apos;t define a relationship from{' '}
                <span className="font-medium text-ink">{nodeType(sourceId)}</span> to{' '}
                <span className="font-medium text-ink">{nodeType(targetId)}</span>.
                <span className="block mt-1 text-[10px] text-ink-muted/80">
                  Add one on the ontology&apos;s schema page to connect these entities.
                </span>
              </>
            ) : (
              'No lineage edge types defined'
            )}
          </div>
        )}
        {options.map((o) => (
          <button
            key={o.edgeType}
            disabled={!o.allowed}
            title={o.allowed ? o.description : o.reason}
            onClick={() => o.allowed && onPick(o.edgeType)}
            className={cn(
              'w-full flex items-start gap-2 px-3 py-2 rounded-xl text-left transition-colors',
              o.allowed ? 'hover:bg-accent-lineage/10 text-ink cursor-pointer' : 'opacity-50 cursor-not-allowed text-ink-muted',
            )}
          >
            <LucideIcons.ArrowRight className={cn('w-3.5 h-3.5 mt-0.5 flex-shrink-0', o.allowed ? 'text-accent-lineage' : 'text-ink-muted')} />
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{o.label}</div>
              {(o.description || o.reason) && (
                <div className="text-[10px] text-ink-muted line-clamp-2">{o.allowed ? o.description : o.reason}</div>
              )}
            </div>
          </button>
        ))}
      </div>
    </motion.div>
  )
}

export default EdgeTypePickerPopover
