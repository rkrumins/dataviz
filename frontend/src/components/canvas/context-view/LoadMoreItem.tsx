import { useState } from 'react'
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ViewLayerConfig } from '@/types/schema'

export function LoadMoreItem({
  depth,
  parentIsLast,
  count,
  onLoadMore,
}: {
  parentId?: string
  depth: number
  parentIsLast: boolean[]
  count: number
  onLoadMore: () => void
  layer?: ViewLayerConfig
}) {
  const [isHovered, setIsHovered] = useState(false)
  const indentWidth = depth * 16

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      data-canvas-interactive
      className="flex items-center gap-2 mx-1 rounded-xl cursor-pointer transition-all duration-200 group/item relative min-h-[36px] py-1.5"
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
          onLoadMore()
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className={cn(
          "flex flex-1 items-center justify-center gap-2 py-1.5 rounded-lg border text-[11px] font-medium transition-all duration-200",
          "bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.06] hover:border-white/[0.15] text-ink-muted hover:text-ink/90 active:scale-[0.98]"
        )}
      >
        <span className="flex items-center justify-center w-5 h-5 rounded-full bg-white/[0.05]">
          <LucideIcons.Plus className={cn("w-3.5 h-3.5 transition-transform", isHovered ? "scale-125 text-blue-400" : "text-ink-muted/70")} />
        </span>
        <span className="tracking-wide">Load {Math.min(20, count)} more nodes ({count} remaining)</span>
      </button>
    </motion.div>
  )
}
