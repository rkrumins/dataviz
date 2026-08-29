/**
 * The Connections panel's wiring into the Context View canvas.
 *
 * This class of wiring cannot be reached in jsdom without mounting the whole
 * 5k-line canvas, so it is pinned at the source level — the same idiom as
 * `noBackdropFilterInScrollers.test.ts`. Three tight assertions guard the
 * three things a future edit could silently undo: that the panel is what is
 * mounted, that it still lives inside the band-reserving wrapper (or the
 * bottom row of every column slides under it), and that its highlight goes
 * to the overlay ONLY — routing it to the columns as well would dim every
 * card on the board, because the panel carries no node set.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, '../../ContextViewCanvas.tsx'), 'utf8')

describe('the Connections panel is wired into the Context View', () => {
  it('the Context View mounts ConnectionsPanel and no longer mounts EdgeLegend', () => {
    expect(source).toContain('<ConnectionsPanel')
    expect(source).not.toMatch(/<EdgeLegend/)
    expect(source).not.toMatch(/from '\.\.\/EdgeLegend'/)
  })

  it('the panel stays inside the band-reserving wrapper', () => {
    expect(source).toContain(
      "useBandReservation(edgeLegendRef, '--edge-legend-height', measureLegendHeader)"
    )
    const wrapperStart = source.indexOf('ref={edgeLegendRef}')
    expect(wrapperStart).toBeGreaterThan(-1)
    const wrapperBlock = source.slice(wrapperStart, source.indexOf('</div>', wrapperStart))
    expect(wrapperBlock).toContain('<ConnectionsPanel')
  })

  it('the panel is keyed by view, and its type resolver hands over a description', () => {
    // A pinned highlight or an opened panel must not survive a view switch.
    expect(source).toContain('key={connectionsViewId}')
    // getEdgeTypeDefinition fabricates prose when the ontology has none; the
    // resolver overrides it so the panel prints the ontology's words or none.
    expect(source).toMatch(/return \{ \.\.\.def, description \}/)
  })

  it('the panel highlight reaches the overlay only — cards keep their own highlight', () => {
    expect(source).toContain(
      'isHighlightActive={connectionHighlight !== null || isHighlightActive}'
    )
    expect(source).toMatch(/isHighlightActive=\{isHighlightActive\}/)
  })
})
