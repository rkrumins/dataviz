/**
 * Does CSS `zoom` scale PERCENTAGE sizes in this browser?
 *
 * It used to, everywhere: an element with `zoom: 1.6; height: calc(100% / 1.6)`
 * laid out at exactly its container's height. Chromium's standardised zoom
 * (and Firefox's) no longer scales percentages — only absolute lengths — so
 * that same element came out at 62.5% of the container: at 160% the canvas's
 * columns stopped a third of the way up the screen, over dead space, and the
 * virtualizer mounted rows for the shortened column only. Measured once, the
 * first time it is asked.
 */
let scalesPercentages: boolean | null = null

export function zoomScalesPercentages(): boolean {
  if (scalesPercentages !== null) return scalesPercentages
  if (typeof document === 'undefined' || !document.body) return false
  const outer = document.createElement('div')
  outer.style.cssText = 'position:absolute;visibility:hidden;left:0;top:0;width:100px;height:100px;pointer-events:none'
  const inner = document.createElement('div')
  inner.style.cssText = 'zoom:2;height:50%'
  outer.appendChild(inner)
  document.body.appendChild(outer)
  // Legacy zoom paints the 50% child at 100px; standardised zoom at 50px.
  // (jsdom does no layout and reports 0: the standardised answer.)
  scalesPercentages = inner.getBoundingClientRect().height > 75
  outer.remove()
  return scalesPercentages
}
