/**
 * SearchHitInlineRow — a match that lives INSIDE an expanded container,
 * spliced into the column's tree under that container's row.
 *
 * It is deliberately not a card. The rows around it are entities the
 * canvas actually holds; this one is a pointer into the search result,
 * and clicking it is a REVEAL — the canvas walks the hit's ancestors,
 * loads what it must, and the row it lands on is the real one. So it
 * reads a step quieter than a card: no chevron, no actions, dashed
 * accent, and the part of the path that lies below the container the
 * reader is already looking at.
 *
 * The trailing variant carries `overflow` instead of `hit`: the inline
 * stack is capped, and the panel is where the rest belongs.
 */
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { cn } from '@/lib/utils'
import { generateIconFallback } from '@/lib/type-visuals'
import type { AncestorRef, SearchHit } from '@/types/search'
import type { ViewLayerConfig, WorkspaceSchema } from '@/types/schema'


export function SearchHitInlineRow({
  depth,
  parentIsLast,
  layer,
  schema,
  hit,
  crumbs,
  overflow,
  onReveal,
  onOpenPanel,
}: {
  depth: number
  parentIsLast: boolean[]
  layer: ViewLayerConfig
  schema: WorkspaceSchema | null
  /** Absent on the trailing "see the rest" row. */
  hit?: SearchHit
  crumbs?: AncestorRef[]
  /** Present only on the trailing row: hits the cap left out. */
  overflow?: number
  onReveal?: (urn: string, ancestorPath: AncestorRef[]) => void
  onOpenPanel: () => void
}) {
  const indentWidth = depth * 16
  const visual = hit
    ? schema?.entityTypes.find((et) => et.id === hit.node.entityType)?.visual
    : undefined
  const color = visual?.color ?? layer.color

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      data-canvas-interactive
      data-search-hit={hit ? hit.node.urn : 'more'}
      className="flex items-center gap-2 mx-1 rounded-xl transition-all duration-200 group/item relative min-h-[36px] py-1.5"
      style={{ paddingLeft: 12 + indentWidth }}
    >
      <div className="flex items-center absolute left-3 pointer-events-none" style={{ width: indentWidth }}>
        {parentIsLast.map((pIsLast, idx) => (
          <div key={idx} className="w-5 h-full flex justify-center">
            {!pIsLast && (
              <div className="w-px h-full bg-gradient-to-b from-black/[0.06] via-black/[0.10] to-black/[0.06] dark:from-white/[0.08] dark:via-white/[0.12] dark:to-white/[0.08]" />
            )}
          </div>
        ))}
        {depth > 0 && (
          <div className="w-5 h-full relative">
            <div className="absolute left-1/2 -translate-x-1/2 w-px top-0 h-1/2 bg-gradient-to-b from-transparent via-glass-border to-transparent" />
            <div className="absolute left-1/2 top-1/2 -translate-y-1/2 flex items-center">
              <div className="w-3 h-px bg-gradient-to-r from-black/[0.10] to-black/[0.06] dark:from-white/[0.12] dark:to-white/[0.06]" />
            </div>
          </div>
        )}
      </div>

      {hit ? (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onReveal?.(hit.node.urn, hit.ancestorPath ?? [])
          }}
          title={`Show ${hit.node.displayName} on the canvas`}
          className={cn(
            'flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5 rounded-lg border border-dashed text-left transition-all duration-200',
            'border-black/[0.10] dark:border-white/[0.12] hover:bg-black/[0.03] dark:hover:bg-white/[0.05]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
          )}
        >
          <span
            className="flex items-center justify-center w-5 h-5 rounded-md flex-shrink-0"
            style={{ backgroundColor: `${color}1a` }}
          >
            <DynamicIcon
              name={visual?.icon ?? generateIconFallback(hit.node.entityType)}
              className="w-3 h-3"
              style={{ color }}
            />
          </span>

          <span className="text-xs text-ink/90 truncate">{hit.node.displayName}</span>

          {crumbs && crumbs.length > 0 && (
            <span className="flex items-center gap-0.5 min-w-0 text-[10px] text-ink-muted/60">
              {crumbs.map((c) => (
                <span key={c.urn} className="flex items-center gap-0.5 min-w-0">
                  <LucideIcons.ChevronRight className="w-2.5 h-2.5 flex-shrink-0" />
                  <span className="truncate">{c.displayName}</span>
                </span>
              ))}
            </span>
          )}
        </button>
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onOpenPanel()
          }}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 py-1.5 rounded-lg border border-dashed text-[11px] font-medium transition-all duration-200',
            'border-black/[0.10] dark:border-white/[0.12] text-ink-muted hover:text-ink/90',
            'hover:bg-black/[0.03] dark:hover:bg-white/[0.05]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
          )}
        >
          <LucideIcons.Search className="w-3 h-3" />
          <span className="tracking-wide">
            +{(overflow ?? 0).toLocaleString()} more
            <span className="text-ink-muted/50"> · See all in panel</span>
          </span>
        </button>
      )}
    </motion.div>
  )
}
