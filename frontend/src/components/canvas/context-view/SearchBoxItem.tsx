import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ViewLayerConfig } from '@/types/schema'

export function SearchBoxItem({
  parentId,
  depth,
  parentIsLast,
  value,
  onChange,
  isLoading,
  layer
}: {
  parentId: string
  depth: number
  parentIsLast: boolean[]
  value: string
  onChange: (val: string) => void
  isLoading?: boolean
  layer: ViewLayerConfig
}) {
  const [isFocused, setIsFocused] = useState(false)
  const indentWidth = depth * 16

  // Using a local state for input to not jump cursors
  const [localValue, setLocalValue] = useState(value)

  useEffect(() => {
    setLocalValue(value)
  }, [value])

  // Debounce effect: trigger search automatically 400ms after user stops typing
  useEffect(() => {
    if (localValue === value) return

    const handler = setTimeout(() => {
      onChange(localValue)
    }, 400)

    return () => clearTimeout(handler)
  }, [localValue, value, onChange])

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
            <div className="absolute left-1/2 -translate-x-1/2 w-px top-0 h-full" style={{ background: 'linear-gradient(to bottom, transparent, rgba(255,255,255,0.12), transparent)' }} />
            <div className="absolute left-1/2 top-1/2 -translate-y-1/2 flex items-center">
              <div className="w-3 h-px bg-gradient-to-r from-white/[0.12] to-white/[0.06]" />
            </div>
          </div>
        )}
      </div>

      <div
        className={cn(
          "flex flex-1 items-center gap-2.5 px-3 py-2 mx-1 rounded-xl border text-xs font-medium transition-all duration-300 shadow-sm relative group/searchbox overflow-hidden",
          isFocused
            ? "bg-canvas-elevated/90 backdrop-blur-xl border-transparent shadow-xl translate-y-[0px]"
            : "bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04] hover:border-white/[0.12] hover:shadow-md"
        )}
        style={isFocused ? {
          boxShadow: `0 8px 24px -4px ${layer.color}25, inset 0 0 0 1.5px ${layer.color}50`
        } : {}}
      >
        {/* Subtle focus glow background */}
        <div
          className={cn(
            "absolute inset-0 transition-opacity duration-500 pointer-events-none",
            isFocused ? "opacity-100" : "opacity-0"
          )}
          style={{ background: `radial-gradient(ellipse at center, ${layer.color}15 0%, transparent 70%)` }}
        />

        <LucideIcons.Search
          className={cn("w-4 h-4 transition-all duration-300 relative z-10", isFocused ? "scale-110" : "text-ink-muted/50")}
          style={isFocused ? { color: layer.color } : {}}
        />

        <input
          type="text"
          value={localValue}
          onChange={(e) => {
            setLocalValue(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onChange(localValue)
            }
          }}
          onBlur={() => {
            setIsFocused(false)
            if (localValue !== value) onChange(localValue)
          }}
          onFocus={() => setIsFocused(true)}
          placeholder={`Search ${parentId ? 'node' : 'children'}...`}
          className="flex-1 bg-transparent border-none outline-none text-ink placeholder-ink-muted/40 relative z-10 transition-all duration-300 min-w-0"
        />

        <div className="flex items-center gap-1.5 relative z-10 flex-shrink-0">
          {isLoading ? (
            <div className="flex items-center justify-center w-5 h-5 rounded-md bg-white/[0.05]">
              <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: layer.color }} />
            </div>
          ) : (
            <AnimatePresence>
              {isFocused && !localValue && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase text-ink-muted/50 bg-white/[0.05] border border-white/[0.05]"
                >
                  Enter
                </motion.div>
              )}
            </AnimatePresence>
          )}

          <AnimatePresence>
            {localValue && !isLoading && (
              <motion.button
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                onClick={(e) => {
                  e.stopPropagation()
                  setLocalValue('')
                  onChange('')
                }}
                className="flex items-center justify-center w-5 h-5 rounded-md hover:bg-white/[0.1] text-ink-muted/60 hover:text-ink transition-colors bg-white/[0.03]"
              >
                <LucideIcons.X className="w-3 h-3" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  )
}
