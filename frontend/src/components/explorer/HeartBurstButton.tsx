/**
 * HeartBurstButton — favorite-toggle button with a celebratory particle
 * burst when the view is newly favourited.
 *
 * Renders five small heart particles via framer-motion when the state
 * transitions from unfavourited → favourited. The particles fan out
 * and fade so the feedback feels tactile without being cheesy.
 * Nothing fires on un-favourite (removing stars shouldn't celebrate).
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Heart } from 'lucide-react'
import { cn } from '@/lib/utils'

interface HeartBurstButtonProps {
  favourited: boolean
  onToggle: () => void
  size?: 'sm' | 'md'
  /** Extra class on the button element. */
  className?: string
  title?: string
}

/** Angles (in degrees) for the burst particles — symmetric fan. */
const BURST_ANGLES = [-70, -35, 0, 35, 70]

export function HeartBurstButton({
  favourited,
  onToggle,
  size = 'sm',
  className,
  title,
}: HeartBurstButtonProps) {
  const [burstKey, setBurstKey] = useState<number | null>(null)
  // Track previous favourited so we only burst on false → true.
  const prev = useRef(favourited)

  useEffect(() => {
    if (!prev.current && favourited) {
      setBurstKey(k => (k ?? 0) + 1)
    }
    prev.current = favourited
  }, [favourited])

  const iconSize = size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'
  const padding = size === 'md' ? 'p-2' : 'p-1.5'

  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        'relative rounded-lg transition-colors duration-150',
        padding,
        favourited
          ? 'text-red-500 hover:bg-red-500/10'
          : 'text-ink-muted hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/5',
        className,
      )}
      title={title ?? (favourited ? 'Unfavorite' : 'Favorite')}
      aria-pressed={favourited}
    >
      <Heart
        className={cn(iconSize, 'transition-transform duration-150', favourited && 'scale-110')}
        fill={favourited ? 'currentColor' : 'none'}
      />

      {/* Particle burst — appears briefly when favourited becomes true. */}
      <AnimatePresence>
        {burstKey !== null && (
          <motion.span
            key={burstKey}
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            onAnimationComplete={() => setBurstKey(null)}
          >
            {BURST_ANGLES.map((angle, i) => {
              const dist = 18 + (i % 2) * 4
              const x = Math.sin((angle * Math.PI) / 180) * dist
              const y = -Math.cos((angle * Math.PI) / 180) * dist
              return (
                <motion.span
                  key={i}
                  initial={{ x: 0, y: 0, scale: 0.4, opacity: 0 }}
                  animate={{ x, y, scale: 1, opacity: [0, 1, 1, 0] }}
                  transition={{ duration: 0.55, ease: 'easeOut', times: [0, 0.15, 0.6, 1] }}
                  className="absolute"
                >
                  <Heart className="h-2 w-2 text-red-500" fill="currentColor" />
                </motion.span>
              )
            })}
            {/* Central expanding ring for extra punch. */}
            <motion.span
              aria-hidden
              initial={{ scale: 0.4, opacity: 0.6 }}
              animate={{ scale: 1.8, opacity: 0 }}
              transition={{ duration: 0.45, ease: 'easeOut' }}
              className="absolute inset-0 rounded-full border border-red-500/50"
            />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  )
}
