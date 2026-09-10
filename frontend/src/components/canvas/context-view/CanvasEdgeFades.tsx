/**
 * "There is more this way." The canvas runs sideways past the window and,
 * on macOS, the browser's overlay scrollbar fades out entirely when idle —
 * so a still canvas can look like the whole picture. A soft gradient at
 * whichever edge still has content says otherwise, and vanishes on the
 * side that has run out.
 *
 * DECORATION, and nothing else. It paints over the column rows, which
 * makes `pointer-events-none` the one property it may never lose: a
 * canvas surface with pointer events on has already cost a user a
 * morning of un-clickable right-hand column. Nothing here takes a click,
 * a hover, or a focus.
 *
 * Painted from the canvas background token, so it reads as content
 * running out rather than as a border. It sits later in the DOM than the
 * scroller and earlier than the docked chrome, so it covers the rows and
 * the layer strip and the bottom-right dock still cover it.
 */
import { type RefObject } from 'react'
import { useScrollGeometry } from './useScrollGeometry'

const FADE = 'pointer-events-none absolute inset-y-0 w-12 z-30 animate-in fade-in duration-200 motion-reduce:animate-none'

export function CanvasEdgeFades({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const { scrollLeft, scrollWidth, clientWidth } = useScrollGeometry(scrollRef)

  return (
    <>
      {scrollLeft > 0 && (
        <div aria-hidden data-canvas-edge-fade="left" className={`${FADE} left-0 bg-gradient-to-r from-canvas to-transparent`} />
      )}
      {scrollLeft + clientWidth < scrollWidth - 1 && (
        <div aria-hidden data-canvas-edge-fade="right" className={`${FADE} right-0 bg-gradient-to-l from-canvas to-transparent`} />
      )}
    </>
  )
}
