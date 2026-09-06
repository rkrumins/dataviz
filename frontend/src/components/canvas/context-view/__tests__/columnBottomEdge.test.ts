/**
 * The columns end exactly at the visible bottom — the top of the band the
 * docked chrome reserves — and not a strip of dead canvas above it.
 *
 * A percentage height resolves against the scroller's CONTENT box, which
 * already excludes both the reserved padding band below it and the classic
 * scrollbar's strip. Measured in Chromium on the live canvas (scroller
 * offsetHeight 583, clientHeight 572 — an 11px `custom-scrollbar` — and
 * padding-bottom 86): a `calc(100% / 1)`-tall columns wrapper paints 486
 * and its bottom lands on the band top exactly, while subtracting the
 * scrollbar as well paints 475 and stops 11px short. That strip only
 * cleared the selection when clicked.
 *
 * jsdom has no layout, so the rule is pinned at the source level — the
 * idiom of `noBackdropFilterInScrollers.test.ts`.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const canvas = readFileSync(resolve(__dirname, '../ContextViewCanvas.tsx'), 'utf8')

describe('the layer columns fill the scroller\'s visible box', () => {
  it('takes the whole content box, undone by the canvas zoom and nothing else', () => {
    expect(canvas).toContain('height: `calc(100% / ${canvasZoom})`')
  })

  it('never subtracts the scrollbar strip a second time', () => {
    expect(canvas).not.toMatch(/height:\s*`calc\(\(100% -/)
  })
})
