import { useEffect, useState } from 'react'
import { useReducedMotionConfig, useSpring } from 'framer-motion'

/**
 * Springs an integer value smoothly toward `target`. Returns the rounded
 * intermediate value for display in stat tiles. Updates settle quickly
 * (damping 30, stiffness 220) — perceptible animation without lag.
 *
 * `from` is where it starts on mount (default: `target`, so only later changes
 * animate). Under reduced motion it is always exactly `target`.
 */
export function useCountUp(target: number, { from = target }: { from?: number } = {}): number {
  const reduced = useReducedMotionConfig() ?? false
  const spring = useSpring(from, { damping: 30, stiffness: 220 })
  const [display, setDisplay] = useState(from)

  useEffect(() => {
    spring.set(target)
  }, [target, spring])

  useEffect(() => {
    const unsubscribe = spring.on('change', v => setDisplay(Math.round(v)))
    return unsubscribe
  }, [spring])

  return reduced ? target : display
}
