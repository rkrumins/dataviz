import { useCallback, useEffect, useRef } from 'react'

/**
 * Hover/focus "intent" handlers that fire a prefetch after a short dwell — so a
 * deliberate hover warms data (making the click feel instant) while a quick
 * fly-over does nothing. Spread the returned handlers onto a card/row root:
 *
 *   const prefetch = useIntentPrefetch(() => prefetchWorkspaceDetail(qc, ws.id))
 *   <div {...prefetch} onClick={onOpen}>…</div>
 *
 * Purely additive: a no-op when `prefetch` is undefined, and a wasted cache
 * warm at worst if the key doesn't match — it can't change behavior.
 */
export function useIntentPrefetch(prefetch?: () => void, delayMs = 120) {
  // Ref so the returned handlers stay referentially stable while always calling
  // the latest closure (parents pass a fresh `() => prefetchX(id)` each render).
  const fnRef = useRef(prefetch)
  fnRef.current = prefetch
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const start = useCallback(() => {
    if (!fnRef.current) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => fnRef.current?.(), delayMs)
  }, [delayMs])

  const cancel = useCallback(() => clearTimeout(timer.current), [])

  useEffect(() => () => clearTimeout(timer.current), [])

  return { onMouseEnter: start, onFocus: start, onMouseLeave: cancel, onBlur: cancel }
}
