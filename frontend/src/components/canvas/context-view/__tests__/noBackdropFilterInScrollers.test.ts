/**
 * "White strips" on canvas rows and legend rows were backdrop-filter
 * ghosts: Chromium leaves a mis-placed blurred tile — a hard-edged,
 * translucent band — when a backdrop-filter surface sits inside a scroll
 * container (sticky column headers, floating pills), animates its size
 * (the edge legend opening), or is toggled by React state that can miss a
 * mouseleave (the row's hover action overlay). The fundamental fix is to
 * not have the mechanism: surfaces that live inside the columns' scrollers
 * or animate get opacity instead of blur, and hover overlays are owned by
 * CSS (`group-hover`), which the browser can never leave stuck.
 *
 * This pins the rule at the source level so it cannot creep back in.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = resolve(__dirname, '..')
/** Source with comments removed — prose may name the classes; code may not. */
const read = (rel: string) =>
  readFileSync(resolve(here, rel), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const BLUR = /backdrop-blur|backdrop-filter|glass-panel/g

describe('bottom chrome and scroller surfaces carry no backdrop-filter', () => {
  it('LayerColumn: sticky header and floating pills use opacity, not blur', () => {
    expect(read('LayerColumn.tsx').match(BLUR) ?? []).toEqual([])
  })

  it('LoadMoreItem: no blur', () => {
    expect(read('LoadMoreItem.tsx').match(BLUR) ?? []).toEqual([])
  })

  it('EdgeLegend: an opaque elevated panel, not a glass panel', () => {
    expect(read('../EdgeLegend.tsx').match(BLUR) ?? []).toEqual([])
  })

  it('FlatTreeItem: only the card body keeps its subtle blur; the hover overlay has none', () => {
    const src = read('FlatTreeItem.tsx')
    const hits = src.match(BLUR) ?? []
    // The card body's `backdrop-blur-sm` softens cross-column edges behind
    // the node; it is its own static box (no sticky, no animation, no
    // toggling), which is not the ghosting shape. Exactly one, on that line.
    expect(hits).toEqual(['backdrop-blur'])
    expect(src).toMatch(/bg-canvas-elevated\/10 backdrop-blur-sm/)
  })

  it('FlatTreeItem: the hover action overlay is CSS-owned, never React-state-owned', () => {
    const src = read('FlatTreeItem.tsx')
    expect(src).not.toMatch(/opacity:\s*isHovered\s*\?\s*1\s*:\s*0/)
    expect(src).toMatch(/group-hover\/item:opacity-100/)
  })
})
