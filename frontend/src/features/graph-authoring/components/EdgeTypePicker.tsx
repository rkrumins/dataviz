/**
 * EdgeTypePicker — after a connection resolves a valid (source, target) pair,
 * this floats at the drop point and offers ONLY the drawable raw lineage edge
 * types for that pair (AGGREGATED / containment / metadata never appear). When
 * multiple lineage types are valid the user disambiguates with the edge's
 * direction semantics shown ("Source —TYPE→ Target"); a type that fails the
 * ontology is shown disabled with the reason, so the choice is always explained.
 * When exactly one type is allowed it auto-confirms.
 */
import { useEffect, useMemo, useRef } from 'react'
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import type { AllowedEdgeOption } from '../model/ontologyGuard'

export interface EdgeTypePickerProps {
  sourceId: string
  targetId: string
  /** Drop point in viewport coordinates. */
  position: { x: number; y: number }
  /** Drawable options for this endpoint pair (from the controller). */
  options: AllowedEdgeOption[]
  onPick: (edgeType: string) => void
  onCancel: () => void
}

export function EdgeTypePicker({ sourceId, targetId, position, options, onPick, onCancel }: EdgeTypePickerProps) {
  const nodes = useCanvasStore((s) => s.nodes)
  const ref = useRef<HTMLDivElement>(null)
  const labelOf = (id: string) => {
    const n = nodes.find((x) => x.id === id || (x.data?.urn as string) === id)
    return (n?.data?.label as string) || id
  }
  const sourceLabel = labelOf(sourceId)
  const targetLabel = labelOf(targetId)

  const allowed = useMemo(() => options.filter((o) => o.allowed), [options])

  // Auto-confirm when exactly one type is allowed — no decision to make.
  useEffect(() => {
    if (allowed.length === 1) onPick(allowed[0].edgeType)
  }, [allowed, onPick])

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onCancel() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    const t = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => { window.clearTimeout(t); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onCancel])

  // Don't flash the popover when it's about to auto-confirm.
  if (allowed.length === 1) return null

  const left = Math.min(position.x, window.innerWidth - 300)
  const top = Math.min(position.y, window.innerHeight - 320)

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12 }}
      className="fixed z-[210] w-[300px] bg-canvas-elevated/98 backdrop-blur-xl border border-glass-border rounded-2xl shadow-lg overflow-hidden"
      style={{ left, top }}
    >
      <div className="px-4 py-3 border-b border-glass-border">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-accent-lineage/10 flex items-center justify-center">
            <LucideIcons.Spline className="w-4 h-4 text-accent-lineage" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-ink">Choose lineage type</h3>
            <p className="text-[10px] text-ink-muted truncate">{sourceLabel} → {targetLabel}</p>
          </div>
        </div>
      </div>

      <div className="max-h-[260px] overflow-y-auto custom-scrollbar p-2 space-y-1">
        {options.length === 0 && (
          <div className="text-center py-6 text-ink-muted text-xs">No lineage edge types defined</div>
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
              {/* Direction semantics — makes "which one" obvious for the user. */}
              <div className="text-[10px] text-ink-muted truncate">
                {sourceLabel} <span className="text-accent-lineage">—{o.edgeType}→</span> {targetLabel}
              </div>
              {(o.description || (!o.allowed && o.reason)) && (
                <div className="text-[10px] text-ink-muted line-clamp-2">{o.allowed ? o.description : o.reason}</div>
              )}
            </div>
          </button>
        ))}
      </div>
    </motion.div>
  )
}

export default EdgeTypePicker
