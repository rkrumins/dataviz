/**
 * THE TOP OF THE CANVAS SAYS WHAT IT IS DOING — and can be seen saying it.
 *
 * The Context View's notices were reported as hidden "at the top of the
 * canvas", and every one of them was: each placed itself. The Narrow chip sat
 * at `z-30` beside layer columns at `z-30` that come later in the page, so
 * the column headers painted over it. The trace capsule, the connect pill and
 * the Narrow chip all took `absolute top-3`, so any two covered each other and
 * whichever banner was showing. The provider pill was placed by CanvasRouter
 * over the WHOLE canvas, toolbar included, and landed on its search and menu
 * buttons.
 *
 * The fix is structural, so this guard is too: one status stack
 * (`CanvasStatusStack`) holds every one of those notices, and the layering
 * scale (`lib/zIndex.ts`) names the rungs, so "which surface wins" is a
 * decision written down once instead of a number picked per file.
 *
 * SOURCE-LEVEL, because jsdom has no layout and no stacking: a rendering test
 * would report every notice "in the document" while the browser paints a
 * column header over it — which is exactly how this shipped.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Z_INDEX } from '@/lib/zIndex'
import { stripComments } from '@/test/jsxSourceScan'

const SRC = resolve(__dirname, '..')
const read = (rel: string) => stripComments(readFileSync(resolve(SRC, rel), 'utf8'))

const HOW_TO_FIX =
  'Render a notice at the top of the Context View inside <CanvasStatusStack> — a chip in its '
  + '`chips` (most important first), a banner as a child — and let the stack place it. A chip '
  + 'that positions itself (`absolute top-3`, a numeric `z-`) is how two notices came to cover '
  + 'each other and the column headers to cover the Narrow chip.'

/** Everything the Context View says at its top, as it appears in its source. */
const NOTICES = [
  '{providerPill}',
  '<TraceWalkIndicator',
  '<ConnectModePill',
  '<NarrowChip',
  'data-testid="lineage-catching-up"',
  'data-testid="canvas-summaries-banner"',
  'data-testid="canvas-read-pressure-banner"',
  'data-testid="canvas-provider-reconnecting-banner"',
  '<StaleDataBanner',
  '<SubsetIssueBanner',
]

/** Every occurrence of `needle` that is NOT between the stack's open and close tags. */
function outsideStack(src: string, needle: string): number[] {
  const open = src.indexOf('<CanvasStatusStack')
  const close = src.indexOf('</CanvasStatusStack>')
  const out: number[] = []
  for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
    if (open < 0 || close < 0 || at < open || at > close) out.push(at)
  }
  return out
}

/** A chip that places itself: positioned AND given a number rather than a rung. */
const selfPlaced = (src: string): string[] =>
  [...src.matchAll(/className=(?:"[^"]*"|\{[^}]*\})/g)]
    .map((m) => m[0])
    .filter((cls) => /(?<![\w-])(?:absolute|fixed)(?![\w-])/.test(cls) && /(?<![\w-])z-(?:\d+|\[)/.test(cls))

describe('the layering scale', () => {
  it('is the one tailwind.config.js builds its z-index theme from', async () => {
    const config = (await import(pathToFileURL(resolve(SRC, '..', 'tailwind.config.js')).href)).default
    expect(config.theme.extend.zIndex).toEqual(
      Object.fromEntries(Object.entries(Z_INDEX).map(([k, v]) => [k, String(v)])),
    )
  })

  it('climbs in the order the surfaces have to win', () => {
    // The columns under their floating chrome, the status stack over both (a
    // notice nobody can see is no notice), then coachmarks, toasts, popovers,
    // the tooltip explaining a control inside one, and a tour above it all.
    const order = ['canvas', 'chrome', 'status', 'coach', 'toast', 'popover', 'tooltip', 'tour'] as const
    expect(Object.keys(Z_INDEX).sort()).toEqual([...order].sort())
    for (let i = 1; i < order.length; i++) {
      expect(Z_INDEX[order[i]], `${order[i]} must sit above ${order[i - 1]}`).toBeGreaterThan(Z_INDEX[order[i - 1]])
    }
  })
})

describe('the top of the Context View is one status stack', () => {
  const cvc = read('components/canvas/context-view/ContextViewCanvas.tsx')

  it('renders the stack, inside the canvas body below the toolbar', () => {
    const body = cvc.indexOf('data-canvas-body')
    expect(body, 'the canvas body').toBeGreaterThan(0)
    expect(cvc.indexOf('<CanvasStatusStack'), 'the stack opens inside the body').toBeGreaterThan(body)
    expect(cvc.indexOf('<ContextViewHeader'), 'the toolbar comes first').toBeLessThan(body)
  })

  it('every notice at the top is inside it', () => {
    for (const notice of NOTICES) {
      expect(cvc.includes(notice), `${notice} is still rendered by the canvas`).toBe(true)
      expect(outsideStack(cvc, notice), `${notice}: ${HOW_TO_FIX}`).toEqual([])
    }
  })

  it('the columns sit on the canvas rung, under the stack', () => {
    expect(cvc).toMatch(/className="flex h-full min-h-0 relative z-canvas /)
  })

  it('no chip places itself', () => {
    for (const rel of [
      'components/canvas/context-view/CanvasStatusStack.tsx',
      'features/narrow/NarrowChip.tsx',
      'components/canvas/edge-create/ConnectModePill.tsx',
    ]) {
      expect(selfPlaced(read(rel)), `${rel}: ${HOW_TO_FIX}`).toEqual([])
    }
    // The capsule places itself on the Lens board only, which has no stack:
    // on the canvas it is placed like the rest.
    const capsule = read('components/canvas/context-view/TraceWalkIndicator.tsx')
    expect(capsule).toMatch(/surface === 'lens' \? 'absolute inset-x-0 top-3 z-40 px-4' : 'w-full'/)
    // The provider pill neither: CanvasRouter floats it over the other
    // canvases, on the status rung, and hands it to the Context View's stack.
    const pill = read('components/canvas/CanvasProviderStateOverlay.tsx')
    const pillSrc = pill.slice(pill.indexOf('function CanvasProviderStatePill'), pill.indexOf('export const CanvasProviderStateOverlay'))
    expect(selfPlaced(pillSrc), HOW_TO_FIX).toEqual([])
    expect(pillSrc).not.toMatch(/(?<![\w-])absolute(?![\w-])/)
    const router = read('components/canvas/CanvasRouter.tsx')
    expect(router).toMatch(/<CanvasProviderPillSlot value=\{pillInCanvas \? providerPill : null\}>/)
    expect(router).toMatch(/className="pointer-events-none absolute top-4 left-1\/2 z-status -translate-x-1\/2"/)
  })

  it('has teeth: a notice outside the stack is reported', () => {
    const fixture = `<div data-canvas-body>
      <CanvasStatusStack chips={<>{providerPill}</>}>banner</CanvasStatusStack>
      <NarrowChip applied={a} />
    </div>`
    expect(outsideStack(fixture, '<NarrowChip')).toHaveLength(1)
    expect(outsideStack(fixture, '{providerPill}')).toEqual([])
    expect(selfPlaced('<div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex">')).toHaveLength(1)
  })
})
