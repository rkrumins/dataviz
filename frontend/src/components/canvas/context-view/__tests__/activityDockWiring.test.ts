/**
 * The bottom-right dock: Activity above Connections, in ONE stack.
 *
 * They used to be two surfaces in the same corner at different z-tiers — the
 * message chip in the status cluster (z-30) and the Connections panel (z-40) —
 * and an expanded Connections body grew up over the chip, which then could not
 * be clicked at all. Siblings in a bottom-anchored flex column cannot do that:
 * whichever one opens pushes the stack upward.
 *
 * Two things a future edit could silently undo, pinned at the source level
 * (the idiom of `noBackdropFilterInScrollers.test.ts` — this wiring cannot be
 * reached in jsdom without mounting the whole 5k-line canvas): that Activity
 * is mounted inside the band-reserving wrapper above Connections, and that the
 * reservation measures EVERY docked header rather than just the first button.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const canvas = readFileSync(resolve(__dirname, '../ContextViewCanvas.tsx'), 'utf8')
const connections = readFileSync(resolve(__dirname, '../connections/ConnectionsPanel.tsx'), 'utf8')

describe('the Activity panel is docked with Connections in one bottom-right stack', () => {
  it('mounts ActivityPanel inside the band-reserving wrapper, above Connections', () => {
    const wrapperStart = canvas.indexOf('ref={edgeLegendRef}')
    expect(wrapperStart).toBeGreaterThan(-1)
    const block = canvas.slice(wrapperStart, canvas.indexOf('</div>', wrapperStart))
    expect(block).toContain('<ActivityPanel')
    expect(block.indexOf('<ActivityPanel')).toBeLessThan(block.indexOf('<ConnectionsPanel'))
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
})
