/**
 * Bottom-docked chrome floats over the columns. Each piece publishes the
 * height it occupies as a CSS variable on the canvas body — the way
 * TraceBottomDock publishes `--trace-dock-height` — and the columns area
 * pads for the tallest of them, so a column's last row can always scroll
 * clear of the chrome and be clicked.
 */
import { useLayoutEffect, type RefObject } from 'react'

/** Breathing room between the chrome and the last row it must never cover. */
export const BAND_GAP_PX = 8

/**
 * Publish `varName` = (measured height + gap) on the nearest
 * `[data-canvas-body]` while `ref` is mounted; withdraw it on unmount.
 * `measure` defaults to the element's own `offsetHeight`; pass one to
 * reserve only part of the element (a legend's header, not its opened body).
 */
export function useBandReservation(
  ref: RefObject<HTMLElement | null>,
  varName: `--${string}`,
  measure?: (el: HTMLElement) => number,
): void {
  useLayoutEffect(() => {
    const el = ref.current
    const body = el?.closest<HTMLElement>('[data-canvas-body]')
    if (!el || !body) return
    const publish = () => {
      const height = measure ? measure(el) : el.offsetHeight
      body.style.setProperty(varName, `${height + BAND_GAP_PX}px`)
    }
    publish()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null
    ro?.observe(el)
    return () => {
      ro?.disconnect()
      body.style.removeProperty(varName)
    }
    // `measure` is a stable per-call-site function; re-running on identity
    // churn would only republish the same number.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, varName])
}
