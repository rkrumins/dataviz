/**
 * LoadMoreItem — the "there are more children here" row at the bottom of an
 * expanded container's child list.
 *
 * Deliberately click-driven. This used to be an `AutoLoadSentinel` that paged
 * on an IntersectionObserver, which turned into an unattended request pump:
 * its one-shot latch was reset on every re-render (the `onLoadMore` prop was a
 * fresh closure each time), and in the search panel's Isolate/Hide modes the
 * freshly-loaded children were filtered straight back out of the tree — so the
 * column never grew, the sentinel never scrolled out of the observer's root
 * margin, and it re-fired until the parent's entire childCount was drained.
 *
 * Expanding a node already loads its first page (ContextViewCanvas's toggle
 * handler calls `loadChildren`), so the observer only ever served pages 2+.
 * Making those pages explicit costs the user one click and makes a runaway
 * structurally impossible — there is no observer left to mis-latch.
 */
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { CHILDREN_PAGE_SIZE } from '@/config/pagination'

export function LoadMoreItem({
  depth,
  parentIsLast,
  count,
  isLoading = false,
  onLoadMore,
}: {
  parentId?: string
  depth: number
  parentIsLast: boolean[]
  /** Children not yet loaded for this parent. */
  count: number
  isLoading?: boolean
  onLoadMore: () => void
}) {
  const indentWidth = depth * 16
  const nextPage = Math.min(CHILDREN_PAGE_SIZE, count)

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      data-canvas-interactive
      className="flex items-center gap-2 mx-1 rounded-xl transition-all duration-200 group/item relative min-h-[36px] py-1.5"
      style={{ paddingLeft: 12 + indentWidth }}
    >
      <div className="flex items-center absolute left-3 pointer-events-none" style={{ width: indentWidth }}>
        {parentIsLast.map((pIsLast, idx) => (
          <div key={idx} className="w-5 h-full flex justify-center">
            {!pIsLast && (
              <div className="w-px h-full bg-gradient-to-b from-white/[0.08] via-white/[0.12] to-white/[0.08]" />
            )}
          </div>
        ))}
        {depth > 0 && (
          <div className="w-5 h-full relative">
            <div className="absolute left-1/2 -translate-x-1/2 w-px top-0 h-1/2" style={{ background: 'linear-gradient(to bottom, transparent, rgba(255,255,255,0.12), transparent)' }} />
            <div className="absolute left-1/2 top-1/2 -translate-y-1/2 flex items-center">
              <div className="w-3 h-px bg-gradient-to-r from-white/[0.12] to-white/[0.06]" />
            </div>
          </div>
        )}
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation()
          if (!isLoading) onLoadMore()
        }}
        disabled={isLoading}
        aria-label={`Load ${nextPage} more of ${count.toLocaleString()} remaining`}
        className={cn(
          'flex flex-1 items-center justify-center gap-2 py-1.5 rounded-lg border text-[11px] font-medium transition-all duration-200',
          'bg-white/[0.03] border-white/[0.08] text-ink-muted',
          isLoading
            ? 'cursor-wait opacity-70'
            : 'hover:bg-white/[0.06] hover:border-white/[0.15] hover:text-ink/90 active:scale-[0.98]',
        )}
      >
        {isLoading ? (
          <>
            <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="tracking-wide">Loading…</span>
          </>
        ) : (
          <>
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-white/[0.05] group-hover/item:bg-white/[0.08] transition-colors">
              <LucideIcons.Plus className="w-3.5 h-3.5 text-ink-muted/70" />
            </span>
            <span className="tracking-wide">
              Load {nextPage} more
              <span className="text-ink-muted/50"> · {count.toLocaleString()} remaining</span>
            </span>
          </>
        )}
      </button>
    </motion.div>
  )
}
