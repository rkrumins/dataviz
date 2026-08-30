/**
 * The bottom-right dock: Data loads above Connections, in ONE stack.
 *
 * They used to be two surfaces in the same corner at different z-tiers — the
 * message chip in the status cluster (z-30) and the Connections panel (z-40) —
 * and an expanded Connections body grew up over the chip, which then could not
 * be clicked at all. Siblings in a bottom-anchored flex column cannot do that:
 * whichever one opens pushes the stack upward.
 *
 * Two things a future edit could silently undo, pinned at the source level
 * (the idiom of `noBackdropFilterInScrollers.test.ts` — this wiring cannot be
 * reached in jsdom without mounting the whole 5k-line canvas): that Data loads
 * is mounted inside the band-reserving wrapper above Connections, and that the
 * reservation measures EVERY docked header rather than just the first button.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const canvas = readFileSync(resolve(__dirname, '../ContextViewCanvas.tsx'), 'utf8')
const connections = readFileSync(resolve(__dirname, '../connections/ConnectionsPanel.tsx'), 'utf8')
const chips = readFileSync(resolve(__dirname, '../CanvasStatusChips.tsx'), 'utf8')

describe('the Data loads panel is docked with Connections in one bottom-right stack', () => {
  it('mounts DataLoadsPanel inside the band-reserving wrapper, above Connections', () => {
    const wrapperStart = canvas.indexOf('ref={edgeLegendRef}')
    expect(wrapperStart).toBeGreaterThan(-1)
    const block = canvas.slice(wrapperStart, canvas.indexOf('</div>', wrapperStart))
    expect(block).toContain('<DataLoadsPanel')
    expect(block.indexOf('<DataLoadsPanel')).toBeLessThan(block.indexOf('<ConnectionsPanel'))
    // A bottom-anchored column: opening either panel grows the stack upward,
    // so neither can ever cover the other.
    expect(block).toMatch(/flex flex-col gap-1\.5/)
  })

  it('the band reservation measures every docked header, not just the first button', () => {
    expect(canvas).toMatch(/const measureLegendHeader[\s\S]{0,400}?\[data-dock-header\]/)
    expect(canvas).not.toContain("el.querySelector<HTMLElement>('button')?.offsetHeight")
  })

  it('both docked panels mark their collapsed header as the measured footprint', () => {
    expect(connections).toContain('data-dock-header')
  })

  it('caps the stack, so the Data loads header cannot be pushed out of reach', () => {
    // Both bodies open is taller than the canvas: Data loads' list is 40vh and
    // Connections' rows 45vh, plus ~244px of headers, summaries and footers.
    // The column is bottom-anchored inside an `overflow-hidden` body, so
    // without a cap the overflow is clipped off the TOP — taking with it the
    // Data loads header, the only control that closes Data loads.
    const wrapperStart = canvas.indexOf('ref={edgeLegendRef}')
    const block = canvas.slice(wrapperStart, canvas.indexOf('</div>', wrapperStart))
    expect(block).toMatch(/overflow-y-auto/)
    // and it scrolls the dock, not the canvas behind it
    expect(block).toMatch(/overscroll-contain/)
    // The cap leaves the bottom offset out of the budget, or a raised dock
    // (trace open) overflows the top by exactly the dock's height.
    expect(block).toMatch(/maxHeight:[^\n]*100%[^\n]*--trace-dock-height/)
  })

  it('the status chips clear the dock column instead of sitting under it', () => {
    // The dock is w-64 at right:1rem — 16px to 272px from the right edge, at
    // z-40, with an opaque body. A chip cluster right-aligned at `right-3`
    // shares that whole x-range, so an expanded panel paints and hit-tests
    // over every chip in it. Clearing it horizontally is the fix; raising its
    // z-tier would only put the chips over the panel's rows.
    expect(chips).not.toMatch(/absolute right-3 z-30/)
    expect(chips).toMatch(/right:\s*'calc\(1rem \+ 16rem \+ 0\.5rem\)'/)
  })
})
