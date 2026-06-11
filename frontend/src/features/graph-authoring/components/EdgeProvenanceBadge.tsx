/**
 * EdgeProvenanceBadge — a small pill distinguishing RAW edges (user/system
 * authored ground truth) from AGGREGATED edges (derived by the rollup job from
 * raw edges after publish, and therefore read-only in the authoring UI).
 */
import { GitCommitHorizontal, Sigma } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LineageEdge } from '@/store/canvas'

export function EdgeProvenanceBadge({ edge, className }: { edge: Pick<LineageEdge, 'data'>; className?: string }) {
  const aggregated = edge.data?.isAggregated === true
  if (aggregated) {
    const count = edge.data?.sourceEdgeCount
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
          'bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20',
          className,
        )}
        title={`Derived by aggregation${count ? ` from ${count} raw edges` : ''} after publish — edit the underlying raw edges instead.`}
      >
        <Sigma className="w-3 h-3" />
        Aggregated · derived
      </span>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
        'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20',
        className,
      )}
      title="A raw lineage edge — authored ground truth."
    >
      <GitCommitHorizontal className="w-3 h-3" />
      Raw
    </span>
  )
}

export default EdgeProvenanceBadge
